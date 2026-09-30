const mongoose = require("mongoose");
const CV = require("../models/CV");
const CareerProfile = require("../models/CareerProfile");
const { parseCV, detectFileType } = require("../services/cvParser");
const { analyzeCV, optimizeCV } = require("../services/aiService");

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function upload(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Please choose a CV file first." });

    const originalFilename = req.file.originalname;
    /* Identify the file from its own bytes, never from the browser-reported
     * Content-Type. Android Chrome, iOS Safari and most cloud-download
     * sources send "application/octet-stream" (or an empty value) for a plain
     * PDF, so trusting the MIME header made valid PDFs fail on any device
     * other than a developer's laptop. detectFileType() throws a 400 with a
     * clear message for anything that is not really a PDF or DOCX, so a file
     * renamed from .png/.txt cannot slip through on its name alone. */
    const fileType = detectFileType(req.file.buffer, originalFilename, req.file.mimetype);
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
    return res.status(e.statusCode || 500).json({ success: false, error: e.message || "We couldn't upload your CV. Please try again." });
  }
}

async function list(req, res) {
  const cvs = await CV.find({ userId: req.user._id }).sort({ createdAt: -1 }).select("-extractedText -optimizedContent");
  // Also return text length info without full text
  return res.json({ success: true, data: { cvs } });
}

async function getOne(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    return res.json({ success: true, data: { cv } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
  }
}

async function analyze(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    if (!cv.extractedText) return res.status(422).json({ success: false, error: "We couldn't find any text in this CV. Please upload a different file." });

    const jobDescription = (req.body.jobDescription || "").toString().slice(0, 10000);
    const profile = await CareerProfile.findOne({ userId: req.user._id }).lean();

    const analysis = await analyzeCV(cv.extractedText, jobDescription, profile);
    cv.analysis = analysis;
    cv.jobDescription = jobDescription;
    await cv.save();

    return res.json({ success: true, data: { analysis } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "We couldn't analyze your CV. Please try again.", code: e.code || undefined });
  }
}

async function optimize(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    if (!cv.analysis) return res.status(400).json({ success: false, error: "Please analyze your CV first, then improve it." });

    const optimizedContent = await optimizeCV(cv.extractedText, cv.analysis, cv.jobDescription || "");
    cv.optimizedContent = optimizedContent;
    await cv.save();

    return res.json({ success: true, data: { optimizedContent } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "We couldn't improve your CV. Please try again.", code: e.code || undefined });
  }
}

async function remove(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    const cv = await CV.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    return res.json({ success: true, data: { message: "CV deleted." } });
  } catch (e) {
    return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
  }
}

async function update(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });
    const cv = await CV.findOne({ _id: req.params.id, userId: req.user._id });
    if (!cv) return res.status(404).json({ success: false, error: "We couldn't find that CV. Please refresh the page and try again." });

    const { jobDescription } = req.body;
    if (jobDescription !== undefined) {
      cv.jobDescription = String(jobDescription).slice(0, 10000);
      await cv.save();
    }

    return res.json({ success: true, data: { cv } });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ success: false, error: e.message || "We couldn't save your changes. Please try again.", code: e.code || undefined });
  }
}

module.exports = { upload, list, getOne, analyze, optimize, remove, update };
