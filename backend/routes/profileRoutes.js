const express = require("express");
const profileController = require("../controllers/profileController");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, (req, res) => profileController.getProfile(req, res));
router.put("/", authMiddleware, (req, res) => profileController.updateProfile(req, res));
// Remove a single piece of profile information, or a single skill. Both are
// scoped to the signed-in user by the controller and never accept a user id
// from the client.
router.delete("/fields/:field", authMiddleware, (req, res) => profileController.deleteField(req, res));
router.delete("/skills/:skill", authMiddleware, (req, res) => profileController.removeSkill(req, res));

module.exports = router;
