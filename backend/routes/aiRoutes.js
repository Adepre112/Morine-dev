const express = require("express");
const { authMiddleware } = require("../middleware/auth");
const controller = require("../controllers/aiController");

const router = express.Router();

router.use(authMiddleware);

router.post("/chat", (req, res) => controller.chat(req, res));
router.post("/career-profile", (req, res) => controller.careerProfile(req, res));

module.exports = router;