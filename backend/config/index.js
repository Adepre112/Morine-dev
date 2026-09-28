// ─────────────────────────────────────────────
// Morine backend configuration
// Job provider: Job Listings API (https://www.joblistingsapi.com/docs)
//   Base URL : https://api.joblistingsapi.com/v1
//   Auth     : X-API-Key header, server-side only
//   Env var  : JOB_LISTING_API_KEY
//   Nigeria  : every job request is pinned to country=NG
// NOTE: the API key is never logged and never leaves the server.
// ─────────────────────────────────────────────

const JOB_LISTINGS_BASE_URL = "https://api.joblistingsapi.com/v1";

module.exports = {
  jobListings: {
    baseUrl: JOB_LISTINGS_BASE_URL,
    apiKey: process.env.JOB_LISTING_API_KEY,
    // Morine is Nigeria-only (ISO 3166-1 alpha-2).
    countryCode: "NG",
    defaultPerPage: 10,
    maxPerPage: 25,
    cacheTTL: 30 * 60 * 1000,
    requestTimeoutMs: 15000,
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || "development",
  },
};
