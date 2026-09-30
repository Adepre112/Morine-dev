const User = require("../models/User");
const CareerProfile = require("../models/CareerProfile");
const RefreshToken = require("../models/RefreshToken");
const {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateResetToken,
  hashResetToken,
} = require("../middleware/auth");
const nodemailer = require("nodemailer");

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TOKEN_MAX_AGE = 60 * 60 * 1000; // 1 hour

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/* Email transporter - lazily initialized */
let emailTransporter = null;

function getEmailTransporter() {
  if (emailTransporter) return emailTransporter;

  const host = process.env.EMAIL_HOST;
  const port = parseInt(process.env.EMAIL_PORT || "587", 10);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  emailTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return emailTransporter;
}

/* Sender address for every outgoing mail. This lives at module scope as its
   own function because the value is needed at send time: declaring it inside
   getEmailTransporter() left `from` undefined in sendResetEmail(), which made
   every password-reset email throw a ReferenceError and silently send nothing. */
function fromAddress() {
  return process.env.EMAIL_FROM || `"Morine" <${process.env.EMAIL_USER}>`;
}

/* ---- Password-reset link origin -------------------------------------------
 *
 * Morine is a SINGLE-ORIGIN app: one Render service serves the frontend and
 * every /api/* route from the same host, so FRONTEND_URL is deliberately unset
 * in production (see render.yaml) and the reset link has to be built from the
 * request. That is convenient, but the Host and X-Forwarded-Proto headers are
 * attacker-controlled the moment anyone can reach the process directly, so a
 * derived origin is treated as UNTRUSTED and must clear every check below
 * before it is allowed into an email. Reflecting an unchecked Host header
 * would let anyone mail a victim a genuine, freshly-minted reset token wrapped
 * in a link pointing at the attacker's own domain.
 *
 *   1. FRONTEND_URL, when the operator has set it, is authoritative.
 *   2. Otherwise the origin is derived from the request, but:
 *        - the scheme must be exactly "http" or "https" (blocks "javascript:",
 *          "data:" and any second "//authority" smuggled in after a colon);
 *        - the host must be a bare hostname or bracketed IPv6 literal, with an
 *          optional numeric port and nothing else -- no scheme, no path, no
 *          userinfo ("user@host"), no whitespace, no backslash;
 *        - a comma-joined X-Forwarded-* chain is ambiguous, so it is rejected
 *          rather than guessed at;
 *        - the host must additionally be one this deployment is willing to
 *          send a live token to. Valid syntax is NOT enough: anyone who can
 *          reach the process can set "Host: evil.example", and a victim who
 *          clicked that link would hand a working reset token to the attacker.
 *          In production the host must therefore be on the allowlist below;
 *        - in production the scheme is pinned to https so a spoofed "http"
 *          cannot downgrade a live link.
 *
 * If none of that yields an origin, no link is built. In production the mail is
 * skipped entirely rather than shipping an unusable or attacker-chosen link;
 * only in development does the plaintext dev fallback remain.
 */
const SAFE_SCHEMES = new Set(["http", "https"]);
const SAFE_HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::\d{1,5})?$/;

/* Hosts a request-derived origin may point at while FRONTEND_URL is unset.
 *
 * The default is the EXACT public host this service is deployed on, not a
 * "*.onrender.com" wildcard. A wildcard looks safe but is not: anyone can
 * stand up their own service at evil.onrender.com, send the app one direct
 * request carrying "Host: evil.onrender.com" plus a victim's address, and the
 * app would happily mail that victim a genuine, freshly-minted reset token
 * wrapped in a link pointing at the attacker's host. Syntax validation cannot
 * catch that, so the allowlist has to name a host we actually control.
 *
 * Set RESET_ALLOWED_HOSTS (comma-separated) if the app is served from a custom
 * domain, or if the service is renamed. Development is unrestricted so that
 * LAN testing (e.g. 192.168.x.x:3000) keeps working. */
const DEFAULT_RESET_HOSTS = ["morine-ai.onrender.com"];

function hostIsAllowed(host) {
  const hostname = String(host).replace(/:\d{1,5}$/, "").toLowerCase();
  const configured = String(process.env.RESET_ALLOWED_HOSTS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const allowed = configured.length ? configured : (IS_PRODUCTION ? DEFAULT_RESET_HOSTS : null);
  if (!allowed) return true; // development
  return allowed.some(entry => {
    // A leading "." opts that entry into subdomains, e.g. ".example.com".
    // Without it the match is exact: "example.com" must not quietly authorise
    // "attacker.example.com" or "a.b.example.com".
    const wildcard = entry.startsWith(".");
    const bare = (wildcard ? entry.slice(1) : entry).replace(/^\./, "");
    return hostname === bare || (wildcard && hostname.endsWith("." + bare));
  });
}

/** Reads one header value, rejecting proxy-chain lists like "https, http". */
function singleHeaderValue(req, name) {
  let raw;
  try {
    raw = typeof req.get === "function" ? req.get(name) : (req.headers || {})[name];
  } catch (e) {
    return null;
  }
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.includes(",")) return null;
  return v;
}

function safeScheme(req) {
  const fromHeader = singleHeaderValue(req, "x-forwarded-proto");
  const proto = String(fromHeader || (req && req.protocol) || "").trim().toLowerCase();
  return SAFE_SCHEMES.has(proto) ? proto : null;
}

