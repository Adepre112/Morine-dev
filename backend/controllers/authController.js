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

/* Email transporter - lazily initialized */
let emailTransporter = null;

function getEmailTransporter() {
  if (emailTransporter) return emailTransporter;

  const host = process.env.EMAIL_HOST;
  const port = parseInt(process.env.EMAIL_PORT || "587", 10);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const from = process.env.EMAIL_FROM || `"Morine" <${user}>`;

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

async function sendResetEmail(email, resetToken) {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.warn("[Auth] Email not configured - password reset email not sent");
    return false;
  }

  const frontendUrl = (process.env.FRONTEND_URL || "").trim();
  const resetUrl = frontendUrl
    ? `${frontendUrl.replace(/\/+$/, "")}/#/reset-password?token=${resetToken}`
    : `Reset token (dev only): ${resetToken}`;

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
      from,
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
      sendResetEmail(user.email, resetToken).catch(() => {});

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
      const user = await User.findOne({ resetTokenHash: tokenHash });

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
      const user = await User.findOne({ resetTokenHash: tokenHash }).select("+passwordHash");

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
