/* ─────────────────────────────────────────────
   Morine runtime configuration
   ─────────────────────────────────────────────
   This file is intentionally separate from app.js so the API base URL can be
   set WITHOUT rebuilding or editing application code.

   Resolution order (first non-empty wins):

     1. localStorage["morine_api_base"]
        A per-browser escape hatch, useful for pointing a local copy of the app
        at a remote backend while debugging. Set it from the browser console:
          localStorage.setItem("morine_api_base", "http://localhost:3000");
        Clear it with:
          localStorage.removeItem("morine_api_base");

     2. <meta name="api-base-url" content="..."> in app.html
        Left EMPTY in this project. That is the correct value, not a gap: Morine
        is single-origin. One Render Web Service runs Express, and Express serves
        the frontend and every /api/* route from the same host, so relative
        requests are already correct and need no base URL.

     3. "" (empty)
        Same-origin. This is what production and local development both use,
        because the Express server serves the frontend and the API together on
        http://localhost:3000 in development and on the single Render origin in
        production.

   There is no separate frontend host, so there is no deployment-time URL to set
   and nothing to keep in sync. This file contains no secrets and is safe to
   serve publicly.
   ───────────────────────────────────────────── */
(function () {
  "use strict";

  function readMeta() {
    var meta = document.querySelector('meta[name="api-base-url"]');
    return meta ? String(meta.getAttribute("content") || "").trim() : "";
  }

  function readOverride() {
    try {
      return String(window.localStorage.getItem("morine_api_base") || "").trim();
    } catch (e) {
      // Private browsing / storage disabled: fall through to the meta tag.
      return "";
    }
  }

  // Strip trailing slashes so callers can always join with "/" safely.
  function normalize(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  var apiBaseUrl = readOverride() || readMeta();

  window.MORINE_CONFIG = {
    // "" means same-origin relative requests.
    apiBaseUrl: normalize(apiBaseUrl),
    // Records which source won, so the deployed configuration can be verified
    // from the browser console with MORINE_CONFIG.source.
    source: readOverride() ? "localStorage override" : (readMeta() ? "meta tag" : "same-origin default")
  };
})();
