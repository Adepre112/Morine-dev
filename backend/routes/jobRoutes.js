const express = require("express");
const jobController = require("../controllers/jobController");

const router = express.Router();

// Health check (no provider call, no quota)
router.get("/health", (req, res) => jobController.healthCheck(req, res));

// Job search — Job Listings API, Nigeria only
router.get("/jobs", (req, res) => jobController.searchJobs(req, res));

module.exports = router;
