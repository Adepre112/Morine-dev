/* ============================================================
   MORINE — LANDING PAGE (index.html)
   Public marketing page interactions.
   - Navigation (scroll state, mobile menu)
   - Reveal on scroll
   - Animated "From skills to opportunity" flow
   - How-it-works timeline (scroll-driven fill)
   - Subtle parallax on background glows (desktop only)
   ============================================================ */

(function () {
  "use strict";

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Navigation ---------- */
  var nav = $("#nav");

  function updateNav() {
    nav.classList.toggle("is-scrolled", window.scrollY > 20);
  }
  window.addEventListener("scroll", updateNav, { passive: true });
  updateNav();

  var navToggle = $("#navToggle");
  var mobileMenu = $("#mobileMenu");
  function setMobileMenu(open) {
    mobileMenu.hidden = !open;
    navToggle.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  if (navToggle && mobileMenu) {
    navToggle.addEventListener("click", function () { setMobileMenu(mobileMenu.hidden); });
    $$(".mobile-menu a", mobileMenu).forEach(function (a) {
      a.addEventListener("click", function () { setMobileMenu(false); });
    });
  }
  $$(".nav__link").forEach(function (link) {
    link.addEventListener("click", function () { setMobileMenu(false); });
  });
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest(".nav__toggle")) return;
    if (mobileMenu && !mobileMenu.hidden && !e.target.closest && false) setMobileMenu(false);
  });

  /* Close the mobile menu when tapping outside it */
  document.addEventListener("click", function (e) {
    if (!mobileMenu || mobileMenu.hidden) return;
    if (e.target.closest(".nav")) return;
    setMobileMenu(false);
  });

  /* ---------- Reveal on scroll ---------- */
  var revealEls = $$(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  }

  /* ---------- Solution flow (from skills to opportunity) ---------- */
  var flowWrap = $("#solutionFlow");
  if (flowWrap) {
    var sflow = flowWrap.querySelector(".sflow");
    if ("IntersectionObserver" in window) {
      var fio = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { sflow.classList.add("is-in"); fio.unobserve(entry.target); }
        });
      }, { threshold: 0.3 });
      fio.observe(sflow);
    } else {
      sflow.classList.add("is-in");
    }
  }

  /* ---------- Product preview micro-entrances ---------- */
  var previewShell = $("#previewShell");
  if (previewShell && "IntersectionObserver" in window) {
    var pio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          pio.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });
    pio.observe(previewShell);
  } else if (previewShell) {
    previewShell.classList.add("is-in");
  }

  /* ---------- How-it-works timeline ---------- */
  var timeline = $("#careerTimeline");
  var timelineRaf = null;
  function updateTimeline() {
    if (!timeline) return;
    var vh = window.innerHeight;
    var trigger = vh * 0.72;
    var steps = $$(".tl-step", timeline);
    var lastReached = -1;
    steps.forEach(function (step, i) {
      var node = $(".tl-node", step);
      var r = node.getBoundingClientRect();
      var center = r.top + r.height / 2;
      if (center <= trigger) lastReached = i;
    });
    steps.forEach(function (step, i) { step.classList.toggle("is-in", i <= lastReached); });
    var fill = $(".timeline__fill", timeline);
    if (lastReached < 0) { fill.style.height = "0%"; return; }
    var track = $(".timeline__track", timeline);
    var node = $(".tl-node", steps[lastReached]);
    var tr = track.getBoundingClientRect();
    var nr = node.getBoundingClientRect();
    var pct = Math.min(100, Math.max(0, ((nr.top + nr.height / 2 - tr.top) / tr.height) * 100));
    fill.style.height = pct + "%";
  }
  function onTimelineScroll() {
    if (timelineRaf) return;
    timelineRaf = requestAnimationFrame(function () {
      timelineRaf = null;
      updateTimeline();
    });
  }
  if (timeline) {
    updateTimeline();
    window.addEventListener("scroll", onTimelineScroll, { passive: true });
    window.addEventListener("resize", onTimelineScroll, { passive: true });
  }

  /* ---------- Subtle parallax (desktop only) ---------- */
  var glowA = $(".bg-glow--a");
  var glowB = $(".bg-glow--b");
  var parallaxRaf = null;
  function updateParallax() {
    var enabled = !reduceMotion.matches && window.innerWidth >= 1024;
    if (!enabled) {
      if (glowA) glowA.style.transform = "";
      if (glowB) glowB.style.transform = "";
      return;
    }
    var y = window.scrollY;
    if (glowA) glowA.style.transform = "translate3d(0, " + (y * 0.16).toFixed(1) + "px, 0)";
    if (glowB) glowB.style.transform = "translate3d(0, " + (y * -0.1).toFixed(1) + "px, 0)";
  }
  function onParallax() {
    if (parallaxRaf) return;
    parallaxRaf = requestAnimationFrame(function () {
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
})();