const mongoose = require("mongoose");

const jobMatchSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    jobId: { type: String, default: "" },
    jobTitle: { type: String, required: true },
    company: { type: String, default: "" },
    location: { type: String, default: "" },
    matchScore: { type: Number, min: 0, max: 100, required: true },
    matchingSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    profileAlignment: {
      targetRole: { type: String, default: "" },
      experienceAlignment: { type: String, default: "" },
      educationAlignment: { type: String, default: "" },
      locationAlignment: { type: String, default: "" },
    },
    reasons: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    summary: { type: String, default: "" },
    source: { type: String, default: "HotNigerianJobs" },
  },
  { timestamps: true }
);

jobMatchSchema.index({ userId: 1, createdAt: -1 });
jobMatchSchema.index({ userId: 1, jobId: 1 });

module.exports = mongoose.model("JobMatch", jobMatchSchema);
