const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../middleware/auth");
const cvController = require("../controllers/cvController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];
    // Also check extension as fallback
    const ext = (file.originalname.split(".").pop() || "").toLowerCase();
    if (allowed.includes(file.mimetype) || ["pdf", "docx"].includes(ext)) cb(null, true);
    else cb(new Error("Only PDF and DOCX files are allowed."), false);
  },
});

function handleMulterError(err, req, res, next) {
  if (err) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "File too large. Maximum 5MB allowed." });
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
}

router.use(authMiddleware);

router.post("/upload", upload.single("cv"), handleMulterError, (req, res) => cvController.upload(req, res));
router.get("/", (req, res) => cvController.list(req, res));
router.get("/:id", (req, res) => cvController.getOne(req, res));
router.post("/:id/analyze", (req, res) => cvController.analyze(req, res));
router.post("/:id/optimize", (req, res) => cvController.optimize(req, res));
router.delete("/:id", (req, res) => cvController.remove(req, res));

module.exports = router;
