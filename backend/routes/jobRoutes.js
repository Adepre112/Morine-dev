const express = require("express");
const jobController = require("../controllers/jobController");

const router = express.Router();

// Health check
router.get("/health", (req, res) => jobController.healthCheck(req, res));

// Job search
router.get("/jobs", (req, res) => jobController.searchJobs(req, res));

// Job details (on-demand, costs 1 credit per call)
router.get("/jobs/details", (req, res) => jobController.getJobDetails(req, res));

module.exports = router;
