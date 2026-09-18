require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const connectDB = require("./db/connect");
const jobRoutes = require("./routes/jobRoutes");
const authRoutes = require("./routes/authRoutes");
const profileRoutes = require("./routes/profileRoutes");
const cvRoutes = require("./routes/cvRoutes");
const skillGapRoutes = require("./routes/skillGapRoutes");
const jobMatchRoutes = require("./routes/jobMatchRoutes");
const careerPathRoutes = require("./routes/careerPathRoutes");
const interviewRoutes = require("./routes/interviewRoutes");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..");

// Block access to backend source, node_modules, logs, and test files
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith("/backend") || p.startsWith("/node_modules") || p.includes("/server_out.log") || p.includes("/out.log") || /\/test-.*\.js$/.test(p)) {
    return res.status(404).json({ success: false, error: "Not found" });
  }
  next();
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/cv", cvRoutes);
app.use("/api/skill-gap", skillGapRoutes);
app.use("/api/job-match", jobMatchRoutes);
app.use("/api/career-path", careerPathRoutes);
app.use("/api/interview-prep", interviewRoutes);
app.use("/api", jobRoutes);

// Serve the frontend static files
app.use(express.static(ROOT, { dotfiles: "deny", index: false }));

// Fallback to index.html for SPA-style navigation
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

// 404 handler for unknown API routes
app.use("/api/*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// Global error handler — never leak stack traces in production
app.use((err, req, res, next) => {
  console.error("[Morine] Unhandled error:", err.message);
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || "An internal server error occurred.",
  });
});

// 404 for non-API routes
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// Start server after MongoDB connects
async function start() {
  await connectDB();
  try {
    const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
    const model =
      provider === "groq"
        ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b")
        : provider === "gemini"
          ? (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite")
          : (process.env.OPENAI_MODEL || "gpt-4o-mini");
    const hasKey =
      provider === "groq"
        ? !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "PASTE_THE_GROQ_KEY_HERE"
        : provider === "gemini"
          ? !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "PASTE_THE_GEMINI_KEY_HERE"
          : !!process.env.OPENAI_API_KEY;
    console.log(`[AI] Provider: ${provider}`);
    console.log(`[AI] Model: ${model}`);
    if (!hasKey) console.log(`[AI] Warning: ${provider} API key not configured`);
  } catch (_) {}

  app.listen(PORT, () => {
    console.log(`[Morine] Server running on port ${PORT}`);
    console.log(`[Morine] API endpoints:`);
    console.log(`  POST /api/auth/signup - Register new user`);
    console.log(`  POST /api/auth/login - Sign in`);
    console.log(`  POST /api/auth/logout - Sign out`);
    console.log(`  GET  /api/auth/me - Current user`);
    console.log(`  GET  /api/profile - Get career profile`);
    console.log(`  PUT  /api/profile - Update career profile`);
    console.log(`  POST /api/cv/upload - Upload CV (auth, PDF/DOCX 5MB)`);
    console.log(`  GET  /api/cv - List my CVs`);
    console.log(`  GET  /api/cv/:id - Get CV`);
    console.log(`  POST /api/cv/:id/analyze - Analyze CV (requires OPENAI_API_KEY)`);
    console.log(`  POST /api/cv/:id/optimize - Generate optimized CV`);
    console.log(`  POST /api/skill-gap/analyze - Skill-gap analysis`);
    console.log(`  GET  /api/skill-gap - List skill-gap analyses`);
    console.log(`  GET  /api/skill-gap/:id - Get analysis`);
    console.log(`  DELETE /api/skill-gap/:id - Delete analysis`);
    console.log(`  POST /api/job-match/analyze - AI job matching`);
    console.log(`  GET  /api/job-match - List matches`);
    console.log(`  GET  /api/job-match/:id - Get match`);
    console.log(`  DELETE /api/job-match/:id - Delete match`);
    console.log(`  POST /api/career-path/analyze - Career path`);
    console.log(`  GET  /api/career-path - List career paths`);
    console.log(`  GET  /api/career-path/:id - Get career path`);
    console.log(`  DELETE /api/career-path/:id - Delete career path`);
    console.log(`  POST /api/interview-prep/analyze - Interview prep`);
    console.log(`  GET  /api/interview-prep - List interview prep`);
    console.log(`  GET  /api/interview-prep/:id - Get interview prep`);
    console.log(`  DELETE /api/interview-prep/:id - Delete interview prep`);
    console.log(`  GET  /api/health - Health check`);
    console.log(`  GET  /api/jobs?keyword=...&location=... - Job search`);
    console.log(`[Morine] Frontend served from root`);
  });
}

start().catch((err) => {
  console.error("[Morine] Failed to start server:", err.message);
  process.exit(1);
});

module.exports = app;
