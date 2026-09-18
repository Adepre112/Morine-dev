const config = require("../config");
const { MOCK_JOBS, searchMockJobs, filterMockJobsByLocation } = require("../data/mockJobs");

/**
 * Parse HotNigerianJobs Service
 *
 * Credit costs:
 * - search_jobs: 2 credits/call (keyword-filtered, returns all matches)
 * - list_jobs: 1 credit/call (paginated, no keyword filter)
 * - get_job_details: 1 credit/call (full job data)
 *
 * Free tier: 200 credits/month, 5 req/min.
 *
 * Mock mode:
 * - When USE_MOCK_DATA=true in .env, serves mock data without API calls
 * - When API key is missing/placeholder, falls back to mock data
 * - When API returns errors (429, 502, etc.), falls back to mock data
 * - Real API integration is preserved and used when available
 */
class JobService {
  constructor() {
    this.baseUrl = config.parse.baseUrl;
    this.apiKey = config.parse.apiKey;
    this.defaultPerPage = config.parse.defaultPerPage;
    this.maxPerPage = config.parse.maxPerPage;
    this.cache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 30 minutes for stubs
    this.detailCacheTTL = 60 * 60 * 1000; // 1 hour for details
    this.rateLimitedUntil = 0;

    // Mock mode: use when API unavailable or explicitly enabled
    this.useMock = process.env.USE_MOCK_DATA === "true" || !this.hasCredentials();
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiKey !== "YOUR_API_KEY_HERE");
  }

  getCached(key, ttl) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > (ttl || this.cacheTTL)) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  setCache(key, data) {
    this.cache.set(key, { data, ts: Date.now() });
  }

  /**
   * Make an authenticated request to the Parse API.
   * Only called when NOT in mock mode.
   */
  async parseFetch(endpoint, params = {}) {
    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      await new Promise((r) => setTimeout(r, this.rateLimitedUntil - now));
    }

    const url = new URL(`${this.baseUrl}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.append(k, String(v));
      }
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url.toString(), {
        headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
        this.rateLimitedUntil = Date.now() + retryAfter * 1000;
        throw new Error(`RATE_LIMITED:${retryAfter}`);
      }
      if (response.status === 401 || response.status === 403) throw new Error("AUTH_ERROR");
      if (!response.ok) throw new Error(`PARSE_API_ERROR:${response.status}`);

      return await response.json();
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") throw new Error("TIMEOUT");
      throw error;
    }
  }

  // ─── MOCK MODE ────────────────────────────────────────────────────

  /**
   * Search mock jobs by keyword and location.
   * No API credits consumed.
   */
  mockSearchJobs({ keyword = "", location = "", page = 1, limit = 20 } = {}) {
    let jobs = keyword ? searchMockJobs(keyword) : [...MOCK_JOBS];

    if (location) {
      jobs = filterMockJobsByLocation(jobs, location);
    }

    const totalCount = jobs.length;
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const start = (page - 1) * limit;
    const pageJobs = jobs.slice(start, start + limit);

    return {
      jobs: pageJobs,
      totalCount,
      page,
      resultsPerPage: limit,
      totalPages,
    };
  }

  /**
   * List mock jobs (browsing, no keyword).
   * No API credits consumed.
   */
  mockListJobs({ location = "", page = 1, limit = 20 } = {}) {
    let jobs = [...MOCK_JOBS];

    if (location) {
      jobs = filterMockJobsByLocation(jobs, location);
    }

    const totalCount = jobs.length;
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const start = (page - 1) * limit;
    const pageJobs = jobs.slice(start, start + limit);

    return {
      jobs: pageJobs,
      totalCount,
      page,
      resultsPerPage: limit,
      totalPages,
    };
  }

  /**
   * Get mock job details by URL.
   * No API credits consumed.
   */
  mockGetJobDetails(jobUrl) {
    const job = MOCK_JOBS.find((j) => j.url === jobUrl);
    return job || null;
  }

  // ─── LIVE MODE (Parse API) ────────────────────────────────────────

  normalizeStub(raw) {
    const title = raw.title || raw.job_title || "Untitled";
    const company = this.extractCompanyFromTitle(title);
    return {
      id: raw.job_id || raw.id || null,
      title,
      company,
      url: raw.url || raw.job_url || null,
    };
  }

  normalizeStubs(rawJobs) {
    if (!Array.isArray(rawJobs)) return [];
    return rawJobs.map((j) => this.normalizeStub(j));
  }

  extractCompanyFromTitle(title) {
    if (!title) return "Unknown Company";
    const match1 = title.match(/^(.+?)\s+(?:Graduate\s+&\s+Exp\.\s+)?(?:Job\s+)?Recruitment/i);
    if (match1) return match1[1].trim();
    const match2 = title.match(/^(.+?)\s+at\s+(.+)$/i);
    if (match2) return match2[2].trim();
    return title.replace(/\s*\(\d+\s+Positions?\)\s*$/i, "").trim() || "Unknown Company";
  }

  stubToJob(stub) {
    return {
      id: stub.id,
      title: stub.title,
      company: stub.company,
      location: "",
      description: "",
      url: stub.url,
      salaryMin: null,
      salaryMax: null,
      employmentType: null,
      postedDate: null,
      source: "HotNigerianJobs",
      category: null,
    };
  }

  normalizeJob(raw, url) {
    let salaryMin = null;
    let salaryMax = null;

    if (raw.salary) {
      if (typeof raw.salary === "object") {
        salaryMin = raw.salary.min || raw.salary.minimum || null;
        salaryMax = raw.salary.max || raw.salary.maximum || null;
      } else if (typeof raw.salary === "string") {
        const nums = raw.salary.replace(/[^\d]/g, " ").trim().split(/\s+/).map(Number).filter(Boolean);
        if (nums.length >= 2) { salaryMin = nums[0]; salaryMax = nums[1]; }
        else if (nums.length === 1) salaryMin = nums[0];
      } else if (typeof raw.salary === "number") {
        salaryMin = raw.salary;
      }
    }

    let location = "Nigeria";
    if (raw.location) {
      if (typeof raw.location === "object") {
        location = [raw.location.city, raw.location.region, raw.location.country]
          .filter(Boolean).join(", ");
      } else {
        location = String(raw.location).replace(/\.$/, "");
      }
    }

    let company = "Unknown Company";
    if (raw.recruiter) {
      company = typeof raw.recruiter === "object"
        ? (raw.recruiter.name || "Unknown Company")
        : String(raw.recruiter);
    } else if (raw.company) {
      company = typeof raw.company === "object"
        ? (raw.company.name || "Unknown Company")
        : String(raw.company);
    }

    return {
      id: raw.id || raw._id || raw.job_id || raw.slug || null,
      title: raw.title || raw.job_title || "Untitled",
      company,
      location,
      description: raw.description || "",
      url: url || raw.url || raw.job_url || null,
      salaryMin,
      salaryMax,
      employmentType: raw.level || raw.employment_type || raw.type || null,
      postedDate: raw.posted_at || raw.postedAt || raw.created_at || raw.date || null,
      source: "HotNigerianJobs",
      category: raw.category || raw.sector || null,
    };
  }

  async getListStubs(page) {
    const cacheKey = `listPage:${page}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const raw = await this.parseFetch("list_jobs", {
      page: Math.max(0, page - 1),
      per_page: Math.min(20, this.maxPerPage),
    });

    const wrapper = raw.data || raw;
    const jobs = wrapper.jobs || wrapper.results || [];
    const stubs = this.normalizeStubs(jobs);
    this.setCache(cacheKey, stubs);
    return stubs;
  }

  async liveSearchJobs({ keyword = "", location = "", page = 1, limit = 20 } = {}) {
    let stubs;

    if (keyword) {
      const cacheKey = `search:${keyword}`;
      const cached = this.getCached(cacheKey);
      if (cached) {
        stubs = cached;
      } else {
        const raw = await this.parseFetch("search_jobs", { query: keyword });
        const wrapper = raw.data || raw;
        const jobs = wrapper.jobs || wrapper.results || [];
        stubs = this.normalizeStubs(jobs);
        this.setCache(cacheKey, stubs);
      }
    } else {
      stubs = await this.getListStubs(page);
    }

    const totalCount = stubs.length;
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const start = (page - 1) * limit;
    const pageStubs = stubs.slice(start, start + limit);
    const jobs = pageStubs.map((s) => this.stubToJob(s));

    return { jobs, totalCount, page, resultsPerPage: limit, totalPages };
  }

  async liveListJobs({ location = "", page = 1, limit = 20 } = {}) {
    const stubs = await this.getListStubs(page);
    const totalCount = stubs.length;
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const jobs = stubs.map((s) => this.stubToJob(s));
    return { jobs, totalCount, page, resultsPerPage: limit, totalPages };
  }

  async liveGetJobDetails(jobUrl) {
    if (!jobUrl) return null;
    const cacheKey = `detail:${jobUrl}`;
    const cached = this.getCached(cacheKey, this.detailCacheTTL);
    if (cached) return cached;

    const raw = await this.parseFetch("get_job_details", { url: jobUrl });
    const rawJob = raw.data || raw.job || raw;
    const enriched = this.normalizeJob(rawJob, jobUrl);
    this.setCache(cacheKey, enriched);
    return enriched;
  }

  // ─── UNIFIED INTERFACE ─────────────────────────────────────────────

  /**
   * Search jobs by keyword and/or location.
   * Uses mock data when USE_MOCK_DATA=true or API unavailable.
   */
  async searchJobs(params = {}) {
    if (this.useMock) {
      return this.mockSearchJobs(params);
    }

    try {
      return await this.liveSearchJobs(params);
    } catch (err) {
      console.warn(`[JobService] Live search failed (${err.message}), falling back to mock data`);
      return this.mockSearchJobs(params);
    }
  }

  /**
   * List recent jobs (browsing).
   * Uses mock data when USE_MOCK_DATA=true or API unavailable.
   */
  async listJobs(params = {}) {
    if (this.useMock) {
      return this.mockListJobs(params);
    }

    try {
      return await this.liveListJobs(params);
    } catch (err) {
      console.warn(`[JobService] Live list failed (${err.message}), falling back to mock data`);
      return this.mockListJobs(params);
    }
  }

  /**
   * Get full job details on-demand.
   * Uses mock data when USE_MOCK_DATA=true or API unavailable.
   */
  async getJobDetails(jobUrl) {
    if (this.useMock) {
      return this.mockGetJobDetails(jobUrl);
    }

    try {
      return await this.liveGetJobDetails(jobUrl);
    } catch (err) {
      console.warn(`[JobService] Live detail failed (${err.message}), falling back to mock data`);
      return this.mockGetJobDetails(jobUrl);
    }
  }
}

module.exports = new JobService();
