const mongoose = require("mongoose");

const careerProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    education: {
      type: String,
      default: "",
      maxlength: [2000, "Education cannot exceed 2000 characters."],
    },
    skills: {
      type: [String],
      default: [],
    },
    experience: {
      type: String,
      default: "",
      maxlength: [5000, "Experience cannot exceed 5000 characters."],
    },
    projects: {
      type: String,
      default: "",
      maxlength: [5000, "Projects cannot exceed 5000 characters."],
    },
    goals: {
      type: String,
      default: "",
      maxlength: [2000, "Goals cannot exceed 2000 characters."],
    },
    targetRole: {
      type: String,
      default: "",
      maxlength: [200, "Target role cannot exceed 200 characters."],
    },
    location: {
      type: String,
      default: "",
      maxlength: [200, "Location cannot exceed 200 characters."],
    },
    salaryExpectation: {
      type: String,
      default: "",
      maxlength: [100, "Salary expectation cannot exceed 100 characters."],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CareerProfile", careerProfileSchema);
