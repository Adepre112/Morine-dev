const mongoose = require("mongoose");

const careerPathSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetRole: { type: String, required: true, maxlength: 200 },
    startingPoint: { type: String, default: "" },
    destinationRole: { type: String, default: "" },
    currentSkills: { type: [String], default: [] },
    readiness: { type: Number, min: 0, max: 100, default: 0 },
    summary: { type: String, default: "" },
    stages: [
      {
        stage: { type: Number, required: true },
        title: { type: String, required: true },
        objective: { type: String, default: "" },
        skills: { type: [String], default: [] },
        actions: { type: [String], default: [] },
        projectIdeas: { type: [String], default: [] },
        experienceIdeas: { type: [String], default: [] },
        estimatedDuration: { type: String, default: "" },
        milestone: { type: String, default: "" },
      },
    ],
    milestones: [
      {
        title: { type: String, required: true },
        description: { type: String, default: "" },
        skills: { type: [String], default: [] },
        completionCriteria: { type: String, default: "" },
      },
    ],
    alternativeRoles: [
      {
        title: { type: String, required: true },
        reason: { type: String, default: "" },
      },
    ],
    nextSteps: { type: [String], default: [] },
  },
  { timestamps: true }
);

careerPathSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("CareerPath", careerPathSchema);
