const CareerProfile = require("../models/CareerProfile");

class ProfileController {
  /**
   * GET /api/profile
   */
  async getProfile(req, res) {
    try {
      let profile = await CareerProfile.findOne({ userId: req.user._id });

      if (!profile) {
        profile = await CareerProfile.create({ userId: req.user._id });
      }

      return res.json({
        success: true,
        data: { profile },
      });
    } catch (error) {
      console.error("[Profile] Get error:", error.message);
      return res.status(500).json({
        success: false,
        error: "Unable to load profile. Please try again.",
      });
    }
  }

  /**
   * PUT /api/profile
   */
  async updateProfile(req, res) {
    try {
      const allowedFields = [
        "education",
        "skills",
        "experience",
        "projects",
        "goals",
        "targetRole",
        "location",
        "salaryExpectation",
      ];

      const updates = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (updates.skills && typeof updates.skills === "string") {
        updates.skills = updates.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const profile = await CareerProfile.findOneAndUpdate(
        { userId: req.user._id },
        { $set: updates },
        { new: true, runValidators: true, upsert: true }
      );

      return res.json({
        success: true,
        data: { profile },
      });
    } catch (error) {
      console.error("[Profile] Update error:", error.message);
      if (error.name === "ValidationError") {
        const messages = Object.values(error.errors).map((e) => e.message);
        return res.status(400).json({
          success: false,
          error: messages.join(". "),
        });
      }
      return res.status(500).json({
        success: false,
        error: "Unable to update profile. Please try again.",
      });
    }
  }
}

module.exports = new ProfileController();
