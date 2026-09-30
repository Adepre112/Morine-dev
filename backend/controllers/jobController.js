const jobService = require("../services/jobService");
const { JobListingError } = require("../services/jobService");

/**
 * Maps a documented Job Listings API error `code` to an HTTP status and a
 * user-safe message. Branch on `code` only — never on the English `detail`.
 */
const ERROR_MAP = {
  missing_api_key: { status: 500, message: "Job search isn't available right now. Please try again later." },
  invalid_api_key: { status: 502, message: "Job search isn't available right now. Please try again later." },
  account_suspended: { status: 502, message: "Job search isn't available right now. Please try again later." },
  plan_filter_forbidden: { status: 403, message: "This search filter isn't available yet. Please choose a different one." },
  unknown_role_category: { status: 400, message: "That career field isn't recognised. Please choose another." },
  rate_limited: { status: 429, message: "You're searching a little too often. Please wait a moment and try again." },
  not_found: { status: 404, message: "No jobs were found for that search." },
  validation_error: { status: 400, message: "That search wasn't valid. Please adjust your filters." },
  upstream_timeout: { status: 504, message: "This is taking longer than expected. Please try again." },
  upstream_unreachable: { status: 502, message: "We couldn't load job opportunities. Please check your internet connection and try again." },
  upstream_error: { status: 502, message: "We couldn't load job opportunities. Please try again." },
};

class JobController {
  /**
   * GET /api/jobs?keyword=&location=&page=&limit=
   * Always Nigeria-only (country=NG is applied in the service).
   * Response contract: { success, data, pagination }
   */
  async searchJobs(req, res) {
    try {
      const { keyword, location, page, limit, remote } = req.query;

      const params = {
        keyword: typeof keyword === "string" ? keyword.trim() : "",
        location: typeof location === "string" ? location.trim() : "",
        page: Math.max(1, parseInt(page, 10) || 1),
        limit: Math.min(50, Math.max(1, parseInt(limit, 10) || 10)),
        remoteOnly: remote === "true" || remote === "1",
      };

      const result = await jobService.searchJobs(params);

      const remaining = result.rateLimit && result.rateLimit.remaining;
      if (remaining !== undefined && remaining !== null) {
        res.set("X-Job-RateLimit-Remaining", String(remaining));
      }

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
      const mapped =
        error instanceof JobListingError
          ? ERROR_MAP[error.code]
          : null;

      const status = mapped ? mapped.status : 500;
      const message = mapped ? mapped.message : "Something went wrong. Please try again.";

      // Log the stable code only — never the API key or upstream detail text.
      console.error(`[JobController] searchJobs failed code=${error.code || "unknown"} status=${status}`);

      if (error.code === "rate_limited") {
        const retryAfter = error.retryAfter || 60;
        res.set("Retry-After", String(retryAfter));
      }

      return res.status(status).json({ success: false, error: message, code: error.code || "unknown" });
    }
  }

  /**
   * Reports whether the Job Listings API key is present.
   * Does NOT call the provider, so it costs no quota.
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
