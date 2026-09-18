const mongoose = require("mongoose");
const SkillGapAnalysis = require("../models/SkillGapAnalysis");
const CareerProfile = require("../models/CareerProfile");
const CV = require("../models/CV");
const { analyzeSkillGap } = require("../services/aiService");

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function analyze(req, res) {
  try {
    const userId = req.user._id;
    const profile = await CareerProfile.findOne({ userId }).lean();
    let targetRole = (req.body.targetRole || "").toString().trim();
    if (!targetRole) targetRole = (profile?.targetRole || "").toString().trim();
    if (!targetRole) {
      return res.status(400).json({ success: false, error: "Please add a target role to your Career Profile or provide targetRole in the request." });
    }
    if (targetRole.length > 200) targetRole = targetRole.slice(0, 200);

    let cv = null;
    let sourceCvId = null;
    const cvId = (req.body.cvId || "").toString().trim();
    if (cvId) {
      if (!isValidObjectId(cvId)) return res.status(404).json({ success: false, error: "CV not found." });
      cv = await CV.findOne({ _id: cvId, userId });
      if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
      sourceCvId = cv._id;
    }

    // Build AI input from strongest available info
    const cvText = cv ? (cv.extractedText || "") : "";
    const cvAnalysis = cv ? cv.analysis : null;

    const input = {
      targetRole,
      profile: profile || null,
      cvText,
      cvAnalysis,
    };

    const result = await analyzeSkillGap(input);

    // Ensure targetRole from request/profile is preserved if AI deviates
    result.targetRole = targetRole;

    const doc = await SkillGapAnalysis.create({
      userId,
      targetRole,
      sourceCvId,
      currentSkills: result.currentSkills,
      requiredSkills: result.requiredSkills,
      skillGaps: result.skillGaps,
      strengths: result.strengths,
      recommendations: result.skillGaps.map((g) => g.recommendedAction).filter(Boolean),
      roadmap: result.roadmap,
      overallReadiness: result.overallReadiness,
      summary: result.summary,
    });

    return res.status(201).json({ success: true, data: { analysis: doc, raw: result } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "Skill-gap analysis failed.", code: e.code || undefined });
  }
}

async function list(req, res) {
  const analyses = await SkillGapAnalysis.find({ userId: req.user._id }).sort({ createdAt: -1 });
  return res.json({ success: true, data: { analyses } });
}

async function getOne(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Analysis not found." });
    const doc = await SkillGapAnalysis.findOne({ _id: req.params.id, userId: req.user._id });
    if (!doc) return res.status(404).json({ success: false, error: "Analysis not found." });
    return res.json({ success: true, data: { analysis: doc } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "Analysis not found." });
  }
}

async function remove(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Analysis not found." });
    const doc = await SkillGapAnalysis.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!doc) return res.status(404).json({ success: false, error: "Analysis not found." });
    return res.json({ success: true, data: { message: "Analysis deleted." } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "Analysis not found." });
  }
}

module.exports = { analyze, list, getOne, remove };
