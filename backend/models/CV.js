const mongoose = require("mongoose");

const cvSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    originalFilename: { type: String, required: true },
    fileType: { type: String, required: true, enum: ["pdf", "docx"] },
    fileSize: { type: Number, required: true },
    extractedText: { type: String, default: "" },
    analysis: { type: mongoose.Schema.Types.Mixed, default: null },
    jobDescription: { type: String, default: "" },
    optimizedContent: { type: String, default: "" },
  },
  { timestamps: true }
);

cvSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("CV", cvSchema);
