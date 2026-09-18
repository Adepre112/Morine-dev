const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET;

if (!JWT_SECRET) {
  console.error("[Auth] JWT_SECRET is not set in environment variables.");
  process.exit(1);
}

function generateToken(userId) {
  return generateAccessToken(userId);
}

function generateAccessToken(userId) {
  return jwt.sign({ id: userId }, JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "30m",
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_ACCESS_SECRET);
}

const crypto = require("crypto");

function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please sign in.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "User not found. Please sign in again.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Session expired. Please sign in again.",
        code: "ACCESS_TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({
      success: false,
      error: "Invalid authentication token.",
    });
  }
}

module.exports = {
  generateToken,
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  authMiddleware,
  JWT_SECRET,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
};
