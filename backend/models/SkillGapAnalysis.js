const mongoose = require("mongoose");

const skillGapSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetRole: { type: String, required: true, maxlength: 200 },
    sourceCvId: { type: mongoose.Schema.Types.ObjectId, ref: "CV", default: null },
    currentSkills: { type: [String], default: [] },
    requiredSkills: { type: [String], default: [] },
    skillGaps: {
      type: [
        {
          skill: { type: String, required: true },
          priority: { type: String, enum: ["High", "Medium", "Low"], default: "Medium" },
          reason: { type: String, default: "" },
          recommendedAction: { type: String, default: "" },
        },
      ],
      default: [],
    },
    strengths: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    roadmap: {
      type: [
        {
          stage: { type: Number, required: true },
          title: { type: String, required: true },
          skills: { type: [String], default: [] },
          actions: { type: [String], default: [] },
          projectIdea: { type: String, default: "" },
        },
      ],
      default: [],
    },
    overallReadiness: { type: Number, min: 0, max: 100, default: 0 },
    summary: { type: String, default: "" },
  },
  { timestamps: true }
);

skillGapSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("SkillGapAnalysis", skillGapSchema);
