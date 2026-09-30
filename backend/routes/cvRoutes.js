const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../middleware/auth");
const cvController = require("../controllers/cvController");

const router = express.Router();

const upload = multer({
  // Files are parsed in memory and only the extracted text is persisted, so
  // nothing is ever written to disk and there is no per-device path handling.
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    /* This filter is only a cheap first pass. It cannot inspect the bytes:
     * multer has not read the stream into a buffer yet at this point. The
     * authoritative content check happens in the controller, which calls
     * detectFileType() on req.file.buffer.
     *
     * The filename and Content-Type are treated as hints because they are
     * client-supplied and are frequently wrong on mobile - Android Chrome and
     * iOS Safari report "application/octet-stream" (or nothing) for ordinary
     * PDFs chosen from the Files or Downloads app. Legacy .doc is not
     * supported and is rejected here immediately with a clear message so it
     * never reaches mammoth's confusing ZIP error. */
    const ext = (file.originalname.split(".").pop() || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();

    if (ext === "doc" || mime === "application/msword") {
      return cb(new Error("This is an older Word document (.doc), which we can't read. Please save it as a DOCX or PDF and upload it again."), false);
    }

    const plausible =
      ext === "pdf" || ext === "docx" ||
      mime.includes("pdf") ||
      mime.includes("wordprocessingml") ||
      mime === "application/octet-stream" ||
      mime === "";

    if (plausible) return cb(null, true);
    return cb(new Error("Please upload your CV as a PDF or DOCX file."), false);
  },
});

function handleMulterError(err, req, res, next) {
  if (err) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "Your CV is too large. Please upload a file smaller than 5MB." });
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
}

router.use(authMiddleware);

router.post("/upload", upload.single("cv"), handleMulterError, (req, res) => cvController.upload(req, res));
router.get("/", (req, res) => cvController.list(req, res));
router.get("/:id", (req, res) => cvController.getOne(req, res));
router.put("/:id", (req, res) => cvController.update(req, res));
router.post("/:id/analyze", (req, res) => cvController.analyze(req, res));
router.post("/:id/optimize", (req, res) => cvController.optimize(req, res));
router.delete("/:id", (req, res) => cvController.remove(req, res));

module.exports = router;
