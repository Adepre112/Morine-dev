const CareerProfile = require("../models/CareerProfile");

// Fields a user is allowed to clear individually. Anything outside this list is
// rejected rather than passed through to Mongo.
const REMOVABLE_FIELDS = [
  "education",
  "skills",
  "experience",
  "projects",
  "goals",
  "targetRole",
  "location",
  "salaryExpectation",
];

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

  /**
   * DELETE /api/profile/fields/:field
   *
   * Clears one piece of profile information. The document is always looked up
   * by the authenticated user's id, so a user can only ever edit their own
   * profile and cannot clear another account's data. Every other field is left
   * exactly as it was.
   */
  async deleteField(req, res) {
    try {
      const field = String(req.params.field || "").trim();
      if (!REMOVABLE_FIELDS.includes(field)) {
        return res.status(400).json({
          success: false,
          error: "That part of your profile can't be removed.",
        });
      }

      const empty = field === "skills" ? [] : "";
      const profile = await CareerProfile.findOneAndUpdate(
        { userId: req.user._id },
        { $set: { [field]: empty } },
        { new: true, runValidators: true }
      );

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "We couldn't find your profile. Please try again.",
        });
      }

      return res.json({ success: true, data: { profile } });
    } catch (error) {
      console.error("[Profile] Delete field error:", error.message);
      return res.status(500).json({
        success: false,
        error: "Unable to remove that information. Please try again.",
      });
    }
  }

  /**
   * DELETE /api/profile/skills/:skill
   *
   * Removes a single skill without touching the rest of the profile. Matched
   * case-insensitively against the authenticated user's own skill list.
   */
  async removeSkill(req, res) {
    try {
      const skill = String(req.params.skill || "").trim();
      if (!skill) {
        return res.status(400).json({
          success: false,
          error: "Please enter a skill name.",
        });
      }
      if (skill.length > 100) {
        return res.status(400).json({
          success: false,
          error: "That skill name is too long. Please shorten it.",
        });
      }

      const profile = await CareerProfile.findOne({ userId: req.user._id });
      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "We couldn't find your profile. Please try again.",
        });
      }

      const wanted = skill.toLowerCase();
      const before = profile.skills.length;
      profile.skills = profile.skills.filter(
        (s) => String(s).trim().toLowerCase() !== wanted
      );
      if (profile.skills.length === before) {
        return res.status(404).json({
          success: false,
          error: "That skill isn't in your profile.",
        });
      }

      await profile.save();
      return res.json({ success: true, data: { profile } });
    } catch (error) {
      console.error("[Profile] Remove skill error:", error.message);
      return res.status(500).json({
        success: false,
        error: "Unable to remove that skill. Please try again.",
      });
    }
  }
}

module.exports = new ProfileController();
