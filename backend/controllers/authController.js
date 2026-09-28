const User = require("../models/User");
const CareerProfile = require("../models/CareerProfile");
const RefreshToken = require("../models/RefreshToken");
const {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} = require("../middleware/auth");

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

/* Cookie policy.
 *
 * Morine is a SINGLE-ORIGIN application. GitHub -> Render Web Service -> the
 * single Express process, which serves BOTH the frontend and every /api/* route
 * from the same host. There is no separate frontend host and no proxy, so the
 * browser's request to /api/auth/refresh is same-origin.
 *
 *   Production (https://<service>.onrender.com)
 *     SameSite=Lax + Secure + HttpOnly. Because the request is same-origin,
 *     SameSite is not a restriction here at all -- Lax still allows the cookie
 *     to be sent, and it keeps the cookie protected as a defence-in-depth
 *     measure if the app is ever reached cross-site (an embedded link, a
 *     top-level navigation from another site). SameSite=None would be a
 *     DOWNGRADE here: it is the only value that permits cross-site sending, and
 *     it is unnecessary when the API is on the same origin. Secure is required
 *     because Render terminates TLS in front of the process.
 *
 *   Development (http://localhost:3000)
 *     Identical attributes except Secure is dropped, because browsers refuse to
 *     store a Secure cookie delivered over plain HTTP. Localhost is a secure
 *     context for SameSite purposes, so Lax still works over http.
 *
 * The option object is built in ONE place and reused by both the setter and
 * the clearer. A cookie can only be deleted if the clearing request repeats the
 * original Path / SameSite / Secure attributes exactly, so sharing this
 * function is what guarantees sign-out actually removes the cookie.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function refreshCookieOptions(extra) {
  return Object.assign(
    {
      httpOnly: true,
      path: "/api/auth/refresh",
      sameSite: "lax",
      secure: IS_PRODUCTION,
    },
    extra || {}
  );
}

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, refreshCookieOptions({ maxAge: REFRESH_MAX_AGE }));
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
  // Clear legacy cookie if exists
  res.clearCookie("token");
}

async function issueRefreshToken(userId, req, res) {
  const raw = generateRefreshToken();
  const hash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);
  await RefreshToken.create({
    userId,
    tokenHash: hash,
    expiresAt,
    userAgent: req.headers["user-agent"] || "",
  });
  setRefreshCookie(res, raw);
  return raw;
}

class AuthController {
  async signup(req, res) {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ success: false, error: "Name, email, and password are required." });
      }
      if (name.trim().length < 2) {
        return res.status(400).json({ success: false, error: "Name must be at least 2 characters." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: "Please provide a valid email address." });
      }
      if (password.length < 8) {
        return res.status(400).json({ success: false, error: "Password must be at least 8 characters." });
      }
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ success: false, error: "An account with this email already exists." });
      }
      const passwordHash = await User.hashPassword(password);
      const user = await User.create({ name: name.trim(), email: email.toLowerCase().trim(), passwordHash });
      await CareerProfile.create({ userId: user._id });
      const token = generateAccessToken(user._id);
      await issueRefreshToken(user._id, req, res);
      return res.status(201).json({ success: true, data: { user, token } });
    } catch (error) {
      console.error("[Auth] Signup error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
    }
  }

  async login(req, res) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: "Email and password are required." });
      }
      const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash");
      if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });
      const isMatch = await user.comparePassword(password);
      if (!isMatch) return res.status(401).json({ success: false, error: "Invalid email or password." });
      const token = generateAccessToken(user._id);
      await issueRefreshToken(user._id, req, res);
      return res.json({ success: true, data: { user, token } });
    } catch (error) {
      console.error("[Auth] Login error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
    }
  }

  async refresh(req, res) {
    try {
      const raw = req.cookies?.[REFRESH_COOKIE_NAME];
      if (!raw) return res.status(401).json({ success: false, error: "Refresh token required." });
      const hash = hashRefreshToken(raw);
      const record = await RefreshToken.findOne({ tokenHash: hash });
      if (!record) return res.status(401).json({ success: false, error: "Invalid refresh token." });
      if (record.revokedAt) {
        // Reuse of revoked token — revoke family
        await RefreshToken.updateMany({ userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
        clearRefreshCookie(res);
        return res.status(401).json({ success: false, error: "Refresh token revoked." });
      }
      if (record.expiresAt < new Date()) {
        await RefreshToken.deleteOne({ _id: record._id });
        clearRefreshCookie(res);
        return res.status(401).json({ success: false, error: "Refresh token expired." });
      }
      const user = await User.findById(record.userId);
      if (!user) {
        await RefreshToken.deleteOne({ _id: record._id });
        clearRefreshCookie(res);
        return res.status(401).json({ success: false, error: "User not found." });
      }
      // Rotate
      const newRaw = generateRefreshToken();
      const newHash = hashRefreshToken(newRaw);
      const newExpiresAt = new Date(Date.now() + REFRESH_MAX_AGE);
      record.revokedAt = new Date();
      record.replacedByTokenHash = newHash;
      await record.save();
      await RefreshToken.create({ userId: user._id, tokenHash: newHash, expiresAt: newExpiresAt, userAgent: req.headers["user-agent"] || "" });
      setRefreshCookie(res, newRaw);
      const newAccessToken = generateAccessToken(user._id);
      return res.json({ success: true, data: { token: newAccessToken, user } });
    } catch (error) {
      console.error("[Auth] Refresh error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred." });
    }
  }

  async logout(req, res) {
    try {
      const raw = req.cookies?.[REFRESH_COOKIE_NAME];
      if (raw) {
        const hash = hashRefreshToken(raw);
        const record = await RefreshToken.findOne({ tokenHash: hash });
        if (record) {
          record.revokedAt = new Date();
          await record.save();
        }
      }
    } catch {}
    clearRefreshCookie(res);
    return res.json({ success: true, data: { message: "Logged out successfully." } });
  }

  async me(req, res) {
    return res.json({ success: true, data: { user: req.user } });
  }
}

module.exports = new AuthController();
