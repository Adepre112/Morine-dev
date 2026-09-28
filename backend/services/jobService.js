const config = require("../config");

/**
 * JobService — Job Listings API integration
 *
 * Docs: https://www.joblistingsapi.com/docs
 *   Base URL : https://api.joblistingsapi.com/v1
 *   Endpoint : GET /jobs
 *   Auth     : X-API-Key: process.env.JOB_LISTING_API_KEY
 *   List     : { success: true, jobs: [...], total: number }
 *   Errors   : { detail: string|array, code: string }
 *
 * Morine is Nigeria-only: country=NG is always sent, and any record that
 * explicitly reports a different country is discarded before it is returned.
 *
 * Plan notes (Free tier): description_html is Starter+, and role_category /
 * salary_min / salary_max / cursor are Growth+. Those are therefore never sent
 * as request parameters, so the Free plan cannot return 403 plan_filter_forbidden.
 */
class JobListingError extends Error {
  constructor(code, detail, status, retryAfter) {
    super(detail || code);
    this.name = "JobListingError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

class JobService {
  constructor() {
    const jl = config.jobListings;
    this.baseUrl = jl.baseUrl;
    this.apiKey = jl.apiKey;
    this.countryCode = jl.countryCode;
    this.defaultPerPage = jl.defaultPerPage;
    this.maxPerPage = jl.maxPerPage;
    this.cacheTTL = jl.cacheTTL;
    this.requestTimeoutMs = jl.requestTimeoutMs;
    this.cache = new Map();
    // Local circuit breaker so a rate-limited window is never re-attempted.
    this.rateLimitedUntil = 0;
  }

  hasCredentials() {
    const k = this.apiKey;
    if (!k) return false;
    const v = String(k).trim();
    if (!v) return false;
    // Reject documented placeholders without ever logging the value.
    return !/^YOUR_/i.test(v) && !/your_key_here/i.test(v);
  }

  getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  setCache(key, data) {
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { data, ts: Date.now() });
  }

  buildUrl(params) {
    const url = new URL(`${this.baseUrl}/jobs`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
    });
    return url;
  }

  async apiFetch(params) {
    if (!this.hasCredentials()) {
      throw new JobListingError("missing_api_key", "Job Listings API key is not configured on the server.", 500);
    }

    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      const retryAfter = Math.max(1, Math.ceil((this.rateLimitedUntil - now) / 1000));
      throw new JobListingError("rate_limited", "Job service rate limit reached.", 429, retryAfter);
    }

    const url = this.buildUrl(params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response;
    try {
      response = await fetch(url.toString(), {
        headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new JobListingError("upstream_timeout", "The job service took too long to respond.", 504);
      }
      throw new JobListingError("upstream_unreachable", "Could not reach the job service.", 502);
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.ok) {
      return {
        body,
        rateLimit: {
          limit: response.headers.get("X-RateLimit-Limit"),
          remaining: response.headers.get("X-RateLimit-Remaining"),
          reset: response.headers.get("X-RateLimit-Reset"),
        },
      };
    }

    // Documented stable codes: missing_api_key, invalid_api_key,
    // account_suspended, plan_filter_forbidden, unknown_role_category,
    // rate_limited, not_found, validation_error.
    const code = (body && typeof body.code === "string" && body.code) ||
      (response.status === 429 ? "rate_limited" : "upstream_error");

    if (response.status === 429 || code === "rate_limited") {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10) || 60;
      this.rateLimitedUntil = Date.now() + retryAfter * 1000;
      throw new JobListingError("rate_limited", "Job service rate limit reached.", 429, retryAfter);
    }

    // detail is a string on most errors but an array on 422 validation errors.
    const detail = body && typeof body.detail === "string"
      ? body.detail
      : (body && Array.isArray(body.detail) ? body.detail.map((d) => d && (d.msg || d)).filter(Boolean).join("; ") : null);

    throw new JobListingError(code, detail, response.status);
  }

  /** Map a JobV1 record onto Morine's job shape. Never fabricates values. */
  normalizeJob(raw) {
    const r = raw || {};
    const loc = r.location && typeof r.location === "object" ? r.location : {};
    const sal = r.salary && typeof r.salary === "object" ? r.salary : null;

    const locationFallback = [loc.city, loc.region].filter(Boolean).join(", ");

    const description = typeof r.description_html === "string" && r.description_html.trim()
      ? r.description_html
      : null;

    return {
      id: r.id != null ? r.id : null,
      title: r.title || "Untitled role",
      company: r.company || null,
      location: loc.raw || locationFallback || null,
      city: loc.city || null,
      region: loc.region || null,
      countryCode: loc.country_code || null,
      employmentType: r.employment_type || null,
      remotePolicy: r.remote_policy || null,
      remote: r.is_remote === true,
      remoteScope: r.remote_scope || null,
      category: r.role_category || null,
      subcategory: r.role_subcategory || null,
      salary: sal ? (sal.display || null) : null,
      salaryMin: sal && sal.min != null ? sal.min : null,
      salaryMax: sal && sal.max != null ? sal.max : null,
      salaryCurrency: sal ? (sal.currency || null) : null,
      // null on plans without description_html (Free) — never invented.
      description,
      postedDate: r.listed_at || r.created_at || null,
      updatedDate: r.updated_at || null,
      validThrough: r.valid_through || null,
      status: r.status || null,
      // Real application/listing URL. Always populated upstream.
      url: r.url || null,
      source: r.source || null,
    };
  }

  /**
   * GET /api/jobs  →  Job Listings API  GET /jobs
   * Morine params (keyword, location, page, limit) are translated to
   * title, location, offset, limit. country=NG is always included.
   */
  async searchJobs({ keyword = "", location = "", remoteOnly = false, page = 1, limit } = {}) {
    const perPage = Math.min(this.maxPerPage, Math.max(1, parseInt(limit, 10) || this.defaultPerPage));
    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (currentPage - 1) * perPage;

    const params = {
      limit: perPage,
      offset,
      country: this.countryCode,
    };
    if (keyword) params.title = keyword;
    if (location) params.location = location;
    if (remoteOnly) params.remote_only = "true";

    // Cache key must include every dimension that changes the result set.
    const cacheKey = [
      params.title || "",
      params.location || "",
      params.country,
      params.remote_only || "",
      perPage,
      offset,
    ].join("|");

    const cached = this.getCached(cacheKey);
    if (cached) return { ...cached, cached: true };

    const { body, rateLimit } = await this.apiFetch(params);

    const rawJobs = Array.isArray(body && body.jobs) ? body.jobs : [];
    const total = Number.isFinite(body && body.total) ? Number(body.total) : rawJobs.length;

    const jobs = rawJobs
      .map((j) => this.normalizeJob(j))
      // Defence in depth for the Nigeria-only requirement: never surface a job
      // that explicitly reports another country. Records without a country code
      // are kept (we already asked for country=NG) rather than guessed at.
      .filter((j) => !j.countryCode || j.countryCode === this.countryCode)
      // Delisted postings still return 200 with status "removed".
      .filter((j) => j.status !== "removed");

    const result = {
      jobs,
      totalCount: total,
      page: currentPage,
      resultsPerPage: perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };

    this.setCache(cacheKey, result);
    return { ...result, cached: false, rateLimit };
  }
}

module.exports = new JobService();
module.exports.JobListingError = JobListingError;
