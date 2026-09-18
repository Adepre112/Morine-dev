const express = require("express");
const authController = require("../controllers/authController");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.post("/signup", (req, res) => authController.signup(req, res));
router.post("/login", (req, res) => authController.login(req, res));
router.post("/refresh", (req, res) => authController.refresh(req, res));
router.post("/logout", (req, res) => authController.logout(req, res));
router.get("/me", authMiddleware, (req, res) => authController.me(req, res));

module.exports = router;