function safeHost(req) {
  const raw = singleHeaderValue(req, "host");
  if (!raw || raw.length > 253 || !SAFE_HOST.test(raw)) return null;
  return raw;
}

/** Returns "https://host" or "https://host:port", or null if it cannot be
    established safely. */
function resolveResetOrigin(req) {
  const configured = (process.env.FRONTEND_URL || "").trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch (e) {
      // Malformed FRONTEND_URL: fall through to the request rather than
      // trusting it.
    }
  }
  if (!req) return null;
  const host = safeHost(req);
  if (!host || !hostIsAllowed(host)) return null;
  const scheme = safeScheme(req);
  if (!scheme) return null;
  return `${IS_PRODUCTION ? "https" : scheme}://${host}`;
}

async function sendResetEmail(email, resetToken, req) {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.warn("[Auth] Email not configured - password reset email not sent");
    return false;
  }

  const origin = resolveResetOrigin(req);
  // The token is only ever placed in a URL under a validated origin. It is
  // never logged and never returned to the caller.
  let resetUrl = null;
  if (origin) {
    resetUrl = `${origin}/#/reset-password?token=${encodeURIComponent(resetToken)}`;
  } else if (IS_PRODUCTION) {
    console.warn(
      "[Auth] Could not establish a safe frontend origin for the reset link; " +
        "password reset email not sent. Set FRONTEND_URL explicitly."
    );
    return false;
  } else {
    // Development convenience only: the token is shown so it can be pasted
    // into the app by hand. Never reachable in production.
    resetUrl = `Reset token (dev only): ${resetToken}`;
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #705cff 0%, #22d3ee 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">Morine</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0;">Your AI Career Co-Pilot</p>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="color: #1a1a2e; margin-top: 0;">Reset your password</h2>
        <p>You requested a password reset for your Morine account. Click the button below to set a new password:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #705cff 0%, #22d3ee 100%); color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset Password</a>
        </div>
        <p style="color: #64748b; font-size: 14px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
        <p style="color: #94a3b8; font-size: 12px;">If the button doesn't work, copy this link:<br><span style="word-break: break-all;">${resetUrl}</span></p>
      </div>
      <p style="color: #94a3b8; font-size: 11px; text-align: center; margin-top: 16px;">© 2026 Morine Technologies. Osogbo, Osun State · Remote 🌍</p>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: fromAddress(),
      to: email,
      subject: "Reset your Morine password",
      html,
    });
    return true;
  } catch (error) {
    console.error("[Auth] Failed to send reset email:", error.message);
    return false;
  }
}

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

  async forgotPassword(req, res) {
    try {
      const { email } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: "Please provide a valid email address." });
      }

      const user = await User.findOne({ email: email.toLowerCase() });
      
      // Always return the same generic response to prevent email enumeration
      const genericResponse = {
        success: true,
        data: { message: "If an account exists with this email, a password reset link has been sent." }
      };

      if (!user) {
        return res.json(genericResponse);
      }

      // Generate secure reset token
      const resetToken = generateResetToken();
      const resetTokenHash = hashResetToken(resetToken);
      const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_MAX_AGE);

      // Store only the hash
      user.resetTokenHash = resetTokenHash;
      user.resetTokenExpiry = resetTokenExpiry;
      await user.save();

      // Send email (non-blocking - don't reveal if email fails)
      sendResetEmail(user.email, resetToken, req).catch(() => {});

      return res.json(genericResponse);
    } catch (error) {
      console.error("[Auth] Forgot password error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
    }
  }

  async verifyResetToken(req, res) {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ success: false, error: "Reset token is required." });
      }

      // Find user with this reset token hash
      const tokenHash = hashResetToken(token);
      const user = await User.findOne({ resetTokenHash: tokenHash }).select("+resetTokenHash +resetTokenExpiry");

      if (!user || !user.verifyResetToken(token)) {
        return res.status(400).json({ success: false, error: "Invalid or expired reset token." });
      }

      return res.json({ success: true, data: { valid: true } });
    } catch (error) {
      console.error("[Auth] Verify reset token error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
    }
  }

  async resetPassword(req, res) {
    try {
      const { token, password, confirmPassword } = req.body;

      if (!token) {
        return res.status(400).json({ success: false, error: "Reset token is required." });
      }
      if (!password || !confirmPassword) {
        return res.status(400).json({ success: false, error: "Password and confirmation are required." });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ success: false, error: "Passwords do not match." });
      }
      if (password.length < 8) {
        return res.status(400).json({ success: false, error: "Password must be at least 8 characters." });
      }

      // Find user with this reset token hash
      const tokenHash = hashResetToken(token);
      const user = await User.findOne({ resetTokenHash: tokenHash }).select("+passwordHash +resetTokenHash +resetTokenExpiry");

      if (!user || !user.verifyResetToken(token)) {
        return res.status(400).json({ success: false, error: "Invalid or expired reset token." });
      }

      // Hash new password and clear reset token
      user.passwordHash = await User.hashPassword(password);
      user.resetTokenHash = null;
      user.resetTokenExpiry = null;
      await user.save();

      // Revoke all refresh tokens for this user (force re-login)
      await RefreshToken.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );

      return res.json({ success: true, data: { message: "Password has been reset successfully. You can now sign in with your new password." } });
    } catch (error) {
      console.error("[Auth] Reset password error:", error.message);
      return res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
    }
  }
}

module.exports = new AuthController();
