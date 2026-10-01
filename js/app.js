/* ============================================================
   MORINE APP (app.html) — application JavaScript
   Front-end that talks to the existing /api/auth, /api/jobs,
   /api/cv, /api/skill-gap and /api/ai endpoints, with graceful
   offline fallback only when the server can't be reached.
   ------------------------------------------------------------
   0. Utilities (api, store, toast, helpers)
   1. Router + navigation state (hash-based)
   2. Overview (progress ring, checklist, career path, reco list)
   3. Opportunities (filters + /api/jobs)
   4. CV Optimizer (real backend: /api/cv upload + analyze)
   5. Skill Gap (real backend: /api/skill-gap/analyze)
   6. Career AI (real backend: /api/ai/chat)
   7. Career Profile (localStorage draft, Mongo-ready)
   8. Auth (reuse /api/auth with offline fallback)
   9. Kick-off
   ============================================================ */

/* eslint-disable no-unused-vars */
(() => {
  "use strict";

  const LS_USER = "morine_app_user";
  const LS_PROFILE = "morine_app_profile";
  const LS_PROFILE_OWNER = "morine_app_profile_owner";
  const LS_TOKEN = "morine_token";

  /* ---------- 0. Utilities ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [].slice.call((root || document).querySelectorAll(sel));

  const store = {
    get(key) {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
    },
    del(key) { localStorage.removeItem(key); }
  };

  const userDraft = () => store.get(LS_USER) || { name: "Not signed in", email: "" };

  /* Local Profile draft ownership.
     A draft left on a shared device must never be readable by - or synced into -
     the next account that signs in on it, so every draft is stamped with the
     account that wrote it. The stamp is the account's email address, which the
     frontend already stores at sign-in: it is an identity label, not a secret,
     token or credential. Reading the draft always requires a stamp that matches
     the signed-in account; unattributed (legacy) drafts are treated as untrusted
     and are never displayed or pushed to the server. */
  const accountKey = () => String((userDraft() || {}).email || "").trim().toLowerCase();
  const draftOwnerKey = () => String(store.get(LS_PROFILE_OWNER) || "").trim().toLowerCase();

  function profileDraftOwned() {
    const owner = draftOwnerKey();
    const account = accountKey();
    if (!owner || !account || owner !== account) return false;
    return store.get(LS_PROFILE) != null;
  }

  function ownedProfileDraft() {
    if (!profileDraftOwned()) return null;
    return store.get(LS_PROFILE) || {};
  }

  function writeProfileDraft(draft) {
    // No account identity available: never persist an unattributable draft.
    if (!accountKey()) { clearProfileDraft(); return; }
    store.set(LS_PROFILE, draft);
    store.set(LS_PROFILE_OWNER, accountKey());
  }

  function clearProfileDraft() {
    store.del(LS_PROFILE);
    store.del(LS_PROFILE_OWNER);
  }

  const profileDraft = () => ownedProfileDraft() || {};
  const nameFor = () => {
    const n = userDraft().name;
    return (n && String(n).trim()) || "there";
  };
  const delay = ms => new Promise(r => setTimeout(r, ms));

  /* Shared wording for every "we couldn't reach Morine" message the app shows. */
  const NET_HINT = "We couldn't connect. Please check your internet connection and try again.";

  /* API base URL. js/config.js (loaded before this file) resolves it from a
     localStorage override, then the <meta name="api-base-url"> tag in
     app.html, then falls back to same-origin. See js/config.js for the full
     resolution order and the three supported deployment modes. An empty
     result means "use relative /api paths". */
  const getApiBaseUrl = () => {
    const cfg = window.MORINE_CONFIG;
    if (cfg && typeof cfg.apiBaseUrl === "string") {
      return cfg.apiBaseUrl;
    }
    // Fallback for a page rendered without js/config.js.
    const meta = document.querySelector('meta[name="api-base-url"]');
    return meta ? String(meta.getAttribute("content") || "").trim() : "";
  };

  async function api(path, opts) {
    const baseUrl = getApiBaseUrl();
    const fullPath = baseUrl ? baseUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "") : path;
    const isFormData = opts && opts.body instanceof FormData;
    const defaultHeaders = { "Accept": "application/json" };
    if (!isFormData) defaultHeaders["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeoutMs = opts?.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(fullPath, Object.assign({
        method: "GET",
        credentials: "same-origin"
      }, opts || {}, {
        headers: Object.assign({}, defaultHeaders, (opts && opts.headers) || {}),
        signal: controller.signal
      }));
      clearTimeout(timeoutId);
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === "AbortError") {
        return { ok: false, status: 408, data: { error: "This is taking longer than expected. Please try again." } };
      }
      if (e.name === "TypeError" && e.message.includes("fetch")) {
        return { ok: false, status: 0, data: { error: NET_HINT } };
      }
      return { ok: false, status: 0, data: { error: NET_HINT } };
    }
  }

  /* ---------- Single-flight access-token refresh ----------
     The server rotates the refresh token on every use and treats a second use
     of an already-rotated token as theft: it revokes the ENTIRE token family
     for that user. So if several requests were in flight when the access token
     expired, letting each one call /api/auth/refresh independently would make
     the "loser" of that race revoke the winner's brand-new token and sign the
     user out.

     This makes refresh single-flight: the first caller starts the request and
     every other caller awaits that exact same promise. The server therefore
     sees exactly ONE refresh, no matter how many requests expired at once.
     Mutexes: one in-flight promise; it is cleared in a finally so a failure
     can never wedge the session. */
  let refreshInFlight = null;

  /**
   * Performs at most one refresh for the whole app at a time.
   * Resolves to { refreshed: true } or { refreshed: false, signOut: bool }.
   * Never rejects, so callers do not need their own try/catch.
   */
  function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;

    const run = (async () => {
      try {
        const res = await api("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (res && res.ok && res.data && res.data.data && res.data.data.token) {
          store.set(LS_TOKEN, res.data.data.token);
          return { refreshed: true };
        }
        // 401/403 mean the session is genuinely gone, so the user must sign in
        // again. A transport failure (status 0) or a server fault (5xx) does
        // NOT mean the session is invalid: signing out on a transient blip
        // would log users out for no reason, so those are surfaced as errors
        // instead and the stored token is left untouched.
        const definitive = res && (res.status === 401 || res.status === 403);
        return { refreshed: false, signOut: definitive, res: res };
      } catch (e) {
        return { refreshed: false, signOut: false, res: null };
      } finally {
        // Release the mutex. Guarded so the slot can only be cleared by the
        // promise that currently owns it.
        if (refreshInFlight === run) refreshInFlight = null;
      }
    })();

    refreshInFlight = run;
    return run;
  }

  /* Single-flight sign-out. When a refresh is definitively rejected, every
     request that was waiting on the shared refresh promise wakes up at once.
     Without this guard each of them would call signoutNow(), firing redundant
     POST /api/auth/logout requests and repeated navigation. Exactly one caller
     performs the teardown; the rest await the same promise. */
  let sessionEndInFlight = null;

  function endSessionOnce() {
    if (sessionEndInFlight) return sessionEndInFlight;

    const run = (async () => {
      try {
        await signoutNow();
      } catch (e) {
        // Never block sign-out on a failed network call.
      }
      navigate("signin");
    })().then(
      v => { if (sessionEndInFlight === run) sessionEndInFlight = null; return v; },
      e => { if (sessionEndInFlight === run) sessionEndInFlight = null; throw e; }
    );

    sessionEndInFlight = run;
    return run;
  }

  async function authApi(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, authHeaders(), opts.headers || {});
    const res = await api(path, Object.assign({}, opts, { headers }));
    if (res.status === 401 && res.data && res.data.code === "ACCESS_TOKEN_EXPIRED") {
      // Single-flight: concurrent expiries share one refresh.
      const outcome = await refreshAccessToken();
      if (outcome.refreshed) {
        // Retry exactly once with the new access token.
        return api(path, Object.assign({}, opts, { headers: authHeaders() }));
      }
      if (outcome.signOut) {
        // Single-flight: only one caller tears the session down.
        await endSessionOnce();
        return { ok: false, status: 401, data: { error: "Session expired" } };
      }
      // Refresh could not be attempted (offline / backend restarting). Report
      // the original expiry so the caller shows an honest error state.
      return { ok: false, status: res.status, data: res.data };
    }
    return res;
  }

  function toast(msg, ok) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("toast--error", ok === false);
    el.classList.toggle("toast--success", ok !== false);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3400);
  }

  /* ---------- Confirmation dialog ----------
     Every destructive action on the user's own data goes through confirmAction()
     so the wording always says exactly what is being removed. There is
     deliberately no "delete account" option and no "delete everything" button:
     each feature only ever removes its own records. */
  const confirmEl = $("#confirm");
  const confirmTitleEl = $("#confirmTitle");
  const confirmMsgEl = $("#confirmMsg");
  const confirmScopeEl = $("#confirmScope");
  const confirmOkEl = $("#confirmOk");
  const confirmCancelEl = $("#confirmCancel");
  let confirmResolve = null;
  let confirmLastFocus = null;

  function closeConfirm(result) {
    if (!confirmEl || confirmEl.hidden) return;
    confirmEl.hidden = true;
    if (confirmOkEl) confirmOkEl.disabled = false;
    const done = confirmResolve;
    confirmResolve = null;
    if (confirmLastFocus && typeof confirmLastFocus.focus === "function") {
      try { confirmLastFocus.focus(); } catch (e) { /* element may be gone */ }
    }
    confirmLastFocus = null;
    if (done) done(result === true);
  }

  /**
   * Ask the user to confirm a destructive action on their own data.
   * @param {object} o
   * @param {string} o.title     Short question, e.g. "Delete this CV?"
   * @param {string} o.message   What happens, e.g. "This cannot be undone."
   * @param {string} [o.scope]   Names the specific item(s) being removed.
   * @param {string} [o.confirmLabel] Button label; defaults to "Delete".
   * @returns {Promise<boolean>} true only when the user confirms.
   */
  function confirmAction(o) {
    if (!confirmEl) return Promise.resolve(window.confirm(o.title + " " + (o.message || "")));
    if (confirmResolve) closeConfirm(false);
    confirmLastFocus = document.activeElement;
    if (confirmTitleEl) confirmTitleEl.textContent = o.title || "Are you sure?";
    if (confirmMsgEl) confirmMsgEl.textContent = o.message || "";
    if (confirmScopeEl) {
      const s = o.scope ? String(o.scope) : "";
      confirmScopeEl.textContent = s;
      confirmScopeEl.hidden = !s;
    }
    if (confirmOkEl) {
      confirmOkEl.textContent = o.confirmLabel || "Delete";
      confirmOkEl.classList.toggle("btn--danger-solid", o.destructive !== false);
    }
    confirmEl.hidden = false;
    if (confirmCancelEl) setTimeout(() => confirmCancelEl.focus(), 30);
    return new Promise(resolve => { confirmResolve = resolve; });
  }

  if (confirmCancelEl) confirmCancelEl.addEventListener("click", () => closeConfirm(false));
  if (confirmOkEl) confirmOkEl.addEventListener("click", () => closeConfirm(true));
  if (confirmEl) {
    confirmEl.addEventListener("click", (e) => {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-confirm-cancel")) closeConfirm(false);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (!confirmEl || confirmEl.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeConfirm(false); }
    if (e.key === "Enter") { e.preventDefault(); closeConfirm(true); }
  });

  /* ---------- 1. Router ---------- */
  const VIEWS = [
    { id: "profile", title: "Profile", path: "/profile" },
    { id: "overview", title: "Overview", path: "/overview" },
    { id: "jobs", title: "Opportunities", path: "/opportunities" },
    { id: "cv", title: "CV Optimizer", path: "/cv" },
    { id: "skills", title: "Skill Gap Analysis", path: "/skills" },
    { id: "ai-profile", title: "AI Career Profile", path: "/ai-profile" },
    { id: "career-path", title: "Career Path Discovery", path: "/career-path" },
    { id: "interview", title: "Interview Preparation", path: "/interview" },
    { id: "ai", title: "AI Assistant", path: "/ai" },
    { id: "signin", title: "Sign In", path: "/signin" },
    { id: "signup", title: "Create Account", path: "/signup" },
    { id: "forgot-password", title: "Forgot Password", path: "/forgot-password" },
    { id: "reset-password", title: "Reset Password", path: "/reset-password" }
  ];

  function currentView() {
    const fullHash = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    const pathOnly = fullHash.split("?")[0];
    const hit = VIEWS.find(v => v.path === pathOnly);
    return hit ? hit.id : "overview";
  }

  function viewEl(id) {
    return $(`.app-view[data-view="${id}"]`);
  }

  function showView(id, opts) {
    opts = opts || {};
    const active = VIEWS.find(v => v.id === id) || VIEWS[0];
    VIEWS.forEach(v => {
      const el = viewEl(v.id);
      if (el) el.classList.toggle("is-active", v.id === active.id);
    });
    const titleEl = $("#topTitle");
    const authViews = ["signin", "signup", "forgot-password", "reset-password"];
    if (titleEl && !authViews.includes(active.id)) titleEl.textContent = active.title;
    if (opts.keepHash && location.hash !== "#" + active.path) {
      history.replaceState(null, "", "#" + active.path);
    }
    setActiveNav();
    // Leaving a screen re-masks every password field: switching from Sign In
    // to Create Account (or back) must never reveal a password typed earlier.
    resetPasswordToggles();
    if (active.id === "jobs") loadOpps();
    if (active.id === "cv") initCvOptimizer();
    if (active.id === "skills") loadSgList();
    if (active.id === "interview") loadIpList();
    if (active.id === "career-path") initCareerPath();
    if (active.id === "ai-profile") initAiCareerProfile();
  }

  function setActiveNav() {
    const id = currentView();
    $$(".app-nav").forEach(el => el.classList.toggle("is-active", el.dataset.nav === id));
    $$(".app-bottom__item").forEach(el => el.classList.toggle("is-active", el.dataset.nav === id));
  }

  function navigate(id) {
    const view = VIEWS.find(v => v.id === id);
    if (!view) return;
    const guard = guardRoute(id);
    showView(guard, { keepHash: true });
    history.pushState(null, "", "#" + (VIEWS.find(v => v.id === guard) || view).path);
  }

  /* ---------- Password visibility toggle ----------
   *
   * Every password input sits in a .field__group with an eye button that is a
   * <button type="button">, so a click can never submit the surrounding form.
   * Toggling only flips the input's type between "password" and "text": the
   * value itself is never read, copied, logged or stored - nothing about the
   * password leaves the input element. showView() resets every toggle, so
   * moving between screens always leaves the fields masked again. */
  function setPwToggle(btn, shown) {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    input.type = shown ? "text" : "password";
    btn.classList.toggle("is-shown", shown);
    btn.setAttribute("aria-pressed", String(shown));
    btn.setAttribute("aria-label", shown ? "Hide password" : "Show password");
  }

  function resetPasswordToggles() {
    $$(".field__toggle[data-toggle-password]").forEach(btn => setPwToggle(btn, false));
  }

  function initPasswordToggles() {
    $$(".field__toggle[data-toggle-password]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        // type="button" already keeps this out of submission; preventDefault
        // is belt-and-braces in case a surrounding handler ever submits.
        e.preventDefault();
        const input = document.getElementById(btn.dataset.togglePassword);
        if (!input) return;
        setPwToggle(btn, input.type === "password");
      });
    });
  }

  /* ---------- 2. Overview ---------- */
  const PROFILE_FIELDS = [
    "pfName", "pfRole", "pfInterests", "pfEdSchool", "pfEdDegree", "pfEdYear",
    "pfCerts", "pfSkills", "pfWorkRole", "pfWorkCo", "pfWorkFrom", "pfWorkTo",
    "pfWorkDesc", "pfVol", "pfLoc"
  ];

  function remoteValue() {
    const r = $('input[name="pfRemote"]:checked');
    return r ? r.value : "";
  }

  function computeProgress() {
    const filledCount = PROFILE_FIELDS.filter(id => {
      const el = document.getElementById(id);
      return !!el && el.value.trim().length > 0;
    }).length + (remoteValue() ? 1 : 0);
    const total = PROFILE_FIELDS.length + 1;
    const pct = Math.round((filledCount / total) * 100);
    const has = id => {
      const el = document.getElementById(id);
      return !!el && el.value.trim().length > 0;
    };
    return { pct, has };
  }

  function renderOverview() {
    const p = computeProgress();
    const pctEl = $("#profilePct");
    if (pctEl) pctEl.textContent = p.pct;
    const pill = $("#profilePill");
    if (pill) pill.textContent = p.pct + "% complete";
    const ring = $("#profileRing");
    if (ring) ring.style.setProperty("--p", p.pct);
    const checks = $("#profileChecks");
    if (checks) {
      const items = [
        { id: "pfSkills", label: "Add core skills" },
        { id: "pfWorkRole", label: "Add current role" },
        { id: "pfEdDegree", label: "Add education" },
        { id: "pfInterests", label: "Set career interests" }
      ];
      checks.innerHTML = items.map(i =>
        `<li class="checklist__item${p.has(i.id) ? " is-done" : ""}"><span class="checklist__tick">✓</span><span>${i.label}</span></li>`
      ).join("");
    }
  }

  function renderCareerSteps() {
    const d = profileDraft();
    const setStep = (id, done, text) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("is-done", done);
      const small = el.querySelector("small");
      if (small) small.textContent = text;
    };
    const skills = !!(d.pfSkills && String(d.pfSkills).trim());
    setStep("cprogGap", skills, skills ? "Identified in Skill Gap" : "Run the Skill Gap analysis");
    const hasEdu = !!(d.pfEdDegree || d.pfCerts);
    setStep("cprogLearn", hasEdu, hasEdu ? "Rooted in your profile" : "Set education or certifications");
    const hasExp = !!(d.pfWorkRole && String(d.pfWorkRole).trim());
    setStep("cprogOpp", hasExp, hasExp ? "Matched to your experience" : "Add work experience to refine matches");
  }

  /* ---------- 3. Opportunities (Job Listings API — Nigeria only) ---------- */
  // Maps the backend job record onto what the card renders.
  // Every value below comes from the provider; nothing is invented.
  const normalizeLive = (j) => {
    const r = j || {};
    if (!normalizeLive._i) normalizeLive._i = 0;
    const company = r.company || null;
    const logo = String(company || "?").trim().charAt(0).toUpperCase() || "?";
    const location = r.location ||
      [r.city, r.region].filter(Boolean).join(", ") ||
      null;
    const desc = String(r.description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Provider `remote_policy` values: onsite | hybrid | remote.
    // This is the single source of truth for the remote badge so the same
    // status can never be rendered twice on one card.
    const policy = r.remotePolicy ? String(r.remotePolicy).toLowerCase() : null;
    const isRemote = policy ? policy === "remote" : r.remote === true;

    return {
      id: r.id != null ? String(r.id) : "live-" + (normalizeLive._i++),
      title: r.title || "Untitled role",
      company,
      // Real application / listing URL from the provider. Never dropped.
      url: r.url || null,
      location,
      city: r.city || null,
      region: r.region || null,
      countryCode: r.countryCode || null,
      employmentType: r.employmentType || null,
      remote: isRemote,
      remotePolicy: policy,
      remoteScope: r.remoteScope || null,
      category: r.category || null,
      subcategory: r.subcategory || null,
      salary: r.salary || null,
      postedDate: r.postedDate || null,
      source: r.source || null,
      logo,
      logoClass: "job-card__logo--live-" + (normalizeLive._i % 4),
      desc,
      match: null,
    };
  };

  function timeAgoShort(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    if (days < 30) return days + " days ago";
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : months + " months ago";
  }

  /* Builds the de-duplicated tag set for a card. Every value is real provider
     data, and each fact is added at most once, so "Remote" or a job type can
     never appear in two different rows. */
  function jobFacts(job) {
    const out = [];
    const add = v => {
      const s = String(v == null ? "" : v).trim();
      if (!s) return;
      const low = s.toLowerCase();
      if (out.some(t => t.toLowerCase() === low)) return;
      out.push(s);
    };

    if (job.employmentType) add(String(job.employmentType).replace(/_/g, " "));
    // remotePolicy is the single remote signal: onsite | hybrid | remote.
    if (job.remotePolicy) {
      add(String(job.remotePolicy).toLowerCase());
      if (job.remoteScope && String(job.remotePolicy).toLowerCase() === "remote") {
        add(String(job.remoteScope));
      }
    } else if (job.remote) {
      add("Remote");
    }
    if (job.category) add(job.category);
    const posted = timeAgoShort(job.postedDate);
    if (posted) add("Posted " + posted);
    if (job.source) add("via " + job.source);
    return out;
  }

  function jobsMarkup(job) {
    const href = job.url || null;
    const meta = [job.company, job.location].filter(Boolean).join(" · ");
    const facts = jobFacts(job);

    return `<article class="job-card">
      <div class="job-card__head">
        <div class="job-card__logo ${job.logoClass}">${esc(job.logo)}</div>
        <div class="job-card__meta">
          ${href
            ? `<a href="${esc(href)}" class="job-card__title" aria-label="View opportunity details" target="_blank" rel="noopener">${esc(job.title)}</a>`
            : `<span class="job-card__title">${esc(job.title)}</span>`}
          <span class="job-card__company">${esc(meta || "Company not disclosed")}</span>
        </div>
      </div>
      ${job.desc ? `<p class="job-card__desc">${esc(job.desc.slice(0, 180))}</p>` : ""}
      ${facts.length ? `<div class="job-card__tags">${facts.map(t => `<span class="small-tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="job-card__foot">
        <span class="job-card__salary">${esc(job.salary || "Salary not disclosed")}</span>
        ${href ? `<a href="${esc(href)}" aria-label="View details of ${esc(job.title)}" target="_blank" rel="noopener">View opportunity</a>` : `<span class="mute">No link provided</span>`}
      </div>
    </article>`;
  }

  /* Rebuilds the Career field dropdown from the categories the provider
     actually returned. Nothing here is hard-coded, so the filter can never
     offer a category the API does not have. */
  function syncFieldOptions(jobs) {
    const sel = $("#oppField");
    if (!sel) return;
    const prev = sel.value;
    const cats = [];
    jobs.forEach(o => {
      const c = o && o.category ? String(o.category).trim() : "";
      if (c && !cats.some(x => x.toLowerCase() === c.toLowerCase())) cats.push(c);
    });
    cats.sort((a, b) => a.localeCompare(b));
    sel.innerHTML = `<option value="all">Career field · All</option>` +
      cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    // Keep the user's choice when it still exists in the new result set.
    const stillThere = prev && (prev === "all" || cats.some(c => c.toLowerCase() === String(prev).toLowerCase()));
    sel.value = stillThere ? prev : "all";
  }

  function renderPager(page, totalPages) {
    const pager = $("#oppPager");
    if (!pager) return;
    if (!totalPages || totalPages <= 1) { pager.innerHTML = ""; return; }
    pager.innerHTML = `
      <button class="btn btn--ghost btn--sm" id="oppPrev" ${page <= 1 ? "disabled" : ""}>← Previous</button>
      <span class="opp-pager__info">Page ${page} of ${totalPages}</span>
      <button class="btn btn--ghost btn--sm" id="oppNext" ${page >= totalPages ? "disabled" : ""}>Next →</button>`;
  }

  function renderOpps(list, pagination, opts) {
    opts = opts || {};
    const status = $("#oppStatus");
    const res = $("#oppResults");
    const shown = list.length;
    const total = pagination ? pagination.totalCount : shown;

    if (status) {
      let text;
      if (opts.isError) {
        // Errors must never be reported as "no results".
        text = opts.errorText || "We couldn't load job opportunities. Please try again.";
      } else if (opts.filtered) {
        text = shown
          ? `Showing ${shown} of the ${total} roles on this page after filtering · Page ${pagination ? pagination.page : 1} of ${pagination ? pagination.totalPages : 1}`
          : `No roles on this page match the selected field or experience level. Clear those filters, or go to another page.`;
      } else if (shown) {
        text = `${shown} of ${total} Nigerian opportunities · Page ${pagination ? pagination.page : 1} of ${pagination ? pagination.totalPages : 1}`;
      } else {
        text = "No opportunities found for this search. Try a different keyword or location.";
      }
      status.textContent = text;
      status.classList.toggle("is-error", !!opts.isError);
    }

    if (res) {
      if (shown) {
        res.innerHTML = list.map(o => jobsMarkup(o)).join("");
      } else if (opts.isError) {
        res.innerHTML = `<div class="cvlab__empty"><span class="cvlab__empty-ic">⚠</span><p>${esc(opts.errorText || "We couldn't load job opportunities. Please try again.")}</p></div>`;
      } else {
        res.innerHTML = `<div class="cvlab__empty"><span class="cvlab__empty-ic">🔍</span><p>${esc(opts.emptyText || "No opportunities found for this search. Try a different keyword or location.")}</p></div>`;
      }
    }

    renderPager(pagination ? pagination.page : 1, pagination ? pagination.totalPages : 1);
  }

  /* Loading state. The grid is cleared so no stale or placeholder card is
     shown while a real request is in flight. */
  function renderLoading(message) {
    const status = $("#oppStatus");
    const res = $("#oppResults");
    if (status) {
      status.classList.remove("is-error");
      status.textContent = message;
    }
    if (res) {
      res.innerHTML = `<div class="cvlab__empty"><span class="cvlab__empty-ic">⏳</span><p>${esc(message)}</p></div>`;
    }
    renderPager(1, 1);
  }

  /* Client cache. The key contains every parameter that changes what the
     BACKEND returns (keyword, location, page, limit, remote), so one search can
     never be served for another. The provider's role_category and salary
     filters are Growth+ only, so career field / experience level are applied
     client-side to the real returned data and are deliberately NOT part of the
     network key — changing them must not spend quota. */
  const JOB_CACHE_TTL = 5 * 60 * 1000;
  const jobCache = new Map();
  // Coalesces identical in-flight searches. On first paint both the Overview
  // panel and the Opportunities view ask for the same default result set; this
  // makes them share ONE request instead of racing to issue two.
  const jobInflight = new Map();
  const JOB_PAGE_SIZE = 10;

  async function fetchJobs(params) {
    const p = params || {};
    const q = {
      keyword: String(p.keyword || "").trim(),
      location: String(p.location || "").trim(),
      page: Math.max(1, parseInt(p.page, 10) || 1),
      limit: Math.max(1, parseInt(p.limit, 10) || JOB_PAGE_SIZE),
      remote: !!p.remote,
    };
    const key = [q.keyword, q.location, q.page, q.limit, q.remote ? "1" : "0"].join("|");

    const hit = jobCache.get(key);
    if (hit && Date.now() - hit.ts < JOB_CACHE_TTL) {
      return { ok: true, cached: true, jobs: hit.jobs, pagination: hit.pagination };
    }

    // An identical search is already running: wait for it rather than
    // spending another provider request.
    if (jobInflight.has(key)) {
      const shared = await jobInflight.get(key);
      return { ...shared, coalesced: true };
    }

    const request = (async () => {
      // keyword -> title, location -> location. country is never a parameter:
      // the backend pins country=NG on every call.
      const search = new URLSearchParams();
      if (q.keyword) search.set("keyword", q.keyword);
      if (q.location) search.set("location", q.location);
      if (q.remote) search.set("remote", "true");
      search.set("page", String(q.page));
      search.set("limit", String(q.limit));

      const res = await api("/api/jobs?" + search.toString());
      if (!res.ok) {
        return {
          ok: false,
          cached: false,
          status: res.status,
          code: (res.data && res.data.code) || null,
          error: (res.data && res.data.error) || null,
        };
      }

      const jobs = res.data && Array.isArray(res.data.data) ? res.data.data : [];
      const pagination = (res.data && res.data.pagination) || null;
      jobCache.set(key, { ts: Date.now(), jobs, pagination });
      return { ok: true, cached: false, jobs, pagination };
    })();

    jobInflight.set(key, request);
    try {
      return await request;
    } finally {
      jobInflight.delete(key);
    }
  }

  /* Experience level is derived from the real job title. The provider has no
     level field, so this is an honest client-side refinement: a title with no
     seniority signal is simply "not determinable" and is excluded while a
     level filter is active. */
  const LEVEL_PATTERNS = {
    entry: /\b(junior|jr|graduate|entry[ -]?level|intern|internship|trainee|apprentice|assistant|associate|fresh\s*grad|new\s*grad|cadet)\b/,
    senior: /\b(senior|sr|lead|principal|head|director|manager|chief|architect|vp|vice\s+president|executive|partner)\b/,
  };

  function jobLevel(title) {
    const t = String(title || "").toLowerCase();
    if (LEVEL_PATTERNS.senior.test(t)) return "senior";
    if (LEVEL_PATTERNS.entry.test(t)) return "entry";
    return null;
  }

  function matchesField(job, field) {
    if (!field || field === "all") return true;
    // Exact match against the provider's real category string.
    return String(job.category || "").trim().toLowerCase() === String(field).trim().toLowerCase();
  }

  function matchesLevel(job, level) {
    if (!level || level === "all") return true;
    return jobLevel(job.title) === level;
  }

  function getFilters() {
    return {
      kw: ($("#oppKw") || { value: "" }).value,
      loc: ($("#oppLoc") || { value: "" }).value,
      field: ($("#oppField") || { value: "all" }).value,
      level: ($("#oppLevel") || { value: "all" }).value,
      remote: ($("#oppRemote") || { checked: false }).checked
    };
  }

  function clientFiltersActive() {
    const f = getFilters();
    return (f.field && f.field !== "all") || (f.level && f.level !== "all") || !!f.remote;
  }

  /* Career field and experience level are client-side refinements applied to the
     real returned data. Remote is NOT applied here: the provider supports
     remote_only as a genuine request parameter, so it is sent to the backend. */
  function applyClientFilters(jobs) {
    const f = getFilters();
    return jobs.filter(o => matchesField(o, f.field) && matchesLevel(o, f.level));
  }

  async function loadOpps(opts) {
    opts = opts || {};
    const f = getFilters();
    const page = opts.page || 1;
    // Guards against a stale response overwriting a newer one. The request has
    // already been issued by this point, so this discards the superseded
    // result before it renders — it does not cancel the network call.
    loadOpps._seq = (loadOpps._seq || 0) + 1;
    const seq = loadOpps._seq;

    if (!opts.silent) {
      renderLoading(page > 1 ? "Loading more opportunities…" : "Finding opportunities…");
    }

    const res = await fetchJobs({
      keyword: f.kw,
      location: f.loc,
      remote: f.remote,
      page,
      limit: JOB_PAGE_SIZE,
    });
    if (seq !== loadOpps._seq) return; // a newer search superseded this one

    if (!res.ok) {
      const msg = res.status === 429
        ? "You're searching a little too often. Please wait a moment and try again."
        : (res.error || "We couldn't load job opportunities. Please try again.");
      renderOpps([], { page: 1, totalPages: 1, totalCount: 0 }, { isError: true, errorText: msg });
      return;
    }

    // Defence in depth: the backend already pins country=NG, but never render
    // a record that explicitly reports another country.
    const ngJobs = res.jobs.filter(j => !j.countryCode || String(j.countryCode).toUpperCase() === "NG");
    const normalized = ngJobs.map(normalizeLive);

    // Refresh the field dropdown from what actually came back.
    syncFieldOptions(normalized);

    // Re-read filters: syncFieldOptions may have reset the selection.
    const view = applyClientFilters(normalized);
    const filtered = clientFiltersActive();
    // Single source of truth for the current page, so the pager and its
    // handlers can never disagree.
    const currentPage = (res.pagination && res.pagination.page) || page;
    renderOpps(view, res.pagination, {
      filtered,
      emptyText: filtered
        ? "No opportunities found for this search. Try a different keyword or location, or clear the field / experience filters."
        : "No opportunities found for this search. Try a different keyword or location.",
    });
    wirePager(currentPage);
  }

  function wirePager(page) {
    const prev = $("#oppPrev");
    const next = $("#oppNext");
    if (prev) prev.addEventListener("click", () => loadOpps({ page: Math.max(1, page - 1) }));
    if (next) next.addEventListener("click", () => loadOpps({ page: page + 1 }));
  }

  // Explicit Search only — typing or changing a filter never auto-requests.
  const oppSearchBtn = $("#oppSearchBtn");
  if (oppSearchBtn) oppSearchBtn.addEventListener("click", () => loadOpps({ page: 1 }));
  ["#oppKw", "#oppLoc"].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); loadOpps({ page: 1 }); } });
  });
  // These refine the current page locally, so no request is made.
  ["#oppField", "#oppLevel"].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener("change", () => loadOpps({ page: 1, silent: true }));
  });

  /* ---------- 3b. Recommended Opportunities (shares the jobs cache) ---------- */
  function renderReco() {
    const listEl = $("#recoList");
    if (!listEl) return;
    // Uses the same cache entry as the Opportunities default load, so this
    // does not add an extra provider request.
    fetchJobs({ page: 1 }).then((res) => {
      if (!res.ok) { listEl.innerHTML = ""; return; }
      const raw = res.jobs.slice(0, 3);
      listEl.innerHTML = raw.map(o => {
        const company = o.company || "Company not disclosed";
        const location = o.location || [o.city, o.region].filter(Boolean).join(", ") || "Nigeria";
        return `
        <div class="opp-row">
          <div class="opp-row__ic">${esc(String(company).charAt(0).toUpperCase())}</div>
          <div class="opp-row__body"><strong>${esc(o.title || "Untitled")}</strong><small>${esc(company)} · ${esc(location)}</small></div>
          ${o.url ? `<a href="${esc(o.url)}" class="link" target="_blank" rel="noopener">View →</a>` : ""}
        </div>`;
      }).join("");
    }).catch(() => { listEl.innerHTML = ""; });
  }

  /* ---------- 4. CV Optimizer (real backend: /api/cv) ---------- */
  const AUTH_HINT = "auth";

  let currentCv = null;
  // Every CV the signed-in user has uploaded, newest first. The CV library and
  // all delete/replace logic read from the server rather than trusting this
  // array, so the UI can never drift from what is actually stored.
  let cvAll = [];
  // Set while a delete is in flight so a double click cannot send two DELETEs.
  let cvBusy = false;

  function authHeaders() {
    const t = store.get(LS_TOKEN);
    return t ? { "Authorization": "Bearer " + t } : {};
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function apiErrorHint(res) {
    if (!res) return NET_HINT;
    if (res.status === 0) return NET_HINT;
    if (res.status === 408) return "This is taking longer than expected. Please try again.";
    if (res.status === 401) return AUTH_HINT;
    if (res.status === 403) return "You don't have permission to do this. Please sign in again.";
    if (res.status === 404) return "We couldn't find that. Please go back and try again.";
    if (res.status === 413) return "Your file is too large. Please upload a file smaller than 5MB.";
    if (res.status === 422) {
      const msg = String((res.data && (res.data.error || res.data.message)) || "").trim();
      return msg || "We couldn't read that file. Please check it and try again.";
    }
    if (res.status === 429) return "You've made a lot of requests. Please wait a moment and try again.";
    if (res.status >= 500) return "Something went wrong. Please try again.";
    const msg = String((res.data && (res.data.error || res.data.message)) || "").trim();
    return msg || "Something went wrong. Please try again.";
  }

  function authRequiredMarkup(action) {
    return `<strong>Sign in required</strong>${esc(action)} needs your account. Create a free account or sign in, then try again.<br><a class="btn btn--primary btn--sm" style="margin-top:12px" href="#/signin">Sign in</a>`;
  }

  function errorMarkup(msg) {
    return `<strong>Something went wrong</strong>${esc(msg)}`;
  }

  function cvResultArea() {
    const out = $("#cvOut");
    $$("#cvOut .cvlab__demo").forEach(n => n.remove());
    $$("#cvOut .ai-error").forEach(n => n.remove());
    return out;
  }

  function renderCvError(msg) {
    const out = cvResultArea();
    if (!out) return;
    const el = document.createElement("div");
    el.className = "ai-error";
    el.innerHTML = msg === AUTH_HINT ? authRequiredMarkup("CV analysis") : errorMarkup(msg);
    out.appendChild(el);
  }

  function renderCvAnalysis(a) {
    const out = cvResultArea();
    if (!out) return;
    const n = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
    const skillCount = (a.detectedSkills || []).length;
    const bulletCount = (a.bulletPointImprovements || []).length;
    const does = (a.strengths || []).map(s => `<li><span class="ok">✓</span>${esc(s)}</li>`).join("");
    const avoids = (a.weaknesses || []).concat(a.formattingIssues || []).concat(a.experienceIssues || [])
      .map(s => `<li><span class="no">−</span>${esc(s)}</li>`).join("");
    const ats = (a.atsRecommendations || []).map(s => `<li><span class="ok">✓</span>${esc(s)}</li>`).join("");
    const bullets = (a.bulletPointImprovements || []).map(b => `
      <div class="cvlab__bullet"><em>Before</em><p class="old">${esc(b.current || "")}</p>
      <em class="new">After</em><p>${esc(b.suggested || "")}</p>
      ${b.reason ? `<small class="mute" style="display:block;margin-top:4px">${esc(b.reason)}</small>` : ""}</div>`).join("");
    const kw = (a.missingKeywords || []).filter(Boolean);
    const jm = a.jobMatch || null;
    const jmHtml = jm ? `
      <div class="cvlab__group-title">Job match</div>
      ${(jm.matchingSkills || []).length ? `<div class="job-card__tags">${jm.matchingSkills.map(s => `<span class="small-tag">${esc(s)}</span>`).join("")}</div>` : ""}
      ${jm.relevantExperience ? `<p class="mute" style="margin-top:6px">${esc(jm.relevantExperience)}</p>` : ""}
      ${(jm.areasToImprove || []).map(x => `<p class="mute">• ${esc(x)}</p>`).join("")}` : "";

    const el = document.createElement("div");
    el.className = "cvlab__demo";
    el.innerHTML = `
      <div class="cvlab__banner">AI analysis</div>
      <div class="cvlab__scores">
        <div class="cvlab__score cvlab__score--a"><strong>${n(a.overallScore)}</strong><span>Overall score</span></div>
        <div class="cvlab__score cvlab__score--b"><strong>${skillCount}</strong><span>Skills found</span></div>
        <div class="cvlab__score cvlab__score--c"><strong>${bulletCount}</strong><span>Bullets to rewrite</span></div>
      </div>
      ${a.summary ? `<div class="cvlab__group-title">Summary</div><p class="mute">${esc(a.summary)}</p>` : ""}
      ${does ? `<div class="cvlab__group-title">What works</div><ul class="cvlab__ats">${does}</ul>` : ""}
      ${avoids ? `<div class="cvlab__group-title">What to fix</div><ul class="cvlab__ats">${avoids}</ul>` : ""}
      ${ats ? `<div class="cvlab__group-title">ATS tips</div><ul class="cvlab__ats">${ats}</ul>` : ""}
      ${bullets ? `<div class="cvlab__group-title">Bullet rewrites</div>${bullets}` : ""}
      ${kw.length ? `<div class="cvlab__group-title">Keywords to add</div><div class="job-card__tags">${kw.map(k => `<span class="small-tag">${esc(k)}</span>`).join("")}</div>` : ""}
      ${jmHtml}
      <p class="mute" style="font-size:.8rem">Generated securely by Morine's AI.</p>`;
    out.appendChild(el);
  }

  async function loadCvs() {
    const res = await authApi("/api/cv");
    if (res.ok && res.data && res.data.data && Array.isArray(res.data.data.cvs)) {
      return res.data.data.cvs;
    }
    if (res.status === 401) return AUTH_HINT;
    return [];
  }

  function setCurrentCv(cv) {
    currentCv = cv;
    renderCvManager();
  }

  /** Pull the authoritative CV list from the backend and re-render from it. */
  async function refreshCvLibrary(preferredId) {
    const cvs = await loadCvs();
    if (cvs === AUTH_HINT) {
      renderCvError(AUTH_HINT);
      return false;
    }
    cvAll = cvs;
    if (!cvAll.length) {
      currentCv = null;
      renderCvManager();
      return true;
    }
    // Keep the user's current selection when it still exists, otherwise fall
    // back to the newest CV.
    const keep = preferredId && cvAll.find(c => c._id === preferredId);
    const next = keep || cvAll[0];
    const full = await loadCvFull(next._id);
    currentCv = full || next;
    renderCvManager();
    return true;
  }

  /** The list endpoint omits extractedText/analysis/optimizedContent, so fetch
      the full record whenever the selected CV needs to show its results. */
  async function loadCvFull(id) {
    if (!id) return null;
    const res = await authApi("/api/cv/" + encodeURIComponent(id));
    if (res && res.ok && res.data && res.data.data && res.data.data.cv) return res.data.data.cv;
    return null;
  }

  function renderCvLibrary() {
    if (!cvAll.length) return "";
    const rows = cvAll.map(c => {
      const active = currentCv && currentCv._id === c._id;
      const when = c.createdAt ? new Date(c.createdAt).toLocaleString() : "Unknown date";
      const size = c.fileSize ? Math.max(1, Math.round(c.fileSize / 1024)) + " KB" : "";
      return `
        <div class="saved__item${active ? " is-active" : ""}">
          <div class="saved__meta">
            <strong>${esc(c.originalFilename || "Untitled CV")}</strong>
            <span>${esc(String(c.fileType || "").toUpperCase())}${size ? " &middot; " + esc(size) : ""} &middot; Uploaded ${esc(when)}</span>
          </div>
          <div class="saved__actions">
            ${active ? "" : `<button type="button" class="btn btn--ghost" data-cv-open="${esc(c._id)}">Open</button>`}
            <button type="button" class="btn btn--ghost" data-cv-del="${esc(c._id)}" data-cv-name="${esc(c.originalFilename || "this CV")}">Delete</button>
          </div>
        </div>`;
    }).join("");
    return `
      <div class="saved">
        <h2 class="card__title">Your CVs (${cvAll.length})</h2>
        <p class="mute" style="font-size:.82rem;margin:0 0 10px">Open one to review it, or delete just that file. Deleting a CV does not affect your profile, skills or career data.</p>
        ${rows}
      </div>`;
  }

  /**
   * Wire the library rows (Open / Delete) for whichever branch of the manager
   * is on screen. This must run for the "no CV selected" state too: that branch
   * still renders the saved-CV list, and leaving its buttons unbound makes Delete
   * look like it silently does nothing.
   */
  function bindCvLibraryEvents(out) {
    $$("[data-cv-open]", out).forEach(btn => {
      btn.addEventListener("click", () => openCv(btn.dataset.cvOpen));
    });
    $$("[data-cv-del]", out).forEach(btn => {
      btn.addEventListener("click", () => deleteCvById(btn.dataset.cvDel, btn.dataset.cvName));
    });
  }

  function renderCvManager() {
    const out = $("#cvOut");
    if (!out) return;
    const library = renderCvLibrary();

    if (!currentCv) {
      out.innerHTML = `
        ${library}
        <div class="cvlab__empty">
          <span class="cvlab__empty-ic">📄</span>
          <p>${cvAll.length ? "Select a CV above to review it." : "No CV uploaded yet."}</p>
          <p class="mute">${cvAll.length ? "You can delete any saved CV with the Delete button on its row." : "Upload your CV (PDF or DOCX) to get started."}</p>
        </div>`;
      bindCvLibraryEvents(out);
      return;
    }

    const hasAnalysis = currentCv.analysis && Object.keys(currentCv.analysis).length > 0;
    const hasOptimized = currentCv.optimizedContent && currentCv.optimizedContent.trim().length > 0;

    let analysisHtml = "";
    if (hasAnalysis) {
      const a = currentCv.analysis;
      const n = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
      const skillCount = (a.detectedSkills || []).length;
      const bulletCount = (a.bulletPointImprovements || []).length;
      const does = (a.strengths || []).map(s => `<li><span class="ok">✓</span>${esc(s)}</li>`).join("");
      const avoids = (a.weaknesses || []).concat(a.formattingIssues || []).concat(a.experienceIssues || [])
        .map(s => `<li><span class="no">−</span>${esc(s)}</li>`).join("");
      const ats = (a.atsRecommendations || []).map(s => `<li><span class="ok">✓</span>${esc(s)}</li>`).join("");
      const bullets = (a.bulletPointImprovements || []).map(b => `
        <div class="cvlab__bullet"><em>Before</em><p class="old">${esc(b.current || "")}</p>
        <em class="new">After</em><p>${esc(b.suggested || "")}</p>
        ${b.reason ? `<small class="mute" style="display:block;margin-top:4px">${esc(b.reason)}</small>` : ""}</div>`).join("");
      const kw = (a.missingKeywords || []).filter(Boolean);
      const jm = a.jobMatch || null;
      const jmHtml = jm ? `
        <div class="cvlab__group-title">Job match</div>
        ${(jm.matchingSkills || []).length ? `<div class="job-card__tags">${jm.matchingSkills.map(s => `<span class="small-tag">${esc(s)}</span>`).join("")}</div>` : ""}
        ${jm.relevantExperience ? `<p class="mute" style="margin-top:6px">${esc(jm.relevantExperience)}</p>` : ""}
        ${(jm.areasToImprove || []).map(x => `<p class="mute">• ${esc(x)}</p>`).join("")}` : "";

      analysisHtml = `
        <div class="cvlab__demo">
          <div class="cvlab__banner">AI analysis</div>
          <div class="cvlab__scores">
            <div class="cvlab__score cvlab__score--a"><strong>${n(a.overallScore)}</strong><span>Overall score</span></div>
            <div class="cvlab__score cvlab__score--b"><strong>${skillCount}</strong><span>Skills found</span></div>
            <div class="cvlab__score cvlab__score--c"><strong>${bulletCount}</strong><span>Bullets to rewrite</span></div>
          </div>
          ${a.summary ? `<div class="cvlab__group-title">Summary</div><p class="mute">${esc(a.summary)}</p>` : ""}
          ${does ? `<div class="cvlab__group-title">What works</div><ul class="cvlab__ats">${does}</ul>` : ""}
          ${avoids ? `<div class="cvlab__group-title">What to fix</div><ul class="cvlab__ats">${avoids}</ul>` : ""}
          ${ats ? `<div class="cvlab__group-title">ATS tips</div><ul class="cvlab__ats">${ats}</ul>` : ""}
          ${bullets ? `<div class="cvlab__group-title">Bullet rewrites</div>${bullets}` : ""}
          ${kw.length ? `<div class="cvlab__group-title">Keywords to add</div><div class="job-card__tags">${kw.map(k => `<span class="small-tag">${esc(k)}</span>`).join("")}</div>` : ""}
          ${jmHtml}
          <p class="mute" style="font-size:.8rem">Generated securely by Morine's AI.</p>
        </div>`;
    }

    let optimizedHtml = "";
    if (hasOptimized) {
      optimizedHtml = `
        <div class="cvlab__group-title">Optimized CV</div>
        <div class="cvlab__optimized">
          <pre class="cvlab__optimized-text">${esc(currentCv.optimizedContent)}</pre>
          <div class="cvlab__actions">
            <button class="btn btn--primary" id="cvDownloadBtn">Download Optimized CV</button>
          </div>
        </div>`;
    }

    const uploadDate = currentCv.createdAt ? new Date(currentCv.createdAt).toLocaleString() : "Unknown";

    out.innerHTML = `
      ${library}
      <div class="cvlab__current">
        <div class="cvlab__current-header">
          <div class="cvlab__current-info">
            <strong>${esc(currentCv.originalFilename)}</strong>
            <span class="mute">${esc(currentCv.fileType?.toUpperCase())} · ${esc(String(currentCv.fileSize || 0))} bytes · Uploaded ${esc(uploadDate)}</span>
          </div>
          <div class="cvlab__current-actions">
            <button type="button" class="btn btn--ghost btn--sm" id="cvReplaceBtn">Replace CV</button>
            <button type="button" class="btn btn--danger btn--sm" id="cvDeleteBtn">Delete CV</button>
          </div>
        </div>
      </div>
      <div class="cvlab__divider"></div>
      <div class="cvlab__input card">
        <h2 class="card__title">2 · Target job description</h2>
        <textarea id="cvMgrJobDesc" rows="5" placeholder="Paste a job description to compare keywords and required skills...">${esc(currentCv.jobDescription || "")}</textarea>
        <div class="cvlab__actions">
          ${!hasAnalysis ? `<button class="btn btn--primary" id="cvMgrAnalyzeBtn">Analyze CV</button>` : ""}
          ${hasAnalysis && !hasOptimized ? `<button class="btn btn--primary" id="cvMgrOptimizeBtn">Optimize CV</button>` : ""}
        </div>
      </div>
      ${analysisHtml}
      ${optimizedHtml}
    `;

    // Bind events
    const replaceBtn = $("#cvReplaceBtn");
    if (replaceBtn) replaceBtn.addEventListener("click", () => handleReplaceCv());

    const deleteBtn = $("#cvDeleteBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", () => handleDeleteCv());

    // Library rows: open a specific CV, or delete just that one.
    bindCvLibraryEvents(out);

    const analyzeBtn = $("#cvMgrAnalyzeBtn");
    if (analyzeBtn) analyzeBtn.addEventListener("click", () => handleAnalyzeCv());

    const optimizeBtn = $("#cvMgrOptimizeBtn");
    if (optimizeBtn) optimizeBtn.addEventListener("click", () => handleOptimizeCv());

    const downloadBtn = $("#cvDownloadBtn");
    if (downloadBtn) downloadBtn.addEventListener("click", () => handleDownloadOptimizedCv());

    // Update job description on change
    const jobDesc = $("#cvMgrJobDesc");
    if (jobDesc) {
      jobDesc.addEventListener("change", async () => {
        currentCv.jobDescription = jobDesc.value;
        const res = await authApi("/api/cv/" + currentCv._id, {
          method: "PUT",
          body: JSON.stringify({ jobDescription: jobDesc.value })
        });
        if (!res.ok) console.warn("Failed to update job description");
      });
    }
  }

  async function openCv(id) {
    if (!id) return;
    const full = await loadCvFull(id);
    if (!full) { toast("We couldn't open that CV. Please try again.", false); return; }
    setCurrentCv(full);
  }

  /**
   * Delete exactly one CV, then rebuild the view from the server.
   * Only this CV is removed: profile, skills, analyses and career data are
   * untouched, and the account stays intact.
   */
  async function deleteCvById(id, name) {
    if (!id) return;
    // Guard against a double click firing two DELETEs for the same document.
    if (cvBusy) return;
    const ok = await confirmAction({
      title: "Delete this CV?",
      message: "This permanently removes the file and its saved analysis. This cannot be undone.",
      scope: (name || "This CV") + " — your profile, skills and career data are not affected.",
      confirmLabel: "Delete CV"
    });
    if (!ok) return;
    cvBusy = true;
    try {
      const res = await authApi("/api/cv/" + encodeURIComponent(id), { method: "DELETE" });
      if (!res || !res.ok) {
        // Nothing is removed locally unless the server confirmed the delete, so
        // a failure can never look like a successful removal.
        renderCvError(apiErrorHint(res));
        toast(apiErrorHint(res), false);
        return;
      }
      // Drop the local reference immediately, then re-read the authoritative list
      // from the backend so the UI can neither show a CV that is gone nor hide
      // one that still exists.
      cvAll = cvAll.filter(c => c._id !== id);
      if (currentCv && currentCv._id === id) currentCv = null;
      await refreshCvLibrary(cvAll.length ? cvAll[0]._id : null);
      toast("Your CV was deleted.", true);
    } catch (e) {
      renderCvError(NET_HINT);
      toast(NET_HINT, false);
    } finally {
      cvBusy = false;
    }
  }

  /**
   * "Replace CV" uploads the newly chosen file and then removes the CV it
   * supersedes, so the old one can never resurface as the newest CV later.
   * The button only opens the file picker; the upload runs from the file input's
   * change event, which is the only point at which the chosen file exists.
   */
  let cvReplacePending = false;
  const cvFileInput = $("#cvFile");

  /* Cancelling a file picker fires no event at all, so the pending flag set by
   * handleReplaceCv() would survive and misroute the NEXT unrelated file
   * selection into the destructive replace-and-delete flow.
   *
   * It is cleared on the next click anywhere in the capture phase rather than
   * on window focus: a `change` event from a successful pick is always
   * delivered before the user can click again, so this can never preempt a
   * real selection - and unlike focus it does not depend on whether a given
   * browser fires focus before or after change, which differs between iOS
   * Safari and Chrome. The Replace button arms the flag in its own click
   * handler, which runs after this capture listener. */
  document.addEventListener("click", (e) => {
    /* handleReplaceCv() opens the picker with input.click(), which dispatches a
     * synthetic click on the input that bubbles up to here. That click is part
     * of the replace flow itself, so it must not cancel the intent it just
     * armed. */
    if (cvFileInput && e.target === cvFileInput) return;
    cvReplacePending = false;
  }, true);

  async function runReplaceCv(file) {
    const previous = currentCv;
    if (previous) {
      const ok = await confirmAction({
        title: "Replace your current CV?",
        message: "The new file is uploaded and your previous CV is deleted. This cannot be undone.",
        scope: "Replaces \u201c" + (previous.originalFilename || "your current CV") + "\u201d only. Your profile and other CVs are kept.",
        confirmLabel: "Replace CV"
      });
      if (!ok) return;
    }
    const btn = $("#cvReplaceBtn");
    if (btn) btn.classList.add("is-loading");
    try {
      const up = await uploadCV(file);
      if (!up.ok || !up.data || !up.data.data || !up.data.data.cv) {
        renderCvError(apiErrorHint(up));
        return;
      }
      const newId = up.data.data.cv._id;
      // Only drop the superseded record once the replacement is safely stored.
      if (previous && previous._id && previous._id !== newId) {
        const del = await authApi("/api/cv/" + encodeURIComponent(previous._id), { method: "DELETE" });
        if (!del || !del.ok) {
          // The new CV is saved but the old one is still there. Say so plainly
          // instead of implying the replacement finished.
          renderCvError("Your new CV was saved, but we couldn't remove the old one. Use Delete on its row to remove it.");
          toast("Your new CV was saved, but we couldn't remove the old one.", false);
        }
      }
      await refreshCvLibrary(newId);
      toast("Your CV has been replaced.", true);
    } catch (e) {
      renderCvError(NET_HINT);
    } finally {
      if (btn) btn.classList.remove("is-loading");
    }
  }

  function handleReplaceCv() {
    const input = $("#cvFile");
    if (!input) return;
    cvReplacePending = true;
    /* Clear the selection before opening the picker. Browsers only fire a
     * change event when the new value differs from the old one, so picking the
     * SAME file twice in a row would otherwise silently do nothing. */
    input.value = "";
    input.click();
  }

  async function handleDeleteCv() {
    if (!currentCv) return;
    await deleteCvById(currentCv._id, currentCv.originalFilename);
  }

  async function handleAnalyzeCv() {
    if (!currentCv) return;
    const target = ($("#cvMgrJobDesc") || $("#cvJobDesc") || { value: "" }).value;
    const btn = $("#cvMgrAnalyzeBtn");
    if (btn) btn.classList.add("is-loading");
    try {
      const res = await authApi("/api/cv/" + currentCv._id + "/analyze", {
        method: "POST",
        body: JSON.stringify({ jobDescription: target }),
        timeout: CV_AI_TIMEOUT_MS
      });
      if (res.ok && res.data && res.data.data && res.data.data.analysis) {
        currentCv.analysis = res.data.data.analysis;
        currentCv.jobDescription = target;
        renderCvManager();
        toast("Your CV has been analyzed.", true);
      } else {
        renderCvError(apiErrorHint(res));
      }
    } catch (e) {
      renderCvError(NET_HINT);
    } finally {
      if (btn) btn.classList.remove("is-loading");
    }
  }

  async function handleOptimizeCv() {
    if (!currentCv) return;
    const btn = $("#cvMgrOptimizeBtn");
    if (btn) btn.classList.add("is-loading");
    try {
      const res = await authApi("/api/cv/" + currentCv._id + "/optimize", { method: "POST", timeout: CV_AI_TIMEOUT_MS });
      if (res.ok && res.data && res.data.data && res.data.data.optimizedContent) {
        currentCv.optimizedContent = res.data.data.optimizedContent;
        renderCvManager();
        toast("Your CV has been improved.", true);
      } else {
        renderCvError(apiErrorHint(res));
      }
    } catch (e) {
      renderCvError(NET_HINT);
    } finally {
      if (btn) btn.classList.remove("is-loading");
    }
  }

  function handleDownloadOptimizedCv() {
    if (!currentCv || !currentCv.optimizedContent) return;
    const blob = new Blob([currentCv.optimizedContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Morine-Optimized-CV.txt";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    /* Revoking the object URL synchronously cancels the download on iOS Safari
       and some Android browsers, because the navigation to the blob URL has
       not started yet. Keep it alive briefly, then clean up. Desktop
       downloads are unaffected because the click has already been handled. */
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
    toast("Your improved CV has been downloaded.", true);
  }

  /* CV upload transfers up to 5MB and parses it; a slow mobile connection can
     take well over the 30s default, so give it its own budget. */
  const CV_UPLOAD_TIMEOUT_MS = 60000;

  /* Analyze and Optimize call Gemini, which the backend will retry up to three
     times with a 120s ceiling per attempt plus backoff (~364s worst case).
     The client must outlast that: otherwise the browser aborts, the user is
     told "Request timed out", and the server silently finishes the analysis
     anyway. This constant is derived from that server-side budget. */
  const CV_AI_TIMEOUT_MS = 390000;

  async function initCvOptimizer() {
    // Always read the authoritative list from the backend on entry, so a
    // refresh can never resurrect a deleted CV.
    await refreshCvLibrary();
  }

  function validateCvFile(file) {
    if (!file) return { valid: false, error: "Please choose a CV file first." };
    /* Only PDF and DOCX are supported. Legacy .doc (application/msword) is
       deliberately excluded: the backend cannot parse it, so accepting it here
       would only produce a confusing failure later. The MIME type is treated as
       a hint, never as the deciding factor, because mobile browsers routinely
       report an empty or application/octet-stream type for ordinary PDFs and
       DOCX files; the backend inspects the actual bytes and is authoritative. */
    const allowedTypes = [
      "application/pdf",
      "application/x-pdf",
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const allowedExtensions = ["pdf", "docx"];
    const extension = (file.name.split(".").pop() || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    const isValidType =
      allowedExtensions.includes(extension) ||
      allowedTypes.includes(type) ||
      type.includes("pdf") ||
      type.includes("wordprocessingml");
    if (!isValidType) {
      return { valid: false, error: "Please upload your CV as a PDF or DOCX file." };
    }
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return { valid: false, error: "Your CV is too large. Please upload a file smaller than 5MB." };
    }
    return { valid: true };
  }

  async function uploadCV(file) {
    const validation = validateCvFile(file);
    if (!validation.valid) {
      return { ok: false, status: 400, data: { error: validation.error } };
    }
    const fd = new FormData();
    fd.append("cv", file);
    return await authApi("/api/cv/upload", { method: "POST", body: fd, timeout: CV_UPLOAD_TIMEOUT_MS });
  }

  async function latestCvId() {
    const res = await authApi("/api/cv");
    if (res.ok && res.data && res.data.data && Array.isArray(res.data.data.cvs) && res.data.data.cvs.length) {
      return res.data.data.cvs[0]._id;
    }
    if (res.status === 401) return AUTH_HINT;
    return null;
  }

$("#cvAnalyzeBtn") && $("#cvAnalyzeBtn").addEventListener("click", function () {
    const file = $("#cvFile") && $("#cvFile").files && $("#cvFile").files[0];
    const target = ($("#cvJobDesc") || { value: "" }).value;
    if (!file) {
      toast("Please choose a CV file first.", false);
      return;
    }
    const validation = validateCvFile(file);
    if (!validation.valid) {
      toast(validation.error, false);
      return;
    }
    this.classList.add("is-loading");
    (async () => {
      try {
        const up = await uploadCV(file);
        if (!up.ok || !up.data || !up.data.data || !up.data.data.cv) {
          renderCvError(apiErrorHint(up));
          return;
        }
        const cvId = up.data.data.cv._id;
        const res = await authApi("/api/cv/" + cvId + "/analyze", {
          method: "POST",
          body: JSON.stringify({ jobDescription: target })
        });
        if (res.ok && res.data && res.data.data && res.data.data.analysis) {
          const cv = await (async () => {
            const r = await authApi("/api/cv/" + cvId);
            return r.ok && r.data && r.data.data && r.data.data.cv ? r.data.data.cv : null;
          })();
          if (cv) {
            // Keep the library in step with the new upload.
            cvAll = [cv].concat(cvAll.filter(x => x._id !== cv._id));
            setCurrentCv(cv);
            toast("Your CV has been analyzed.", true);
          } else {
            renderCvError("We couldn't load your CV. Please try again.");
          }
        } else {
          renderCvError(apiErrorHint(res));
        }
      } catch (e) {
        renderCvError(NET_HINT);
      } finally {
        this.classList.remove("is-loading");
      }
    })();
  });

  /* The upload zone is a <label> that NESTS #cvFile, so the browser already
     forwards a tap on it to the file input. Adding a click handler that also
     called input.click() was the reason uploads failed on iPhone: the label's
     own activation and the explicit click() each opened the picker, and the
     synthetic click bubbled back into the same handler and re-entered it.
     iOS Safari rejects a second picker activation inside one user gesture, so
     the picker opened and closed again and no file was ever selected. There is
     deliberately NO click handler here: native label activation is the only
     path that opens the picker, and it fires exactly once. */
  const cvDrop = $("#cvDrop");
  if (cvDrop) {
    cvDrop.addEventListener("dragover", e => { e.preventDefault(); cvDrop.classList.add("is-drag"); });
    cvDrop.addEventListener("dragleave", () => cvDrop.classList.remove("is-drag"));
    cvDrop.addEventListener("drop", e => {
      e.preventDefault();
      cvDrop.classList.remove("is-drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const validation = validateCvFile(f);
      if (!validation.valid) {
        toast(validation.error, false);
        return;
      }
      /* Stage the dropped file on the real input, so "Analyze CV" reads the
         same single source of truth as a picker selection. Assigning
         input.files does not fire a change event, so the label is updated here
         to keep the visible state honest. */
      const input = $("#cvFile");
      if (!input) return;
      let attached = false;
      if (typeof DataTransfer === "function") {
        try {
          const dt = new DataTransfer();
          dt.items.add(f);
          input.files = dt.files;
          attached = !!(input.files && input.files.length);
        } catch (e) { /* handled by the fallback below */ }
      }
      /* DataTransfer is unimplemented in Safari, and iOS has no drag and drop
         at all, so there is no input to stage the file on. Say so instead of
         silently doing nothing: tapping the zone opens the picker, which works
         everywhere. */
      if (!attached) {
        toast("This browser can't attach a dropped file. Tap the upload area and choose the file instead.", false);
        return;
      }
      const label = $("#cvDropLabel");
      if (label) label.textContent = "Selected: " + f.name;
    });
  }
  $("#cvFile") && $("#cvFile").addEventListener("change", function () {
    const file = this.files && this.files[0];
    const label = $("#cvDropLabel");
    if (label && file) label.textContent = "Selected: " + file.name;
    if (!file) return;
    uploadCvFile(file, this);
  });

  /* Single entry point for a newly chosen or dropped file. Selecting a file
     does not upload it: the file is staged in the input and the user presses
     "Analyze CV" (which uploads, then analyzes) so an accidental tap on the
     upload zone never spends an AI request. The only exception is a
     replacement, which must upload immediately to complete the swap. */
  function uploadCvFile(file, input) {
    const label = $("#cvDropLabel");
    if (!file) return;

    const validation = validateCvFile(file);
    if (!validation.valid) {
      toast(validation.error, false);
      if (input) input.value = "";
      if (label) label.textContent = "Drop PDF or DOCX here, or click to browse";
      return;
    }

    if (cvReplacePending) {
      cvReplacePending = false;
      if (input) input.value = "";
      runReplaceCv(file);
    }
  }

  /* ---------- 5. Skill Gap (real backend: /api/skill-gap/analyze) ---------- */
  const sgListEl = $("#sgList");
  const sgHistory = $("#sgHistory");
  let sgAnalyses = [];
  let sgActiveId = null;

  function renderGapError(msg) {
    const out = $("#sgOut");
    if (!out) return;
    const el = document.createElement("div");
    el.className = "ai-error";
    el.innerHTML = msg === AUTH_HINT ? authRequiredMarkup("Skill Gap analysis") : errorMarkup(msg);
    out.innerHTML = "";
    out.appendChild(el);
  }

  function sgEmptyState() {
    const out = $("#sgOut");
    if (out) out.innerHTML = "";
  }

  function renderSgList() {
    if (!sgListEl) return;
    if (!sgAnalyses.length) {
      if (sgHistory) sgHistory.hidden = true;
      sgListEl.innerHTML = "";
      return;
    }
    if (sgHistory) sgHistory.hidden = false;
    sgListEl.innerHTML = sgAnalyses.map(a => {
      const when = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : "";
      const gaps = (a.skillGaps || []).length;
      const active = sgActiveId === a._id;
      return `<div class="saved__item${active ? " is-active" : ""}">
        <div class="saved__meta">
          <strong>${esc(a.targetRole || "Skill gap analysis")}</strong>
          <span>${esc(String(a.overallReadiness || 0))}% readiness &middot; ${gaps} gap${gaps === 1 ? "" : "s"}${when ? " &middot; " + esc(when) : ""}</span>
        </div>
        <div class="saved__actions">
          ${active ? "" : `<button type="button" class="btn btn--ghost" data-sg-open="${esc(a._id)}">View</button>`}
          <button type="button" class="btn btn--danger" data-sg-del="${esc(a._id)}" data-sg-role="${esc(a.targetRole || "this analysis")}">Remove</button>
        </div>
      </div>`;
    }).join("");
    bindSgListEvents();
  }

  function bindSgListEvents() {
    if (!sgListEl) return;
    $$("[data-sg-open]", sgListEl).forEach(b => b.addEventListener("click", () => viewSg(b.dataset.sgOpen)));
    $$("[data-sg-del]", sgListEl).forEach(b => b.addEventListener("click", () => deleteSg(b.dataset.sgDel, b.dataset.sgRole)));
  }

  async function loadSgList() {
    const res = await authApi("/api/skill-gap");
    if (res && res.ok && res.data && res.data.data && Array.isArray(res.data.data.analyses)) {
      sgAnalyses = res.data.data.analyses;
    } else {
      sgAnalyses = [];
    }
    renderSgList();
    return sgAnalyses;
  }

  async function viewSg(id) {
    if (!id) return;
    const res = await authApi("/api/skill-gap/" + encodeURIComponent(id));
    if (res && res.ok && res.data && res.data.data && res.data.data.analysis) {
      sgActiveId = id;
      renderGapAnalysis(res.data.data.analysis);
      renderSgList();
    } else {
      toast(apiErrorHint(res), false);
    }
  }

  /**
   * Remove one stored skill-gap result. This deletes only the analysis record;
   * the user's skills, CV and profile are untouched.
   */
  async function deleteSg(id, role) {
    if (!id) return;
    const ok = await confirmAction({
      title: "Remove this skill gap result?",
      message: "This deletes the saved analysis. Your skills and profile are kept.",
      scope: "For \u201c" + (role || "this analysis") + "\u201d. You can run a new analysis at any time.",
      confirmLabel: "Remove"
    });
    if (!ok) return;
    const res = await authApi("/api/skill-gap/" + encodeURIComponent(id), { method: "DELETE" });
    if (res && res.ok) {
      if (sgActiveId === id) { sgActiveId = null; sgEmptyState(); }
      await loadSgList();
      toast("Your skill gap result was deleted.", true);
    } else {
      toast(apiErrorHint(res), false);
    }
  }

  function renderGapAnalysis(a) {
    const out = $("#sgOut");
    if (!out) return;
    const prioCls = p => (p === "High" ? "high" : p === "Low" ? "low" : "mid");
    const gaps = (a.skillGaps || []).map(g => `
      <div class="sg__gap">
        <div class="sg__gap-text"><strong>${esc(g.skill)}</strong><small>${esc(g.reason || "Gap to close")}</small>
        ${g.recommendedAction ? `<small class="mute" style="display:block;margin-top:2px">→ ${esc(g.recommendedAction)}</small>` : ""}</div>
        <span class="sg__gap-prio ${prioCls(g.priority)}">${String(g.priority || "Medium").toLowerCase()}</span>
      </div>`).join("");
    const roadmap = (a.roadmap || []).map(r => `
      <div class="cvlab__group-title">Stage ${r.stage} — ${esc(r.title)}</div>
      ${(r.skills || []).length ? `<div class="job-card__tags">${r.skills.map(s => `<span class="small-tag">${esc(s)}</span>`).join("")}</div>` : ""}
      ${(r.actions || []).map(x => `<p class="mute">• ${esc(x)}</p>`).join("")}
      ${r.projectIdea ? `<p class="mute" style="margin-top:4px"><strong>Project:</strong> ${esc(r.projectIdea)}</p>` : ""}`).join("");
    const cur = (a.currentSkills || []).filter(Boolean);
    const req = (a.requiredSkills || []).filter(Boolean);
    const stay = cur.length ? `<div class="cvlab__group-title">Keep these current skills</div><div class="job-card__tags">${cur.map(s => `<span class="small-tag">${esc(s)}</span>`).join("")}</div>` : "";
    const need = req.length ? `<div class="cvlab__group-title">Required for ${esc(a.targetRole || "target role")}</div><div class="job-card__tags">${req.map(s => `<span class="small-tag">${esc(s)}</span>`).join("")}</div>` : "";
    out.innerHTML = `
      <div class="sg__ready">
        <div class="cv-score__ring" style="--p:${a.overallReadiness || 0}"><span>${a.overallReadiness || 0}%</span></div>
        <div><strong>You're ${a.overallReadiness || 0}% ready for ${esc(a.targetRole || "your target role")}</strong>
        <p>${esc(a.summary || "Quick gap map to close the difference.")}</p></div>
      </div>
      ${stay}
      ${need}
      <div class="cvlab__group-title">Skill gaps</div>
      <div class="sg__gaps">${gaps || `<p class="mute">No gaps identified.</p>`}</div>
      ${roadmap}
      <div class="cvlab__actions" style="margin-top:16px">
        ${a._id ? `<button type="button" class="btn btn--danger btn--sm" data-sg-del="${esc(a._id)}" data-sg-role="${esc(a.targetRole || "this analysis")}">Clear this result</button>` : ""}
      </div>
      <p class="mute" style="font-size:.8rem">AI gap analysis</p>`;
    if (a._id) {
      sgActiveId = a._id;
      $$("[data-sg-del]", out).forEach(b =>
        b.addEventListener("click", () => deleteSg(b.dataset.sgDel, b.dataset.sgRole)));
    }
  }

  $("#sgAnalyzeBtn") && $("#sgAnalyzeBtn").addEventListener("click", function () {
    const target = ($("#sgTarget") || { value: "" }).value;
    if (!String(target).trim()) {
      renderGapError("Please choose a target role first — we use it to measure your gap.");
      toast("Please choose a target role.", false);
      return;
    }
    this.classList.add("is-loading");
authApi("/api/skill-gap/analyze", {
       method: "POST",
       body: JSON.stringify({ targetRole: String(target).trim() })
     }).then(res => {
      this.classList.remove("is-loading");
      if (res.ok && res.data && res.data.data && res.data.data.analysis) {
        renderGapAnalysis(res.data.data.analysis);
        // The backend returns the stored record, so remember its id and pull
        // the authoritative saved list.
        sgActiveId = res.data.data.analysis._id || null;
        toast("Your skill gap analysis is ready.", true);
        loadSgList();
      } else {
        renderGapError(apiErrorHint(res));
      }
    });
  });

  /* ---------- 5b. Career Path Discovery (real backend: /api/career-path) ---------- */
  const cpOut = $("#cpOut");
  const cpList = $("#cpList");
  const cpTarget = $("#cpTarget");
  const cpHistory = $("#cpHistory");
  const cpProfileHint = $("#cpProfileHint");
  const cpAnalyzeBtn = $("#cpAnalyzeBtn");
  let cpPaths = [];
  let cpActiveId = null;
  let cpServerRole = "";

  function cpEmptyState() {
    if (!cpOut) return;
    cpOut.innerHTML = `<div class="cp__empty card">
      <div class="cp__empty-ic">&#128640;</div>
      <h2 class="card__title">No career path yet</h2>
      <p class="mute">Enter a target role above and Morine maps the stages, skills and milestones between you and that role.</p>
    </div>`;
  }

  function cpLoadingState() {
    if (!cpOut) return;
    cpOut.innerHTML = `<div class="cp__empty card">
      <div class="cp__empty-ic">&#9889;</div>
      <h2 class="card__title">Mapping your path&hellip;</h2>
      <p class="mute">Reading your Profile, CV and skill gap, then building stages and milestones.</p>
    </div>`;
  }

  function cpChips(list) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return "";
    return `<div class="cp__chips">${arr.map(s => `<span class="cp__chip">${esc(s)}</span>`).join("")}</div>`;
  }

  function cpBullets(list, emptyText) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return emptyText ? `<p class="mute">${esc(emptyText)}</p>` : "";
    return `<ul class="cp__list-plain">${arr.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
  }

  function cpListBlock(title, list, emptyText) {
    if (!Array.isArray(list) || !list.length) return emptyText ? `<div class="cp__sub">${esc(title)}</div>${cpBullets([], emptyText)}` : "";
    return `<div class="cp__sub">${esc(title)}</div>${cpBullets(list, "")}`;
  }

  function renderCp(p) {
    if (!cpOut || !p) return;
    const stages = Array.isArray(p.stages) ? p.stages : [];
    const milestones = Array.isArray(p.milestones) ? p.milestones : [];
    const alts = Array.isArray(p.alternativeRoles) ? p.alternativeRoles : [];
    const next = Array.isArray(p.nextSteps) ? p.nextSteps : [];
    const current = Array.isArray(p.currentSkills) ? p.currentSkills : [];
    const readiness = Number.isFinite(Number(p.readiness)) ? Math.min(100, Math.max(0, Number(p.readiness))) : 0;
    const role = p.destinationRole || p.targetRole || "your target role";

    const stageHtml = stages.map(s => {
      const n = Number(s && s.stage) || 0;
      return `<article class="cp__stage">
        <div class="cp__stage-head">
          <span class="cp__stage-num">${n || "-"}</span>
          <h4 class="cp__stage-title">${esc((s && s.title) || "Stage " + (n || ""))}</h4>
          ${s && s.estimatedDuration ? `<span class="cp__stage-dur">${esc(s.estimatedDuration)}</span>` : ""}
        </div>
        ${s && s.objective ? `<p class="cp__stage-obj">${esc(s.objective)}</p>` : ""}
        ${cpListBlock("Skills to build", s && s.skills, "No skills listed for this stage.")}
        ${cpListBlock("Actions", s && s.actions, "")}
        ${cpListBlock("Project ideas", s && s.projectIdeas, "")}
        ${cpListBlock("Experience", s && s.experienceIdeas, "")}
        ${s && s.milestone ? `<div class="cp__sub">Milestone</div><p class="mute">${esc(s.milestone)}</p>` : ""}
      </article>`;
    }).join("");

    const mileHtml = milestones.map(m => `<div class="cp__mile">
      <b>${esc(m.title)}</b>
      ${m.description ? `<span>${esc(m.description)}</span>` : ""}
      ${m.completionCriteria ? `<div class="cp__sub">Done when</div><p class="mute">${esc(m.completionCriteria)}</p>` : ""}
      ${cpChips(m.skills)}
    </div>`).join("");

    const altHtml = alts.map(a => `<div class="cp__alt">
      <b>${esc(a.title)}</b>
      ${a.reason ? `<span>${esc(a.reason)}</span>` : ""}
    </div>`).join("");

    cpOut.innerHTML = `<div class="cp__result">
      <div class="cp__hero">
        <div class="cv-score__ring" style="--p:${readiness}"><span>${readiness}%</span></div>
        <div>
          <strong>${readiness}% ready for ${esc(role)}</strong>
          <p>${esc(p.summary || "")}</p>
          <div class="cp__route">
            ${p.startingPoint ? `<span>From <b>${esc(p.startingPoint)}</b></span><span aria-hidden="true">&rarr;</span>` : ""}
            <span>To <b>${esc(role)}</b></span>
          </div>
        </div>
      </div>

      <div class="cp__panel">
        <h3 class="card__title">Your stages</h3>
        ${current.length ? `<div class="cp__sub">Skills you already have</div>${cpChips(current)}` : ""}
        <div class="cp__stages"${current.length ? ' style="margin-top:14px"' : ""}>${stageHtml || `<p class="mute">No stages were returned for this role.</p>`}</div>
      </div>

      ${milestones.length ? `<div class="cp__panel"><h3 class="card__title">Milestones</h3><div class="cp__milestones" style="margin-top:12px">${mileHtml}</div></div>` : ""}
      ${alts.length ? `<div class="cp__panel"><h3 class="card__title">Roles worth considering</h3><div class="cp__alts" style="margin-top:12px">${altHtml}</div></div>` : ""}
      ${next.length ? `<div class="cp__panel"><h3 class="card__title">Do this next</h3>${cpBullets(next, "")}</div>` : ""}

      <p class="cp__model">AI career path &middot; ${p.createdAt ? "generated " + new Date(p.createdAt).toLocaleString() : "just generated"}</p>
    </div>`;
  }

  function renderCpError(msg) {
    if (!cpOut) return;
    let inner;
    if (msg === AUTH_HINT) inner = authRequiredMarkup("Career Path Discovery");
    else if (/career profile/i.test(msg)) inner = `<strong>Career Profile needed</strong>${esc(msg)}<div style="margin-top:12px"><a class="btn btn--primary btn--sm" href="#/profile">Go to Profile</a></div>`;
    else inner = errorMarkup(msg);
    cpOut.innerHTML = `<div class="ai-error">${inner}</div>`;
  }

  function renderCpList() {
    if (!cpList) return;
    if (cpHistory) cpHistory.hidden = !cpPaths.length;
    if (!cpPaths.length) { cpList.innerHTML = `<p class="mute">No saved career paths yet.</p>`; return; }
    cpList.innerHTML = cpPaths.map(p => {
      const d = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "";
      const r = Number(p.readiness) || 0;
      const dest = p.destinationRole ? "Target: " + p.destinationRole + " &middot; " : "";
      return `<div class="cp__item${p._id === cpActiveId ? " is-active" : ""}">
        <div class="cp__item-main">
          <div class="cp__item-role">${esc(p.targetRole || "Career path")}</div>
          <div class="cp__item-meta">${dest}${r}% ready &middot; ${esc(d)}</div>
        </div>
        <div class="cp__item-actions">
          <button type="button" class="btn btn--ghost btn--sm" data-cp-view="${esc(p._id)}">View</button>
          <button type="button" class="btn btn--ghost btn--sm" data-cp-del="${esc(p._id)}">Remove</button>
        </div>
      </div>`;
    }).join("");
  }

  async function loadCpList() {
    const res = await authApi("/api/career-path?limit=20");
    const paths = res && res.ok && res.data && res.data.data && res.data.data.paths;
    cpPaths = Array.isArray(paths) ? paths : [];
    renderCpList();
    return cpPaths;
  }

  async function loadCpOne(id) {
    if (!id) return;
    const res = await authApi("/api/career-path/" + encodeURIComponent(id));
    if (res && res.ok && res.data && res.data.data && res.data.data.path) {
      cpActiveId = id;
      renderCp(res.data.data.path);
      renderCpList();
    } else {
      renderCpError(apiErrorHint(res));
    }
  }

  async function deleteCp(id) {
    if (!id) return;
    const item = cpPaths.find(p => p._id === id);
    const label = (item && item.targetRole) ? item.targetRole : "this career path result";
    const ok = await confirmAction({
      title: "Remove this career path result?",
      message: "This removes the saved roadmap. You can generate a new one at any time.",
      scope: "For \u201c" + label + "\u201d. Your profile, CV and skill data are not affected.",
      confirmLabel: "Remove"
    });
    if (!ok) return;
    const res = await authApi("/api/career-path/" + encodeURIComponent(id), { method: "DELETE" });
    if (res && res.ok) {
      cpPaths = cpPaths.filter(p => p._id !== id);
      if (cpActiveId === id) { cpActiveId = null; cpEmptyState(); }
      // Re-read the saved list from the backend so the panel matches the server.
      await loadCpList();
      renderCpList();
      toast("Your career path was deleted.", true);
    } else {
      toast(apiErrorHint(res), false);
    }
  }

  function cpSyncHint() {
    if (!cpProfileHint) return;
    // Prefer the Profile form value (what the user sees), then the local draft,
    // then the account's saved server profile. The backend independently falls
    // back to the saved profile target role, so this only aids the UI.
    const localRole = String((($("#pfRole") && $("#pfRole").value) || "")).trim();
    const serverRole = cpServerRole;
    const profRole = localRole || cpDraftRole() || serverRole;
    if (cpTarget && !cpTarget.value.trim() && profRole) cpTarget.placeholder = profRole;
    cpProfileHint.innerHTML = profRole
      ? `Leave blank to use <b>${esc(profRole)}</b> from your Profile. <button type="button" data-cp-use-profile>Use it</button>`
      : `Add a target role in your <a href="#/profile">Profile</a> to reuse it here.`;
  }

  function cpDraftRole() {
    // Ownership-gated: a draft belonging to another account must never be read
    // here as this account's target role.
    const d = profileDraft();
    return d && d.pfRole ? String(d.pfRole).trim() : "";
  }

  function cpLoadServerRole() {
    authApi("/api/profile")
      .then(res => {
        if (!res.ok || !res.data || !res.data.data) return;
        const p = res.data.data.profile || res.data.data;
        const role = p && p.targetRole ? String(p.targetRole).trim() : "";
        if (role && role !== cpServerRole) {
          cpServerRole = role;
          if (cpActiveId === null) cpSyncHint();
        }
      })
      .catch(() => { /* hint is cosmetic; generation still falls back server-side */ });
  }

  async function handleCpAnalyze() {
    const role = String((cpTarget && cpTarget.value) || "").trim();
    if (cpAnalyzeBtn) cpAnalyzeBtn.classList.add("is-loading");
    cpLoadingState();
    const res = await authApi("/api/career-path/analyze", {
      method: "POST",
      body: JSON.stringify(role ? { targetRole: role } : {})
    });
    if (cpAnalyzeBtn) cpAnalyzeBtn.classList.remove("is-loading");
    const path = res && res.ok && res.data && res.data.data && res.data.data.path;
    if (path) {
      cpActiveId = path._id;
      cpPaths = [path].concat(cpPaths.filter(p => p._id !== path._id));
      renderCp(path);
      renderCpList();
      toast("Your career path is ready.", true);
    } else {
      renderCpError(apiErrorHint(res));
    }
  }

  if (cpAnalyzeBtn) cpAnalyzeBtn.addEventListener("click", handleCpAnalyze);
  if (cpList) cpList.addEventListener("click", e => {
    const v = e.target.closest("[data-cp-view]");
    const d = e.target.closest("[data-cp-del]");
    if (v) loadCpOne(v.getAttribute("data-cp-view"));
    else if (d) deleteCp(d.getAttribute("data-cp-del"));
  });
  if (cpProfileHint) cpProfileHint.addEventListener("click", e => {
    if (!e.target.closest("[data-cp-use-profile]") || !cpTarget) return;
    // Resolve the role the same way the hint rendered it, so the button still
    // works when the role came from the local draft or the saved server profile.
    const profRole = String((($("#pfRole") && $("#pfRole").value) || "")).trim()
      || cpDraftRole()
      || cpServerRole;
    if (profRole) { cpTarget.value = profRole; cpTarget.focus(); }
  });

  function initCareerPath() {
    if (!cpOut) return;
    cpSyncHint();
    cpLoadServerRole();
    loadCpList().then(paths => {
      if (paths && paths.length) loadCpOne(paths[0]._id);
      else cpEmptyState();
    });
  }

  /* ---------- 5c. AI Career Profile (read-only AI view, real backend: POST /api/ai/career-profile) ---------- */
  const aipOut = $("#aipOut");
  const aipSources = $("#aipSources");
  const aipBtn = $("#aipGenerateBtn");
  let aipLoaded = false;

  function aipSetLoading(on) {
    if (aipOut) {
      aipOut.innerHTML = on
        ? `<div class="aip__loading"><span class="spin" aria-hidden="true"></span><p>Interpreting your Profile, CV and Skill Gap&hellip;</p></div>`
        : "";
    }
    if (aipBtn) {
      aipBtn.classList.toggle("is-loading", on);
      aipBtn.disabled = !!on;
      aipBtn.textContent = on ? "Generating" : "Generate AI Career Profile";
    }
  }

  function aipError(msg) {
    if (aipOut) aipOut.innerHTML = `<div class="aip__err">${esc(msg)}</div>`;
  }

  function aipList(items, cls) {
    if (!items || !items.length) return "";
    return `<ul class="aip__list ${cls}">` + items.map(i => `<li>${esc(i)}</li>`).join("") + `</ul>`;
  }

  function renderAiProfile(p, sourceUpdatedAt) {
    if (!aipOut || !p) return;
    const strengths = (p.coreStrengths || []).map(s =>
      `<li><strong>${esc(s.title)}</strong><span class="aip__evidence">Evidence from your data: ${esc(s.evidence)}</span></li>`
    ).join("");
    const roles = (p.potentialRoles || []).map(r =>
      `<li><strong>${esc(r.title)}</strong><span class="aip__evidence">Why: ${esc(r.reason)}</span></li>`
    ).join("");
    const dev = (p.developmentAreas || []).map(d =>
      `<li><strong>${esc(d.area)}</strong><span class="aip__evidence">Why: ${esc(d.reason)}</span></li>`
    ).join("");

    const sections = [];
    if (p.headline) sections.push(`<div class="aip__headline">${esc(p.headline)}</div>`);
    if (p.summary) sections.push(`<p class="aip__summary">${esc(p.summary)}</p>`);
    if (strengths) sections.push(`<h3>Core strengths</h3><ul class="aip__list">${strengths}</ul>`);
    if ((p.careerAreas || []).length) sections.push(`<h3>Relevant career areas</h3>${aipList(p.careerAreas)}`);
    if ((p.transferableSkills || []).length) sections.push(`<h3>Transferable skills</h3>${aipList(p.transferableSkills)}`);
    if (roles) sections.push(`<h3>Potential roles</h3><ul class="aip__list">${roles}</ul>`);
    if (dev) sections.push(`<h3>Career development areas</h3><ul class="aip__list">${dev}</ul>`);
    if (p.positioning) sections.push(`<h3>Professional positioning</h3><p>${esc(p.positioning)}</p>`);
    if ((p.dataGaps || []).length) {
      sections.push(`<h3>Not available in your data</h3>${aipList(p.dataGaps, "aip__list--gap")}`);
    }

    let stamp = "";
    if (sourceUpdatedAt && sourceUpdatedAt.profile) {
      stamp = `<p class="aip__stamp">Based on Profile data last updated ${esc(new Date(sourceUpdatedAt.profile).toLocaleString())}.</p>`;
    }

    aipOut.innerHTML = `<div class="aip__card card">
      <p class="aip__tag">AI-generated insight</p>
      ${sections.join("")}
      ${stamp}
    </div>`;
  }

  function renderAipSources() {
    if (!aipSources) return;
    const rows = [
      { k: "Profile", v: "Your editable source of truth. Edit it in Profile." },
      { k: "CV Optimizer", v: "Your uploaded CV, if you have one." },
      { k: "Skill Gap Analysis", v: "Your latest skill gap, if you have run one." },
      { k: "Career Path Discovery", v: "Your latest saved career path, if you have generated one." }
    ];
    aipSources.innerHTML = `<h2 class="card__title">Data this view interprets</h2>
      <ul class="aip__sources-list">` + rows.map(r => `<li><strong>${esc(r.k)}</strong><span>${esc(r.v)}</span></li>`).join("") + `</ul>`;
  }

  function initAiCareerProfile() {
    renderAipSources();
    if (!aipOut) return;
    if (aipLoaded) return;
    aipLoaded = true;
    aipOut.innerHTML = `<div class="aip__idle"><p>Generate your AI Career Profile to see an AI interpretation of the information you have already provided.</p></div>`;
  }

  if (aipBtn) aipBtn.addEventListener("click", function () {
    aipSetLoading(true);
    authApi("/api/ai/career-profile", { method: "POST", body: JSON.stringify({}) })
      .then(res => {
        aipSetLoading(false);
        if (res.ok && res.data && res.data.data && res.data.data.profile) {
          renderAiProfile(res.data.data.profile, res.data.data.sourceUpdatedAt);
          toast("Your AI Career Profile is ready.", true);
        } else {
          aipError(apiErrorHint(res));
        }
      });
  });

  /* ---------- 6. Career AI (real backend: POST /api/ai/chat) ---------- */
  const chatBody = $("#chatBody");
  const chatInput = $("#chatInput");
  const chatHistory = [];
  // The static greeting that ships in the markup. Captured before any message
  // exists so sign-out can restore it instead of leaving an empty transcript;
  // it contains no user data.
  const CHAT_GREETING = chatBody ? chatBody.innerHTML : "";

  function appendBubble(kind, html) {
    const b = document.createElement("div");
    b.className = "msg msg--" + kind;
    b.innerHTML = html;
    if (chatBody) {
      chatBody.appendChild(b);
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }

  /* ---------- Career AI reply rendering ----------
     The model answers in Markdown, so the reply is converted to real HTML and
     users never see raw **, * or # characters.

     Safety: the entire reply is HTML-escaped FIRST, so nothing produced by the
     model can reach the DOM as markup. Only tags this code emits itself are
     written, and a final allow-list pass drops anything unexpected as defence
     in depth. Deliberately avoids lookbehind so older Safari can parse it. */
  const MD_ALLOWED_TAGS = ["p", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "code", "a", "blockquote"];

  function mdInline(input) {
    const codes = [];
    let s = String(input == null ? "" : input).replace(/`([^`]+)`/g, function (m, c) {
      codes.push(c);
      return "\u0000" + codes.length + "\u0000";
    });
    s = s.replace(/\[([^\]\n]{1,200})\]\(((?:https?:)?\/\/[^\s)]{1,400})\)/gi, function (m, txt, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>";
    });
    s = s.replace(/\*\*([^*\s][^*]*?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
    s = s.replace(/(^|[\s(])_([^_\s][^_]*?\S)_(?![\w])/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, n) {
      return "<code>" + (codes[+n - 1] || "") + "</code>";
    });
    return s;
  }

  function mdIsBullet(l) { return /^ *\s*[-*+]\s+\S/.test(l.replace(/\t/g, "  ")); }
  function mdIsOrdered(l) { return /^ *\s*\d{1,3}[.)]\s+\S/.test(l.replace(/\t/g, "  ")); }
  function mdIsHeading(l) { return /^#{1,6}\s+\S/.test(l); }
  function mdIndent(l) { const m = l.replace(/\t/g, "  ").match(/^ */); return m ? m[0].length : 0; }

  function mdParseBlocks(lines) {
    const out = [];
    const n = lines.length;
    let i = 0;
    const isList = (l) => mdIsBullet(l) || mdIsOrdered(l);

    function parseList(baseIndent) {
      const ordered = mdIsOrdered(lines[i]);
      const tag = ordered ? "ol" : "ul";
      const strip = ordered ? /^\s*\d{1,3}[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < n) {
        const line = lines[i];
        if (!line.trim()) {
          let j = i;
          while (j < n && !lines[j].trim()) j++;
          if (j < n && isList(lines[j]) && mdIndent(lines[j]) >= baseIndent) { i = j; continue; }
          break;
        }
        if (!isList(line)) {
          if (mdIndent(line) > baseIndent && items.length) {
            items[items.length - 1] += "<br>" + mdInline(line.trim());
            i++;
            continue;
          }
          break;
        }
        const ind = mdIndent(line);
        if (ind < baseIndent) break;
        if (ind > baseIndent) {
          if (!items.length) items.push("");
          const before = i;
          const nested = parseList(ind);
          if (i === before) {
            items[items.length - 1] += mdInline(line.trim());
            i++;
          } else {
            items[items.length - 1] += nested;
          }
          continue;
        }
        if (mdIsOrdered(line) !== ordered) break;
        items.push(mdInline(line.replace(strip, "")));
        i++;
      }
      let html = "<" + tag + ">";
      for (let k = 0; k < items.length; k++) html += "<li>" + items[k] + "</li>";
      return html + "</" + tag + ">";
    }

    while (i < n) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (mdIsHeading(line)) {
        const hashes = line.match(/^#+/) || ["#"];
        const lv = Math.min(Math.max(hashes[0].length, 1), 6);
        out.push("<h" + lv + ">" + mdInline(line.slice(hashes[0].length).trim()) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (/^\s*(?:>|&gt;)/.test(line)) {
        const quoted = [];
        while (i < n && /^\s*(?:>|&gt;)/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*(?:>|&gt;)\s?/, "").trim());
          i++;
        }
        out.push("<blockquote><p>" + quoted.map(mdInline).join("<br>") + "</p></blockquote>");
        continue;
      }

      if (isList(line)) {
        const before = i;
        out.push(parseList(mdIndent(line)));
        if (i === before) { out.push("<p>" + mdInline(line.trim()) + "</p>"); i++; }
        continue;
      }

      const para = [];
      while (i < n && lines[i].trim() && !mdIsHeading(lines[i]) && !isList(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      out.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
    }

    return out.join("");
  }

  function mdSanitize(html) {
    return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, function (m, slash, tag, attrs) {
      const t = tag.toLowerCase();
      if (MD_ALLOWED_TAGS.indexOf(t) === -1) return "";
      if (t === "a" && !slash) {
        const href = (attrs.match(/\shref="([^"]*)"/) || [])[1] || "";
        if (!/^https?:\/\//i.test(href)) return "";
      }
      return m;
    });
  }

  function renderMarkdown(src) {
    const text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    return mdSanitize(mdParseBlocks(esc(text).split("\n")));
  }

  function pushBot(html) {
    appendBubble("bot", `<div class="msg__orb">✦</div><div class="msg__bubble">${html}</div>`);
  }

  function chatErrorNode(msg) {
    if (msg === AUTH_HINT) {
      return `<div class="msg__bubble msg__bubble--error"><p>Please sign in to use Career AI.</p>
        <div class="msg__signin"><button type="button" class="chat-cta" data-signin-cta>Sign in</button></div></div>`;
    }
    return `<div class="msg__bubble msg__bubble--error"><p>${esc(msg).replace(/\n/g, "<br>")}</p></div>`;
  }

  async function sendBot(text) {
    chatHistory.push({ role: "user", content: text });
    await delay(250);
    const t = document.createElement("div");
    t.className = "msg msg--bot";
    t.innerHTML = `<div class="msg__orb">✦</div><div class="msg__bubble"><div class="msg__typing"><i></i><i></i><i></i></div></div>`;
    if (chatBody) chatBody.appendChild(t);

const res = await authApi("/api/ai/chat", {
       method: "POST",
       body: JSON.stringify({ messages: chatHistory })
     });

    t.remove();
    if (res.ok && res.data && res.data.data && res.data.data.reply) {
      chatHistory.push({ role: "assistant", content: res.data.data.reply });
      pushBot(`<div class="msg__md">${renderMarkdown(res.data.data.reply)}</div>`);
    } else {
      chatHistory.pop();
      const hint = apiErrorHint(res);
      appendBubble("bot", `<div class="msg__orb">✦</div>${chatErrorNode(hint)}`);
    }
  }

  function onAsk(text) {
    const value = String(text || "").trim();
    if (!value) return;
    appendBubble("user", `<div class="msg__orb">◦</div><div class="msg__bubble"><p>${esc(value)}</p></div>`);
    if (chatInput) chatInput.value = "";
    sendBot(value);
  }

  $("#chatForm") && $("#chatForm").addEventListener("submit", function (e) {
    e.preventDefault();
    onAsk(chatInput && chatInput.value);
  });
  $("#chatSugg") && $("#chatSugg").addEventListener("click", function (e) {
    const b = e.target.closest("[data-q]");
    if (b) onAsk(b.textContent);
  });
  document.addEventListener("click", function (e) {
    const btn = e.target.closest("[data-signin-cta]");
    if (btn) { closeDrawer(); navigate("signin"); }
  });

  /* ---------- 7. Interview Prep (real backend: /api/interview-prep/analyze) ---------- */
  const ipListEl = $("#ipList");
  const ipHistory = $("#ipHistory");
  let ipPreps = [];
  let ipActiveId = null;

  function renderIpError(msg) {
    const out = $("#ipOut");
    if (!out) return;
    const el = document.createElement("div");
    el.className = "ai-error";
    el.innerHTML = msg === AUTH_HINT ? authRequiredMarkup("Interview preparation") : errorMarkup(msg);
    out.innerHTML = "";
    out.appendChild(el);
  }

  function renderIpList() {
    if (!ipListEl) return;
    if (!ipPreps.length) {
      if (ipHistory) ipHistory.hidden = true;
      ipListEl.innerHTML = "";
      return;
    }
    if (ipHistory) ipHistory.hidden = false;
    ipListEl.innerHTML = ipPreps.map(p => {
      const when = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "";
      const qs = (p.questions || []).length;
      const active = ipActiveId === p._id;
      const title = p.jobTitle ? p.targetRole + " — " + p.jobTitle : (p.targetRole || "Interview preparation");
      return `<div class="saved__item${active ? " is-active" : ""}">
        <div class="saved__meta">
          <strong>${esc(title)}</strong>
          <span>${esc(String(p.readiness == null ? "" : p.readiness))}${p.readiness != null ? "% readiness" : ""} &middot; ${qs} question${qs === 1 ? "" : "s"}${when ? " &middot; " + esc(when) : ""}</span>
        </div>
        <div class="saved__actions">
          ${active ? "" : `<button type="button" class="btn btn--ghost" data-ip-open="${esc(p._id)}">View</button>`}
          <button type="button" class="btn btn--danger" data-ip-del="${esc(p._id)}" data-ip-name="${esc(title)}">Delete</button>
        </div>
      </div>`;
    }).join("");
    bindIpListEvents();
  }

  function bindIpListEvents() {
    if (!ipListEl) return;
    $$("[data-ip-open]", ipListEl).forEach(b => b.addEventListener("click", () => viewIp(b.dataset.ipOpen)));
    $$("[data-ip-del]", ipListEl).forEach(b => b.addEventListener("click", () => deleteIp(b.dataset.ipDel, b.dataset.ipName)));
  }

  async function loadIpList() {
    const res = await authApi("/api/interview-prep");
    if (res && res.ok && res.data && res.data.data && Array.isArray(res.data.data.preparations)) {
      ipPreps = res.data.data.preparations;
    } else {
      ipPreps = [];
    }
    renderIpList();
    return ipPreps;
  }

  async function viewIp(id) {
    if (!id) return;
    const res = await authApi("/api/interview-prep/" + encodeURIComponent(id));
    if (res && res.ok && res.data && res.data.data && res.data.data.preparation) {
      ipActiveId = id;
      renderIpPreparation(res.data.data.preparation);
      renderIpList();
    } else {
      toast(apiErrorHint(res), false);
    }
  }

  /**
   * Delete one interview-preparation session. Only that session is removed;
   * the user's profile and CV are untouched.
   */
  async function deleteIp(id, name) {
    if (!id) return;
    const ok = await confirmAction({
      title: "Delete this interview session?",
      message: "This removes the saved questions and guidance. This cannot be undone.",
      scope: "For \u201c" + (name || "this session") + "\u201d. Your profile and CV are not affected.",
      confirmLabel: "Delete session"
    });
    if (!ok) return;
    const res = await authApi("/api/interview-prep/" + encodeURIComponent(id), { method: "DELETE" });
    if (res && res.ok) {
      if (ipActiveId === id) {
        ipActiveId = null;
        const out = $("#ipOut");
        if (out) out.innerHTML = "";
      }
      await loadIpList();
      toast("Your interview preparation was deleted.", true);
    } else {
      toast(apiErrorHint(res), false);
    }
  }

  function renderIpPreparation(a) {
    const out = $("#ipOut");
    if (!out) return;
    const questions = (a.questions || []).map(q => `
      <div class="ip__q">
        <div class="ip__q-head">
          <span class="ip__q-badge">${esc(q.category || "Question")}</span>
          <span class="ip__q-diff">${esc(q.difficulty || "Medium")}</span>
        </div>
        <p class="ip__q-text">${esc(q.question)}</p>
        ${q.whyItMatters ? `<p class="ip__q-why">${esc(q.whyItMatters)}</p>` : ""}
        ${(q.whatToCover || []).length ? `
          <div class="ip__q-cover"><strong>What to cover:</strong>
            <ul>${q.whatToCover.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          </div>` : ""}
        ${(q.followUpQuestions || []).length ? `
          <div class="ip__q-follow"><strong>Follow-up:</strong>
            <ul>${q.followUpQuestions.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          </div>` : ""}
      </div>`).join("");

    const guidance = (a.answerGuidance || []).map(g => `
      <div class="ip__guide">
        <strong>${esc(g.framework || "Framework")}</strong>
        ${(g.keyPoints || []).length ? `<ul>${g.keyPoints.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${(g.warningPoints || []).length ? `<p class="mute"><strong>Watch out:</strong> ${g.warningPoints.map(x => esc(x)).join("; ")}</p>` : ""}
      </div>`).join("");

    const skillFocus = (a.skillFocus || []).map(s => `
      <div class="ip__skill"><strong>${esc(s.skill)}</strong><small>${esc(s.reason || "")}</small> ${s.preparationAction ? `<p class="mute">→ ${esc(s.preparationAction)}</p>` : ""}</div>`).join("");

    const studyPlan = (a.studyPlan || []).map(s => `
      <div class="ip__stage">
        <div class="ip__stage-title">Stage ${s.stage}: ${esc(s.title)}</div>
        ${(s.actions || []).length ? `<ul>${s.actions.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${(s.resources || []).length ? `<p class="mute"><strong>Resources:</strong> ${s.resources.map(x => esc(x)).join(", ")}</p>` : ""}
        ${s.completionCriteria ? `<p class="mute"><strong>Done when:</strong> ${esc(s.completionCriteria)}</p>` : ""}
      </div>`).join("");

    out.innerHTML = `
      <div class="ip__header">
        <div class="ip__readiness">
          <div class="cv-score__ring" style="--p:${a.readiness || 0}"><span>${a.readiness || 0}%</span></div>
          <div>
            <strong>${esc(a.targetRole || "Target role")} ${a.jobTitle ? `· ${esc(a.jobTitle)}` : ""}</strong>
            <p>${esc(a.summary || "")}</p>
          </div>
        </div>
        ${(a.focusAreas || []).length ? `<div class="ip__focus"><strong>Focus areas:</strong> ${a.focusAreas.map(x => `<span class="small-tag">${esc(x)}</span>`).join("")}</div>` : ""}
      </div>
      ${questions ? `<div class="ip__section"><h3>Questions</h3>${questions}</div>` : ""}
      ${guidance ? `<div class="ip__section"><h3>Answer Guidance</h3>${guidance}</div>` : ""}
      ${skillFocus ? `<div class="ip__section"><h3>Skill Focus</h3>${skillFocus}</div>` : ""}
      ${(a.behavioralTopics || []).length ? `<div class="ip__section"><h3>Behavioral Topics</h3><div class="job-card__tags">${a.behavioralTopics.map(x => `<span class="small-tag">${esc(x)}</span>`).join("")}</div>` : ""}
      ${studyPlan ? `<div class="ip__section"><h3>Study Plan</h3>${studyPlan}</div>` : ""}
      ${(a.nextSteps || []).length ? `<div class="ip__section"><h3>Next Steps</h3><ul>${a.nextSteps.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="cvlab__actions" style="margin-top:16px">
        ${a._id ? `<button type="button" class="btn btn--danger btn--sm" data-ip-del="${esc(a._id)}" data-ip-name="${esc((a.jobTitle ? a.targetRole + " — " + a.jobTitle : a.targetRole) || "this session")}">Delete this session</button>` : ""}
      </div>
      <p class="mute" style="font-size:.8rem; margin-top:16px;">AI interview preparation</p>`;
    if (a._id) {
      ipActiveId = a._id;
      $$("[data-ip-del]", out).forEach(b =>
        b.addEventListener("click", () => deleteIp(b.dataset.ipDel, b.dataset.ipName)));
    }
  }

  $("#ipGenerateBtn") && $("#ipGenerateBtn").addEventListener("click", function () {
    const target = ($("#ipTarget") || { value: "" }).value;
    const type = ($("#ipType") || { value: "general" }).value;
    const jobDesc = ($("#ipJobDesc") || { value: "" }).value;
    if (!String(target).trim()) {
      renderIpError("Please choose a target role first.");
      toast("Please choose a target role.", false);
      return;
    }
    this.classList.add("is-loading");
    const body = { targetRole: String(target).trim() };
    if (type !== "general") body.preparationType = type;
    if (jobDesc.trim()) body.job = { description: jobDesc.trim() };
authApi("/api/interview-prep/analyze", {
       method: "POST",
       body: JSON.stringify(body)
     }).then(res => {
      this.classList.remove("is-loading");
      if (res.ok && res.data && res.data.data && res.data.data.preparation) {
        renderIpPreparation(res.data.data.preparation);
        ipActiveId = res.data.data.preparation._id || null;
        toast("Your interview preparation is ready.", true);
        loadIpList();
      } else {
        renderIpError(apiErrorHint(res));
      }
    });
  });

  /* ---------- 8. Career Profile ---------- */
  const pfStatus = $("#pfStatus");

  function collectProfile() {
    const p = {};
    PROFILE_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      p[id] = el && el.value ? el.value.trim() : "";
    });
    p.pfRemote = remoteValue() || "notset";
    p.updatedAt = new Date().toISOString();
    return p;
  }

  function saveProfile(opts) {
    const p = collectProfile();
    writeProfileDraft(p);
    const u = userDraft();
    u.name = p.pfName || u.name;
    u.email = p.pfRole ? u.email : u.email;
    store.set(LS_USER, u);
    // Keep the removable-item chips and Clear buttons in step with what was
    // just saved, even if a value changed without an input event.
    Object.keys(PF_LIST_FIELDS).forEach(renderPfChips);
    syncPfClearButtons();
    renderUser();
    renderOverview();
    renderReco();
    renderCareerSteps();
    // The account copy is what the AI features read, so mirror the form to the
    // backend. The local draft stays as the offline copy.
    if (!opts || opts.sync !== false) syncProfileToServer();
    return p;
  }

  /** Mirror the Profile form into the signed-in user's CareerProfile document. */
  async function syncProfileToServer() {
    if (!isSignedIn()) return false;
    const payload = draftToProfilePayload();
    const res = await authApi("/api/profile", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      toast("Saved on this device only. We couldn't save it to your account yet.", false);
      return false;
    }
    return true;
  }

  function loadProfileIntoForm() {
    const p = profileDraft();
    Object.keys(p).forEach(k => {
      if (k === "updatedAt" || k === "pfRemote") return;
      const el = document.getElementById(k);
      if (el) el.value = p[k] || "";
    });
    const remote = p.pfRemote;
    if (remote && remote !== "notset") {
      $$('input[name="pfRemote"]').forEach(r => { r.checked = r.value === remote; });
    }
    if (pfStatus) {
      pfStatus.textContent = p.updatedAt
        ? "Saved " + new Date(p.updatedAt).toLocaleString()
        : "Not saved yet. Fill it in and select Save.";
    }
    renderOverview();
  }

  $("#pfForm") && $("#pfForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const btn = $("#pfSaveBtn");
    if (btn) btn.classList.add("is-loading");
    saveProfile({ sync: false });
    syncProfileToServer().then(ok => {
      if (btn) btn.classList.remove("is-loading");
      if (pfStatus) pfStatus.textContent = "Saved " + new Date().toLocaleString();
      toast(ok ? "Your career profile was saved to your account." : "Your career profile was saved on this device only.", ok);
    });
  });

  /* ---------- 8a. Remove individual Profile information ----------
     Users can clear any single field, or drop one item out of a comma-separated
     list, without deleting the rest of their profile. There is deliberately no
     "delete profile" control: profile data is the basis of the other features. */
  const PF_LIST_FIELDS = {
    pfSkills: "Skills",
    pfCerts: "Certifications"
  };

  // Friendly names for the confirmation dialog, so the prompt names the exact
  // piece of information being removed rather than an element id.
  const PF_FIELD_LABELS = {
    pfName: "Full name",
    pfRole: "Target role",
    pfInterests: "Career interests",
    pfEdSchool: "School / institution",
    pfEdDegree: "Degree / programme",
    pfEdYear: "Graduation year",
    pfCerts: "Certifications",
    pfSkills: "Skills",
    pfWorkRole: "Work role",
    pfWorkCo: "Company",
    pfWorkFrom: "Work start year",
    pfWorkTo: "Work end year",
    pfWorkDesc: "Work description",
    pfVol: "Volunteer work",
    pfLoc: "Preferred location"
  };

  const splitList = raw => String(raw || "")
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);

  function renderPfChips(fieldId) {
    const holder = document.getElementById(fieldId + "Chips");
    const input = document.getElementById(fieldId);
    if (!holder || !input) return;
    const items = splitList(input.value);
    if (!items.length) {
      holder.innerHTML = `<p class="mute" style="font-size:.78rem;margin:6px 0 0">No ${esc((PF_LIST_FIELDS[fieldId] || "items").toLowerCase())} added yet.</p>`;
      return;
    }
    holder.innerHTML = `<p class="mute" style="font-size:.78rem;margin:10px 0 0">Remove one:</p>
      <div class="chips">${items.map((item, i) => `
        <span class="chip-item">${esc(item)}
          <button type="button" data-pf-rm="${esc(fieldId)}" data-pf-idx="${i}" aria-label="Remove ${esc(item)}">&times;</button>
        </span>`).join("")}</div>`;
    $$("[data-pf-rm]", holder).forEach(b => {
      b.addEventListener("click", () => {
        const fieldId = b.dataset.pfRm;
        const idx = Number(b.dataset.pfIdx);
        const items = splitList(input.value);
        const removed = items[idx];
        if (removed === undefined) return;
        removePfListItem(fieldId, removed);
      });
    });
  }

  /**
   * Clear a single Profile field. The removal is written straight to the
   * account so it survives a refresh, without touching the other fields.
   */
  async function clearPfField(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    if (!String(el.value || "").trim()) return;
    const label = PF_FIELD_LABELS[fieldId] || "this field";
    const confirmed = await confirmAction({
      title: "Remove this information?",
      message: "This clears \u201c" + label + "\u201d from your profile. The rest of your profile is kept.",
      scope: "You can add it again at any time.",
      confirmLabel: "Remove"
    });
    if (!confirmed) return;
    el.value = "";
    if (PF_LIST_FIELDS[fieldId]) renderPfChips(fieldId);
    syncPfClearButtons();
    writeProfileDraft(collectProfile());
    if (isSignedIn()) {
      const simple = PF_SIMPLE_PROFILE_FIELDS[fieldId];
      if (simple) {
        // One-to-one field: clear exactly that stored field, server-side.
        authApi("/api/profile/fields/" + encodeURIComponent(simple), { method: "DELETE" })
          .then(res => { if (!res || !res.ok) toast(apiErrorHint(res), false); });
      } else {
        // Part of a composed block, so re-send the block with the item removed.
        const block = Object.keys(PF_BLOCK_FIELDS).find(b =>
          PF_BLOCK_FIELDS[b].fields.some(f => f.key === fieldId));
        if (block) syncProfileToServer();
      }
    }
    el.focus();
  }

  function syncPfClearButtons() {
    $$("[data-pf-clear]").forEach(b => {
      const el = document.getElementById(b.dataset.pfClear);
      const has = el && String(el.value || "").trim().length > 0;
      b.hidden = !has;
    });
  }

  function enhanceProfileForm() {
    // A per-field Clear control, so one piece of information can be removed
    // without touching the rest of the profile.
    PROFILE_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const field = el.closest(".field");
      if (!field) return;
      const label = field.querySelector("label");
      if (!label || label.querySelector("[data-pf-clear]")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "field__clear";
      btn.setAttribute("data-pf-clear", id);
      btn.textContent = "CLEAR";
      btn.setAttribute("aria-label", "Clear " + (label.textContent || id).trim());
      btn.addEventListener("click", () => clearPfField(id));
      label.appendChild(btn);
    });

    // Removable item chips for the comma-separated lists.
    Object.keys(PF_LIST_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const field = el.closest(".field");
      if (!field) return;
      const holder = document.createElement("div");
      holder.id = id + "Chips";
      field.appendChild(holder);
      el.addEventListener("input", () => { renderPfChips(id); syncPfClearButtons(); });
      renderPfChips(id);
    });

    $("#pfForm") && $("#pfForm").addEventListener("input", syncPfClearButtons);
    syncPfClearButtons();
  }

  /* ---------- 8a-2. Profile <-> backend mapping ----------
     The Profile form is a finer-grained editor than the CareerProfile document,
     so related form fields are composed into one stored field. Each value is
     written as "Label: value" and read back by label, which keeps the round trip
     lossless even when a value spans several lines. */
  // Form field -> stored field, for form fields that map one-to-one.
  const PF_SIMPLE_PROFILE_FIELDS = {
    pfRole: "targetRole",
    pfInterests: "goals",
    pfLoc: "location",
    pfSkills: "skills"
  };

  // Form fields composed into a single stored field.
  const PF_BLOCK_FIELDS = {
    education: {
      fields: [
        { key: "pfEdSchool", label: "School / institution" },
        { key: "pfEdDegree", label: "Degree / programme" },
        { key: "pfEdYear", label: "Graduation year" },
        { key: "pfCerts", label: "Certifications" }
      ]
    },
    experience: {
      fields: [
        { key: "pfWorkRole", label: "Role" },
        { key: "pfWorkCo", label: "Company" },
        { key: "pfWorkFrom", label: "From" },
        { key: "pfWorkTo", label: "To" },
        { key: "pfWorkDesc", label: "What you did" },
        { key: "pfVol", label: "Volunteer work" }
      ]
    }
  };

  const PF_BLOCK_LOOKUP = (() => {
    const map = {};
    Object.keys(PF_BLOCK_FIELDS).forEach(block => {
      PF_BLOCK_FIELDS[block].fields.forEach(f => { map[f.label.toLowerCase()] = { block, key: f.key }; });
    });
    return map;
  })();

  /** Build the stored text for one composed field from the form. */
  function composeBlock(spec) {
    return spec.fields
      .map(f => {
        const el = document.getElementById(f.key);
        const v = el && el.value ? el.value.trim() : "";
        return v ? f.label + ": " + v : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Read the form field values back out of a stored composed field. */
  function parseBlock(text) {
    const out = {};
    let current = null;
    String(text || "").split("\n").forEach(line => {
      const m = line.match(/^\s*([^:]{1,60}):\s?([\s\S]*)$/);
      const hit = m ? PF_BLOCK_LOOKUP[m[1].trim().toLowerCase()] : null;
      if (hit) {
        current = hit.key;
        out[current] = m[2];
      } else if (current) {
        // Continuation of a multi-line value.
        out[current] = (out[current] ? out[current] + "\n" : "") + line;
      }
    });
    return out;
  }

  function draftToProfilePayload() {
    const d = collectProfile();
    const payload = {};
    if (d.pfRole) payload.targetRole = d.pfRole;
    if (d.pfInterests) payload.goals = d.pfInterests;
    if (d.pfLoc) payload.location = d.pfLoc;
    payload.skills = splitList(d.pfSkills);
    Object.keys(PF_BLOCK_FIELDS).forEach(block => {
      payload[block] = composeBlock(PF_BLOCK_FIELDS[block]);
    });
    return payload;
  }

  /** Turn a stored CareerProfile back into form values. */
  function profileToDraft(profile) {
    const p = profile || {};
    const d = { pfName: (userDraft().name || "") };
    d.pfRole = p.targetRole || "";
    d.pfInterests = p.goals || "";
    d.pfLoc = p.location || "";
    d.pfSkills = Array.isArray(p.skills) ? p.skills.join(", ") : "";
    Object.keys(PF_BLOCK_FIELDS).forEach(block => {
      const parsed = parseBlock(p[block]);
      PF_BLOCK_FIELDS[block].fields.forEach(f => { d[f.key] = parsed[f.key] || ""; });
    });
    d.updatedAt = p.updatedAt ? new Date(p.updatedAt).toISOString() : new Date().toISOString();
    return d;
  }

  function applyDraftToForm(d) {
    PROFILE_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = d[id] || "";
    });
    if (pfStatus) {
      pfStatus.textContent = d.updatedAt
        ? "Saved " + new Date(d.updatedAt).toLocaleString()
        : "Not saved yet. Fill it in and select Save.";
    }
    Object.keys(PF_LIST_FIELDS).forEach(renderPfChips);
    syncPfClearButtons();
    renderOverview();
  }

  const STORED_PROFILE_FIELDS = [
    "education", "experience", "projects", "goals",
    "targetRole", "location", "salaryExpectation"
  ];

  function profileHasContent(p) {
    if (!p) return false;
    if (Array.isArray(p.skills) && p.skills.length) return true;
    return STORED_PROFILE_FIELDS.some(k => String(p[k] || "").trim().length > 0);
  }

  function draftHasContent(d) {
    return PROFILE_FIELDS.some(id => String((d && d[id]) || "").trim().length > 0);
  }

  /**
   * Load the signed-in user's stored profile and show it. The account copy is
   * the source of truth; the local draft is only a fallback for when the
   * backend cannot be reached.
   */
  async function loadServerProfile() {
    if (!isSignedIn()) return;
    // Anything on this device that is not attributed to the signed-in account -
    // a previous account's draft, or an old draft with no owner stamp at all -
    // is discarded here first. It must never be displayed for this account and
    // must never be pushed into this account's server profile.
    if (!profileDraftOwned()) clearProfileDraft();
    const res = await authApi("/api/profile");
    if (!res || !res.ok || !res.data || !res.data.data) return;
    const p = res.data.data.profile || res.data.data;
    if (!profileHasContent(p)) {
      // Nothing is stored on the account yet. This account's own unfinished
      // local draft - and only that draft - is restored and adopted rather than
      // overwriting a blank profile. profileDraft() is ownership-gated, so a
      // draft written by a different account can never reach this branch.
      const localDraft = profileDraft();
      if (draftHasContent(localDraft)) {
        applyDraftToForm(localDraft);
        await syncProfileToServer();
        return;
      }
      applyDraftToForm(profileToDraft(p));
      return;
    }
    const d = profileToDraft(p);
    writeProfileDraft(d);
    applyDraftToForm(d);
  }

  /**
   * Remove one item out of a comma-separated Profile list and persist it.
   * Skills are removed one at a time on the server; certifications live inside
   * the composed education block, so that block is re-sent instead.
   */
  async function removePfListItem(fieldId, item) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    const current = splitList(el.value);
    const wanted = String(item).toLowerCase();
    const idx = current.findIndex(s => s.toLowerCase() === wanted);
    if (idx === -1) return;
    const listName = (PF_LIST_FIELDS[fieldId] || "list").toLowerCase();
    const confirmed = await confirmAction({
      title: "Remove \u201c" + item + "\u201d?",
      message: "This removes it from your " + listName + " list. Your other " + listName + " are kept.",
      scope: "You can add it again at any time.",
      confirmLabel: "Remove"
    });
    if (!confirmed) return;
    current.splice(idx, 1);
    el.value = current.join(", ");
    renderPfChips(fieldId);
    syncPfClearButtons();
    writeProfileDraft(collectProfile());
    if (!isSignedIn()) return;
    if (fieldId === "pfSkills") {
      // One item out of this user's own saved skills. Nothing else is touched.
      authApi("/api/profile/skills/" + encodeURIComponent(item), { method: "DELETE" })
        .then(res => { if (!res || !res.ok) toast(apiErrorHint(res), false); });
    } else {
      syncProfileToServer();
    }
  }

  /* ---------- 8b. Progressive Web App + offline honesty ---------- */
  const netbar = $("#netbar");
  const installbar = $("#installbar");
  const installBtn = $("#installBtn");
  const installDismiss = $("#installDismiss");
  let deferredInstallPrompt = null;

  function syncNetBar() {
    if (!netbar) return;
    netbar.hidden = navigator.onLine !== false;
  }

  window.addEventListener("online", syncNetBar);
  window.addEventListener("offline", syncNetBar);
  syncNetBar();

  // Surface an offline state before an API call fails, rather than pretending
  // backend-dependent features work without a connection.
  const _api = api;
  api = async function (p, opts) {
    if (navigator.onLine === false && typeof p === "string" && p.indexOf("/api/") === 0) {
      return { ok: false, status: 0, data: { error: "You're offline. Please check your internet connection and try again." } };
    }
    return _api(p, opts);
  };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {
        /* App still works fully without a service worker. */
      });
    });
  }

  // Only offer installation when the browser actually supports it.
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installbar) installbar.hidden = false;
  });
  if (installBtn) installBtn.addEventListener("click", function () {
    if (!deferredInstallPrompt) { installbar.hidden = true; return; }
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function () { deferredInstallPrompt = null; });
    if (installbar) installbar.hidden = true;
  });
  if (installDismiss) installDismiss.addEventListener("click", function () {
    deferredInstallPrompt = null;
    if (installbar) installbar.hidden = true;
  });
  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    if (installbar) installbar.hidden = true;
  });

  /* ---------- 8c. Auth ---------- */
  const authTitleEl = $("#authTitle");

  function serverFlag(ok) {
    const el = $("#serverStatus");
    if (!el) return;
    el.textContent = ok ? "Connected" : "Offline";
    el.style.borderColor = ok ? "rgba(52,211,153,.45)" : "rgba(248,113,113,.45)";
    el.style.color = ok ? "var(--mint)" : "#f87171";
  }

  function authSuccess(name, email) {
    store.set(LS_USER, { name: name || nameFor(), email: email || "" });
    renderUser();
    // Pull the signed-in user's stored profile into the form straight away.
    loadServerProfile();
    toast("Welcome back, " + (name || "there") + ".", true);
    navigate("overview");

  }

  async function signoutNow() {
    // Revoke the server-side refresh session. Without this the httpOnly refresh
    // cookie stays valid for its full lifetime and can still mint access
    // tokens after the user believes they have signed out.
    try { await api("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) { /* never block sign-out */ }
    // End only the session. Stored Profile drafts, CVs and career data are the
    // user's own data and are intentionally left untouched so signing back in
    // restores their information.
    store.del(LS_USER);
    store.del(LS_TOKEN);
    clearUserScopedViewState();
    renderUser();
    if (currentView() !== "signin") navigate("signin");
    toast("Signed out.", false);
  }

  // Drop rendered, user-scoped content so it is not visible behind the sign-in
  // screen after logout.
  function clearUserScopedViewState() {
    // Career AI conversation. Both the rendered transcript and the in-memory
    // message array are session state: clearing them means the next account to
    // sign in on this device sees no trace of the previous conversation, and its
    // first request to the AI starts clean instead of resending the previous
    // account's messages. Only the static (user-free) greeting is restored.
    chatHistory.length = 0;
    if (chatBody) chatBody.innerHTML = CHAT_GREETING;
    if (chatInput) chatInput.value = "";
    // Profile form values still render the previous account's information. Clear
    // them so nothing from that account can be shown to, or saved by, the next
    // account. The local draft itself is left in storage but is stamped with the
    // account that owns it and is only ever readable by that same account.
    PROFILE_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    $$('input[name="pfRemote"]').forEach(r => { r.checked = false; });
    renderOverview();
    renderCareerSteps();
    cpPaths = [];
    cpActiveId = null;
    cpServerRole = "";
    if (cpList) cpList.innerHTML = "";
    if (cpHistory) cpHistory.hidden = true;
    if (cpOut) cpOut.innerHTML = "";
    if (cpTarget) cpTarget.value = "";
    if (aipOut) aipOut.innerHTML = "";
    // Drop rendered CV references on sign-out so the next person to sign in on
    // this device cannot see them. This only clears the page; nothing is
    // deleted from the server, and signing back in reloads the real list.
    currentCv = null;
    cvAll = [];
    const cvOut = $("#cvOut");
    if (cvOut) cvOut.innerHTML = "";
    sgAnalyses = [];
    sgActiveId = null;
    renderSgList();
    const sgOut = $("#sgOut");
    if (sgOut) sgOut.innerHTML = "";
    ipPreps = [];
    ipActiveId = null;
    renderIpList();
    const ipOut = $("#ipOut");
    if (ipOut) ipOut.innerHTML = "";
  }

  const INITIALS = n => String(n).trim().split(/\s+/).map(w => w[0] || "").slice(0, 2).join("").toUpperCase();

  function renderUser() {
    const u = userDraft();
    const name = u.name || "Not signed in";
    const initials = INITIALS(name);
    const side = $("#sideUser");
    if (side) {
      // Sign-out lives in its own block below the feature list, never as a
      // feature item. It carries a visible text label as well as an icon so it
      // is unambiguous on desktop and in the mobile drawer.
      side.innerHTML = `
        <div class="side-user">
          <div class="side-user__ava">${initials}</div>
          <div class="side-user__meta"><strong>${esc(name)}</strong><small>${esc(u.email || "No account connected")}</small></div>
        </div>
        <button type="button" class="side-user__btn side-user__btn--signout" data-signout>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span>Log out</span>
        </button>`;
      const so = side.querySelector("[data-signout]");
      if (so) so.addEventListener("click", signoutNow);
    }
    const top = $("#topUser");
    if (top) {
      top.innerHTML = u.name
        ? `<div class="top-user" title="Signed in">${initials}</div>`
        : `<button type="button" class="top-user--ghost" data-signin>Sign in</button>`;
      const b = top.querySelector("[data-signin]");
      if (b) b.addEventListener("click", () => navigate("signin"));
    }
    // The Overview greeting carries the signed-in person's name. Re-render it
    // from the current session so a previous account's name is never left on
    // screen after sign-out, and the next account's name appears after sign-in.
    const welcome = $("#welcomeName");
    if (welcome) welcome.textContent = u.name ? ", " + name : "";
  }

  function handleAuth(path, fields, btnId) {
    const btn = $("#" + btnId);
    const body = {};
    fields.forEach(f => { body[f.name] = (document.getElementById(f.id) || { value: "" }).value; });
    if (btn) btn.classList.add("is-loading");
    return api(path, { method: "POST", body: JSON.stringify(body) }).then(res => {
      if (btn) setTimeout(() => btn.classList.remove("is-loading"), 350);
      // /api/auth/login and /api/auth/signup both return { success, data: { user, token } },
      // so the user object lives at data.data.user — not data.user.
      const name = body.name
        || (res.data && res.data.data && res.data.data.user && res.data.data.user.name)
        || (res.data && res.data.user && res.data.user.name);
      if (res.ok) {
        if (res.data && res.data.data && res.data.data.token) store.set(LS_TOKEN, res.data.data.token);
        authSuccess(name, body.email);
      } else if (res.status === 0) {
        store.del(LS_TOKEN);
        toast(apiErrorHint(res), false);
      } else if (res.status === 401) {
        store.del(LS_TOKEN);
        toast((res.data && (res.data.error || res.data.message)) || "Incorrect email or password.", false);
      } else {
        store.del(LS_TOKEN);
        toast(apiErrorHint(res), false);
      }
    });
  }

  $("#appSigninForm") && $("#appSigninForm").addEventListener("submit", function (e) {
    e.preventDefault();
    handleAuth("/api/auth/login",
      [{ name: "email", id: "appEmail" }, { name: "password", id: "appPass" }],
      "appSigninBtn");
  });
  $("#appSignupForm") && $("#appSignupForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const pass = ($("#appPass2") || { value: "" }).value;
    const confirm = ($("#appPass3") || { value: "" }).value;
    if (pass !== confirm) {
      toast("Passwords do not match.", false);
      return;
    }
    handleAuth("/api/auth/signup",
      [{ name: "name", id: "appName" }, { name: "email", id: "appEmail2" }, { name: "password", id: "appPass2" }],
      "appSignupBtn");
  });

  // Forgot Password
  $("#appForgotForm") && $("#appForgotForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const btn = $("#forgotSubmitBtn");
    const email = ($("#forgotEmail") || { value: "" }).value;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast("Please enter a valid email address.", false);
      return;
    }
    if (btn) btn.classList.add("is-loading");
    api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email })
    }).then(res => {
      if (btn) btn.classList.remove("is-loading");
      if (res.ok) {
        $("#appForgotForm").hidden = true;
        $("#forgotSuccess").hidden = false;
      } else {
        toast((res.data && (res.data.error || res.data.message)) || "Something went wrong. Please try again.", false);
      }
    }).catch(() => {
      if (btn) btn.classList.remove("is-loading");
      toast(NET_HINT, false);
    });
  });

  // Reset Password - extract token from URL
  function getResetTokenFromUrl() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    return params.get("token") || "";
  }

  function initResetPasswordView() {
    const token = getResetTokenFromUrl();
    const tokenInput = $("#resetToken");
    if (tokenInput) tokenInput.value = token;
    // Verify token
    if (token) {
      api("/api/auth/verify-reset-token", {
        method: "POST",
        body: JSON.stringify({ token })
      }).then(res => {
        if (res.ok && res.data && res.data.data && res.data.data.valid) {
          $("#appResetForm").hidden = false;
          $("#resetError").hidden = true;
        } else {
          $("#appResetForm").hidden = true;
          $("#resetError").hidden = false;
          const msg = (res.data && (res.data.error || res.data.message)) || "This password reset link is invalid or has expired.";
          $("#resetErrorMsg").textContent = msg;
        }
      }).catch(() => {
        $("#appResetForm").hidden = true;
        $("#resetError").hidden = false;
        $("#resetErrorMsg").textContent = "We couldn't check that reset link. Please try again.";
      });
    } else {
      $("#appResetForm").hidden = true;
      $("#resetError").hidden = false;
      $("#resetErrorMsg").textContent = "This reset link is incomplete. Please request a new one.";
    }
  }

  $("#appResetForm") && $("#appResetForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const btn = $("#resetSubmitBtn");
    const token = ($("#resetToken") || { value: "" }).value;
    const password = ($("#resetPass") || { value: "" }).value;
    const confirmPassword = ($("#resetPassConfirm") || { value: "" }).value;
    if (!password || !confirmPassword) {
      toast("Please enter and confirm your new password.", false);
      return;
    }
    if (password !== confirmPassword) {
      toast("Passwords do not match.", false);
      return;
    }
    if (password.length < 8) {
      toast("Password must be at least 8 characters.", false);
      return;
    }
    if (btn) btn.classList.add("is-loading");
    api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password, confirmPassword })
    }).then(res => {
      if (btn) btn.classList.remove("is-loading");
      if (res.ok) {
        $("#appResetForm").hidden = true;
        $("#resetSuccess").hidden = false;
      } else {
        toast((res.data && (res.data.error || res.data.message)) || "Password reset failed. Please try again.", false);
      }
    }).catch(() => {
      if (btn) btn.classList.remove("is-loading");
      toast(NET_HINT, false);
    });
  });

  // Re-initialize reset password view when navigated to
  const originalShowView = showView;
  showView = function(id, opts) {
    originalShowView(id, opts);
    if (id === "reset-password") initResetPasswordView();
  };

  $("#authSkip") && $("#authSkip").addEventListener("click", function () {
    toast("We couldn't connect right now. Please try again later.", false);
    navigate("overview");
  });
  $("#authSkip2") && $("#authSkip2").addEventListener("click", function () {
    toast("We couldn't connect right now. Please try again later.", false);
    navigate("overview");
  });

  /* ---------- Drawer (mobile) ---------- */
  const menuBtn = $("#menuBtn");
  const veil = $("#menuVeil");
  const drawer = $("#sideDraw");
  function openDrawer() {
    if (drawer) {
      const inner = drawer.querySelector(".side-draw__inner");
      const source = $("#appSide");
      if (inner && source && !inner.firstElementChild) inner.innerHTML = source.innerHTML;
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
    }
    if (veil) veil.hidden = false;
    if (menuBtn) menuBtn.classList.add("is-open");
  }
  function closeDrawer() {
    if (drawer) { drawer.classList.remove("is-open"); drawer.setAttribute("aria-hidden", "true"); }
    if (veil) veil.hidden = true;
    if (menuBtn) menuBtn.classList.remove("is-open");
  }
  if (menuBtn) menuBtn.addEventListener("click", () => (menuBtn.classList.contains("is-open") ? closeDrawer() : openDrawer()));
  if (veil) veil.addEventListener("click", closeDrawer);
  if (drawer) drawer.addEventListener("click", e => {
    if (e.target.closest("[data-signout]")) { signoutNow(); closeDrawer(); return; }
    if (e.target.closest("[data-signin]")) { navigate("signin"); closeDrawer(); return; }
    if (e.target.closest("a")) closeDrawer();
  });

  function healthCheck() {
    api("/api/health").then(({ ok }) => serverFlag(ok));
  }

  /* ---------- 9. Kick-off ---------- */
  // Views that require a signed-in account. Reaching one of these without a
  // session sends the user to sign-in, so Back, a refresh, or a typed-in hash
  // cannot expose a protected screen. The API already rejects every call with
  // 401; this closes the client-side shell too.
  const PROTECTED_VIEWS = new Set([
    "profile", "overview", "jobs", "cv", "skills", "ai-profile",
    "career-path", "interview", "ai"
  ]);

  function isSignedIn() {
    return !!store.get(LS_TOKEN);
  }

  function guardRoute(id) {
    const publicAuthViews = ["signin", "signup", "forgot-password", "reset-password"];
    if (publicAuthViews.includes(id)) return id;
    if (PROTECTED_VIEWS.has(id) && !isSignedIn()) return "signin";
    return id;
  }

  function init() {
    initPasswordToggles();
    renderUser();
    // Add per-field Clear controls and removable list items before filling the
    // form, so the chips reflect the saved draft immediately.
    enhanceProfileForm();
    loadProfileIntoForm();
    Object.keys(PF_LIST_FIELDS).forEach(renderPfChips);
    syncPfClearButtons();
    renderOverview();
    renderReco();
    renderCareerSteps();
    healthCheck();
    // Replace the local draft with the account's stored profile so the Profile
    // screen and the AI features agree on the same information.
    loadServerProfile();

    const welcome = $("#welcomeName");
    if (welcome) welcome.textContent = ", " + nameFor();

    window.addEventListener("hashchange", function () {
      let id = currentView();
      const guard = guardRoute(id);
      if (guard !== id) {
        // replaceState (not pushState) so Back cannot return to the blocked view.
        history.replaceState(null, "", "#/signin");
        id = "signin";
      }
      showView(id);
      renderOverview();
      renderCareerSteps();
    });

    let initial = currentView();
    const guard = guardRoute(initial);
    if (guard !== initial) {
      initial = "signin";
      history.replaceState(null, "", "#/signin");
    }
    showView(initial);
    if (!location.hash) history.replaceState(null, "", "#/overview");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();