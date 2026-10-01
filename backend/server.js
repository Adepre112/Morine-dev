require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");

// Global error handlers for uncaught errors
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Morine] Unhandled Rejection at:", promise, "reason:", reason);
  console.error("[Morine] Stack:", reason instanceof Error ? reason.stack : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Morine] Uncaught Exception:", err);
  console.error("[Morine] Stack:", err.stack);
  process.exit(1);
});

process.on("exit", (code) => {
  console.error("[Morine] Process exiting with code:", code);
});

console.log("[Morine] MONGODB_URI set:", !!process.env.MONGODB_URI);
console.log("[Morine] GEMINI_API_KEY set:", !!process.env.GEMINI_API_KEY);

/* Password-reset email transport, reported ONCE at boot.
 *
 * The transport is chosen only by EMAIL_PROVIDER, so a deployment that never
 * sets it silently keeps the legacy SMTP path - which Render cannot egress on -
 * and the first symptom is a reset request that returns HTTP 200 and delivers
 * nothing. Printing the resolved provider, the reset-link allowlist and the
 * NAMES of any missing variables at boot turns that into a visible deployment
 * check instead of a production incident.
 *
 * Booleans and variable names only. BREVO_API_KEY, EMAIL_PASS, reset tokens
 * and JWTs are never read for logging. */
(function logEmailTransportAtBoot() {
  const emailService = require("./services/emailService");
  const provider = emailService.getEmailProvider();
  console.log("[Morine] EMAIL_PROVIDER:", provider);
  if (provider === "brevo") {
    const missing = emailService.missingBrevoEnv();
    if (missing.length) {
      console.error("[Morine] EMAIL NOT READY - class=NOT_CONFIGURED missing " +
        missing.join(", ") + " (reset email cannot be sent)");
    } else {
      // resolveSender() reduces EMAIL_FROM to the BARE address Brevo requires.
      // Its boolean is safe to log; the address itself is not printed.
      const sender = emailService.resolveSender();
      console.log("[Morine] EMAIL ready provider=brevo senderAddressIsBareEmail=" +
        sender.valid + " senderNameSet=" + !!sender.name);
      if (!sender.valid) {
        console.error("[Morine] EMAIL_FROM must be a BARE address " +
          "(noreply@yourdomain.com) verified in Brevo - not a \"Name <addr>\" string");
      }
    }
  } else {
    const smtpMissing = ["EMAIL_HOST", "EMAIL_USER", "EMAIL_PASS"]
      .filter((k) => !String(process.env[k] || "").trim());
    if (smtpMissing.length) {
      console.warn("[Morine] EMAIL legacy smtp path selected but missing " +
        smtpMissing.join(", ") + "; reset email cannot be sent");
    } else {
      console.log("[Morine] EMAIL legacy smtp path selected (EMAIL_PROVIDER=brevo " +
        "is the production transport)");
    }
  }
  console.log("[Morine] RESET_ALLOWED_HOSTS:",
    String(process.env.RESET_ALLOWED_HOSTS || "").trim() || "(unset - using the canonical production host)");
})();

// The refresh cookie is Secure in production, which means browsers will drop it
// over plain HTTP. If NODE_ENV is unset on the host, the cookie silently
// degrades to a development policy and every production session breaks at the
// first refresh. Fail loudly at boot rather than leaving users mysteriously
// signed out. render.yaml sets NODE_ENV=production.
if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  console.warn("[Morine] NODE_ENV is not set to production/development/test.");
  if (process.env.NODE_ENV === undefined) {
    console.warn("[Morine] Assuming 'development'. On Render set NODE_ENV=production,");
    console.warn("[Morine] otherwise the Secure refresh cookie will not be used.");
  }
}

const connectDB = require("./db/connect");
const { disconnectDB } = require("./db/connect");

