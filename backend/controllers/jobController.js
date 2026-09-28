const jobService = require("../services/jobService");
const { JobListingError } = require("../services/jobService");

/**
 * Maps a documented Job Listings API error `code` to an HTTP status and a
 * user-safe message. Branch on `code` only — never on the English `detail`.
 */
const ERROR_MAP = {
  missing_api_key: { status: 500, message: "Job search is not configured on the server. Please try again later." },
  invalid_api_key: { status: 502, message: "The job service rejected our API key. Please try again later." },
  account_suspended: { status: 502, message: "The job service account is unavailable. Please try again later." },
  plan_filter_forbidden: { status: 403, message: "This search filter is not available on the current plan." },
  unknown_role_category: { status: 400, message: "That career field is not recognised. Please choose another." },
  rate_limited: { status: 429, message: "Live job search has reached its request limit. Please try again shortly." },
  not_found: { status: 404, message: "No jobs were found for that search." },
  validation_error: { status: 400, message: "That search request was not valid. Please adjust your filters." },
  upstream_timeout: { status: 504, message: "The job service took too long to respond. Please try again." },
  upstream_unreachable: { status: 502, message: "Unable to reach the job service right now. Please try again." },
  upstream_error: { status: 502, message: "Unable to fetch jobs from the job service. Please try again." },
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
      const message = mapped ? mapped.message : "An unexpected error occurred. Please try again later.";

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
