const express = require("express");
const profileController = require("../controllers/profileController");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, (req, res) => profileController.getProfile(req, res));
router.put("/", authMiddleware, (req, res) => profileController.updateProfile(req, res));

module.exports = router;
