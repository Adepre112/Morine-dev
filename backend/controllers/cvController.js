const mongoose = require("mongoose");
const CV = require("../models/CV");
const CareerProfile = require("../models/CareerProfile");
const { parseCV } = require("../services/cvParser");
const { analyzeCV, optimizeCV } = require("../services/aiService");

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function upload(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded. Please select a PDF or DOCX." });

    const originalFilename = req.file.originalname;
    const fileType = req.file.mimetype.includes("pdf") ? "pdf" : "docx";
    const extractedText = await parseCV(req.file.buffer, fileType, originalFilename);

    const cv = await CV.create({
      userId: req.user._id,
      originalFilename,
      fileType,
      fileSize: req.file.size,
      extractedText,
    });

    return res.status(201).json({ success: true, data: { cv } });
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, error: e.message || "Upload failed." });
  }
}

async function list(req, res) {
  const cvs = await CV.find({ userId: req.user._id }).sort({ createdAt: -1 }).select("-extractedText -optimizedContent");
  // Also return text length info without full text
  return res.json({ success: true, data: { cvs } });
}

async function getOne(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "CV not found." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
    return res.json({ success: true, data: { cv } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "CV not found." });
  }
}

async function analyze(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "CV not found." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
    if (!cv.extractedText) return res.status(422).json({ success: false, error: "CV has no extractable text to analyze." });

    const jobDescription = (req.body.jobDescription || "").toString().slice(0, 10000);
    const profile = await CareerProfile.findOne({ userId: req.user._id }).lean();

    const analysis = await analyzeCV(cv.extractedText, jobDescription, profile);
    cv.analysis = analysis;
    cv.jobDescription = jobDescription;
    await cv.save();

    return res.json({ success: true, data: { analysis } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "Analysis failed.", code: e.code || undefined });
  }
}

async function optimize(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "CV not found." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
    if (!cv.analysis) return res.status(400).json({ success: false, error: "Please analyze the CV before optimizing." });

    const optimizedContent = await optimizeCV(cv.extractedText, cv.analysis, cv.jobDescription || "");
    cv.optimizedContent = optimizedContent;
    await cv.save();

    return res.json({ success: true, data: { optimizedContent } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "Optimization failed.", code: e.code || undefined });
  }
}

async function remove(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "CV not found." });
    const cv = await CV.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "CV not found." });
    return res.json({ success: true, data: { message: "CV deleted." } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "CV not found." });
  }
}

module.exports = { upload, list, getOne, analyze, optimize, remove };
