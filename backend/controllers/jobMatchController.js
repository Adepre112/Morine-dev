const mongoose = require("mongoose");
const JobMatch = require("../models/JobMatch");
const CareerProfile = require("../models/CareerProfile");
const CV = require("../models/CV");
const SkillGapAnalysis = require("../models/SkillGapAnalysis");
const { analyzeJobMatch } = require("../services/aiService");

function isValidObjectId(id) { return mongoose.Types.ObjectId.isValid(id); }

async function analyze(req, res) {
  try {
    const userId = req.user._id;
    const job = req.body.job;
    if (!job || typeof job !== "object") return res.status(400).json({ success: false, error: "Job information is required." });
    const title = (job.title || "").toString().trim();
    if (!title) return res.status(400).json({ success: false, error: "Job title is required." });

    const profile = await CareerProfile.findOne({ userId }).lean();
    if (!profile || (!profile.targetRole && !profile.skills?.length && !profile.experience)) {
      // Require at least targetRole or some context
      if (!profile || !profile.targetRole) {
        return res.status(400).json({ success: false, error: "Complete your Career Profile with a target role to get personalized job matches." });
      }
    }

    let cvText = "";
    let cvAnalysis = null;
    if (req.body.cvId) {
      const cvId = req.body.cvId.toString().trim();
      if (!isValidObjectId(cvId)) return res.status(404).json({ success: false, error: "CV not found." });
      const cv = await CV.findOne({ _id: cvId, userId });
      if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
      cvText = cv.extractedText || "";
      cvAnalysis = cv.analysis || null;
    }

    let skillGap = null;
    if (req.body.skillGapId) {
      const sgId = req.body.skillGapId.toString().trim();
      if (!isValidObjectId(sgId)) return res.status(404).json({ success: false, error: "Skill-gap analysis not found." });
      skillGap = await SkillGapAnalysis.findOne({ _id: sgId, userId });
      if (!skillGap) return res.status(404).json({ success: false, error: "Skill-gap analysis not found." });
    } else {
      // Optionally retrieve latest relevant skill-gap for targetRole
      const targetRole = (profile?.targetRole || "").trim();
      if (targetRole) {
        skillGap = await SkillGapAnalysis.findOne({ userId, targetRole }).sort({ createdAt: -1 }).lean();
        if (!skillGap) skillGap = await SkillGapAnalysis.findOne({ userId }).sort({ createdAt: -1 }).lean();
      } else {
        skillGap = await SkillGapAnalysis.findOne({ userId }).sort({ createdAt: -1 }).lean();
      }
    }

    const jobInfo = {
      title: (job.title || "").toString().slice(0, 300),
      company: (job.company || "").toString().slice(0, 200),
      location: (job.location || "").toString().slice(0, 200),
      description: (job.description || "").toString().slice(0, 8000),
      requirements: Array.isArray(job.requirements) ? job.requirements.map(String).slice(0, 20) : [],
      id: (job.id || job._id || "").toString().slice(0, 100),
    };
    if (!jobInfo.description && !jobInfo.requirements.length) {
      // Allow but note unavailable
    }

    const result = await analyzeJobMatch({ profile, cvText, cvAnalysis, skillGap, job: jobInfo });

    const doc = await JobMatch.create({
      userId,
      jobId: jobInfo.id,
      jobTitle: jobInfo.title,
      company: jobInfo.company,
      location: jobInfo.location,
      matchScore: result.matchScore,
      matchingSkills: result.matchingSkills,
      missingSkills: result.missingSkills,
      profileAlignment: result.profileAlignment,
      reasons: result.reasons,
      recommendations: result.recommendations,
      summary: result.summary,
      source: "HotNigerianJobs",
    });

    return res.status(201).json({ success: true, data: { match: doc, analysis: result } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "Job match failed.", code: e.code || undefined });
  }
}

async function list(req, res) {
  const { page = 1, limit = 20, targetRole, minimumScore } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const filter = { userId: req.user._id };
  if (targetRole) filter.jobTitle = { $regex: targetRole, $options: "i" };
  if (minimumScore) filter.matchScore = { $gte: Math.max(0, parseInt(minimumScore, 10) || 0) };
  const total = await JobMatch.countDocuments(filter);
  const matches = await JobMatch.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l);
  return res.json({ success: true, data: { matches, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) || 1 } } });
}

async function getOne(req, res) {
  if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Match not found." });
  const doc = await JobMatch.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) return res.status(404).json({ success: false, error: "Match not found." });
  return res.json({ success: true, data: { match: doc } });
}

async function remove(req, res) {
  if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Match not found." });
  const doc = await JobMatch.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  if (!doc) return res.status(404).json({ success: false, error: "Match not found." });
  return res.json({ success: true, data: { message: "Match deleted." } });
}

module.exports = { analyze, list, getOne, remove };
