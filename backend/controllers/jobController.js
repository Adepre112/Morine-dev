const jobService = require("../services/jobService");

class JobController {
  /**
   * GET /api/jobs
   * Query params: keyword, location, page, limit
   * Cost: 2 credits (search) or 1 credit (list) per call
   */
  async searchJobs(req, res) {
    try {
      const { keyword, location, page, limit } = req.query;

      const params = {
        keyword: typeof keyword === "string" ? keyword.trim() : "",
        location: typeof location === "string" ? location.trim() : "",
        page: Math.max(1, parseInt(page, 10) || 1),
        limit: Math.min(50, Math.max(1, parseInt(limit, 10) || 20)),
      };

      const result = params.keyword
        ? await jobService.searchJobs(params)
        : await jobService.listJobs(params);

      return res.json({
        success: true,
        data: result.jobs,
        pagination: {
          page: result.page,
          resultsPerPage: result.resultsPerPage,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
        },
      });
    } catch (error) {
      console.error("[JobController] searchJobs error:", error.message);

      if (error.message === "PARSE_API_KEY must be set in environment variables") {
        return res.status(500).json({
          success: false,
          error: "Job search service is not configured. Please try again later.",
        });
      }
      if (error.message.startsWith("RATE_LIMITED")) {
        const retryAfter = error.message.split(":")[1] || "60";
        return res.status(429).json({
          success: false,
          error: `Too many requests. Please try again in ${retryAfter} seconds.`,
        });
      }
      if (error.message === "AUTH_ERROR") {
        return res.status(502).json({
          success: false,
          error: "Unable to authenticate with the job service. Please try again later.",
        });
      }
      if (error.message === "TIMEOUT") {
        return res.status(504).json({
          success: false,
          error: "The job service took too long to respond. Please try again.",
        });
      }
      if (error.message.startsWith("PARSE_API_ERROR")) {
        return res.status(502).json({
          success: false,
          error: "Unable to fetch jobs from the job board. Please try again.",
        });
      }

      return res.status(500).json({
        success: false,
        error: "An unexpected error occurred. Please try again later.",
      });
    }
  }

  /**
   * GET /api/jobs/details?url=...
   * Fetch full job details on-demand.
   * Cost: 1 credit/call.
   */
  async getJobDetails(req, res) {
    try {
      const { url } = req.query;

      if (!url || typeof url !== "string") {
        return res.status(400).json({
          success: false,
          error: "A job URL is required.",
        });
      }

      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({
          success: false,
          error: "Invalid job URL.",
        });
      }

      const details = await jobService.getJobDetails(url);

      if (!details) {
        return res.status(404).json({
          success: false,
          error: "Job details not found.",
        });
      }

      return res.json({
        success: true,
        data: details,
      });
    } catch (error) {
      console.error("[JobController] getJobDetails error:", error.message);

      if (error.message.startsWith("RATE_LIMITED")) {
        const retryAfter = error.message.split(":")[1] || "60";
        return res.status(429).json({
          success: false,
          error: `Too many requests. Please try again in ${retryAfter} seconds.`,
        });
      }

      return res.status(500).json({
        success: false,
        error: "Unable to fetch job details. Please try again.",
      });
    }
  }

  /**
   * GET /api/health
   */
  healthCheck(req, res) {
    return res.json({
      status: "ok",
      service: "morine-backend",
      timestamp: new Date().toISOString(),
      apiConfigured: jobService.hasCredentials(),
    });
  }
}

module.exports = new JobController();
