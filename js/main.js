/* ============================================================
   MORINE — LANDING PAGE INTERACTIONS
   ------------------------------------------------------------
   1. Utilities
   2. Navigation (scroll state, mobile menu)
   3. Reveal-on-scroll
   4. Animated counters
   5. Auth modal (open/close, tabs, password toggles)
   6. Job filter chips
   7. Form validation + API auth
   8. Toast notifications
   9. Profile section
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 1. Utilities ---------- */
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  let toastTimer = null;
  function showToast(message, type = "success") {
    const toast = $("#toast");
    toast.textContent = message;
    toast.className = `toast toast--${type}`;
    toast.removeAttribute("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.setAttribute("hidden", ""), 3800);
  }

  function lockScroll(lock) {
    document.body.style.overflow = lock ? "hidden" : "";
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
  }

  function setFieldError(input, message) {
    const field = input.closest(".field");
    if (!field) return;
    const errorEl = field.querySelector(".field__error");
    input.classList.toggle("is-invalid", Boolean(message));
    field.classList.toggle("is-invalid", Boolean(message));
    if (errorEl) errorEl.textContent = message || "";
  }

  const validators = {
    name: (v) => (v.trim().length >= 2 ? "" : "Please enter your full name."),
    email: (v) => (isValidEmail(v) ? "" : "Please enter a valid email address."),
    password: (v) => (v.length >= 8 ? "" : "Password must be at least 8 characters."),
    terms: (el) => (el.checked ? "" : "Please accept the terms to continue."),
  };

  function validateForm(form) {
    let firstInvalid = null;
    $$("input, select", form).forEach((input) => {
      if (!input.required && !input.name) return;
      const value = input.type === "checkbox" ? input.checked : input.value;
      const message = input.type === "checkbox"
        ? (validators.terms ? validators.terms(input) : "")
        : (validators[input.name] ? validators[input.name](value) : "");
      setFieldError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    });
    return firstInvalid;
  }

  function wireLiveValidation(form) {
    $$("input", form).forEach((input) => {
      const check = () => {
        const message = input.type === "checkbox"
          ? (validators[input.name] ? validators[input.name](input) : "")
          : (validators[input.name] ? validators[input.name](input.value) : "");
        setFieldError(input, message);
      };
      input.addEventListener("input", check);
      input.addEventListener("blur", check);
    });
  }

  /* ---------- Auth State ---------- */
  const AUTH_KEY = "morine_token";
  let currentUser = null;

  function getToken() {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function setToken(token) {
    if (token) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(token));
    } else {
      localStorage.removeItem(AUTH_KEY);
    }
  }

  let refreshPromise = null;
  async function doRefresh(){
    if(refreshPromise) return refreshPromise;
    refreshPromise = (async()=>{
      const res = await fetch("/api/auth/refresh", { method:"POST", credentials:"include" });
      const data = await res.json().catch(()=>({}));
      if(!res.ok || !data.success) throw new Error(data.error || "Refresh failed");
      const newToken = data.data?.token;
      if(newToken) setToken(newToken);
      return newToken;
    })();
    try{ const t=await refreshPromise; return t; } finally { refreshPromise=null; }
  }

  async function apiFetch(url, options={}){
    const token = getToken();
    const headers = Object.assign({}, options.headers || {});
    if(token) headers["Authorization"] = "Bearer " + token;
    if(options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"]="application/json";
    let res = await fetch(url, Object.assign({}, options, { headers }));
    if(res.status===401){
      // Try refresh once, avoid loop on refresh endpoint itself
      if(url.includes("/api/auth/refresh") || url.includes("/api/auth/login") || url.includes("/api/auth/signup")) throw Object.assign(new Error("Authentication required. Please sign in."),{status:401});
      try{
        await doRefresh();
        const newToken = getToken();
        if(newToken) headers["Authorization"]="Bearer "+newToken;
        res = await fetch(url, Object.assign({}, options, { headers }));
      }catch(e){
        // refresh failed -> clear state
        setToken(null); currentUser=null; updateNavAuthState();
        const err=new Error("Session expired. Please sign in again."); err.status=401; throw err;
      }
    }
    return res;
  }

  async function apiRequest(url, method, body) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    let res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials:"include" });
    if(res.status===401 && !url.includes("/api/auth/")){
      try{
        await doRefresh();
        const newToken=getToken();
        if(newToken) headers["Authorization"]="Bearer "+newToken;
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials:"include" });
      }catch{}
    }
    const data = await res.json();
    if (!data.success) {
      const err = new Error(data.error || "Request failed");
      err.code = data.code || null;
      err.status = res.status;
      throw err;
    }
    return data.data;
  }

  function updateNavAuthState() {
    const navActions = $(".nav__actions");
    if (!navActions) return;
    if (currentUser) {
      const initial = (currentUser.name || "U").charAt(0).toUpperCase();
      navActions.innerHTML =
        '<button class="btn btn--ghost btn--sm" id="navProfileBtn" title="My Profile">' + initial + '</button>' +
        '<button class="btn btn--ghost btn--sm" id="navLogoutBtn">Sign out</button>';
      $("#navProfileBtn").addEventListener("click", () => {
        openFeature("profile");
      });
      $("#navLogoutBtn").addEventListener("click", handleLogout);
    } else {
      navActions.innerHTML =
        '<a href="/signin" class="btn btn--ghost btn--sm js-open-auth" data-mode="signin">Sign in</a>' +
        '<a href="#cta" class="btn btn--primary btn--sm">Get started free</a>';
      navActions.querySelectorAll(".js-open-auth").forEach((btn) =>
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          openAuth(btn.dataset.mode || "signup");
        })
      );
    }
  }

  async function restoreSession() {
    let token = getToken();
    if (!token) {
      try{ await doRefresh(); token=getToken(); if(!token) return; }catch{ return; }
    }
    try {
      const data = await apiRequest("/api/auth/me", "GET");
      currentUser = data.user;
      localStorage.setItem("morine_app_user", JSON.stringify(currentUser));
      updateNavAuthState();
      loadProfile();
    } catch {
      // try refresh once if access expired
      try{ await doRefresh(); const data2=await apiRequest("/api/auth/me","GET"); currentUser=data2.user; localStorage.setItem("morine_app_user", JSON.stringify(currentUser)); updateNavAuthState(); loadProfile(); }
      catch{ setToken(null); currentUser = null; localStorage.removeItem("morine_app_user"); updateNavAuthState(); }
    }
  }

  function setFormLoading(form, loading) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = loading;
      if (loading) btn.dataset.originalText = btn.textContent;
      btn.textContent = loading ? "Please wait..." : (btn.dataset.originalText || btn.textContent);
    }
  }

  /* ---------- 2. Navigation ---------- */
  const nav = $("#nav");

  function updateNav() {
    nav.classList.toggle("is-scrolled", window.scrollY > 20);
  }
  window.addEventListener("scroll", updateNav, { passive: true });
  updateNav();

  // Mobile menu
  const navToggle = $("#navToggle");
  const mobileMenu = $("#mobileMenu");
  function setMobileMenu(open) {
    mobileMenu.hidden = !open;
    navToggle.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  navToggle.addEventListener("click", () => setMobileMenu(mobileMenu.hidden));

  $$(".mobile-menu a", mobileMenu).forEach((a) =>
    a.addEventListener("click", () => setMobileMenu(false))
  );

  // Smooth scrolling is handled by CSS; close menu on nav links
  $$(".nav__link").forEach((link) =>
    link.addEventListener("click", () => setMobileMenu(false))
  );

  /* ---------- 3. Reveal on scroll ---------- */
  const revealEls = $$(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  // Stagger children of grid sections for a premium reveal
  $$(".features__grid, .jobs__grid").forEach((grid) => {
    $$(".reveal", grid).forEach((card, i) => {
      card.style.transitionDelay = `${(i % 3) * 90}ms`;
    });
  });

  /* ---------- 4. Animated counters ---------- */
  function animateCounter(el, duration = 1400, delay = 0) {
    const target = parseInt(el.dataset.count, 10) || 0;
    const suffix = el.dataset.suffix || "";
    setTimeout(() => {
      const start = performance.now();
      function tick(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }, delay);
  }

  // Meaningful counters only: the CV pipeline counters run inside runCvAnalysis()
  // (see 4c) so no standalone stat counters are needed here.

  /* ---------- 4b. How-it-works timeline ---------- */
  const timeline = $("#careerTimeline");
  let timelineRaf = null;
  function updateTimeline() {
    const vh = window.innerHeight;
    const trigger = vh * 0.72;
    const steps = $$(".tl-step", timeline);
    let lastReached = -1;

    steps.forEach((step, i) => {
      const node = $(".tl-node", step);
      const r = node.getBoundingClientRect();
      const center = r.top + r.height / 2;
      if (center <= trigger) lastReached = i;
    });

    steps.forEach((step, i) => step.classList.toggle("is-in", i <= lastReached));

    const fill = $(".timeline__fill", timeline);
    if (lastReached < 0) {
      fill.style.height = "0%";
      return;
    }
    const track = $(".timeline__track", timeline);
    const node = $(".tl-node", steps[lastReached]);
    const tr = track.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((nr.top + nr.height / 2 - tr.top) / tr.height) * 100));
    fill.style.height = pct + "%";
  }
  function onTimelineScroll() {
    if (timelineRaf) return;
    timelineRaf = requestAnimationFrame(() => {
      timelineRaf = null;
      updateTimeline();
    });
  }
  if (timeline) {
    updateTimeline();
    window.addEventListener("scroll", onTimelineScroll, { passive: true });
    window.addEventListener("resize", onTimelineScroll, { passive: true });
  }

  /* ---------- 4c. CV optimizer pipeline ---------- */
  const cvPipeline = $("#cvPipeline");
  function runCvAnalysis() {
    if (cvPipeline.dataset.ran) return;
    cvPipeline.dataset.ran = "1";

    const aimentCounts = $$(".aiment [data-count]", cvPipeline);
    aimentCounts.forEach((el, i) => animateCounter(el, 950, 150 + i * 130));

    const items = $$(".aiment", cvPipeline);
    items.forEach((item, i) => {
      item.style.setProperty("--w", item.dataset.w);
      setTimeout(() => item.classList.add("is-fill"), 200 + i * 130);
      setTimeout(() => item.classList.add("is-done"), 400 + i * 130);
    });
  }
  if (cvPipeline) {
    if ("IntersectionObserver" in window) {
      const cvio = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              runCvAnalysis();
              cvio.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.3 }
      );
      cvio.observe(cvPipeline);
    } else {
      runCvAnalysis();
    }
  }

  /* ---------- 4d. Subtle parallax (background glows) ---------- */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const glowA = $(".bg-glow--a");
  const glowB = $(".bg-glow--b");
  let parallaxRaf = null;

  function updateParallax() {
    const enabled = !reduceMotion.matches && window.innerWidth >= 900;
    if (!enabled) {
      if (glowA) glowA.style.transform = "";
      if (glowB) glowB.style.transform = "";
      return;
    }
    const y = window.scrollY;
    if (glowA) glowA.style.transform = `translate3d(0, ${(y * 0.16).toFixed(1)}px, 0)`;
    if (glowB) glowB.style.transform = `translate3d(0, ${(y * -0.1).toFixed(1)}px, 0)`;
  }
  function onParallax() {
    if (parallaxRaf) return;
    parallaxRaf = requestAnimationFrame(() => {
      parallaxRaf = null;
      updateParallax();
    });
  }
  if (glowA || glowB) {
    updateParallax();
    window.addEventListener("scroll", onParallax, { passive: true });
    window.addEventListener("resize", onParallax, { passive: true });
    if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", updateParallax);
  }

  /* ---------- 5. Auth modal ---------- */
  const modal = $("#authModal");
  const closeAuthBtns = $$("[data-close-auth]");
  const openAuthBtns = $$(".js-open-auth");

  let lastFocused = null;

  function getFocusable() {
    return $$(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      modal
    ).filter((el) => el.getClientRects().length > 0);
  }

  function openAuth(mode) {
    lastFocused = document.activeElement;
    setAuthMode(mode || "signup");
    modal.hidden = false;
    lockScroll(true);
    const firstInput = $(".auth-form:not([hidden]) input");
    if (firstInput) setTimeout(() => { if (!modal.hidden) firstInput.focus(); }, 120);
  }

  function closeAuth() {
    modal.hidden = true;
    lockScroll(false);
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function setAuthMode(mode) {
    const formToShow = mode === "signin" ? $("#signinForm") : $("#signupForm");
    const formToHide = mode === "signin" ? $("#signupForm") : $("#signinForm");
    formToShow.hidden = false;
    formToHide.hidden = true;
    formToHide.reset();
    $$(".auth-tab").forEach((tab) =>
      tab.classList.toggle("is-active", tab.dataset.tab === mode)
    );
    $("#authTitle").textContent = mode === "signin" ? "Welcome back" : "Join Morine";
    $(".modal__sub").textContent =
      mode === "signin"
        ? "Your future employer is waiting for your next move."
        : "Your future employer is already looking for you.";
  }

  openAuthBtns.forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openAuth(btn.dataset.mode || "signup");
    })
  );
  closeAuthBtns.forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      closeAuth();
    })
  );
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeAuth();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeAuth();
  });

  // Trap Tab focus inside the open dialog
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || modal.hidden) return;
    const focusables = getFocusable();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Tabs
  $$(".auth-tab").forEach((tab) =>
    tab.addEventListener("click", () => setAuthMode(tab.dataset.tab))
  );

  // Password visibility toggles
  $$("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $("#" + btn.dataset.togglePassword);
      const willShow = input.type === "password";
      input.type = willShow ? "text" : "password";
      btn.classList.toggle("is-shown", willShow);
      btn.setAttribute("aria-pressed", String(willShow));
      btn.setAttribute("aria-label", willShow ? "Hide password" : "Show password");
    });
  });

  /* ---------- 6. Job filter ---------- */
  const chips = $$(".chip");
  const cards = $$(".job-card");

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const filter = chip.dataset.filter;

      cards.forEach((card) => {
        const show = filter === "all" || card.dataset.category === filter;
        card.classList.toggle("is-hiding", !show);
        if (show) {
          card.classList.remove("is-shown");
          void card.offsetWidth; // restart animation
          card.classList.add("is-shown");
        }
      });
    });
  });

  /* ---------- 7. Forms ---------- */
  // Wire up live validation on all auth + CTA forms
  [ "#signupForm", "#signinForm", "#ctaForm" ].forEach((id) => {
    const form = $(id);
    if (form) wireLiveValidation(form);
  });

  const signupForm = $("#signupForm");
  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const invalid = validateForm(signupForm);
    if (invalid) {
      invalid.focus();
      showToast("Almost there — please fix the highlighted fields.", "error");
      return;
    }
    setFormLoading(signupForm, true);
    try {
      const data = await apiRequest("/api/auth/signup", "POST", {
        name: $("#suName").value.trim(),
        email: $("#suEmail").value.trim(),
        password: $("#suPassword").value,
      });
      setToken(data.token);
      currentUser = data.user;
      localStorage.setItem("morine_app_user", JSON.stringify(currentUser));
      signupForm.reset();
      closeAuth();
      updateNavAuthState();
      showToast("Welcome to Morine, " + currentUser.name.split(" ")[0] + "!");
      loadProfile();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setFormLoading(signupForm, false);
    }
  });

  const signinForm = $("#signinForm");
  signinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const invalid = validateForm(signinForm);
    if (invalid) {
      invalid.focus();
      showToast("Please check your email and password.", "error");
      return;
    }
    setFormLoading(signinForm, true);
    try {
      const data = await apiRequest("/api/auth/login", "POST", {
        email: $("#siEmail").value.trim(),
        password: $("#siPassword").value,
      });
      setToken(data.token);
      currentUser = data.user;
      localStorage.setItem("morine_app_user", JSON.stringify(currentUser));
      signinForm.reset();
      closeAuth();
      updateNavAuthState();
      showToast("Welcome back, " + currentUser.name.split(" ")[0] + "!");
      loadProfile();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setFormLoading(signinForm, false);
    }
  });

  function clearAllTemporaryState(){
    // Job Search - clear inputs, keep results until next search; reset filter
    try{
      const kw=$("#liveKeyword"), loc=$("#liveLocation");
      if(kw) kw.value=""; if(loc) loc.value="";
      $$(".chip").forEach(c=>{ c.classList.toggle("is-active", c.dataset.filter==="all"); });
      // clear AI Match selected state but keep history list (will be reloaded for next user)
      const jmRes=$("#jobMatchResults"); if(jmRes) jmRes.hidden=true;
      _jobCache={};
    }catch{}
    // CV - clear file input and temporary job description, keep saved CV list (will reload for next user)
    try{
      selectedCVFile=null;
      if(cvFileInput) cvFileInput.value="";
      if(cvDropLabel) cvDropLabel.textContent="Drop PDF or DOCX here, or click to browse";
      if(cvJobDesc) cvJobDesc.value="";
      if(cvUploadStatus){ cvUploadStatus.textContent=""; cvUploadStatus.className="cv-status"; }
      // keep cvResults visible during session but hide on logout for shared device
      if(cvResultsEl) cvResultsEl.hidden=true;
      if(cvOptimizedEl) cvOptimizedEl.hidden=true;
      const cvDropEl=$("#cvDrop"); if(cvDropEl) cvDropEl.classList.remove("is-drag");
    }catch{}
    // Skill Gap - clear manual target role and CV selection, keep result visible during session but hide on logout
    try{
      if(sgTargetRole) sgTargetRole.value="";
      if(sgCvSelect) sgCvSelect.value="";
      if(sgStatus){ sgStatus.textContent=""; sgStatus.className="cv-status"; }
      if(sgResultsEl) sgResultsEl.hidden=true;
    }catch{}
    // Job Match handled above
    // Career Path - clear manual target role and CV selection
    try{
      if(cpTargetRole) cpTargetRole.value="";
      if(cpCvSelect) cpCvSelect.value="";
      if(cpStatus){ cpStatus.textContent=""; cpStatus.className="cv-status"; }
      if(cpResultsEl) cpResultsEl.hidden=true;
    }catch{}
    // Interview - clear manual selections
    try{
      if(ipTargetRole) ipTargetRole.value="";
      if(ipCvSelect) ipCvSelect.value="";
      if(ipJobSelect) ipJobSelect.value="";
      if(ipStatus){ ipStatus.textContent=""; ipStatus.className="cv-status"; }
      if(ipResultsEl) ipResultsEl.hidden=true;
    }catch{}
    // Clear lists that are per-user (will be reloaded for next user, but clear DOM to prevent leak)
    try{
      const lists=["#cvList","#sgList","#jobMatchList","#cpList","#ipList","#liveResults","#livePagination","#liveStatus"];
      lists.forEach(sel=>{ const el=$(sel); if(el) el.innerHTML=""; });
      const status=$("#liveStatus"); if(status){ status.textContent=""; status.className="live-search__status"; }
    }catch{}
  }

  async function handleLogout() {
    try {
      await apiRequest("/api/auth/logout", "POST");
    } catch {}
    setToken(null);
    currentUser = null;
    localStorage.removeItem("morine_app_user");
    clearAllTemporaryState();
    updateNavAuthState();
    showToast("Signed out successfully.");
  }

  // Feature workspace navigation
  // Each feature section has a data-feature attribute on its card, and sections have corresponding IDs
  function openFeature(featureId) {
    // Hide all feature workspaces first
    const workspaces = ["cv-optimizer", "skill-gap", "career-path", "interview-prep", "jobs", "profile"];
    workspaces.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    // Show the requested feature
    const target = document.getElementById(featureId);
    if (target) {
      target.hidden = false;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // Clear temporary inputs from the previously visible feature
    clearAllTemporaryState();
  }

  function closeFeature() {
    // Hide all feature workspaces
    const workspaces = ["cv-optimizer", "skill-gap", "career-path", "interview-prep", "jobs", "profile"];
    workspaces.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    // Scroll to top of landing page
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Clear all temporary form inputs
    clearAllTemporaryState();
    // Reset auth UI
    updateNavAuthState();
  }

  // Anchor links that target hidden feature workspaces (nav/hero/footer) open them via openFeature
  const featureHashTargets = ["profile", "cv-optimizer", "skill-gap", "career-path", "interview-prep", "jobs"];
  document.addEventListener("click", (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!link) return;
    const hash = (link.getAttribute("href") || "").slice(1);
    if (featureHashTargets.indexOf(hash) !== -1) {
      e.preventDefault();
      openFeature(hash);
    }
  });

  const ctaForm = $("#ctaForm");
  ctaForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const invalid = validateForm(ctaForm);
    if (invalid) {
      invalid.focus();
      showToast("Almost there — please fix the highlighted fields.", "error");
      return;
    }
    setFormLoading(ctaForm, true);
    try {
      const data = await apiRequest("/api/auth/signup", "POST", {
        name: $("#ctaName").value.trim(),
        email: $("#ctaEmail").value.trim(),
        password: $("#ctaPassword").value,
      });
      setToken(data.token);
      currentUser = data.user;
      ctaForm.reset();
      updateNavAuthState();
      showToast("Account created! Let's build your profile, " + currentUser.name.split(" ")[0] + ".");
      loadProfile();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setFormLoading(ctaForm, false);
    }
  });

  /* ---------- 8. Live job search (Job Listings API) ---------- */
  const liveKeyword = $("#liveKeyword");
  const liveLocation = $("#liveLocation");
  const liveSearchBtn = $("#liveSearchBtn");
  const liveStatus = $("#liveStatus");
  const liveResults = $("#liveResults");
  const livePagination = $("#livePagination");

  let livePage = 1;
  let liveTotalJobs = 0;
  let liveTotalPages = 0;
  let _jobCache = {};

  function doLiveSearch(page) {
    if (!liveResults) return;
    page = page || 1;
    livePage = page;
    const kw = liveKeyword ? liveKeyword.value.trim() : "";
    const loc = liveLocation ? liveLocation.value.trim() : "";

    if (liveSearchBtn) liveSearchBtn.disabled = true;
    if (liveStatus) { liveStatus.className = "live-search__status"; liveStatus.textContent = "Searching..."; }
    liveResults.innerHTML = "";
    livePagination.innerHTML = "";

    const params = new URLSearchParams();
    if (kw) params.append("keyword", kw);
    if (loc) params.append("location", loc);
    params.append("page", livePage);
    params.append("limit", 20);

    fetch("/api/jobs?" + params.toString())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error || "Search failed");
        liveTotalJobs = data.pagination.totalCount;
        liveTotalPages = data.pagination.totalPages;
        var jobs = data.data;
        _jobCache = {};
        jobs.forEach(function(j){ var k = j.id || j.url || j.title; _jobCache[k]=j; });
        if (jobs.length === 0) {
          liveResults.innerHTML = '<div class="jobs__empty"><h3>No jobs found</h3><p>Try different keywords or a broader location.</p></div>';
          if (liveStatus) liveStatus.textContent = "0 results";
        } else {
          if (liveStatus) liveStatus.textContent = liveTotalJobs.toLocaleString() + " jobs found";
          liveResults.innerHTML = jobs.map(renderLiveJob).join("");
          renderLivePagination();
          setLiveSearchBarVisible(false);
        }
      })
      .catch(function (err) {
        if (liveStatus) { liveStatus.className = "live-search__status live-search__status--error"; liveStatus.textContent = err.message; }
        liveResults.innerHTML = '<div class="jobs__empty"><h3>Something went wrong</h3><p>' + escapeHtml(err.message) + '</p></div>';
        setLiveSearchBarVisible(true);
      })
      .finally(function () {
        if (liveSearchBtn) liveSearchBtn.disabled = false;
      });
  }

  function renderLiveJob(job) {
    var key = job.id || job.url || job.title;
    var salary = job.salaryMin
      ? formatSalary(job.salaryMin) + (job.salaryMax ? " – " + formatSalary(job.salaryMax) : "")
      : null;
    var posted = job.postedDate ? timeAgo(job.postedDate) : "";
    var desc = job.description
      ? job.description.replace(/<[^>]*>/g, "").substring(0, 300)
      : "";
    if (!desc) desc = "Job details are unavailable for this listing. Click AI Match to get a personalized estimate based on title and available information.";

    return '<article class="job-card live-job-card">' +
      '<div class="job-card__head">' +
        '<div class="job-card__title">' + escapeHtml(job.title) + '</div>' +
      '</div>' +
      '<div class="job-card__meta">' +
        '<span>' + escapeHtml(job.company) + '</span>' +
        '<span>' + escapeHtml(job.location) + '</span>' +
        (job.employmentType ? '<span>' + escapeHtml(formatType(job.employmentType)) + '</span>' : '') +
        (posted ? '<span>' + posted + '</span>' : '') +
      '</div>' +
      '<div class="job-card__desc">' + escapeHtml(desc) + '</div>' +
      '<div class="job-card__foot" style="flex-wrap:wrap;gap:8px;">' +
        '<div>' +
          (salary ? '<span class="job-card__salary">' + salary + '</span>' : '') +
          '<span class="job-card__source">' + escapeHtml(job.source) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button class="btn btn--primary btn--sm" onclick="window.Morine.analyzeJobMatchById(\'' + escapeAttr(String(key)) + '\')">AI Match</button>' +
          (job.url ? '<a href="' + escapeHtml(job.url) + '" target="_blank" rel="noopener" class="btn btn--soft btn--sm">View Job &rarr;</a>' : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderLivePagination() {
    if (liveTotalPages <= 1) { livePagination.innerHTML = ""; return; }
    var html = "";
    html += '<button ' + (livePage === 1 ? "disabled" : "") + ' onclick="window.Morine.liveSearch(' + (livePage - 1) + ')">Prev</button>';
    var start = Math.max(1, livePage - 2);
    var end = Math.min(liveTotalPages, livePage + 2);
    for (var i = start; i <= end; i++) {
      html += '<button class="' + (i === livePage ? "active" : "") + '" onclick="window.Morine.liveSearch(' + i + ')">' + i + '</button>';
    }
    html += '<button ' + (livePage === liveTotalPages ? "disabled" : "") + ' onclick="window.Morine.liveSearch(' + (livePage + 1) + ')">Next</button>';
    livePagination.innerHTML = html;
  }

  // --- Job Match ---
  const jobMatchResultsEl = $("#jobMatchResults");
  const jobMatchListEl = $("#jobMatchList");
  async function analyzeJobMatchById(key) {
    var job = _jobCache[key];
    if (!job) { showToast("Job details are unavailable for this listing.", "error"); return; }
    if (!currentUser) { showToast("Please sign in to get personalized AI job matches.", "error"); openAuth("signin"); return; }
    try {
      showToast("Analyzing match — this may take 10-20 seconds...");
      if (jobMatchResultsEl) { jobMatchResultsEl.hidden=false; jobMatchResultsEl.innerHTML='<p style="color:var(--text-dim)">Analyzing <strong>'+escapeHtml(job.title)+'</strong>…</p>'; }
      var payload = { job: { id: job.id || key, title: job.title, company: job.company, location: job.location, description: job.description || "", requirements: [] } };
      var data = await apiRequest("/api/job-match/analyze", "POST", payload);
      var m = data.match || data.analysis;
      renderJobMatch(m);
      await loadJobMatches();
      showToast("Match analysis complete.");
    } catch(e){
      if (e.code==='AI_QUOTA_EXHAUSTED') showToast("AI matching is temporarily unavailable because the AI service has reached its usage limit.", "error");
      else showToast(e.message, "error");
      if (jobMatchResultsEl && jobMatchResultsEl.innerHTML.includes("Analyzing")) {
        jobMatchResultsEl.innerHTML = '<p style="color:#f87171">'+escapeHtml(e.message)+'</p><p style="color:var(--text-mute);font-size:.85rem">Your job search still works — try browsing other listings.</p>';
      }
      try{ await loadJobMatches(); }catch{}
    }
  }
  function renderJobMatch(m){
    if(!m || !jobMatchResultsEl) return;
    jobMatchResultsEl.hidden=false;
    var score = Math.min(100,Math.max(0, Number(m.matchScore)||0));
    jobMatchResultsEl.innerHTML = `
      <h3 style="font-size:1.15rem;">AI Match — ${escapeHtml(m.jobTitle)} @ ${escapeHtml(m.company)}</h3>
      <div class="cv-score"><div class="cv-score__ring" style="--p:${score}"><span>${score}<small style="font-size:.7rem">%</small></span></div><div><strong>AI Match Score</strong><p style="color:var(--text-dim);font-size:.82rem;">AI-generated compatibility estimate based on the information available. Not a hiring probability.</p><p style="font-size:.85rem;margin-top:6px;">${escapeHtml(m.summary||'')}</p></div></div>
      <div><h4>Why This Job Matches</h4><ul>${(m.reasons||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div><h4>Matching Skills</h4><p>${(m.matchingSkills||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      <div><h4>Skills To Strengthen</h4><p>${(m.missingSkills||[]).map(s=>`<span class="cv-chip" style="border-color:#f59e0b;background:rgba(245,158,11,.1)">${escapeHtml(s)}</span>`).join("")||"None — strong cover"}</p></div>
      <div><h4>Profile Alignment</h4><ul>
        <li><strong>Target Role:</strong> ${escapeHtml(m.profileAlignment?.targetRole||'—')}</li>
        <li><strong>Experience:</strong> ${escapeHtml(m.profileAlignment?.experienceAlignment||'—')}</li>
        <li><strong>Education:</strong> ${escapeHtml(m.profileAlignment?.educationAlignment||'—')}</li>
        <li><strong>Location:</strong> ${escapeHtml(m.profileAlignment?.locationAlignment||'—')}</li>
      </ul></div>
      <div><h4>Recommendations</h4><ul>${(m.recommendations||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="btn btn--ghost" onclick="document.getElementById('jobMatchResults').hidden=true">Close</button></div>
    `;
    jobMatchResultsEl.scrollIntoView({behavior:"smooth", block:"start"});
  }
  async function loadJobMatches(){
    if(!currentUser || !jobMatchListEl) return;
    try{
      var data = await apiRequest("/api/job-match","GET");
      var list = data.matches || [];
      if(list.length===0){ jobMatchListEl.innerHTML='<p style="color:var(--text-dim);font-size:.9rem;">No saved matches yet. Use AI Match on a job above.</p>'; return; }
      jobMatchListEl.innerHTML = list.map(function(a){
        return '<div class="cv-list__item"><div class="cv-list__meta"><strong>'+escapeHtml(a.jobTitle)+' @ '+escapeHtml(a.company)+'</strong><span>'+a.matchScore+'% · '+escapeHtml(a.location)+' · '+new Date(a.createdAt).toLocaleDateString()+'</span></div><div class="cv-list__actions"><button class="btn btn--ghost btn--sm" onclick="window.Morine.viewJobMatch(\''+a._id+'\')">View</button><button class="btn btn--ghost btn--sm" onclick="window.Morine.deleteJobMatch(\''+a._id+'\')">Delete</button></div></div>';
      }).join("");
    }catch(e){ jobMatchListEl.innerHTML='<p style="color:#ef4444">'+escapeHtml(e.message)+'</p>'; }
  }
  async function viewJobMatch(id){
    try{ var d= await apiRequest("/api/job-match/"+id,"GET"); renderJobMatch(d.match); }catch(e){ showToast(e.message,"error"); }
  }
  async function deleteJobMatch(id){
    if(!confirm("Delete this match?")) return;
    try{ await apiRequest("/api/job-match/"+id,"DELETE"); showToast("Match deleted."); if(jobMatchResultsEl) jobMatchResultsEl.hidden=true; await loadJobMatches(); }catch(e){ showToast(e.message,"error"); }
  }

  function formatSalary(n) {
    return "\u20A6" + n.toLocaleString();
  }

  function formatType(t) {
    return t.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function timeAgo(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    var days = Math.floor(diff / 86400000);
    if (days < 1) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return days + " days ago";
    if (days < 30) return Math.floor(days / 7) + " weeks ago";
    return Math.floor(days / 30) + " months ago";
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  if (liveSearchBtn) liveSearchBtn.addEventListener("click", function () { doLiveSearch(1); });
  if (liveKeyword) liveKeyword.addEventListener("keydown", function (e) { if (e.key === "Enter") doLiveSearch(1); });
  if (liveLocation) liveLocation.addEventListener("keydown", function (e) { if (e.key === "Enter") doLiveSearch(1); });

  function setLiveSearchBarVisible(visible){
    const bar = $(".live-search__bar");
    const newBtn = $("#liveNewSearch");
    if (bar) bar.hidden = !visible;
    if (newBtn) newBtn.hidden = visible;
  }
  const liveNewSearchBtn = $("#liveNewSearch");
  if (liveNewSearchBtn) liveNewSearchBtn.addEventListener("click", function(){ setLiveSearchBarVisible(true); const bar=$(".live-search__bar"); if(bar){ const first=bar.querySelector("input"); if(first) first.focus(); } });

  /* ---------- 9. Profile section ---------- */
  async function loadProfile() {
    if (!currentUser) return;
    try {
      const data = await apiRequest("/api/profile", "GET");
      renderProfile(data.profile);
    } catch (err) {
      console.error("Failed to load profile:", err.message);
    }
  }

  function renderProfile(profile, mode) {
    const section = $("#profile");
    if (!section) return;
    const isLoggedIn = !!currentUser;
    const panel = section.querySelector(".profile-panel");
    if (!panel) return;

    if (!isLoggedIn) {
      panel.innerHTML =
        '<div class="profile__locked">' +
          '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>' +
          '<h3>Sign in to build your career profile</h3>' +
          '<p>Your profile powers AI job matching, CV optimization, skill-gap analysis and interview prep.</p>' +
          '<button class="btn btn--primary js-open-auth" data-mode="signup">Create your free profile</button>' +
        '</div>';
      panel.querySelectorAll(".js-open-auth").forEach((btn) =>
        btn.addEventListener("click", (e) => { e.preventDefault(); openAuth(btn.dataset.mode || "signup"); })
      );
      return;
    }

    if (mode === "summary") {
      renderProfileSummary(panel, profile);
      return;
    }

    var skills = (profile.skills || []).join(", ");

    panel.innerHTML =
      '<div class="profile__form" id="profileFormWrap">' +
        '<div class="field"><label for="profTargetRole">Target role</label><input type="text" id="profTargetRole" value="' + escapeAttr(profile.targetRole || '') + '" placeholder="e.g. Frontend Developer" /></div>' +
        '<div class="field"><label for="profLocation">Location</label><input type="text" id="profLocation" value="' + escapeAttr(profile.location || '') + '" placeholder="e.g. Lagos, Nigeria" /></div>' +
        '<div class="field"><label for="profSalary">Salary expectation</label><input type="text" id="profSalary" value="' + escapeAttr(profile.salaryExpectation || '') + '" placeholder="e.g. \u20A6500,000 / month" /></div>' +
        '<div class="field"><label for="profEducation">Education</label><textarea id="profEducation" rows="3" placeholder="e.g. B.Sc. Computer Science, University of Lagos">' + escapeHtml(profile.education || '') + '</textarea></div>' +
        '<div class="field"><label for="profSkills">Skills (comma-separated)</label><textarea id="profSkills" rows="2" placeholder="e.g. JavaScript, React, Node.js, Python">' + escapeHtml(skills) + '</textarea></div>' +
        '<div class="field"><label for="profExperience">Experience</label><textarea id="profExperience" rows="4" placeholder="Describe your work experience...">' + escapeHtml(profile.experience || '') + '</textarea></div>' +
        '<div class="field"><label for="profProjects">Projects</label><textarea id="profProjects" rows="3" placeholder="Notable projects you have worked on...">' + escapeHtml(profile.projects || '') + '</textarea></div>' +
        '<div class="field"><label for="profGoals">Career goals</label><textarea id="profGoals" rows="3" placeholder="What do you want to achieve?">' + escapeHtml(profile.goals || '') + '</textarea></div>' +
        '<div class="profile__actions">' +
          '<button class="btn btn--primary" id="profileSaveBtn">Save profile</button>' +
          '<span class="profile__status" id="profileStatus"></span>' +
        '</div>' +
      '</div>';

    var saveBtn = $("#profileSaveBtn");
    if (saveBtn) saveBtn.addEventListener("click", saveProfile);
  }

  function renderProfileSummary(panel, profile) {
    const rows = [
      ["Target role", profile.targetRole],
      ["Location", profile.location],
      ["Salary expectation", profile.salaryExpectation],
      ["Skills", (profile.skills || []).join(", ")],
      ["Education", profile.education],
      ["Experience", profile.experience],
      ["Projects", profile.projects],
      ["Career goals", profile.goals],
    ].filter(([, v]) => String(v || "").trim() !== "");
    panel.innerHTML =
      '<div class="profile__form" id="profileSummaryWrap">' +
        '<h3 style="font-size:1.15rem;margin:0 0 4px;">Your Career Profile</h3>' +
        '<p style="color:var(--text-dim);font-size:.9rem;margin:0 0 14px;">This powers job matching, CV optimization, skill-gap analysis, career path discovery and interview prep.</p>' +
        '<div class="cv-list">' +
          (rows.length
            ? rows.map(([k, v]) => '<div class="cv-list__item"><div class="cv-list__meta"><strong>' + escapeHtml(k) + '</strong><span>' + escapeHtml(v) + '</span></div></div>').join("")
            : '<div class="cv-list__item"><div class="cv-list__meta"><span>No profile details yet — add them to power your results.</span></div></div>') +
        '</div>' +
        '<div class="profile__actions" style="margin-top:14px;">' +
          '<button class="btn btn--primary" id="profileEditBtn">Edit profile</button>' +
        '</div>' +
      '</div>';
    const editBtn = $("#profileEditBtn");
    if (editBtn) editBtn.addEventListener("click", editProfile);
  }

  async function editProfile() {
    try {
      const d = await apiRequest("/api/profile", "GET");
      renderProfile(d.profile || {}, "form");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function saveProfile() {
    var statusEl = $("#profileStatus");
    var saveBtn = $("#profileSaveBtn");
    if (statusEl) statusEl.textContent = "Saving...";
    if (saveBtn) saveBtn.disabled = true;
    try {
      await apiRequest("/api/profile", "PUT", {
        targetRole: ($("#profTargetRole") || {}).value || "",
        location: ($("#profLocation") || {}).value || "",
        salaryExpectation: ($("#profSalary") || {}).value || "",
        education: ($("#profEducation") || {}).value || "",
        skills: ($("#profSkills") || {}).value || "",
        experience: ($("#profExperience") || {}).value || "",
        projects: ($("#profProjects") || {}).value || "",
        goals: ($("#profGoals") || {}).value || "",
      });
      showToast("Profile updated successfully.");
      const d = await apiRequest("/api/profile", "GET");
      renderProfile(d.profile || {}, "summary");
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message;
      showToast(err.message, "error");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function escapeAttr(str) {
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- 10. CV Optimizer ---------- */
  let selectedCVFile = null;
  const cvGate = $("#cvGate");
  const cvWorkspace = $("#cvWorkspace");
  const cvFileInput = $("#cvFile");
  const cvDrop = $("#cvDrop");
  const cvDropLabel = $("#cvDropLabel");
  const cvJobDesc = $("#cvJobDesc");
  const cvUploadBtn = $("#cvUploadBtn");
  const cvUploadStatus = $("#cvUploadStatus");
  const cvListEl = $("#cvList");
  const cvResultsEl = $("#cvResults");
  const cvOptimizedEl = $("#cvOptimized");

  function updateCVAuthUI() {
    const logged = !!currentUser;
    if (cvGate) cvGate.hidden = logged;
    if (cvWorkspace) cvWorkspace.hidden = !logged;
    if (logged) loadCVList();
  }

  // Wrap updateNavAuthState to also update CV gate (preserve original)
  const _origUpdateNavAuthState = updateNavAuthState;
  updateNavAuthState = function() {
    _origUpdateNavAuthState();
    updateCVAuthUI();
  };

  // Make feature cards open their feature workspace
  document.querySelectorAll(".feature-card").forEach(card => {
    const feature = card.getAttribute("data-feature");
    if (feature) {
      card.classList.add("feature-card--clickable");
      card.addEventListener("click", () => openFeature(feature));
    }
  });

  if (cvDrop) {
    cvDrop.addEventListener("click", () => cvFileInput && cvFileInput.click());
    cvDrop.addEventListener("dragover", e => { e.preventDefault(); cvDrop.classList.add("is-drag"); });
    cvDrop.addEventListener("dragleave", () => cvDrop.classList.remove("is-drag"));
    cvDrop.addEventListener("drop", e => {
      e.preventDefault(); cvDrop.classList.remove("is-drag");
      if (e.dataTransfer.files[0]) { selectedCVFile = e.dataTransfer.files[0]; if(cvDropLabel) cvDropLabel.textContent = selectedCVFile.name; }
    });
  }
  if (cvFileInput) cvFileInput.addEventListener("change", () => {
    if (cvFileInput.files[0]) { selectedCVFile = cvFileInput.files[0]; if(cvDropLabel) cvDropLabel.textContent = selectedCVFile.name; }
  });

  async function uploadCV(path) {
    const fd = new FormData();
    fd.append("cv", selectedCVFile);
    let token = getToken();
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    let res = await fetch(path, { method: "POST", headers, body: fd, credentials:"include" });
    if(res.status===401){
      try{ await doRefresh(); token=getToken(); const h={}; if(token) h["Authorization"]="Bearer "+token; res=await fetch(path,{method:"POST", headers:h, body:fd, credentials:"include"}); }catch{}
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Upload failed");
    return data.data;
  }

  async function loadCVList() {
    if (!currentUser || !cvListEl) return;
    try {
      const data = await apiRequest("/api/cv", "GET");
      const cvs = data.cvs || [];
      if (cvs.length === 0) { cvListEl.innerHTML = '<p style="color:var(--text-dim);font-size:.9rem;">No CVs yet — upload one above.</p>'; return; }
      cvListEl.innerHTML = cvs.map(cv => `
        <div class="cv-list__item">
          <div class="cv-list__meta"><strong>${escapeHtml(cv.originalFilename)}</strong><span>${cv.fileType.toUpperCase()} · ${(cv.fileSize/1024).toFixed(1)}KB · ${new Date(cv.createdAt).toLocaleDateString()}${cv.analysis ? ' · Analyzed' : ''}${cv.optimizedContent ? ' · Optimized' : ''}</span></div>
          <div class="cv-list__actions">
            <button class="btn btn--ghost btn--sm" onclick="window.Morine.viewCV('${cv._id}')">View</button>
            ${!cv.analysis ? `<button class="btn btn--primary btn--sm" onclick="window.Morine.analyzeCV('${cv._id}')">Analyze</button>` : `<button class="btn btn--ghost btn--sm" onclick="window.Morine.viewCV('${cv._id}')">Results</button>`}
            <button class="btn btn--ghost btn--sm" onclick="window.Morine.deleteCV('${cv._id}')">Delete</button>
          </div>
        </div>`).join("");
    } catch (e) { cvListEl.innerHTML = `<p style="color:#ef4444;">${escapeHtml(e.message)}</p>`; }
  }

  function renderAnalysis(cv) {
    const a = cv.analysis;
    if (!a) return;
    const hasJob = !!cv.jobDescription;
    cvResultsEl.hidden = false;
    cvResultsEl.innerHTML = `
      <h3 style="font-size:1.15rem;">Analysis — ${escapeHtml(cv.originalFilename)}</h3>
      <div class="cv-score"><div class="cv-score__ring" style="--p:${a.overallScore}"><span>${a.overallScore}</span></div><div><strong>Overall Score</strong><p style="color:var(--text-dim);font-size:.9rem;">${escapeHtml(a.summary||'')}</p></div></div>
      <div><h4>Strengths</h4><ul>${(a.strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div><h4>Areas to Improve</h4><ul>${(a.weaknesses||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div><h4>Skills Detected</h4><p>${(a.detectedSkills||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      <div><h4>Keywords</h4><p>${(a.detectedKeywords||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      ${hasJob ? `<div><h4>Missing Keywords</h4><p>${(a.missingKeywords||[]).map(s=>`<span class="cv-chip" style="border-color:#f59e0b;background:rgba(245,158,11,.1);">${escapeHtml(s)}</span>`).join("")||"None — good coverage!"}</p></div>` : ""}
      <div><h4>Bullet Point Improvements</h4>${(a.bulletPointImprovements||[]).map(b=>`<div class="cv-bullet"><div class="cv-bullet__label">CURRENT</div><p>${escapeHtml(b.current||"")}</p><div class="cv-bullet__label" style="color:#22c55e;">SUGGESTED</div><p class="cv-bullet cv-bullet__suggested">${escapeHtml(b.suggested||"")}</p><small style="color:var(--text-dim);">${escapeHtml(b.reason||"")}</small></div>`).join("")||"<p>—</p>"}</div>
      <div><h4>Formatting / ATS-oriented Recommendations</h4><ul>${(a.atsRecommendations||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      ${a.formattingIssues?.length ? `<div><h4>Formatting Issues</h4><ul>${a.formattingIssues.map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul></div>` : ""}
      ${a.experienceIssues?.length ? `<div><h4>Experience Issues</h4><ul>${a.experienceIssues.map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul></div>` : ""}
      ${a.jobMatch ? `<div><h4>Job Description Match</h4><p><strong>Matching skills:</strong> ${(a.jobMatch.matchingSkills||[]).join(", ")||"—"}</p><p><strong>Missing skills:</strong> ${(a.jobMatch.missingSkills||[]).join(", ")||"—"}</p><p><strong>Matching keywords:</strong> ${(a.jobMatch.matchingKeywords||[]).join(", ")||"—"}</p><p><strong>Missing keywords:</strong> ${(a.jobMatch.missingKeywords||[]).join(", ")||"—"}</p><p>${escapeHtml(a.jobMatch.relevantExperience||"")}</p><ul>${(a.jobMatch.areasToImprove||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul></div>` : ""}
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn--primary" onclick="window.Morine.optimizeCV('${cv._id}')">Generate Optimized CV</button>
        <button class="btn btn--ghost" onclick="window.Morine.viewCV('${cv._id}')">Refresh</button>
      </div>
    `;
    cvResultsEl.scrollIntoView({behavior:"smooth", block:"start"});
    if (cv.optimizedContent) renderOptimized(cv);
  }

  function renderOptimized(cv) {
    cvOptimizedEl.hidden = false;
    cvOptimizedEl.innerHTML = `
      <h3>Optimized CV — review before downloading</h3>
      <p style="color:var(--text-dim);font-size:.88rem;">Review and edit — we never invent facts. Original and optimized versions are kept separate.</p>
      <textarea id="cvOptimizedText">${escapeHtml(cv.optimizedContent||"")}</textarea>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn--primary" id="cvDownloadBtn">Download .txt</button>
        <button class="btn btn--ghost" onclick="document.getElementById('cvOptimized').hidden=true">Close</button>
      </div>
    `;
    const dl = document.getElementById("cvDownloadBtn");
    if (dl) dl.addEventListener("click", () => {
      const text = document.getElementById("cvOptimizedText").value;
      const blob = new Blob([text], {type:"text/plain"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download=(cv.originalFilename.replace(/\.[^/.]+$/,"")||"optimized")+"_optimized.txt"; a.click(); URL.revokeObjectURL(url);
    });
  }

  if (cvUploadBtn) cvUploadBtn.addEventListener("click", async () => {
    if (!currentUser) { showToast("Please sign in to upload your CV.", "error"); openAuth("signin"); return; }
    if (!selectedCVFile) { showToast("Please select a PDF or DOCX file.", "error"); return; }
    cvUploadBtn.disabled = true;
    if (cvUploadStatus) { cvUploadStatus.textContent = "Uploading..."; cvUploadStatus.className="cv-status"; }
    let uploadedId = null;
    try {
      const up = await uploadCV("/api/cv/upload");
      uploadedId = up.cv._id;
      if (cvUploadStatus) cvUploadStatus.textContent = "Uploaded — analyzing...";
      const jd = cvJobDesc ? cvJobDesc.value.trim() : "";
      // Analyze immediately
      const anRes = await apiRequest(`/api/cv/${uploadedId}/analyze`, "POST", jd ? { jobDescription: jd } : {});
      showToast("CV analyzed successfully.");
      if (cvUploadStatus) { cvUploadStatus.textContent = "Done!"; cvUploadStatus.className="cv-status is-success"; }
      selectedCVFile = null; if(cvDropLabel) cvDropLabel.textContent = "Drop PDF or DOCX here, or click to browse"; if(cvFileInput) cvFileInput.value="";
      await loadCVList();
      // Fetch full CV to render
      const full = await apiRequest(`/api/cv/${uploadedId}`, "GET");
      renderAnalysis(full.cv);
      hideCvInput();
    } catch (e) {
      // If CV was uploaded but analysis failed (e.g. quota), keep CV and show friendly message
      if (uploadedId) {
        try { await loadCVList(); } catch {}
        selectedCVFile = null; if(cvDropLabel) cvDropLabel.textContent = "Drop PDF or DOCX here, or click to browse"; if(cvFileInput) cvFileInput.value="";
        // Show view button even when analysis failed
        if (cvUploadStatus) { cvUploadStatus.textContent = e.message; cvUploadStatus.className="cv-status is-error"; }
        showToast(e.message, "error");
        // Optionally show CV without analysis
        try {
          const full = await apiRequest(`/api/cv/${uploadedId}`, "GET");
          if (full.cv && !full.cv.analysis) {
            cvResultsEl.hidden = false;
            cvResultsEl.innerHTML = `<p>CV <strong>${escapeHtml(full.cv.originalFilename)}</strong> uploaded successfully.</p><p style="color:var(--text-dim);font-size:.9rem;">${escapeHtml(e.message)}</p><button class="btn btn--primary" onclick="window.Morine.analyzeCV('${uploadedId}')">Try analysis again</button>`;
          }
        } catch {}
      } else {
        if (cvUploadStatus) { cvUploadStatus.textContent = e.message; cvUploadStatus.className="cv-status is-error"; }
        showToast(e.message, "error");
      }
    } finally { cvUploadBtn.disabled = false; }
  });

  function showCvInput(){
    if (currentUser) { try{ loadCVList(); }catch{} }
    const form = $("#cvWorkspace .cv-upload");
    const again = $("#cvNewAction");
    if (form) form.hidden = false;
    if (again) again.hidden = true;
  }
  function hideCvInput(){
    const form = $("#cvWorkspace .cv-upload");
    const again = $("#cvNewAction");
    if (form) form.hidden = true;
    if (again) again.hidden = false;
  }
  const cvNewBtn = $("#cvNewBtn");
  if (cvNewBtn) cvNewBtn.addEventListener("click", showCvInput);

  async function viewCV(id) {
    try { const data = await apiRequest(`/api/cv/${id}`, "GET"); if (data.cv.analysis) renderAnalysis(data.cv); else { cvResultsEl.hidden=false; cvResultsEl.innerHTML=`<p>CV <strong>${escapeHtml(data.cv.originalFilename)}</strong> uploaded. No analysis yet.</p><button class="btn btn--primary" onclick="window.Morine.analyzeCV('${id}')">Analyze now</button>`; } if (data.cv.optimizedContent) renderOptimized(data.cv); else cvOptimizedEl.hidden=true; } catch(e){ showToast(e.message,"error"); }
  }
  async function analyzeCV(id) {
    const jd = cvJobDesc ? cvJobDesc.value.trim() : "";
    try { showToast("Analyzing — this may take 10-20 seconds..."); const data = await apiRequest(`/api/cv/${id}/analyze`, "POST", jd ? {jobDescription: jd} : {}); await loadCVList(); const full = await apiRequest(`/api/cv/${id}`, "GET"); renderAnalysis(full.cv); hideCvInput(); showToast("Analysis complete."); } catch(e){ showToast(e.message,"error"); }
  }
  async function optimizeCV(id) {
    try { showToast("Generating optimized CV..."); const data = await apiRequest(`/api/cv/${id}/optimize`, "POST"); const full = await apiRequest(`/api/cv/${id}`, "GET"); renderOptimized(full.cv); showToast("Optimized CV ready — review and download."); } catch(e){ showToast(e.message,"error"); }
  }
  async function deleteCV(id) {
    if (!confirm("Delete this CV?")) return;
    try { await apiRequest(`/api/cv/${id}`, "DELETE"); showToast("CV deleted."); cvResultsEl.hidden=true; cvOptimizedEl.hidden=true; await loadCVList(); } catch(e){ showToast(e.message,"error"); }
  }

  /* ---------- 10b. Skill-Gap Analysis ---------- */
  const sgGate = $("#sgGate");
  const sgWorkspace = $("#sgWorkspace");
  const sgTargetRole = $("#sgTargetRole");
  const sgCvSelect = $("#sgCvSelect");
  const sgAnalyzeBtn = $("#sgAnalyzeBtn");
  const sgStatus = $("#sgStatus");
  const sgListEl = $("#sgList");
  const sgResultsEl = $("#sgResults");

  function updateSkillGapAuthUI() {
    const logged = !!currentUser;
    if (sgGate) sgGate.hidden = logged;
    if (sgWorkspace) sgWorkspace.hidden = !logged;
    if (logged) { loadSkillGapList(); loadSgCvOptions(); prefillSgTargetRole(); }
  }

  // Extend nav auth wrapper to also update skill-gap
  const _origUpdateNav2 = updateNavAuthState;
  updateNavAuthState = function() {
    _origUpdateNav2();
    updateCVAuthUI();
    updateSkillGapAuthUI();
  };

  async function prefillSgTargetRole() {
    if (!currentUser || !sgTargetRole) return;
    try {
      const data = await apiRequest("/api/profile", "GET");
      if (data.profile && data.profile.targetRole && !sgTargetRole.value) sgTargetRole.value = data.profile.targetRole;
    } catch {}
  }

  async function loadSgCvOptions() {
    if (!sgCvSelect || !currentUser) return;
    try {
      const data = await apiRequest("/api/cv", "GET");
      const cvs = data.cvs || [];
      const cur = sgCvSelect.value;
      sgCvSelect.innerHTML = '<option value="">Analyze without CV (profile only)</option>' + cvs.map(cv => `<option value="${cv._id}">${escapeHtml(cv.originalFilename)} · ${cv.fileType.toUpperCase()}</option>`).join("");
      if (cur) sgCvSelect.value = cur;
    } catch {}
  }

  async function loadSkillGapList() {
    if (!currentUser || !sgListEl) return;
    try {
      const data = await apiRequest("/api/skill-gap", "GET");
      const list = data.analyses || [];
      if (list.length === 0) { sgListEl.innerHTML = '<p style="color:var(--text-dim);font-size:.9rem;">No analyses yet — run one above. Previous analyses are preserved even if a new one fails due to AI limits.</p>'; return; }
      sgListEl.innerHTML = list.map(a => `
        <div class="cv-list__item">
          <div class="cv-list__meta"><strong>${escapeHtml(a.targetRole)}</strong><span>${a.overallReadiness}% readiness · ${new Date(a.createdAt).toLocaleDateString()} · ${a.skillGaps.length} gaps</span></div>
          <div class="cv-list__actions">
            <button class="btn btn--ghost btn--sm" onclick="window.Morine.viewSkillGap('${a._id}')">View</button>
            <button class="btn btn--ghost btn--sm" onclick="window.Morine.deleteSkillGap('${a._id}')">Delete</button>
          </div>
        </div>`).join("");
    } catch (e) { sgListEl.innerHTML = `<p style="color:#ef4444;">${escapeHtml(e.message)}</p>`; }
  }

  function renderSkillGap(a) {
    if (!a || !sgResultsEl) return;
    sgResultsEl.hidden = false;
    const readiness = Math.min(100, Math.max(0, Number(a.overallReadiness)||0));
    sgResultsEl.innerHTML = `
      <h3 style="font-size:1.15rem;">Skill-Gap Analysis — ${escapeHtml(a.targetRole)}</h3>
      <p style="color:var(--text-dim);font-size:.9rem;">${escapeHtml(a.summary||'')}</p>
      <div class="cv-score"><div class="cv-score__ring" style="--p:${readiness}"><span>${readiness}<small style="font-size:.7rem">%</small></span></div><div><strong>Overall Readiness</strong><p style="color:var(--text-dim);font-size:.82rem;">AI-generated readiness estimate — not an employment probability. Based on your profile${a.sourceCvId ? ' + CV' : ''}.</p></div></div>
      <div><h4>Current Skills</h4><p>${(a.currentSkills||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      <div><h4>Required Skills for ${escapeHtml(a.targetRole)}</h4><p>${(a.requiredSkills||[]).map(s=>`<span class="cv-chip" style="background:rgba(34,211,238,.1);border-color:rgba(34,211,238,.25);">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      <div><h4>Key Strengths</h4><ul>${(a.strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div><h4>Skill Gaps</h4>${(a.skillGaps||[]).map(g=>`<div class="cv-bullet"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><strong>${escapeHtml(g.skill)}</strong><span class="cv-chip" style="border-color:${g.priority==='High'?'#f87171':g.priority==='Medium'?'#fbbf24':'#34d399'};background:${g.priority==='High'?'rgba(248,113,113,.12)':g.priority==='Medium'?'rgba(251,191,36,.12)':'rgba(52,211,153,.12)'}">${escapeHtml(g.priority)}</span></div><p style="margin:6px 0;color:var(--text-dim);font-size:.9rem;"><strong>Why:</strong> ${escapeHtml(g.reason||'')}</p><p style="font-size:.9rem;"><strong>Next:</strong> ${escapeHtml(g.recommendedAction||'')}</p></div>`).join("")||"<p>—</p>"}</div>
      <div><h4>Learning Roadmap</h4>${(a.roadmap||[]).map(r=>`<div class="cv-bullet"><div class="cv-bullet__label">STAGE ${r.stage}: ${escapeHtml(r.title)}</div><p><strong>Skills:</strong> ${(r.skills||[]).map(s=>escapeHtml(s)).join(", ")||"—"}</p><ul>${(r.actions||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul>${r.projectIdea ? `<p style="margin-top:6px;"><strong>Project idea:</strong> ${escapeHtml(r.projectIdea)}</p>` : ""}</div>`).join("")||"<p>—</p>"}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn--primary" onclick="window.Morine.reanalyzeSkillGap()">Generate Again</button>
        <button class="btn btn--ghost" onclick="window.Morine.deleteSkillGap('${a._id}')">Delete</button>
      </div>
    `;
    sgResultsEl.scrollIntoView({behavior:"smooth", block:"start"});
  }

  async function runSkillGapAnalyze() {
    if (!currentUser) { showToast("Please sign in to analyze skill gaps.", "error"); openAuth("signin"); return; }
    const targetRole = sgTargetRole ? sgTargetRole.value.trim() : "";
    if (!targetRole) { showToast("Please enter a target role.", "error"); if (sgTargetRole) sgTargetRole.focus(); return; }
    if (sgAnalyzeBtn) sgAnalyzeBtn.disabled = true;
    if (sgStatus) { sgStatus.textContent = "Analyzing — this may take 10-20 seconds..."; sgStatus.className="cv-status"; }
    try {
      const body = { targetRole };
      if (sgCvSelect && sgCvSelect.value) body.cvId = sgCvSelect.value;
      const data = await apiRequest("/api/skill-gap/analyze", "POST", body);
      showToast("Skill-gap analysis complete.");
      if (sgStatus) { sgStatus.textContent = "Done!"; sgStatus.className="cv-status is-success"; }
      await loadSkillGapList();
      await loadSgCvOptions();
      // Render the newly created analysis
      if (data.analysis) renderSkillGap(data.analysis);
      else if (data.analysis && data.analysis._id) { const full = await apiRequest(`/api/skill-gap/${data.analysis._id}`, "GET"); renderSkillGap(full.analysis); }
      hideSgInput();
    } catch (e) {
      if (sgStatus) { sgStatus.textContent = e.message; sgStatus.className="cv-status is-error"; }
      showToast(e.message, "error");
      // Preserve existing list even on failure
      try { await loadSkillGapList(); } catch {}
    } finally { if (sgAnalyzeBtn) sgAnalyzeBtn.disabled = false; }
  }

  async function viewSkillGap(id) {
    try { const data = await apiRequest(`/api/skill-gap/${id}`, "GET"); renderSkillGap(data.analysis); } catch(e){ showToast(e.message,"error"); }
  }
  async function deleteSkillGap(id) {
    if (!confirm("Delete this analysis?")) return;
    try { await apiRequest(`/api/skill-gap/${id}`, "DELETE"); showToast("Analysis deleted."); sgResultsEl.hidden=true; await loadSkillGapList(); } catch(e){ showToast(e.message,"error"); }
  }
  function reanalyzeSkillGap() { showSgInput(); if (sgTargetRole) sgTargetRole.focus(); window.scrollTo({top: document.getElementById("skill-gap").offsetTop - 80, behavior:"smooth"}); }

  function showSgInput(){
    if (currentUser) { try{ loadSkillGapList(); }catch{} }
    const form = $("#sgWorkspace .cv-upload");
    const again = $("#sgNewAction");
    if (form) form.hidden = false;
    if (again) again.hidden = true;
  }
  function hideSgInput(){
    const form = $("#sgWorkspace .cv-upload");
    const again = $("#sgNewAction");
    if (form) form.hidden = true;
    if (again) again.hidden = false;
  }
  const sgNewBtn = $("#sgNewBtn");
  if (sgNewBtn) sgNewBtn.addEventListener("click", showSgInput);

  if (sgAnalyzeBtn) sgAnalyzeBtn.addEventListener("click", runSkillGapAnalyze);

  // Career path discovery
  const cpGate=$("#cpGate"), cpWorkspace=$("#cpWorkspace"), cpTargetRole=$("#cpTargetRole"), cpCvSelect=$("#cpCvSelect"), cpAnalyzeBtn=$("#cpAnalyzeBtn"), cpStatus=$("#cpStatus"), cpListEl=$("#cpList"), cpResultsEl=$("#cpResults");
  function updateCpAuthUI(){ const l=!!currentUser; if(cpGate) cpGate.hidden=l; if(cpWorkspace) cpWorkspace.hidden=!l; if(l){ loadCpList(); loadCpCvOptions(); prefillCpTargetRole(); } }
  async function prefillCpTargetRole(){ if(!currentUser||!cpTargetRole) return; try{ const d=await apiRequest("/api/profile","GET"); if(d.profile?.targetRole && !cpTargetRole.value) cpTargetRole.value=d.profile.targetRole; }catch{} }
  async function loadCpCvOptions(){ if(!cpCvSelect||!currentUser) return; try{ const d=await apiRequest("/api/cv","GET"); const cvs=d.cvs||[]; const cur=cpCvSelect.value; cpCvSelect.innerHTML='<option value="">Without CV (profile + history)</option>'+cvs.map(cv=>`<option value="${cv._id}">${escapeHtml(cv.originalFilename)} · ${cv.fileType.toUpperCase()}</option>`).join(""); if(cur) cpCvSelect.value=cur; }catch{} }
  async function loadCpList(){ if(!currentUser||!cpListEl) return; try{ const d=await apiRequest("/api/career-path","GET"); const list=d.paths||d.data?.paths||[]; if(list.length===0){ cpListEl.innerHTML='<p style="color:var(--text-dim);font-size:.9rem;">No career paths yet — build one above.</p>'; return;} cpListEl.innerHTML=list.map(a=>`<div class="cv-list__item"><div class="cv-list__meta"><strong>${escapeHtml(a.targetRole)}</strong><span>${a.readiness}% readiness · ${new Date(a.createdAt).toLocaleDateString()} · ${a.stages?.length||0} stages</span></div><div class="cv-list__actions"><button class="btn btn--ghost btn--sm" onclick="window.Morine.viewCareerPath('${a._id}')">View</button><button class="btn btn--ghost btn--sm" onclick="window.Morine.deleteCareerPath('${a._id}')">Delete</button></div></div>`).join(""); }catch(e){ cpListEl.innerHTML=`<p style="color:#ef4444">${escapeHtml(e.message)}</p>`; } }
  function renderCareerPath(a){
    if(!a||!cpResultsEl) return; cpResultsEl.hidden=false;
    const r=Math.min(100,Math.max(0,Number(a.readiness)||0));
    cpResultsEl.innerHTML=`
      <h3 style="font-size:1.15rem;">Career Path to ${escapeHtml(a.targetRole||a.destinationRole)}</h3>
      <div class="cv-score"><div class="cv-score__ring" style="--p:${r}"><span>${r}<small style="font-size:.7rem">%</small></span></div><div><strong>AI-generated career readiness estimate</strong><p style="color:var(--text-dim);font-size:.82rem;">Not an employment probability. Based on your profile${a.startingPoint?' — '+escapeHtml(a.startingPoint):''}.</p></div></div>
      <p style="color:var(--text-dim);font-size:.9rem;">${escapeHtml(a.summary||'')}</p>
      <div><h4>Starting Point</h4><p>${escapeHtml(a.startingPoint||'—')}</p><p>${(a.currentSkills||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||""}</p></div>
      <div><h4>Roadmap</h4>${(a.stages||[]).map(s=>`<div class="cv-bullet"><div class="cv-bullet__label">STAGE ${s.stage}: ${escapeHtml(s.title)}</div><p><strong>${escapeHtml(s.objective||'')}</strong></p><p><strong>Skills:</strong> ${(s.skills||[]).map(x=>escapeHtml(x)).join(", ")||"—"}</p><ul>${(s.actions||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ul>${(s.projectIdeas||[]).length?`<p><strong>Projects:</strong> ${s.projectIdeas.map(x=>escapeHtml(x)).join("; ")}</p>`:""}${(s.experienceIdeas||[]).length?`<p><strong>Experience:</strong> ${s.experienceIdeas.map(x=>escapeHtml(x)).join("; ")}</p>`:""}${s.estimatedDuration?`<p><em>Duration: ${escapeHtml(s.estimatedDuration)}</em></p>`:""}${s.milestone?`<p><strong>Milestone:</strong> ${escapeHtml(s.milestone)}</p>`:""}</div>`).join("")||"<p>—</p>"}</div>
      <div><h4>Milestones</h4>${(a.milestones||[]).map(m=>`<div class="cv-bullet"><strong>${escapeHtml(m.title)}</strong><p>${escapeHtml(m.description||'')}</p><p style="font-size:.85rem;color:var(--text-dim)">${escapeHtml(m.completionCriteria||'')}</p></div>`).join("")||"<p>—</p>"}</div>
      <div><h4>Alternative Roles</h4><ul>${(a.alternativeRoles||[]).map(x=>`<li><strong>${escapeHtml(x.title)}</strong> — ${escapeHtml(x.reason||'')}</li>`).join("")||"<li>—</li>"}</ul></div>
      <div><h4>Next Steps</h4><ol style="margin-left:18px;list-style:decimal;">${(a.nextSteps||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ol></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('skill-gap')">View Skill Gap</button>
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('jobs')">Find Matching Jobs</button>
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('cv-optimizer')">Optimize My CV</button>
        <button class="btn btn--primary btn--sm" onclick="window.Morine.deleteCareerPath('${a._id}')">Delete</button>
      </div>
    `;
    cpResultsEl.scrollIntoView({behavior:"smooth",block:"start"});
  }
  async function runCpAnalyze(){
    if(!currentUser){ showToast("Please sign in to build a career path.","error"); openAuth("signin"); return; }
    const tr=cpTargetRole?cpTargetRole.value.trim():"";
    if(cpAnalyzeBtn) cpAnalyzeBtn.disabled=true;
    if(cpStatus){ cpStatus.textContent="Building path — 10-20s…"; cpStatus.className="cv-status"; }
    try{
      const body={}; if(tr) body.targetRole=tr; if(cpCvSelect&&cpCvSelect.value) body.cvId=cpCvSelect.value;
      const d=await apiRequest("/api/career-path/analyze","POST",body);
      showToast("Career path ready.");
      if(cpStatus){ cpStatus.textContent="Done!"; cpStatus.className="cv-status is-success"; }
      await loadCpList(); renderCareerPath(d.path); hideCpInput();
    }catch(e){
      if(cpStatus){ cpStatus.textContent=e.message; cpStatus.className="cv-status is-error"; }
      if(e.code==="AI_QUOTA_EXHAUSTED") showToast("Career path generation is temporarily unavailable because the AI service has reached its usage limit. Your profile and existing career data are still safe.","error");
      else showToast(e.message,"error");
      try{ await loadCpList(); }catch{}
    }finally{ if(cpAnalyzeBtn) cpAnalyzeBtn.disabled=false; }
  }
  async function viewCareerPath(id){ try{ const d=await apiRequest("/api/career-path/"+id,"GET"); renderCareerPath(d.path); }catch(e){ showToast(e.message,"error"); } }
  async function deleteCareerPath(id){ if(!confirm("Delete this career path?")) return; try{ await apiRequest("/api/career-path/"+id,"DELETE"); showToast("Deleted."); if(cpResultsEl) cpResultsEl.hidden=true; await loadCpList(); }catch(e){ showToast(e.message,"error"); } }
  if(cpAnalyzeBtn) cpAnalyzeBtn.addEventListener("click", runCpAnalyze);

  function showCpInput(){
    if (currentUser) { try{ loadCpList(); }catch{} }
    const form = $("#cpWorkspace .cv-upload");
    const again = $("#cpNewAction");
    if (form) form.hidden = false;
    if (again) again.hidden = true;
  }
  function hideCpInput(){
    const form = $("#cpWorkspace .cv-upload");
    const again = $("#cpNewAction");
    if (form) form.hidden = true;
    if (again) again.hidden = false;
  }
  const cpNewBtn = $("#cpNewBtn");
  if (cpNewBtn) cpNewBtn.addEventListener("click", showCpInput);

  // Interview Preparation
  const ipGate=$("#ipGate"), ipWorkspace=$("#ipWorkspace"), ipTargetRole=$("#ipTargetRole"), ipCvSelect=$("#ipCvSelect"), ipJobSelect=$("#ipJobSelect"), ipAnalyzeBtn=$("#ipAnalyzeBtn"), ipStatus=$("#ipStatus"), ipListEl=$("#ipList"), ipResultsEl=$("#ipResults");
  function updateIpAuthUI(){ const l=!!currentUser; if(ipGate) ipGate.hidden=l; if(ipWorkspace) ipWorkspace.hidden=!l; if(l){ loadIpList(); loadIpCvOptions(); loadIpJobOptions(); prefillIpTargetRole(); } }
  async function prefillIpTargetRole(){ if(!currentUser||!ipTargetRole) return; try{ const d=await apiRequest("/api/profile","GET"); if(d.profile?.targetRole && !ipTargetRole.value) ipTargetRole.value=d.profile.targetRole; }catch{} }
  async function loadIpCvOptions(){ if(!ipCvSelect||!currentUser) return; try{ const d=await apiRequest("/api/cv","GET"); const cvs=d.cvs||[]; const cur=ipCvSelect.value; ipCvSelect.innerHTML='<option value="">Without CV</option>'+cvs.map(cv=>`<option value="${cv._id}">${escapeHtml(cv.originalFilename)}</option>`).join(""); if(cur) ipCvSelect.value=cur;}catch{} }
  async function loadIpJobOptions(){ if(!ipJobSelect||!currentUser) return; try{ const d=await apiRequest("/api/job-match","GET"); const ms=(d.matches||[]).slice(0,10); // also load live jobs cache if available
    let opts='<option value="">General role preparation</option>';
    ms.forEach(m=>{ opts+=`<option value="jm:${m._id}">${escapeHtml(m.jobTitle)} @ ${escapeHtml(m.company)} (matched)</option>`; });
    // add recent live jobs if cached
    Object.values(_jobCache).slice(0,5).forEach(j=>{ opts+=`<option value="job:${escapeAttr(j.id||j.title)}">${escapeHtml(j.title)} @ ${escapeHtml(j.company||'')}</option>`; });
    ipJobSelect.innerHTML=opts;
  }catch{} }
  async function loadIpList(){ if(!currentUser||!ipListEl) return; try{ const d=await apiRequest("/api/interview-prep","GET"); const list=d.preparations||[]; if(list.length===0){ ipListEl.innerHTML='<p style="color:var(--text-dim);font-size:.9rem;">No preparations yet — prepare above.</p>'; return;} ipListEl.innerHTML=list.map(a=>`<div class="cv-list__item"><div class="cv-list__meta"><strong>${escapeHtml(a.targetRole)}${a.jobTitle?` — ${escapeHtml(a.jobTitle)}`:''}</strong><span>${a.readiness}% readiness · ${new Date(a.createdAt).toLocaleDateString()} · ${a.questions?.length||0} questions</span></div><div class="cv-list__actions"><button class="btn btn--ghost btn--sm" onclick="window.Morine.viewInterviewPrep('${a._id}')">View</button><button class="btn btn--ghost btn--sm" onclick="window.Morine.deleteInterviewPrep('${a._id}')">Delete</button></div></div>`).join(""); }catch(e){ ipListEl.innerHTML=`<p style="color:#ef4444">${escapeHtml(e.message)}</p>`; } }
  function renderInterviewPrep(a){
    if(!a||!ipResultsEl) return; ipResultsEl.hidden=false;
    const r=Math.min(100,Math.max(0,Number(a.readiness)||0));
    let qFilter='All';
    const cats=[...new Set((a.questions||[]).map(q=>q.category))];
    ipResultsEl.innerHTML=`
      <h3 style="font-size:1.15rem;">Interview Preparation: ${escapeHtml(a.targetRole)}${a.jobTitle?` — ${escapeHtml(a.jobTitle)}${a.company?` @ ${escapeHtml(a.company)}`:''}`:''}</h3>
      <div class="cv-score"><div class="cv-score__ring" style="--p:${r}"><span>${r}<small style="font-size:.7rem">%</small></span></div><div><strong>AI-generated interview readiness estimate</strong><p style="color:var(--text-dim);font-size:.82rem;">Not a hiring probability. Based on your actual profile/CV.</p><p style="font-size:.9rem;margin-top:6px;">${escapeHtml(a.summary||'')}</p></div></div>
      <div><h4>Focus Areas</h4><p>${(a.focusAreas||[]).map(s=>`<span class="cv-chip">${escapeHtml(s)}</span>`).join("")||"—"}</p></div>
      <div><h4>Skill Focus</h4>${(a.skillFocus||[]).map(s=>`<div class="cv-bullet"><strong>${escapeHtml(s.skill)}</strong><p>${escapeHtml(s.reason||'')}</p><p><em>${escapeHtml(s.preparationAction||'')}</em></p></div>`).join("")||"<p>—</p>"}</div>
      <div style="margin:12px 0;"><strong>Filter: </strong><select id="ipQFilter" style="background:rgba(6,10,23,.55);border:1px solid var(--border);border-radius:8px;padding:6px 10px;"><option value="All">All</option>${cats.map(c=>`<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")}</select></div>
      <div id="ipQuestions">${(a.questions||[]).map(q=>`<div class="cv-bullet ip-q" data-cat="${escapeAttr(q.category)}"><div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(q.category)} · ${escapeHtml(q.difficulty)}</strong><button class="btn btn--ghost btn--sm" onclick="this.closest('.ip-q').querySelector('.ip-guidance').hidden=!this.closest('.ip-q').querySelector('.ip-guidance').hidden; this.textContent=this.textContent==='Show Answer Guidance'?'Hide Guidance':'Show Answer Guidance'">Show Answer Guidance</button></div><p style="margin:8px 0;font-weight:600;">${escapeHtml(q.question)}</p><p style="font-size:.85rem;color:var(--text-dim)"><strong>Why it matters:</strong> ${escapeHtml(q.whyItMatters||'')}</p><p style="font-size:.85rem"><strong>What to cover:</strong> ${(q.whatToCover||[]).map(x=>escapeHtml(x)).join(" · ")||"—"}</p>${(q.followUpQuestions||[]).length?`<p style="font-size:.85rem"><strong>Follow-ups:</strong> ${q.followUpQuestions.map(x=>escapeHtml(x)).join(" · ")}</p>`:""}<div class="ip-guidance" hidden style="margin-top:10px;padding:10px;background:rgba(148,163,216,.06);border-radius:8px;">${(()=>(a.answerGuidance||[]).find(g=>g.questionId===q.id)?(()=>{const g=(a.answerGuidance||[]).find(x=>x.questionId===q.id);return `<p><strong>Framework:</strong> ${escapeHtml(g.framework||'')}</p><p><strong>Key points:</strong></p><ul>${(g.keyPoints||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ul><p><strong>Warnings:</strong></p><ul>${(g.warningPoints||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ul>`})():"<p style='color:var(--text-mute)'>No guidance</p>")()}</div></div>`).join("")}</div>
      <div><h4>Study Plan</h4>${(a.studyPlan||[]).map(s=>`<div class="cv-bullet"><div class="cv-bullet__label">STAGE ${s.stage}: ${escapeHtml(s.title)}</div><ul>${(s.actions||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ul>${(s.resources||[]).length?`<p><strong>Resources:</strong> ${s.resources.map(x=>escapeHtml(x)).join(", ")}</p>`:""}<p style="font-size:.85rem;color:var(--text-dim)">${escapeHtml(s.completionCriteria||'')}</p></div>`).join("")||"<p>—</p>"}</div>
      <div><h4>Next Steps</h4><ol style="margin-left:18px;list-style:decimal;">${(a.nextSteps||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("")||"<li>—</li>"}</ol></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('skill-gap')">Review Skill Gaps</button>
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('cv-optimizer')">Optimize CV</button>
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('career-path')">Career Path</button>
        <button class="btn btn--ghost btn--sm" onclick="window.Morine.openFeature('jobs')">Find Jobs</button>
      </div>
    `;
    const sel=ipResultsEl.querySelector("#ipQFilter");
    if(sel) sel.addEventListener("change",e=>{
      const v=e.target.value;
      ipResultsEl.querySelectorAll(".ip-q").forEach(el=>{ el.hidden = (v!=="All" && el.dataset.cat!==v); });
    });
    ipResultsEl.scrollIntoView({behavior:"smooth",block:"start"});
  }
  async function runIpAnalyze(){
    if(!currentUser){ showToast("Please sign in to prepare.","error"); openAuth("signin"); return; }
    const tr=ipTargetRole?ipTargetRole.value.trim():"";
    if(ipAnalyzeBtn) ipAnalyzeBtn.disabled=true;
    if(ipStatus){ ipStatus.textContent="Preparing — 10-20s…"; ipStatus.className="cv-status"; }
    try{
      const body={}; if(tr) body.targetRole=tr;
      if(ipCvSelect&&ipCvSelect.value) body.cvId=ipCvSelect.value;
      if(ipJobSelect&&ipJobSelect.value){
        const v=ipJobSelect.value;
        if(v.startsWith("jm:")) body.jobMatchId=v.slice(3);
        else if(v.startsWith("job:")){
          const key=v.slice(4);
          const j=_jobCache[key];
          if(j) body.job={title:j.title,company:j.company,location:j.location,description:j.description||"",requirements:[]};
        }
      }
      const d=await apiRequest("/api/interview-prep/analyze","POST",body);
      showToast("Interview preparation ready.");
      if(ipStatus){ ipStatus.textContent="Done!"; ipStatus.className="cv-status is-success"; }
      await loadIpList(); renderInterviewPrep(d.preparation); hideIpInput();
    }catch(e){
      if(ipStatus){ ipStatus.textContent=e.message; ipStatus.className="cv-status is-error"; }
      if(e.code==="AI_QUOTA_EXHAUSTED") showToast("Interview preparation is temporarily unavailable because the AI service has reached its usage limit. Your existing career data is safe. Please try again later.","error");
      else showToast(e.message,"error");
      try{ await loadIpList(); }catch{}
    }finally{ if(ipAnalyzeBtn) ipAnalyzeBtn.disabled=false; }
  }
  async function viewInterviewPrep(id){ try{ const d=await apiRequest("/api/interview-prep/"+id,"GET"); renderInterviewPrep(d.preparation); }catch(e){ showToast(e.message,"error"); } }
  async function deleteInterviewPrep(id){ if(!confirm("Delete?")) return; try{ await apiRequest("/api/interview-prep/"+id,"DELETE"); showToast("Deleted."); if(ipResultsEl) ipResultsEl.hidden=true; await loadIpList(); }catch(e){ showToast(e.message,"error"); } }
  if(ipAnalyzeBtn) ipAnalyzeBtn.addEventListener("click", runIpAnalyze);

  function showIpInput(){
    if (currentUser) { try{ loadIpList(); }catch{} }
    const form = $("#ipWorkspace .cv-upload");
    const again = $("#ipNewAction");
    if (form) form.hidden = false;
    if (again) again.hidden = true;
  }
  function hideIpInput(){
    const form = $("#ipWorkspace .cv-upload");
    const again = $("#ipNewAction");
    if (form) form.hidden = true;
    if (again) again.hidden = false;
  }
  const ipNewBtn = $("#ipNewBtn");
  if (ipNewBtn) ipNewBtn.addEventListener("click", showIpInput);

  // Consolidated auth state: single source of truth for all features
  const _origFinalAuth = updateNavAuthState;
  updateNavAuthState = function(){
    _origFinalAuth();
    // Ensure all gated workspaces reflect currentUser
    updateCVAuthUI();
    updateSkillGapAuthUI();
    updateCpAuthUI();
    updateIpAuthUI();
    if(currentUser){
      loadJobMatches();
      // Cp/Ip loads already triggered via updateCpAuthUI/updateIpAuthUI, but ensure job data for interview selector
      loadIpJobOptions();
    }
  };

  // Back to Home buttons — hide feature workspaces and return to landing
  const backHomeButtons = [
    "cvBackHome", "skillGapBackHome", "careerPathBackHome", "interviewBackHome", "jobsBackHome", "profileBackHome"
  ];
  backHomeButtons.forEach(id => {
    const btn = $("#" + id);
    if (btn) btn.addEventListener("click", closeFeature);
  });

  // --- Temporary form cleanup on section leave (shared-device safety) ---
  function clearJobSearchForm(){ try{ const kw=$("#liveKeyword"), loc=$("#liveLocation"); if(kw) kw.value=""; if(loc) loc.value=""; $$(".chip").forEach(c=>c.classList.toggle("is-active", c.dataset.filter==="all")); }catch{} }
  function clearCvForm(){ try{ selectedCVFile=null; if(cvFileInput) cvFileInput.value=""; if(cvDropLabel) cvDropLabel.textContent="Drop PDF or DOCX here, or click to browse"; if(cvJobDesc) cvJobDesc.value=""; if(cvUploadStatus){ cvUploadStatus.textContent=""; cvUploadStatus.className="cv-status"; } }catch{} }
  function clearSkillGapForm(){ try{ if(sgTargetRole) sgTargetRole.value=""; if(sgCvSelect) sgCvSelect.value=""; if(sgStatus){ sgStatus.textContent=""; sgStatus.className="cv-status"; } }catch{} }
  function clearCareerPathForm(){ try{ if(cpTargetRole) cpTargetRole.value=""; if(cpCvSelect) cpCvSelect.value=""; if(cpStatus){ cpStatus.textContent=""; cpStatus.className="cv-status"; } }catch{} }
  function clearInterviewForm(){ try{ if(ipTargetRole) ipTargetRole.value=""; if(ipCvSelect) ipCvSelect.value=""; if(ipJobSelect) ipJobSelect.value=""; if(ipStatus){ ipStatus.textContent=""; ipStatus.className="cv-status"; } }catch{} }
  function clearJobMatchSelection(){ try{ if(jobMatchResultsEl) jobMatchResultsEl.hidden=true; }catch{} }

  // Observe section visibility to clear temporary inputs when user leaves feature; repopulate from profile on re-enter if authenticated
  if("IntersectionObserver" in window){
    const leaveObserver = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        const id=entry.target.id;
        if(!entry.isIntersecting){
          if(id==="jobs") { clearJobSearchForm(); clearJobMatchSelection(); }
          else if(id==="cv-optimizer") clearCvForm();
          else if(id==="skill-gap") clearSkillGapForm();
          else if(id==="career-path") clearCareerPathForm();
          else if(id==="interview-prep") clearInterviewForm();
        } else {
          // Re-enter: repopulate profile-backed defaults for authenticated user
          if(!currentUser) return;
          if(id==="skill-gap" && sgTargetRole && !sgTargetRole.value) prefillSgTargetRole();
          if(id==="career-path" && cpTargetRole && !cpTargetRole.value) prefillCpTargetRole();
          if(id==="interview-prep" && ipTargetRole && !ipTargetRole.value) prefillIpTargetRole();
        }
      });
    },{threshold:0.1});
    ["jobs","cv-optimizer","skill-gap","career-path","interview-prep"].forEach(id=>{ const el=document.getElementById(id); if(el) leaveObserver.observe(el); });
  }

  /* ---------- 11. Session restore ---------- */
  updateCVAuthUI();
  updateSkillGapAuthUI();
  updateCpAuthUI();
  updateIpAuthUI();
  if(currentUser){ loadJobMatches(); loadCpList(); loadIpList(); }
  restoreSession();

  // Expose API for markup-driven flows
  window.Morine = {
    openAuth,
    closeAuth,
    showToast,
    quickSearch: function (kw, loc) {
      openFeature("jobs");
      if (liveKeyword) liveKeyword.value = kw;
      if (liveLocation) liveLocation.value = loc;
      doLiveSearch(1);
    },
    liveSearch: doLiveSearch,
    getUser: function () { return currentUser; },
    logout: handleLogout,
    openFeature,
    closeFeature,
    viewCV,
    analyzeCV,
    optimizeCV,
    deleteCV,
    loadCVList,
    viewSkillGap,
    deleteSkillGap,
    reanalyzeSkillGap,
    loadSkillGapList,
    analyzeJobMatchById,
    viewJobMatch,
    deleteJobMatch,
    loadJobMatches,
    renderJobMatch,
    viewCareerPath,
    deleteCareerPath,
    loadCpList,
    viewInterviewPrep,
    deleteInterviewPrep,
  };
})();