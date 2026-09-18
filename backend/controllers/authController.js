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

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/refresh",
    maxAge: REFRESH_MAX_AGE,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/refresh",
  });
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
