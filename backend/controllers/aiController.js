const CareerProfile = require("../models/CareerProfile");
const CV = require("../models/CV");
const SkillGapAnalysis = require("../models/SkillGapAnalysis");
const CareerPath = require("../models/CareerPath");
const JobMatch = require("../models/JobMatch");
const { chat, generateCareerProfile } = require("../services/aiService");

// POST /api/ai/chat
async function chatHandler(req, res) {
  try {
    let messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    messages = messages
      .map((m) => ({
        role: m && m.role === "assistant" ? "assistant" : "user",
        content: m && m.content ? String(m.content) : "",
      }))
      .filter((m) => m.content.trim());

    const profile = await CareerProfile.findOne({ userId: req.user._id }).lean();
    const result = await chat(messages, profile);

    return res.json({ success: true, data: result });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({
      success: false,
      error: e.message || "Career AI is unavailable right now. Please try again later.",
      code: e.code || undefined,
    });
  }
}

// POST /api/ai/career-profile
// AI interpretation of the user's existing data. Read-only: never writes to CareerProfile.
async function careerProfileHandler(req, res) {
  try {
    const userId = req.user._id;
    const profile = await CareerProfile.findOne({ userId }).lean();
    if (!profile) {
      return res.status(400).json({
        success: false,
        error: "Please add your Profile information first. AI Career Profile only interprets data you have provided.",
      });
    }

    const cv = await CV.findOne({ userId }).sort({ createdAt: -1 });
    const cvText = cv ? cv.extractedText || "" : "";
    const cvAnalysis = cv ? cv.analysis || null : null;
    const cvUpdatedAt = cv ? cv.updatedAt : null;

    let skillGap = await SkillGapAnalysis.findOne({ userId, targetRole: profile.targetRole }).sort({ createdAt: -1 }).lean();
    if (!skillGap) skillGap = await SkillGapAnalysis.findOne({ userId }).sort({ createdAt: -1 }).lean();

    const careerPath = await CareerPath.findOne({ userId }).sort({ createdAt: -1 }).lean();
    const jobMatches = await JobMatch.find({ userId }).sort({ createdAt: -1 }).limit(5).lean();

    const result = await generateCareerProfile({ profile, cvText, cvAnalysis, skillGap, careerPath, jobMatches });

    return res.json({
      success: true,
      data: {
        profile: result,
        sourceUpdatedAt: {
          profile: profile.updatedAt || null,
          cv: cvUpdatedAt,
          skillGap: skillGap ? skillGap.createdAt : null,
          careerPath: careerPath ? careerPath.createdAt : null,
        },
      },
    });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({
      success: false,
      error: e.message || "AI Career Profile is unavailable right now. Please try again later.",
      code: e.code || undefined,
    });
  }
}

module.exports = { chat: chatHandler, careerProfile: careerProfileHandler };