connectDB()
  .then(() => {
    console.log("[MongoDB] Ready. Starting AI config...");
    
    // AI Provider config
    console.log("[Morine] Step 2: Reading AI_PROVIDER...");
    console.log("[Morine] Step 2a: process.env.AI_PROVIDER =", process.env.AI_PROVIDER);
    const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
    console.log("[Morine] Step 3: AI_PROVIDER read:", provider);
    console.log("[Morine] Step 3a: Reading GEMINI_MODEL...");
    const model =
      provider === "groq"
        ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b")
        : provider === "gemini"
          ? (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite")
          : (process.env.OPENAI_MODEL || "gpt-4o-mini");
    console.log("[Morine] Step 4: Model determined:", model);
    console.log("[Morine] Step 4a: Checking API keys...");
    const hasKey =
      provider === "groq"
        ? !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "PASTE_THE_GROQ_KEY_HERE"
        : provider === "gemini"
          ? !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "PASTE_THE_GEMINI_KEY_HERE"
          : !!process.env.OPENAI_API_KEY;
    console.log("[Morine] Step 5: Key check done, hasKey:", hasKey);
    console.log("[AI] Provider:", provider);
    console.log("[AI] Model:", model);
    if (!hasKey) console.log("[AI] Warning:", provider, "API key not configured");
console.log("[Morine] Step 6: AI config complete");
    
    console.log("[Morine] Step 7: Loading express, cors, cookie-parser, path...");
    try {
      const express = require("express");
      console.log("[Morine] Step 8a: express loaded");
      const cors = require("cors");
      console.log("[Morine] Step 8b: cors loaded");
      const cookieParser = require("cookie-parser");
      console.log("[Morine] Step 8c: cookieParser loaded");
      const path = require("path");
      console.log("[Morine] Step 8d: path loaded");
    } catch (e) {
      console.error("[Morine] ERROR loading modules:", e.message, e.stack);
      throw e;
    }
    
    const app = express();
    console.log("[Morine] Step 9: app created");
    const PORT = process.env.PORT || 3000;
    const ROOT = path.join(__dirname, "..");
    console.log("[Morine] Step 10: PORT:", PORT, "ROOT:", ROOT);
    
    /* Block public access to internal files.
     *
     * This process is the entire public site in the Render deployment, and
     * express.static(ROOT) serves the repository root, so anything sitting at the
     * root is downloadable by anyone. That includes development scripts and log
     * files, which can disclose internal paths, stack traces and connection
     * errors. They are denied here rather than deleted so local history and the
     * existing workflow are preserved. Real application assets (index.html,
     * app.html, privacy.html, terms.html, sw.js, manifest.webmanifest, js/, css/)
     * are unaffected.
     */
    const BLOCKED_INTERNAL = [
      /^\/backend(\/|$)/,
      /^\/node_modules(\/|$)/,
      /\.log$/i,                                              // server.log, server_err.log, ...
      /\/(verify[\w.-]*|final_check|test[\w.-]*|debug[\w.-]*)\.js$/i,
    ];
    app.use((req, res, next) => {
      const p = req.path;
      if (BLOCKED_INTERNAL.some((re) => re.test(p))) {
        return res.status(404).json({ success: false, error: "Not found" });
      }
      next();
    });
    
    // Middleware
    /* CORS.
     * Morine is single-origin: this one Express process serves the frontend AND
     * the API from the same host, so the browser makes same-origin requests and
     * never performs a CORS check. Emitting CORS headers in that normal case
     * would be dead weight, and defaulting the allowed origin to
     * http://localhost:3000 would be actively wrong in production (it would
     * advertise localhost as a trusted origin whenever FRONTEND_URL is unset).
     *
     * So: CORS is mounted ONLY when FRONTEND_URL is explicitly set. That keeps
     * the normal Render deployment same-origin with no CORS surface at all,
     * while still allowing a deliberate extra origin to be allow-listed.
     */
    const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();
    if (FRONTEND_URL) {
      console.log("[Morine] Step 10b: FRONTEND_URL set, enabling CORS for", FRONTEND_URL);
      app.use(cors({
        origin: FRONTEND_URL,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      }));
    } else {
      console.log("[Morine] Step 10b: FRONTEND_URL not set, serving same-origin only (no CORS)");
    }
    
    app.use(express.json());
    app.use(cookieParser());
    
    // API routes
    console.log("[Morine] Step 11: Loading routes...");
    const jobRoutes = require("./routes/jobRoutes");
    console.log("[Morine] Step 11a: jobRoutes loaded");
    const authRoutes = require("./routes/authRoutes");
    console.log("[Morine] Step 11b: authRoutes loaded");
    const profileRoutes = require("./routes/profileRoutes");
    console.log("[Morine] Step 11c: profileRoutes loaded");
    const cvRoutes = require("./routes/cvRoutes");
    console.log("[Morine] Step 11d: cvRoutes loaded");
    const skillGapRoutes = require("./routes/skillGapRoutes");
    console.log("[Morine] Step 11e: skillGapRoutes loaded");
    const jobMatchRoutes = require("./routes/jobMatchRoutes");
    console.log("[Morine] Step 11e: jobMatchRoutes loaded");
    const careerPathRoutes = require("./routes/careerPathRoutes");
    console.log("[Morine] Step 11f: careerPathRoutes loaded");
    const interviewRoutes = require("./routes/interviewRoutes");
    console.log("[Morine] Step 11g: interviewRoutes loaded");
    const aiRoutes = require("./routes/aiRoutes");
    console.log("[Morine] Step 11h: aiRoutes loaded");
    
    app.use("/api/auth", authRoutes);
    app.use("/api/profile", profileRoutes);
    app.use("/api/cv", cvRoutes);
    app.use("/api/skill-gap", skillGapRoutes);
    app.use("/api/job-match", jobMatchRoutes);
    app.use("/api/career-path", careerPathRoutes);
    app.use("/api/interview-prep", interviewRoutes);
    app.use("/api/ai", aiRoutes);
    app.use("/api", jobRoutes);
    console.log("[Morine] Step 12: All routes mounted");
    
    // Serve the frontend static files
    console.log("[Morine] Step 13: Configuring static files...");
    app.use(express.static(ROOT, { dotfiles: "deny", index: false }));
    console.log("[Morine] Step 14: Static files configured");
    
    // Fallback to index.html for SPA-style navigation
    app.get("/", (req, res) => {
      res.sendFile(path.join(ROOT, "index.html"));
    });
    console.log("[Morine] Step 15: SPA fallback configured");
    
    // Application shell route
    app.get("/app", (req, res) => {
      res.sendFile(path.join(ROOT, "app.html"));
    });
    console.log("[Morine] Step 16: App shell route configured");

    // Informational legal pages (content derived from actual app behaviour only)
    app.get("/privacy", (req, res) => {
      res.sendFile(path.join(ROOT, "privacy.html"));
    });
    app.get("/terms", (req, res) => {
      res.sendFile(path.join(ROOT, "terms.html"));
    });
    console.log("[Morine] Step 16b: Privacy/Terms routes configured");
    
    // 404 handler for unknown API routes
    app.use("/api/*", (req, res) => {
      res.status(404).json({
        success: false,
        error: "We couldn't find that. Please go back and try again.",
      });
    });
    console.log("[Morine] Step 17: API 404 handler configured");
    
    // Global error handler. The technical detail stays in the server log for
    // developers; the browser only ever receives friendly wording.
    app.use((err, req, res, next) => {
      console.error("[Morine] Unhandled error:", err.message);
      const friendly = err.statusCode && err.statusCode < 500 && err.message
        ? err.message
        : "Something went wrong. Please try again.";
      res.status(err.statusCode || 500).json({
        success: false,
        error: friendly,
      });
    });
    console.log("[Morine] Step 18: Error handler configured");
    
    // 404 for non-API routes
    app.use((req, res) => {
      res.status(404).json({ success: false, error: "We couldn't find that. Please go back and try again." });
    });
    console.log("[Morine] Step 19: All handlers configured");
    
    console.log("[Morine] Step 20: Starting app.listen...");
    const server = app.listen(PORT, () => {
      console.log("[Morine] Step 21: Server callback fired - listening on port", PORT);
      console.log("[Morine] Server listening on port", PORT);
      console.log("[Morine] API endpoints:");
      console.log("  POST /api/auth/signup - Register new user");
      console.log("  POST /api/auth/login - Sign in");
      console.log("  POST /api/auth/logout - Sign out");
      console.log("  GET  /api/auth/me - Current user");
      console.log("  GET  /api/profile - Get career profile");
      console.log("  PUT  /api/profile - Update career profile");
      console.log("  DELETE /api/profile/fields/:field - Remove one profile field");
      console.log("  DELETE /api/profile/skills/:skill - Remove one skill from the profile");
      console.log("  POST /api/cv/upload - Upload CV (auth, PDF/DOCX 5MB)");
      console.log("  GET  /api/cv - List my CVs");
      console.log("  GET  /api/cv/:id - Get CV");
      console.log("  POST /api/cv/:id/analyze - Analyze CV (uses configured AI provider)");
      console.log("  POST /api/cv/:id/optimize - Generate optimized CV");
      console.log("  POST /api/skill-gap/analyze - Skill-gap analysis");
      console.log("  GET  /api/skill-gap - List skill-gap analyses");
      console.log("  GET  /api/skill-gap/:id - Get analysis");
      console.log("  DELETE /api/skill-gap/:id - Delete analysis");
      console.log("  POST /api/job-match/analyze - AI job matching");
      console.log("  GET  /api/job-match - List matches");
      console.log("  GET  /api/job-match/:id - Get match");
      console.log("  DELETE /api/job-match/:id - Delete match");
      console.log("  POST /api/career-path/analyze - Career path");
      console.log("  GET  /api/career-path - List career paths");
      console.log("  GET  /api/career-path/:id - Get career path");
      console.log("  DELETE /api/career-path/:id - Delete career path");
      console.log("  POST /api/interview-prep/analyze - Interview prep");
      console.log("  GET  /api/interview-prep - List interview prep");
      console.log("  GET  /api/interview-prep/:id - Get interview prep");
      console.log("  DELETE /api/interview-prep/:id - Delete interview prep");
      console.log("  GET  /api/health - Health check");
      console.log("  GET  /api/jobs?keyword=...&location=... - Job search");
      console.log("  POST /api/ai/chat - Career AI chat (auth)");
      console.log("[Morine] Frontend served from root");
      console.log("[Morine] Server startup complete - process should remain alive");
      console.log("[Morine] Step 22: Server startup sequence complete");
    });
    console.log("[Morine] Step 23: app.listen() returned, server object created");
    
    server.on("error", (err) => {
      console.error("[Morine] Server error:", err.message);
      console.error("[Morine] Stack:", err.stack);
      process.exit(1);
    });
    
    server.on("listening", () => {
      console.log("[Morine] Step 24: Server 'listening' event fired");
      console.log("[Morine] Process PID:", process.pid);
    });
    console.log("[Morine] Step 25: Server event listeners attached");

    /* Graceful shutdown. Render (and any orchestrator) sends SIGTERM before it
       recycles an instance. Without this the process is killed mid-request and
       in-flight database work is dropped. Stop accepting new connections, let
       the active ones drain, then close the MongoDB pool cleanly. */
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Morine] ${signal} received. Shutting down gracefully...`);

      // Force-exit if a hung connection prevents the drain from finishing.
      const forceExit = setTimeout(() => {
        console.error("[Morine] Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
      }, 10000);
      if (forceExit.unref) forceExit.unref();

      server.close(async () => {
        console.log("[Morine] HTTP server closed. Closing database connection...");
        await disconnectDB();
        clearTimeout(forceExit);
        console.log("[Morine] Shutdown complete.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err) => {
    console.error("[Morine] Failed to start server:", err.message);
    console.error("[Morine] Stack:", err.stack);
    process.exit(1);
  });