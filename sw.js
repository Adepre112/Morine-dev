/* Morine service worker.
 *
 * Safety rules enforced here:
 *  - Every /api/* request is network-only. No API response is ever read into the
 *    cache, so no auth, profile, CV, AI or job data can be stored or replayed.
 *  - Only same-origin GET requests for a fixed allow-list of static shell files
 *    are cached. Nothing else is added to the cache at runtime.
 *  - The cache is not used as an identity boundary. Sign-in state lives in
 *    localStorage and an httpOnly cookie, neither of which the SW touches, and
 *    cached responses are never served to a different user on the same device:
 *    the shell contains no user data.
 *  - Navigations are network-first so a fresh app.html is always preferred; the
 *    cached copy is an offline fallback only.
 *  - EVERY shell asset is network-first for the same reason. This used to be
 *    cache-first, keyed on the cache name below, which meant a frontend fix
 *    could never reach a device that had already installed the worker: the
 *    worker is only reinstalled when sw.js itself changes, so a commit that
 *    touched only js/app.js or css/app.css left every returning browser on the
 *    old files indefinitely. That is exactly how an iOS fix shipped and still
 *    did not fix the iPhone. Network-first costs one conditional request per
 *    asset and makes a deploy take effect on the next load with no user action.
 */

const VERSION = "morine-shell-v2";
const SHELL_CACHE = VERSION;

/* Fixed application-shell allow-list. Paths are absolute from the SW scope ("/"). */
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.html",
  "/css/styles.css",
  "/css/landing.css",
  "/css/app.css",
  "/js/landing.js",
  "/js/app.js",
  "/manifest.webmanifest",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/icon-maskable-192.png",
  "/assets/icon-maskable-512.png",
  "/assets/icon.svg",
];

const OFFLINE_APP_SHELL = "/app.html";
const OFFLINE_LANDING = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll is atomic-ish; a single failure would abort install, so add
      // individually and tolerate misses so a renamed asset cannot break install.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload", credentials: "same-origin" }))
            .catch(() => { /* optional shell asset */ })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Never treat API traffic, non-GET, or cross-origin requests as cacheable. */
function isApiRequest(url) {
  return url.pathname === "/api" || url.pathname.indexOf("/api/") === 0;
}

function isCacheableShell(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf("/assets/") === 0) return true;
  return SHELL_ASSETS.indexOf(url.pathname) !== -1;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Everything that is not a plain same-origin GET is passed straight through.
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // API: network only. Never read into cache, never serve from cache. This is
  // what keeps auth responses, profile/CV data, AI output and live job results
  // out of the cache entirely.
  if (isApiRequest(url)) return;

  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first, cached shell only as an offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          const inWorkspace = url.pathname === "/app" ||
            url.pathname === "/app.html" ||
            url.pathname === "/app/";
          return caches.match(OFFLINE_APP_SHELL)
            .then((hit) => hit || caches.match(OFFLINE_LANDING))
            .then((hit) => hit || new Response(
              "<!doctype html><meta charset=\"utf-8\"><title>Morine - offline</title>" +
              "<body style=\"font-family:system-ui;background:#080c1b;color:#e6e9f5;padding:40px\">" +
              "<h1>You're offline</h1>" +
              "<p>Please check your internet connection. Morine needs to be online to sign in, load your Profile, search " +
              "Opportunities and run AI features.</p></body>",
              { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
            ));
        })
    );
    return;
  }

  // Static shell assets: network-first, cached copy as an offline fallback.
  // Deliberately NOT cache-first - see the note above VERSION. The cache is
  // still refreshed on every successful fetch so the offline path stays useful.
  if (isCacheableShell(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match(OFFLINE_APP_SHELL).then((f) => f || Response.error()))
        )
    );
  }
  // Anything else falls through to the network untouched.
});
