/* ==========================================================================
 * Grammar Quest — UI layer (presentation only)
 * --------------------------------------------------------------------------
 * Subscribes to the game engine (js/game.js) and renders screens. Contains
 * no game rules: all state transitions go through engine action methods.
 * Screens: loading, home, map, level, intro, game, results, review,
 * level-complete, error + modals (pause / help / confirm).
 * ========================================================================== */
(function () {
  "use strict";

  const engine = window.grammarQuest;
  const E = engine.EVENTS;

  /* ----------------------------- constants ----------------------------- */

  // Painted-hole maps measured from the three supplied gameplay artworks.
  // Coordinates are percent positions IN EACH IMAGE; mapHole() converts them
  // to field percent under background-size:cover/center so targets sit on the
  // painted holes at every field aspect ratio.
  const HOLE_LAYOUTS = {
    desktop: {
      aspect: 1672 / 941,
      top: [{ x: 28.3, y: 49.8 }, { x: 49.7, y: 49.8 }, { x: 71.1, y: 49.8 }],
      bottom: [{ x: 31.8, y: 67.3 }, { x: 53.9, y: 67.3 }, { x: 75.6, y: 67.3 }],
    },
    tablet: {
      aspect: 1448 / 1086,
      top: [{ x: 33.0, y: 47.6 }, { x: 66.4, y: 47.6 }],
      bottom: [{ x: 22.4, y: 64.9 }, { x: 49.5, y: 64.9 }, { x: 76.8, y: 64.9 }],
    },
    mobile: {
      aspect: 941 / 1672,
      top: [{ x: 28.8, y: 50.9 }, { x: 70.9, y: 50.9 }],
      bottom: [{ x: 26.9, y: 65.3 }, { x: 72.3, y: 65.3 }],
    },
  };
  // Centralized Prairie Dog asset map — the ONLY gameplay target characters.
  // Reactions reflect the LEARNER'S action result (engine answerCorrect/Wrong),
  // never the grammar of the sentence itself.
  const PD = "assets/images/prairie-dogs/";
  const PRAIRIE_DOG_ASSETS = {
    neutral: {
      glasses: PD + "prairie-dog-neutral-glasses.png",
      student: PD + "prairie-dog-neutral-student.png",
      cool: PD + "prairie-dog-neutral-cool.png",
    },
    correct: {
      thumbsUp: PD + "prairie-dog-correct-thumbs-up.png",
      celebrate: PD + "prairie-dog-correct-celebrate.png",
    },
    wrong: {
      surprised: PD + "prairie-dog-wrong-surprised.png",
      anxious: PD + "prairie-dog-wrong-anxious.png",
      crying: PD + "prairie-dog-wrong-crying.png",
      dizzy: PD + "prairie-dog-wrong-dizzy.png",
      smashed: PD + "prairie-dog-wrong-smashed.png",
    },
  };
  const NEUTRAL_KEYS = Object.keys(PRAIRIE_DOG_ASSETS.neutral);

  // The Adventure Map is fully responsive: every device class renders its
  // OWN artwork and its OWN island coordinates. Backgrounds live in
  // assets/images — map-desktop.webp|jpg (1672x941 landscape panorama),
  // map-tablet.webp|jpg (1086x1448 portrait), bg-map-journey.webp|jpg
  // (941x1672 vertical, phones) — attached by css/style.css through the
  // .map-canvas--<tier> classes that applyMapTier() sets from the measured
  // map viewport (works inside a platform container, not just the window).
  //
  // fit:"aspect" — the canvas keeps the artwork's aspect ratio (vertical
  //   scrolling journey). fit:"cover" — the canvas fills the whole content
  //   area below the header and node positions are transformed through the
  //   real background-size:cover crop (mapCoverPos), so islands stay
  //   aligned at every stage aspect ratio without stretching the painting.
  //
  // Anchor coordinates are percent positions IN EACH ARTWORK, calibrated
  // against the painted islands, ordered start island -> castle island.
  const MAP_LAYOUTS = {
    desktop: {
      artW: 1672,
      artH: 941,
      fit: "cover",
      anchors: [
        { x: 15.0, y: 72.5 },  // large foreground start island (big tree)
        { x: 33.0, y: 63.5 },  // first bridge island
        { x: 43.5, y: 52.5 },  // second bridge island (inner grass, clear of the falls)
        { x: 53.5, y: 46.0 },  // waterfall island
        { x: 63.5, y: 40.0 },  // mid-path island
        { x: 72.5, y: 33.5 },  // ascending island
        { x: 80.0, y: 27.0 },  // island below the castle bridge
        { x: 85.5, y: 28.0 },  // castle island plateau — the destination
      ],
      castle: { x: 88.0, y: 12.5 }, // castle keep; trail stub fades out here
    },
    tablet: {
      artW: 1086,
      artH: 1448,
      fit: "aspect",
      anchors: [
        { x: 18.0, y: 78.0 },  // foreground start island (big tree, fence)
        { x: 65.5, y: 58.5 },  // waterfall island (right side, clear of the falls' mist)
        { x: 48.0, y: 36.0 },  // central hub island (cherry blossom, clear of the cliff)
        { x: 74.0, y: 24.0 },  // castle island plateau, below the castle keep
      ],
      castle: { x: 78.0, y: 12.5 },
    },
    mobile: {
      artW: 941,
      artH: 1672,
      fit: "aspect",
      anchors: [
        { x: 21, y: 86.5 },   // foreground island (hero / current level)
        { x: 39, y: 72.5 },   // wide earthen island
        { x: 19, y: 59 },     // island with the waterfall
        { x: 28, y: 50 },     // small green island
        { x: 46, y: 39.5 },   // stone-and-green island
        { x: 66, y: 28.5 },   // castle island — the destination
      ],
      castle: { x: 66, y: 24 },
    },
  };

  // Mobile overflow (original working phone layout): when more levels load
  // than the artwork has islands, the canvas grows and nodes continue on
  // evenly spaced rows through the middle band.
  const MAP_OVERFLOW_LANES = [50, 40, 60, 38, 62, 42, 58, 36, 64, 44, 56, 46, 54];
  const MAP_OVERFLOW_ROW = 150;
  const MAP_OVERFLOW_TOP = 170;
  const MAP_OVERFLOW_BOTTOM = 118;
  const MAP_SOON_MAX = 3; // locked "on the way" islands above loaded levels

  const MAP_TIERS = ["desktop", "tablet", "mobile"];
  // Below this stage width/height ratio the desktop cover crop would eat the
  // edge islands (start bottom-left, castle top-right), so the stage caps
  // its height and centers vertically instead.
  const MAP_DESKTOP_MIN_RATIO = 1.4;
  const MAP_ART_URLS = {
    desktop: { webp: "assets/images/map-desktop.webp", jpg: "assets/images/map-desktop.jpg" },
    tablet: { webp: "assets/images/map-tablet.webp", jpg: "assets/images/map-tablet.jpg" },
    mobile: { webp: "assets/images/bg-map-journey.webp", jpg: "assets/images/bg-map-journey.jpg" },
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  const FEEDBACK_DELAY = { correct: 1100 };
  // Wrong-answer reveal beat: the red hit lands at the hammer's impact frame,
  // the green correct-target reveal follows ~140ms later, and the correction
  // card waits until that reveal has settled. Wrong answers never auto-
  // advance — the learner presses Next after reading the correction.
  const REVEAL_DELAY = { correctTarget: 140, feedbackCard: 420, failScreen: 2400 };
  const STREAK_MILESTONES = [3, 5, 10];
  const SETTINGS_KEY = "grammar-quest:ui-settings:v1";

  const REWARDS = "assets/images/rewards/";
  const MASCOTS = "assets/images/mascots/";

  /* ------------------------------ helpers ------------------------------ */

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        if (key === "class") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs[key];
        else if (key === "html") node.innerHTML = attrs[key]; // never used with engine content
        else if (key.startsWith("on") && typeof attrs[key] === "function") {
          node.addEventListener(key.slice(2), attrs[key]);
        } else if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    (children || []).forEach((child) => {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  const clearNode = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  function fmtTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* SVG icon helper: renders a <use> reference into the sprite that lives
   * in index.html. Legacy png names map to sprite ids so call sites read the
   * same ("star-full" -> #i-star). */
  const SPRITE_ICONS = {
    "star-full": "star",
    "star-empty": "star-o",
    "heart-full": "heart",
    "heart-empty": "heart-o",
    "lock-closed": "lock",
    "wrong": "x-circle",
  };

  function icon(name, size, cls) {
    const id = SPRITE_ICONS[name] || name;
    const svg = svgEl("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      class: "icon" + (cls ? " " + cls : ""),
    });
    if (size) {
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
    svg.appendChild(svgEl("use", { href: "#i-" + id }));
    return svg;
  }

  const starsRow = (earned, max, animate, cls) => {
    const row = el("div", { class: (cls || "map-jnode__stars") + (animate ? " results__stars" : "") });
    for (let i = 1; i <= max; i++) {
      const isFull = i <= earned;
      const classes = [];
      if (isFull) classes.push("icon--gold");
      else classes.push("star--empty");
      if (animate && isFull) classes.push("star--earn");
      row.appendChild(icon(isFull ? "star-full" : "star-empty", 0, classes.join(" ")));
    }
    return row;
  };

  // Returns heart icon elements to append DIRECTLY into #hud-hearts —
  // no wrapper div, so .gamebar__hearts styles apply and nothing nests.
  const heartsRow = (lives, max) => {
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= max; i++) {
      const full = i <= lives;
      frag.appendChild(icon(full ? "heart-full" : "heart-empty", 22,
        full ? "heart--full" : "heart--empty"));
    }
    return frag;
  };

  /* ------------------------------ UI state ----------------------------- */

  const ctx = {
    screen: "loading",
    moleIndex: 0,
    lastWaveSig: null,
    activeMoles: [],
    levelId: null,
    challengeId: null,
    challenge: null,        // challengeStarted payload
    question: null,         // current public question
    questionLocked: false,
    marked: null,           // { learnerValue, correctValue } for resize re-render
    pendingResult: null,
    gameCompleted: false,
    levelJustCompleted: null,
    reviewReturn: "results",
    modalStack: [],
    layoutMobile: false,
    resizeTimer: null,
    mapTier: null,            // active map device class (desktop|tablet|mobile)
    mapRenderWidth: 0,        // last map-viewport size the map was laid out for
    mapRenderHeight: 0,
    seenJourneyKeys: new Set(), // level ids already shown unlocked (pop anim)
  };

  const uiSettings = loadSettings();

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return { sound: parsed.sound !== false, animations: parsed.animations !== false };
    } catch (err) {
      return { sound: true, animations: true };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(uiSettings)); } catch (err) { /* private mode */ }
  }

  function applyMotionPreference() {
    document.body.classList.toggle("reduce-motion", !uiSettings.animations);
  }

  /* ------------------------------- sound -------------------------------
   * Thin adapter over the central audio manager (js/audio.js). Legacy
   * short names map to the production sound set; every call is a no-op
   * if audio failed to load — gameplay never depends on sound. */
  const SOUND_ALIASES = {
    click: "uiClick",
    correct: "answerCorrect",
    wrong: "answerWrong",
    streak: "streak",
    "timer-low": "timerWarning",
    complete: "challengeComplete",
    unlock: "levelUnlock",
  };
  const Sound = {
    play(name) {
      try {
        const key = SOUND_ALIASES[name] || name;
        window.grammarQuestAudio.play(key);
      } catch (err) { /* audio is an enhancement layer — never throw */ }
    },
  };

  /* --------------------------- screen manager -------------------------- */

  const SCREENS = {
    loading: "#screen-loading",
    error: "#screen-error",
    home: "#screen-home",
    map: "#screen-map",
    level: "#screen-level",
    intro: "#screen-intro",
    game: "#screen-game",
    results: "#screen-results",
    review: "#screen-review",
    "level-complete": "#screen-level-complete",
  };

  function showScreen(name) {
    ctx.screen = name;
    Object.values(SCREENS).forEach((sel) => { $(sel).hidden = true; });
    const target = $(SCREENS[name]);
    if (target) target.hidden = false;
    document.querySelector(".app").dataset.screen = name;
    HammerCursor.sync(); // the hammer only ever lives on the gameplay screen
  }

  /* ------------------------------- toasts ------------------------------ */

  let toastTimer = null;
  function toast(message, iconName) {
    const box = $("#toast");
    clearNode(box);
    if (iconName) box.appendChild(icon(iconName, 22, "icon--gold"));
    box.appendChild(el("span", { text: message }));
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
  }

  /* ------------------------------- modals ------------------------------ */

  const MODALS = { pause: "#modal-pause", help: "#modal-help", confirm: "#modal-confirm" };

  function openModal(name) {
    ctx.modalStack.push(name);
    $("#modal-root").hidden = false;
    Object.values(MODALS).forEach((sel) => { $(sel).hidden = true; });
    $(MODALS[name]).hidden = false;
  }

  function closeModal() {
    const name = ctx.modalStack.pop();
    if (ctx.modalStack.length) {
      // restore the modal that was underneath (e.g. settings opened from pause)
      Object.values(MODALS).forEach((sel) => { $(sel).hidden = true; });
      $(MODALS[ctx.modalStack[ctx.modalStack.length - 1]]).hidden = false;
    } else {
      $("#modal-root").hidden = true;
    }
    return name;
  }

  function closeAllModals() {
    ctx.modalStack = [];
    $("#modal-root").hidden = true;
    Object.values(MODALS).forEach((sel) => { $(sel).hidden = true; });
  }

  /* --------------------------- hammer game cursor ----------------------
   * The fantasy hammer is the ONLY pointer inside the whack arena on
   * desktop: a fixed overlay <img> (pointer-events:none) that tracks the
   * mouse in a rAF loop while .hammer-mode hides the native cursor over
   * the whole arena — dogs, bubbles, bubble text and paddles included.
   * Touch devices get NO hammer at all: no floating cursor, no tap-strike
   * overlay, no animation — a tap on the Prairie Dog/bubble submits the
   * answer directly and the mole reaction carries the feedback. Hammer
   * availability is decided by POINTER CAPABILITY ((hover:hover) and
   * (pointer:fine)), never by viewport width, so rotating a phone can
   * never enable it. The engine stays authoritative: the hammer only
   * animates, reactions are driven by ANSWER_SUBMITTED and never by
   * sentence text.
   * -------------------------------------------------------------------- */
  const HAMMER_URL = "assets/images/ui/grammar-quest-hammer.png";
  const HAMMER_OFFSET_X = 0.33; // strike face inside the artwork (head at the
  const HAMMER_OFFSET_Y = 0.56; // pointer, handle extends to bottom-right)
  const HAMMER_IMPACT_MS = 150; // swing start -> head contact (matches keyframes)
  const HAMMER_SWING_MS = 340;  // total whack animation budget incl. recoil

  const HammerCursor = (() => {
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let root = null;         // persistent desktop overlay (position layer)
    let img = null;          // rotating artwork layer
    let raf = 0;
    let px = 0;
    let py = 0;              // latest pointer position (never shown at 0,0)
    let inside = false;      // pointer currently within the arena
    let mode = false;        // hammer-mode live (native cursor hidden)
    let locked = false;      // reaction playing -> no new swings
    let w = 96;
    let h = 96;              // cached overlay size

    // Capability, not width: hybrid devices that pair/unpair a mouse keep
    // working — the query re-syncs hammer mode the moment it changes.
    if (finePointer.addEventListener) {
      finePointer.addEventListener("change", () => { mode = false; sync(); });
    }

    function ensure() {
      if (root || !finePointer.matches) return; // never created on touch devices
      root = document.createElement("div");
      root.className = "hammer-cursor";
      root.setAttribute("aria-hidden", "true");
      img = document.createElement("img");
      img.className = "hammer-cursor__img";
      img.src = HAMMER_URL;
      img.alt = "";
      img.draggable = false;
      root.appendChild(img);
      document.body.appendChild(root);
    }

    function syncSize() {
      if (root && img) {
        const r = img.getBoundingClientRect();
        if (r.width) { w = r.width; h = r.height || r.width; }
      }
    }

    function render() {
      raf = 0;
      if (root && root.classList.contains("is-visible")) {
        root.style.transform = "translate3d(" + Math.round(px - w * HAMMER_OFFSET_X) +
          "px," + Math.round(py - h * HAMMER_OFFSET_Y) + "px,0)";
      }
    }

    function track(x, y) {
      px = x;
      py = y;
      if (!raf) raf = requestAnimationFrame(render);
    }

    function show(x, y) {
      ensure();
      syncSize();
      if (x !== undefined) track(x, y);
      root.classList.add("is-visible"); // only ever shown with valid coordinates
      render();
    }

    function hide() {
      if (root) root.classList.remove("is-visible");
    }

    function aim(onTarget) {
      if (root) root.classList.toggle("is-aim", !!onTarget);
    }

    function whack() {
      if (!mode || locked) return false;
      ensure();
      syncSize();
      root.classList.remove("is-whacking");
      void root.offsetWidth; // restart the keyframes on rapid swings
      root.classList.add("is-whacking", "is-locked");
      locked = true;
      setTimeout(() => {
        if (root) root.classList.remove("is-whacking");
      }, HAMMER_SWING_MS);
      return true;
    }

    // Reveal engine reactions exactly when the hammer head lands; callers
    // pass the reaction work and this schedules it at the impact frame.
    // On touch (no hammer) the reaction plays immediately.
    function impact(fn) {
      if (mode && inside) setTimeout(fn, HAMMER_IMPACT_MS);
      else fn();
    }

    // New wave ready: unlock swings and re-arm cursor hiding if the game
    // is in an interactive state (not paused / feedback / modal / results).
    function arm() {
      locked = false;
      if (root) root.classList.remove("is-locked", "is-whacking", "is-aim");
      sync();
    }

    function sync() {
      const arena = document.getElementById("whack");
      if (!arena) return;
      const ok = ctx.screen === "game" && engine.status === "playing" &&
        !!ctx.question && $("#feedback").hidden && ctx.modalStack.length === 0;
      mode = ok && finePointer.matches;
      arena.classList.toggle("hammer-mode", mode);
      if (!mode) hide();
      else if (inside) show(px, py); // pointer never left between waves
    }

    function bindArena() {
      const arena = document.getElementById("whack");
      if (!arena) return;
      const overDefaultCursor = (t) =>
        !!(t && t.closest && t.closest(".use-default-cursor"));

      arena.addEventListener("pointerenter", (e) => {
        if (e.pointerType === "touch") return;
        inside = true;
        if (mode && !overDefaultCursor(e.target)) show(e.clientX, e.clientY);
      });
      arena.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return;
        inside = true;
        // keep coordinates fresh even while hammer-mode is momentarily off
        // (feedback card up, paused) so re-arming never flashes an old spot
        track(e.clientX, e.clientY);
        if (!mode || !root) return;
        // pause pill / other real controls keep the native cursor
        const overChrome = overDefaultCursor(e.target);
        root.classList.toggle("is-visible", !overChrome);
        if (overChrome) return;
        aim(!!(e.target.closest && e.target.closest(".mole, .paddle")));
      });
      arena.addEventListener("pointerleave", (e) => {
        if (e.pointerType === "touch") return;
        inside = false;
        hide();
        aim(false);
      });
      arena.addEventListener("pointerdown", (e) => {
        if (!ctx.question || ctx.questionLocked) return;
        const target = e.target.closest ? e.target.closest(".mole, .paddle") : null;
        if (!target) return;
        // Touch: no hammer at all — the mole's own click handler submits the
        // answer. Only a live fine-pointer desktop swing animates the hammer.
        if (e.pointerType === "touch" || !finePointer.matches) return;
        if (mode) whack();
      });
    }

    return { bindArena, sync, arm, impact, hide };
  })();

  /* =============================== HOME =============================== */

  function renderHome() {
    const overall = engine.getOverallProgress();
    const next = engine.getNextUnlockedActivity();
    const stats = $("#home-stats");
    clearNode(stats);

    const started = overall.completedChallenges > 0;
    if (started) {
      stats.appendChild(el("li", { class: "stat-chip" }, [
        icon("trophy", 20, "icon--gold"),
        el("span", { text: "Level " + (next ? next.levelId : overall.totalLevels) }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        icon("star-full", 20, "icon--gold"),
        el("span", { class: "stat-chip__value", text: overall.totalStars + " stars" }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        icon("list-checks", 20),
        el("span", { text: overall.completedChallenges + "/" + overall.totalChallenges + " challenges" }),
      ]));
    } else {
      stats.appendChild(el("li", { class: "stat-chip" }, [
        icon("trophy", 20, "icon--gold"),
        el("span", { text: overall.totalChallenges + " challenges await" }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        icon("star-full", 20, "icon--gold"),
        el("span", { text: "Up to " + overall.maxTotalStars + " stars" }),
      ]));
    }

    $("#home-continue-label").textContent = started ? "Continue" : "Start Adventure";
    showScreen("home");
  }

  /* =============================== MAP ================================ */

  function renderMap() {
    const overall = engine.getOverallProgress();
    $("#map-stars span").textContent = String(overall.totalStars);
    const canvas = $("#map-canvas");
    clearNode(canvas);
    // Reset the explicit canvas height so the new tier's CSS and artwork
    // aspect are measured from a clean state.
    canvas.style.height = "";
    renderJourneyMap(canvas);
  }

  /* ----- The responsive journey map --------------------------------------
   * Every device class gets its own composition: the desktop panorama
   * (wide climb across floating islands, bottom-left start -> upper-right
   * castle, canvas fills the content area via background-size:cover with
   * node positions transformed through the real crop), the tablet painting
   * (its own zigzag of islands, canvas keeps the artwork aspect), and the
   * original phone climb (unchanged). Levels, progress, unlocks and stars
   * all come from the engine — nothing about progression is baked in.
   * -------------------------------------------------------------------- */

  // Device class from the MEASURED map viewport (clientWidth/Height include
  // the tier padding, so the result cannot oscillate when padding changes).
  // Breakpoints match the gameplay field tiers: phone <= 600, tablet
  // 601-1024 (portrait), everything wider — including landscape tablets —
  // rides the desktop panorama.
  function mapTierFor(w, h) {
    if (w <= 0 || h <= 0) return ctx.mapTier || "mobile";
    if (w <= 600) return "mobile";
    if (w <= 1024) return h > w ? "tablet" : "desktop";
    return "desktop";
  }

  // Artwork-space percent -> canvas-space percent for a
  // background-size:cover / center artwork of aspect a (same math as
  // mapHole, generalized so nodes stay glued to their islands at ANY
  // stage aspect ratio).
  function mapCoverPos(pos, a, w, h) {
    const s = Math.max(w / a, h); // image drawn at width a*s, height s
    const ox = (a * s - w) / 2;
    const oy = (s - h) / 2;
    return {
      x: ((pos.x / 100) * a * s - ox) / w * 100,
      y: ((pos.y / 100) * s - oy) / h * 100,
    };
  }

  const warmedArt = new Set();
  function warmMapArt(tier) {
    const urls = MAP_ART_URLS[tier];
    if (!urls) return;
    for (const src of [urls.webp, urls.jpg]) {
      if (warmedArt.has(src)) continue;
      warmedArt.add(src);
      const img = new Image();
      img.decoding = "async";
      img.src = src;
    }
  }

  // Applies the tier to the section (header/frame/node sizing) and canvas
  // (background artwork), and preloads that artwork so it never flashes in.
  function applyMapTier(tier) {
    const screenEl = $("#screen-map");
    const canvas = $("#map-canvas");
    MAP_TIERS.forEach((t) => {
      screenEl.classList.toggle("map-tier-" + t, t === tier);
      canvas.classList.toggle("map-canvas--" + t, t === tier);
    });
    ctx.mapTier = tier;
    warmMapArt(tier);
  }

  // Evenly spread n stops over a list of landing spots, so e.g. 4 nodes on
  // the desktop artwork span start island -> castle island instead of
  // bunching into the bottom-left corner.
  function spreadStops(list, n) {
    if (n <= 1) return [list[0]];
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(list[Math.round(i * (list.length - 1) / (n - 1))]);
    }
    return out;
  }

  // Landing spots for the desktop/tablet journeys: painted islands first;
  // once the game ships more levels than there are islands, the painted
  // bridge midpoints join the route (still on the artwork's path), and only
  // beyond that do extra wraps lift into the sky band above the route.
  function mapPositions(layout, n) {
    const A = layout.anchors;
    if (n <= A.length) return spreadStops(A, n);
    const half = [];
    for (let i = 0; i < A.length - 1; i++) {
      half.push(A[i], { x: (A[i].x + A[i + 1].x) / 2, y: (A[i].y + A[i + 1].y) / 2 });
    }
    half.push(A[A.length - 1]);
    if (n <= half.length) return spreadStops(half, n);
    const out = half.slice();
    let wrap = 1;
    while (out.length < n) {
      const base = half[out.length % half.length];
      out.push({ x: base.x, y: Math.max(10, base.y - wrap * 6) });
      if (out.length % half.length === 0) wrap++;
    }
    return out;
  }

  function renderJourneyMap(canvas) {
    const levels = engine.getLevels();
    const info = engine.getGameInfo();
    const next = engine.getNextUnlockedActivity();

    // Real levels first, then a few locked "on the way" islands when the game
    // declares more levels than it currently ships.
    const entries = levels.map((level, i) => ({ kind: "level", level, i }));
    const soonCount = Math.max(0, Math.min(MAP_SOON_MAX, (info.declaredTotalLevels || 0) - levels.length));
    for (let p = 0; p < soonCount; p++) {
      entries.push({ kind: "soon", i: levels.length + p, firstSoon: p === 0 });
    }

    entries.forEach((entry) => {
      if (entry.kind !== "level") return;
      const level = entry.level;
      const progress = engine.getLevelProgress(level.id);
      entry.progress = progress;
      entry.isCurrent = !!next && next.levelId === level.id;
      entry.perfect = progress.completed && progress.stars >= progress.maxStars && progress.maxStars > 0;
      entry.rating = progress.completed
        ? Math.max(1, Math.round((progress.stars / Math.max(1, progress.maxStars)) * 3))
        : 0;
    });

    // Show the screen first so the viewport has a real size to measure, then
    // lay out synchronously (reading clientWidth forces layout — no rAF hop,
    // which would stall in background tabs and leave the map hidden).
    showScreen("map");

    // Tier classes carry each device class's own background and frame CSS;
    // they must be active before the canvas is measured.
    const viewport = canvas.parentElement;
    const tier = mapTierFor(viewport.clientWidth, viewport.clientHeight);
    applyMapTier(tier);
    const layout = MAP_LAYOUTS[tier];
    canvas.classList.add("map-canvas--journey", "is-positioning");

    const width = canvas.clientWidth || 360;
    let height;
    let toCanvas; // artwork-space % -> canvas-space %

    if (layout.fit === "cover") {
      // Desktop panorama: the canvas fills the whole content area below the
      // header; the artwork covers it and node positions ride the crop.
      // On tall windows (big monitors, wide-app cap) the raw area can be much
      // taller than the artwork's aspect — unbounded cover would then crop
      // away the start/castle islands. Cap the stage ratio so at most ~11%
      // is trimmed per side; the canvas centers vertically in the remainder.
      const cs = getComputedStyle(viewport);
      const availH = viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      height = Math.max(320, Math.min(Math.floor(availH), Math.round(width / MAP_DESKTOP_MIN_RATIO)));
      const artAspect = layout.artW / layout.artH;
      toCanvas = (p) => mapCoverPos(p, artAspect, width, height);
    } else {
      // Vertical journey: the canvas IS the artwork (no crop, no stretch).
      height = Math.round(width * layout.artH / layout.artW);
      toCanvas = (p) => ({ x: p.x, y: p.y });
    }

    ctx.mapTier = tier;
    ctx.mapRenderWidth = viewport.clientWidth;
    ctx.mapRenderHeight = viewport.clientHeight;

    // Landing spots for this tier (artwork-space %).
    let stops;
    if (tier === "mobile") {
      if (entries.length <= layout.anchors.length) {
        stops = entries.map((entry) => layout.anchors[entry.i] || layout.anchors[layout.anchors.length - 1]);
      } else {
        // More levels than islands: extend the climb beyond the artwork's
        // natural bands (background-size: cover crops in from the sides).
        height = Math.max(
          height,
          MAP_OVERFLOW_TOP + MAP_OVERFLOW_BOTTOM + (entries.length - 1) * MAP_OVERFLOW_ROW
        );
        stops = entries.map((entry) => ({
          x: MAP_OVERFLOW_LANES[entry.i % MAP_OVERFLOW_LANES.length],
          y: (height - MAP_OVERFLOW_BOTTOM - entry.i * MAP_OVERFLOW_ROW) / height * 100,
        }));
      }
    } else {
      stops = mapPositions(layout, entries.length);
    }

    entries.forEach((entry, i) => {
      entry.pos = toCanvas(stops[i]);
    });

    canvas.style.height = height + "px";

    entries.forEach((entry) => {
      canvas.appendChild(buildJourneyNode(entry));
    });
    ctx.seenJourneyKeys.clear();
    entries.forEach((entry) => {
      if (entry.kind === "level" && entry.level.unlocked) {
        ctx.seenJourneyKeys.add(String(entry.level.id));
      }
    });

    drawJourneyPath(canvas, entries, width, height, layout, toCanvas);
    canvas.classList.remove("is-positioning");

    // Where to park the view on scrolling tiers: the learner's current
    // island (or the top of their climb when everything is done), kept in
    // the lower-middle. The desktop panorama never scrolls.
    if (layout.fit === "cover") {
      viewport.scrollTop = 0;
      return;
    }
    let focusY = null;
    const current = entries.find((e) => e.kind === "level" && e.isCurrent);
    if (current) focusY = current.pos.y / 100 * height;
    else {
      const lastLevel = [...entries].reverse().find((e) => e.kind === "level");
      if (lastLevel) focusY = lastLevel.pos.y / 100 * height;
      else if (entries.length) focusY = entries[entries.length - 1].pos.y / 100 * height;
    }
    if (focusY != null) {
      const vh = viewport.clientHeight;
      viewport.scrollTop = Math.max(0, Math.min(focusY - vh * 0.62, viewport.scrollHeight - vh));
    }
  }

  function buildJourneyNode(entry) {
    const level = entry.kind === "level" ? entry.level : null;
    const locked = !level || !level.unlocked;

    let state;
    let label;
    let aria;
    if (!level) {
      state = "map-jnode--soon";
      label = entry.firstSoon ? "Coming soon" : ""; // only once, not everywhere
      aria = "Future level, coming soon";
    } else {
      state = !level.unlocked ? "map-jnode--locked"
        : entry.perfect ? "map-jnode--perfect"
        : entry.progress.completed ? "map-jnode--completed"
        : entry.isCurrent ? "map-jnode--current"
        : "map-jnode--unlocked";
      label = level.title;
      aria = level.unlocked
        ? "Level " + level.id + ": " + level.title + (entry.progress.completed ? " (completed)" : "")
        : "Level " + level.id + " locked";
    }

    // A small one-time pop the first time an island shows up unlocked.
    const newly = !!level && level.unlocked && !ctx.seenJourneyKeys.has(String(level.id));

    const disc = el("span", { class: "map-jnode__disc" }, [
      locked ? icon("lock-closed", 34) : el("span", { text: String(level.id) }),
    ]);

    const kids = [disc];
    if (level && entry.progress.completed) kids.push(starsRow(entry.rating, 3, false, "map-jnode__stars"));
    if (label) kids.push(el("span", { class: "map-jnode__label", text: label }));

    // Percentage positions relative to the map stage, so nodes stay glued to
    // their islands whenever the stage (or the artwork) scales.
    return el("button", {
      class: "map-jnode " + state + (newly ? " map-jnode--newly" : ""),
      style: "left:" + (Math.round(entry.pos.x * 100) / 100) + "%; top:" + (Math.round(entry.pos.y * 100) / 100) + "%",
      "aria-label": aria,
      onclick: () => {
        if (!level) return; // "coming soon" islands are quiet placeholders
        if (!level.unlocked) { toast("Pass the previous level to unlock this island", "lock-closed"); return; }
        Sound.play("click");
        openLevel(level.id);
      },
    }, kids);
  }

  // Dotted, softly glowing trail linking the islands (nodes render on top of
  // the SVG, so the dots visually end at each disc edge). The curve is built
  // from the ACTIVE layout's node centers — vertical S-curves on the phone
  // climb, wide diagonal arcs across the desktop panorama — and a short stub
  // fades out towards this tier's castle. Stroke geometry scales with the
  // canvas width so the trail reads the same on a phone and a 1440p monitor.
  function drawJourneyPath(canvas, entries, width, height, layout, toCanvas) {
    const f = (n) => Math.round(n * 10) / 10;
    const pts = entries.map((e) => ({ x: e.pos.x / 100 * width, y: e.pos.y / 100 * height }));
    const last = pts[pts.length - 1];
    const scale = Math.max(1, Math.min(3.1, width / 420));

    const svg = svgEl("svg", {
      class: "map-path",
      viewBox: "0 0 " + Math.round(width) + " " + Math.round(height),
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });

    if (last) {
      const c = toCanvas(layout.castle);
      const cx = c.x / 100 * width;
      const cy = c.y / 100 * height;
      const dx = cx - last.x;
      const dy = cy - last.y;
      const len = Math.hypot(dx, dy) || 1;
      const gap = 46 * scale; // start just clear of the last node's disc
      const sx = last.x + dx / len * gap;
      const sy = last.y + dy / len * gap;
      const qx = (sx + cx) / 2 - dy / len * len * 0.18;
      const qy = (sy + cy) / 2 + dx / len * len * 0.18;
      svg.appendChild(svgEl("path", {
        class: "map-path__stub",
        d: "M" + f(sx) + " " + f(sy) + " Q " + f(qx) + " " + f(qy) + " " + f(cx) + " " + f(cy),
        "stroke-width": f(4 * scale),
        "stroke-dasharray": "0.1 " + f(12 * scale),
      }));
    }
    if (pts.length > 1) {
      let d = "M" + f(pts[0].x) + " " + f(pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        // control points run along the travel direction — pure vertical
        // segments (the phone climb) render exactly like the original path
        const k = len * 0.55;
        const c1x = a.x + dx / len * k;
        const c1y = a.y + dy / len * k;
        const c2x = b.x - dx / len * k;
        const c2y = b.y - dy / len * k;
        d += " C " + f(c1x) + " " + f(c1y) + ", " + f(c2x) + " " + f(c2y) + ", " + f(b.x) + " " + f(b.y);
      }
      svg.appendChild(svgEl("path", {
        class: "map-path__glow",
        d,
        "stroke-width": f(12 * scale),
      }));
      svg.appendChild(svgEl("path", {
        class: "map-path__dash",
        d,
        "stroke-width": f(5 * scale),
        "stroke-dasharray": "0.1 " + f(13.5 * scale),
      }));
    }
    canvas.insertBefore(svg, canvas.firstChild);
  }

  /* ============================ LEVEL DETAIL =========================== */

  function openLevel(levelId) {
    ctx.levelId = levelId;
    renderLevel();
  }

  function renderLevel() {
    const level = engine.getLevel(ctx.levelId);
    if (!level) { renderMap(); return; }
    const progress = engine.getLevelProgress(level.id);

    $("#level-title").textContent = "Level " + level.id + " · " + level.title;
    $("#level-topic").textContent = level.grammarTopic || "";
    $("#level-stars span").textContent = progress.stars + "/" + progress.maxStars;
    $("#level-desc").textContent = level.description || "";

    const next = engine.getNextUnlockedActivity();
    const list = $("#challenge-list");
    clearNode(list);

    level.challenges.forEach((challenge) => {
      const isFinal = challenge.type === "mixed" || /final/i.test(challenge.title || "");
      const isCurrent = !!next && next.levelId === level.id && next.challengeId === challenge.id;

      let state = "challenge-card--available";
      if (!challenge.unlocked) state = "challenge-card--locked";
      else if (isCurrent) state = "challenge-card--current";
      else if (challenge.completed) state = "challenge-card--completed";

      const meta = el("div", { class: "challenge-card__meta" }, [
        el("span", { text: challenge.difficulty || "" }),
        challenge.attempts > 0 ? el("span", { class: "pos", text: "Best " + challenge.bestAccuracy + "%" }) : null,
        challenge.attempts > 0 ? el("span", { text: "Score " + challenge.bestScore }) : null,
      ]);

      const card = el("li", {
        class: "challenge-card " + state + (isFinal ? " challenge-card--final" : ""),
      }, [
        el("div", { class: "challenge-card__top" }, [
          el("span", { class: "challenge-card__num", text: "Challenge " + challenge.id }),
          el("span", { class: "challenge-card__badge" }, [
            !challenge.unlocked ? icon("lock-closed", 26)
              : challenge.completed ? icon("star-full", 26, "icon--gold")
              : isFinal ? icon("trophy", 26, "icon--gold") : null,
          ]),
        ]),
        el("h3", { class: "challenge-card__title", text: challenge.title }),
        meta,
        challenge.completed ? starsRow(challenge.highestStars, 3, false, "challenge-card__stars") : null,
        challenge.unlocked ? el("button", {
          class: "challenge-card__start",
          text: challenge.completed ? "Replay" : isFinal ? "Start Final Test" : "Start",
          onclick: () => {
            Sound.play("click");
            openIntro(level.id, challenge.id);
          },
        }) : null,
      ]);

      list.appendChild(card);
    });

    showScreen("level");
  }

  /* ============================ CHALLENGE INTRO ======================== */

  const INTRO_COPY = {
    correct_sentence: "Read the sentence and decide: is the English correct?",
    incorrect_sentence: "Read each sentence and hit the one with the mistake.",
    missing_word: "Choose the word that completes the sentence correctly.",
    speed_round: "Think fast! Decide quickly — correct or incorrect?",
    mixed: "The Final Test mixes every question type from this level. Good luck!",
    default: "Read the instruction at the top and choose the right answer.",
  };

  function openIntro(levelId, challengeId) {
    const meta = engine.getChallenge(levelId, challengeId);
    if (!meta) { renderLevel(); return; }
    ctx.levelId = levelId;
    ctx.challengeId = challengeId;

    $("#intro-level-title").textContent = "Level " + levelId + " • " + meta.levelTitle;
    $("#intro-kicker").textContent = "Challenge " + challengeId + (meta.difficulty ? " • " + meta.difficulty : "");
    $("#intro-title").textContent = meta.title;
    $("#intro-instruction").textContent = INTRO_COPY[meta.type] || INTRO_COPY.default;

    // premium HUD pills: glass chips with color-tinted sprite icons
    const chips = $("#intro-chips");
    clearNode(chips);
    const chip = (cls, iconName, text) => chips.appendChild(el("li", { class: "intro-chip " + cls }, [
      icon(iconName, 19),
      el("span", { text }),
    ]));
    chip("intro-chip--time", "timer",
      meta.settings.timeLimitSeconds ? fmtTime(meta.settings.timeLimitSeconds) : "No timer");
    chip("intro-chip--lives", "heart", meta.settings.lives + " lives");
    chip("intro-chip--pass", "star", "Pass " + meta.settings.passingPercentage + "%");
    chip("intro-chip--count", "trophy", meta.effectiveQuestionCount + " questions");

    // The intro mascot is the fixed Prairie Dog brand hero — no per-difficulty swap.

    showScreen("intro");
  }

  /* ============================== GAMEPLAY ============================= */

  // Device class follows the SAME thresholds as the CSS background swaps
  // (mobile <= 600, tablet <= 1024, desktop > 1024) so the hole map always
  // matches the artwork actually displayed.
  function yardTier() {
    const w = window.innerWidth;
    if (w <= 600) return 'mobile';
    // Portrait tablets: the 4:3 tablet artwork cover-crops so hard its outer
    // holes fall off-frame — tall fields use the portrait artwork instead.
    const yard = document.querySelector('#whack');
    if (yard && yard.clientHeight > 0 && yard.clientWidth / yard.clientHeight < 0.9) return 'mobile';
    return w <= 1024 ? 'tablet' : 'desktop';
  }

  // Convert an in-image percent position to field percent for a
  // background-size:cover / center artwork of the given aspect.
  function mapHole(pos, tier, fieldW, fieldH) {
    const layout = HOLE_LAYOUTS[tier];
    const a = layout.aspect;
    const s = Math.max(fieldW / a, fieldH); // image drawn at width a*s, height s
    const ox = (a * s - fieldW) / 2;
    const oy = (s - fieldH) / 2;
    return {
      x: ((pos.x / 100) * a * s - ox) / fieldW * 100,
      y: ((pos.y / 100) * s - oy) / fieldH * 100,
    };
  }

  function shuffleList(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }


  function setupGameScreen(payload) {
    ctx.challenge = payload;
    ctx.lastWaveSig = null;
    ctx.marked = null;
    ctx.pendingResult = null;
    ctx.question = null;
    ctx.questionLocked = false;
    ctx.lastHoleKey = null;

    $("#hud-level").textContent = "Level " + payload.levelId;
    $("#hud-challenge").textContent = payload.levelTitle || payload.challengeTitle;
    $("#hud-finaltag").hidden = !(payload.challengeType === "mixed" || /final/i.test(payload.challengeTitle || ""));
    $("#hud-timer-wrap").hidden = !payload.settings.timeLimitSeconds;
    $("#hud-timer").textContent = payload.settings.timeLimitSeconds ? fmtTime(payload.settings.timeLimitSeconds) : "";
    updateTimerClass(payload.settings.timeLimitSeconds, payload.settings.timeLimitSeconds);

    const hearts = $("#hud-hearts");
    clearNode(hearts);
    hearts.appendChild(heartsRow(payload.settings.lives, payload.settings.lives));

    $("#hud-score").textContent = "0";
    setProgress(0, payload.totalQuestions, 1);
    $("#hud-streak").hidden = true;

    const whack = $("#whack");
    whack.classList.toggle("whack--speed", payload.challengeType === "speed_round");

    clearNode($("#yard"));
    $("#binary").hidden = true;
    hideFeedback();
    showScreen("game");
    yardTier();
  }

  function setProgress(answered, total, currentNumber) {
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    $("#hud-progress-fill").style.width = pct + "%";
    $("#hud-progress-label").textContent = "Question " + Math.min(currentNumber, total) + " / " + total;
  }

  function updateTimerClass(remaining, total) {
    const box = $("#hud-timer-wrap");
    box.classList.remove("hud__timer--warn", "hud__timer--danger");
    if (!total || remaining === null || remaining === undefined) return;
    if (remaining <= 5) box.classList.add("hud__timer--danger");
    else if (remaining <= total * 0.2) box.classList.add("hud__timer--warn");
  }

  function syncFieldArtwork() {
    const yard = document.querySelector("#whack");
    if (!yard) return;
    const tall = yard.clientWidth > 0 && yard.clientWidth / yard.clientHeight < 0.9;
    yard.classList.toggle("whack--tall", tall);
  }

  function renderQuestion(payload) {
    ctx.question = payload.question;
    ctx.questionLocked = false;
    ctx.marked = null;
    ctx.lastHitEl = null;
    ctx.activeMoles = [];
    ctx.tapMeansCorrect = true;

    const yard = $("#yard");
    const binary = $("#binary");
    const tier = yardTier();
    const q = payload.question;
    clearNode(yard);
    hideFeedback();
    binary.hidden = true;
    syncFieldArtwork();

    const setText = (sel, value) => { $(sel).textContent = value; };
    const setShown = (sel, shown) => { $(sel).hidden = !shown; };

    if (q.type === "correct_incorrect") {
      // Whack-a-mole WAVE: the engine's sentence + decoys from the same
      // level pop out of different holes at once. Hitting a sentence claims
      // it matches the instruction; the engine stays the only validator.
      ctx.tapMeansCorrect = !/mistake|wrong/i.test(q.prompt || "");
      setText("#instruction-text", q.prompt || "Is this sentence correct?");
      setText("#instruction-hint", ctx.tapMeansCorrect
        ? "Whack the animal with the CORRECT sentence"
        : "Whack the animal with the sentence that has a MISTAKE");
      setShown("#instruction-hint", true);
      setShown("#instruction-sentence", false);

      const wave = buildSentenceWave(q, tier);
      if (wave) {
        spawnWave(yard, tier, wave);
      } else {
        // Fallback (no decoy data): single mascot + Correct/Mistake paddles.
        const layout = HOLE_LAYOUTS[tier];
        const pool = layout.bottom.concat(layout.top);
        let hole = pool[Math.floor(Math.random() * pool.length)];
        if (ctx.lastHoleKey && hole.x === ctx.lastHoleKey.x && hole.y === ctx.lastHoleKey.y) {
          hole = pool[(pool.indexOf(hole) + 1) % pool.length];
        }
        ctx.lastHoleKey = hole;
        spawnWave(yard, tier, [{ text: q.text || "", claim: ctx.tapMeansCorrect }], true);
        binary.hidden = false;
      }
    } else if (q.type === "missing_word") {
      setText("#instruction-text", "Tap the animal holding the missing word");
      setShown("#instruction-hint", false);
      const holder = $("#instruction-sentence");
      clearNode(holder);
      holder.appendChild(renderSentenceWithBlank(q.text || ""));
      setShown("#instruction-sentence", true);
      spawnOptionMoles(yard, tier, q);
    } else if (q.type === "multiple_choice") {
      setText("#instruction-text", q.prompt || "Tap the animal with the correct sentence");
      setShown("#instruction-hint", false);
      setShown("#instruction-sentence", false);
      spawnOptionMoles(yard, tier, q);
    } else {
      // Unknown format: degrade gracefully instead of a blank field.
      setText("#instruction-text", q.prompt || "Choose the correct answer");
      setShown("#instruction-hint", false);
      setShown("#instruction-sentence", false);
      spawnOptionMoles(yard, tier, { options: (Array.isArray(q.options) ? q.options : ["true", "false"]) });
    }

    setProgress(payload.answeredCount, payload.totalQuestions, payload.questionNumber);

    // New wave is live: the hammer may swing again.
    HammerCursor.arm();
  }

  /* ----- Sentence waves (UI-layer grouping; engine validates answers) -----
   * Each correct_incorrect question becomes a wave of 1-4 sentences. Exactly
   * one sentence satisfies the instruction. Hitting a sentence submits the
   * claim "this is the one to hit" mapped onto the engine's own isCorrect
   * check for its question sentence: a hit on a satisfying target submits
   * src.isCorrect and a hit on any other target submits the opposite — so
   * the engine's verdict always matches the target that was actually hit.
   * The wave ALWAYS contains the satisfying target (it leads the group and
   * can never be cut by a small per-field target count). Decoy texts come
   * from the level's sentence pool (fetched read-only from questions.json).
   * -------------------------------------------------------------------- */

  function buildSentenceWave(q, tier) {
    const pool = ctx.sentencePool && ctx.sentencePool[String(ctx.levelId)];
    if (!pool || !pool.length) return null;
    const text = (q.text || '').trim();
    const src = pool.find((p) => p.text === text);
    if (!src) return null;

    const C = ctx.tapMeansCorrect; // claim the instruction asks the learner to make
    const others = shuffleList(pool.filter((p) => p.text !== src.text));
    const decoys = [];
    let srcSatisfies;
    if (src.isCorrect === C) {
      // The engine sentence satisfies the instruction: every decoy must NOT.
      srcSatisfies = true;
      for (const p of others) {
        if (p.isCorrect !== C && decoys.length < 3) decoys.push(p);
      }
    } else {
      // Exactly one decoy satisfies; the rest must not.
      srcSatisfies = false;
      let targetPlaced = false;
      for (const p of others) {
        if (!targetPlaced && p.isCorrect === C) { decoys.unshift(p); targetPlaced = true; }
        else if (p.isCorrect !== C && decoys.length < 3) decoys.push(p);
      }
      if (!targetPlaced) return null;
    }

    const wanted = waveTargetCount(tier, text, decoys.map((d) => d.text));
    // Claim per target: engine-correct exactly when this target satisfies the
    // instruction (satisfying -> src.isCorrect, otherwise its negation).
    const toItem = (sentence, satisfies) => ({
      text: sentence.text,
      claim: satisfies ? src.isCorrect : !src.isCorrect,
      satisfies,
    });
    let group;
    if (srcSatisfies) {
      group = [toItem(src, true)]
        .concat(decoys.slice(0, Math.max(0, wanted - 1)).map((d) => toItem(d, false)));
    } else {
      // decoys[0] (unshifted above) is the satisfying target: it leads the
      // group so a 1-target field still shows the selectable correct answer.
      group = [toItem(decoys[0], true), toItem(src, false)]
        .concat(decoys.slice(1, Math.max(1, wanted)).map((d) => toItem(d, false)))
        .slice(0, Math.max(1, wanted));
    }
    return shuffleList(group);
  }

  function waveTargetCount(tier, longestOwn, decoyTexts) {
    const longest = Math.max(longestOwn ? longestOwn.length : 0, ...decoyTexts.map((t) => t.length));
    // Ultra-short fields (landscape phones) have no vertical room for two
    // stacked targets between the instruction and feedback zones.
    const field = document.querySelector('#whack');
    if (field && field.clientHeight > 0 && field.clientHeight < 320) return 1;
    if (tier === 'mobile') return longest > 36 ? 1 : 2;
    if (tier === 'tablet') return longest > 40 ? 2 : (Math.random() < 0.5 ? 2 : 3);
    const r = Math.random();
    return r < 0.18 ? 2 : r < 0.85 ? 3 : 4;
  }

  // Pick holes whose estimated mascot + bubble boxes never collide and stay
  // out of the instruction (top) and feedback (bottom) safe zones.
  // opts.compact  — single-word option chips (far smaller than sentences)
  // opts.relaxTop — bubbles may cross the instruction zone when the field
  //                 otherwise cannot host every target. Used only for option
  //                 waves: dropping an option by position could drop the
  //                 engine's correct answer, leaving the wrong-answer reveal
  //                 with no target to highlight.
  function pickWaveHoles(tier, count, fw, fh, texts, opts) {
    const layout = HOLE_LAYOUTS[tier];
    const compact = !!(opts && opts.compact);
    const relaxTop = !!(opts && opts.relaxTop);
    const vw = window.innerWidth;
    const short = fh < 420;
    const fontPx = clampNum(15, 1.25 * vw / 100, 22);
    const capW = short ? Math.min(320, 40 * vw / 100) : (tier === 'mobile' ? 38 * vw / 100 : Math.min(320, 27 * vw / 100));
    // estimate each sentence's real rendered bubble width from its text
    const estW = texts && texts.length
      ? texts.map((t) => Math.max(compact ? 64 : 92, Math.min(capW, String(t).length * fontPx * 0.52 + (compact ? 18 : 26))))
      : Array.from({ length: count }, () => capW);
    const bubbleH = compact ? 46 : (short ? 58 : (tier === 'mobile' ? 88 : 78));
    // Match the RENDERED CSS sizes (.mole width clamps) so collision checks
    // never underestimate; word chips render smaller via .mole--word.
    const moleW = compact
      ? clampNum(64, 20 * vw / 100, 104)
      : short
        ? clampNum(64, 15 * fh / 100, 110)
        : tier === 'mobile' ? clampNum(98, 30 * vw / 100, 138) : clampNum(116, 14.5 * vw / 100, 200);
    // Relaxed mode tolerates slight box overlap: stacked dogs in different
    // holes read naturally and beat dropping an option (and with it possibly
    // the engine's correct answer) on a tight field.
    const pad = relaxTop ? moleW * 0.22 : 0;
    const shrink = (b) => ({ l: b.l + pad, r: b.r - pad, t: b.t + pad, b: b.b - pad });
    // measure the REAL instruction card so bubbles never cross into it
    let topLimit = short ? 58 : 92;
    const instr = document.querySelector('#instruction');
    const field = document.querySelector('#whack');
    if (instr && field) {
      const ir = instr.getBoundingClientRect();
      const fr = field.getBoundingClientRect();
      topLimit = Math.max(topLimit, Math.min(ir.bottom - fr.top + 10, fh * 0.5));
    }
    const bottomLimit = short ? 74 : (tier === 'mobile' ? 124 : 100); // feedback zone
    const intersects = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

    const boxesOf = (h, w) => {
      const p = mapHole(h, tier, fw, fh);
      if (p.x < 6 || p.x > 94) return null; // mapped hole off-frame under heavy crop
      const x = p.x / 100 * fw;
      const y = p.y / 100 * fh;
      const moleTop = y - moleW * 1.04;
      return {
        hole: h,
        pos: p, // field-space % — spawn code positions the mole from here
        mole: { l: x - moleW / 2, t: moleTop, r: x + moleW / 2, b: y },
        bubble: { l: x - w / 2, t: moleTop - 12 - bubbleH, r: x + w / 2, b: moleTop },
      };
    };

    const widths = estW.slice().sort((a, b) => b - a); // place widest first
    // Most complete spread across all attempts. An incomplete greedy pass must
    // NEVER return early: option waves require every target placed (dropping
    // one by position could drop the engine's correct answer).
    let best = null;
    const remember = (cands) => { if (cands.length && (!best || cands.length > best.length)) best = cands; };
    const commit = (cands) => {
      ctx.lastWaveSig = cands.map((c) => c.hole.x + '/' + c.hole.y).sort().join('|');
      ctx.lastHoleKey = cands[0].hole;
      return cands;
    };
    for (let attempt = 0; attempt < 16; attempt++) {
      const order = shuffleList(layout.top.concat(layout.bottom));
      const chosen = [];
      for (let h of order) {
        if (chosen.length >= count) break;
        const w = widths[chosen.length];
        const cand = boxesOf(h, w);
        if (!cand) continue;
        // Normal mode: the whole bubble clears the instruction. Relaxed mode:
        // only the mascot body must clear it — the bubble may overlap.
        if (relaxTop ? cand.mole.t < topLimit : cand.bubble.t < topLimit) continue;
        // Mole must stay inside the field; a tall bottom margin is not needed
        // because every mole ducks into its hole before feedback appears.
        if (cand.mole.b > fh - (short ? 26 : 44)) continue;
        let ok = true;
        for (const c of chosen) {
          const a = relaxTop ? { mole: shrink(cand.mole), bubble: shrink(cand.bubble) } : cand;
          const b = relaxTop ? { mole: shrink(c.mole), bubble: shrink(c.bubble) } : c;
          if (intersects(a.bubble, b.bubble) || intersects(a.mole, b.mole) ||
              intersects(a.bubble, b.mole) || intersects(a.mole, b.bubble)) { ok = false; break; }
        }
        if (ok) chosen.push(cand);
      }
      if (!chosen.length) continue;
      if (chosen.length < count) { remember(chosen); continue; }
      const sig = chosen.map((c) => c.hole.x + '/' + c.hole.y).sort().join('|');
      if (sig === ctx.lastWaveSig && attempt < 12) { remember(chosen); continue; }
      if (sig === ctx.lastWaveSig && count > 1) {
        // geometrically forced repeat (e.g. only one valid spread on a short
        // field): try one target fewer for a visibly different pattern
        const smaller = chosen.slice(0, count - 1);
        if (smaller.length) return commit(smaller);
      }
      return commit(chosen);
    }
    if (compact && count > 1 && (!best || best.length < count)) {
      // Word options that cannot all fit the painted holes (e.g. phones, where
      // a bottom-row dog's bubble always reaches into the top-row dog's box):
      // fan them across a SINGLE ground line so every option stays selectable —
      // dropping one by position could drop the engine's correct answer and
      // leave the wrong-answer reveal with no target.
      const anchor = boxesOf(layout.bottom[0] || layout.top[0], capW);
      const y = anchor ? anchor.pos.y : 65;
      const fan = [];
      for (let i = 0; i < count; i++) {
        const x = count === 1 ? 50 : 18 + 64 * i / (count - 1); // 18%..82% of the field
        const w = widths[i] || capW;
        const cx = x / 100 * fw;
        const cy = y / 100 * fh;
        const moleTop = cy - moleW * 1.04;
        fan.push({
          hole: { x, y, fan: true },
          pos: { x, y },
          mole: { l: cx - moleW / 2, t: moleTop, r: cx + moleW / 2, b: cy },
          bubble: { l: cx - w / 2, t: moleTop - 12 - bubbleH, r: cx + w / 2, b: moleTop },
        });
      }
      ctx.lastWaveSig = "fan" + count;
      ctx.lastHoleKey = fan[0].hole;
      return fan;
    }
    if (best) return commit(best);
    // Last resort: the spread top row.
    const fallback = layout.top.slice(0, count).map((h, i) => boxesOf(h, widths[i] || capW)).filter(Boolean);
    if (!fallback.length) return commit(best || []);
    ctx.lastWaveSig = fallback.map((c) => c.hole.x + '/' + c.hole.y).sort().join('|');
    ctx.lastHoleKey = fallback[0].hole;
    return fallback;
  }

  function clampNum(min, v, max) { return Math.min(max, Math.max(min, v)); }

  function spawnWave(yard, tier, wave, isFallbackSingle) {
    const fw = yard.clientWidth || 1;
    const fh = yard.clientHeight || 1;
    let boxes = pickWaveHoles(tier, wave.length, fw, fh, wave.map((w) => w.text));
    let usable = wave;
    if (boxes.length < wave.length) {
      // Never stack two targets in one hole; when the field can only host
      // fewer targets, keep the instruction-satisfying one and fill the rest.
      usable = trimWaveTo(wave, boxes.length);
      boxes = pickWaveHoles(tier, usable.length, fw, fh, usable.map((w) => w.text));
      if (boxes.length < usable.length) usable = trimWaveTo(wave, boxes.length);
    }
    usable.forEach((item, i) => {
      const box = boxes[i];
      const mole = makeMole(box.pos, {
        bubble: item.text,
        index: i,
        label: item.text,
        delay: i * 70,
        onTap: () => submitClaim(item.claim !== undefined ? item.claim : item.text, mole),
      });
      ctx.moleIndex = (ctx.moleIndex + 1) % NEUTRAL_KEYS.length;
      // satisfies powers the wrong-answer reveal: the target whose hit the
      // engine judges correct for this interaction
      ctx.activeMoles.push({ el: mole, text: item.text, satisfies: item.satisfies === true });
      yard.appendChild(mole);
    });
    // One soft pop per wave — never N identical pops for N simultaneous dogs.
    Sound.play("targetPop");
  }

  // Reduce a wave to `count` targets without ever dropping the target that
  // satisfies the instruction — after a wrong answer there must always be a
  // real correct target on the field to reveal.
  function trimWaveTo(wave, count) {
    const keep = wave.filter((w) => w.satisfies);
    const rest = shuffleList(wave.filter((w) => !w.satisfies))
      .slice(0, Math.max(0, count - keep.length));
    return shuffleList(keep.concat(rest));
  }

  // Option questions: one mascot per option, popping from the widest-spaced
  // row of the current artwork's holes. Unused painted holes stay empty.
  // EVERY option is always spawned: the engine guarantees its correctAnswer
  // is among the options, so dropping one by position could hide the correct
  // target — word chips use compact estimates, and if the field still cannot
  // host them collision-free, placement relaxes the instruction safe-zone
  // rather than dropping an option.
  function spawnOptionMoles(yard, tier, q) {
    const options = Array.isArray(q.options) ? q.options : [];
    const fw = yard.clientWidth || 1;
    const fh = yard.clientHeight || 1;
    let boxes = pickWaveHoles(tier, options.length, fw, fh, options.map(String), { compact: true });
    if (boxes.length < options.length) {
      boxes = pickWaveHoles(tier, options.length, fw, fh, options.map(String), { compact: true, relaxTop: true });
    }
    const usable = Math.min(options.length, boxes.length);
    for (let i = 0; i < usable; i++) {
      const box = boxes[i];
      const option = options[i];
      const mole = makeMole(box.pos, {
        bubble: String(option),
        index: i,
        label: 'Answer: ' + option,
        delay: i * 70,
        word: true,
        onTap: () => submitClaim(option, mole),
      });
      ctx.activeMoles.push({ el: mole, text: String(option) });
      yard.appendChild(mole);
    }
  }

  function makeMole(pos, options) {
    const delay = options.delay || 0;
    // Cycle personalities (glasses / student / cool) so a wave feels alive;
    // neutral art never reveals anything about the sentence.
    const personality = NEUTRAL_KEYS[(ctx.moleIndex + (options.index || 0)) % NEUTRAL_KEYS.length];
    const mole = el("button", {
      class: "mole" + (options.word ? " mole--word" : ""),
      // bottom:(100-y)% pins the mascot's feet at the hole centre line
      style: "left:" + pos.x + "%; bottom:" + (100 - pos.y) + "%",
      "aria-label": options.label,
    }, [
      el("span", { class: "mole__clip" }, [
        el("img", {
          class: "mole__img",
          src: PRAIRIE_DOG_ASSETS.neutral[personality],
          alt: "",
          style: "animation-delay:" + delay + "ms",
        }),
      ]),
      el("span", {
        class: "mole__bubble",
        text: options.bubble,
        style: "animation-delay:" + (140 + delay) + "ms",
      }),
    ]);
    // start the idle breathing once the pop-up finishes (rise = 340ms + delay)
    setTimeout(() => {
      if (mole.isConnected && !mole.classList.contains("is-hit")) mole.classList.add("is-idle");
    }, (delay || 0) + 340);
    mole.addEventListener("click", () => {
      if (ctx.questionLocked) return;
      mole.classList.remove("is-idle");
      // No visual state here: the reaction (is-hit + Prairie Dog art) is
      // revealed by markAnswer() at the hammer's impact frame, so the swing
      // decides the timing and the engine decides everything else.
      options.onTap();
    });
    return mole;
  }

  // Swap the character image inside a mole WITHOUT moving its box — the
  // wrapper keeps its size, so glasses -> thumbs-up -> smashed never jumps.
  function setMoleArt(mole, url) {
    const img = mole.querySelector(".mole__img");
    if (img && img.getAttribute("src") !== url) img.src = url;
  }

  // Reaction state machines driven ONLY by the engine result.
  function playCorrectReaction(mole, streak) {
    mole.classList.add("is-correct");
    // celebrate on strong success (streak 3+), thumbs-up otherwise
    setMoleArt(mole, streak >= 3 ? PRAIRIE_DOG_ASSETS.correct.celebrate : PRAIRIE_DOG_ASSETS.correct.thumbsUp);
    mole.classList.add("is-bounce");
  }

  function playWrongReaction(mole, livesAfter) {
    mole.classList.add("is-wrong");
    if (livesAfter <= 0) {
      // losing the last life is the strongest failure beat
      setMoleArt(mole, PRAIRIE_DOG_ASSETS.wrong.crying);
      return;
    }
    // surprised -> smashed -> dizzy cartoon beat (~700ms total, still snappy)
    setMoleArt(mole, PRAIRIE_DOG_ASSETS.wrong.surprised);
    setTimeout(() => {
      if (!mole.isConnected) return;
      setMoleArt(mole, PRAIRIE_DOG_ASSETS.wrong.smashed);
      mole.classList.add("is-smashed");
    }, 100);
    setTimeout(() => {
      if (!mole.isConnected) return;
      setMoleArt(mole, PRAIRIE_DOG_ASSETS.wrong.dizzy);
      mole.classList.remove("is-smashed");
      mole.classList.add("is-dizzy");
    }, 320);
  }

  function renderSentenceWithBlank(text) {
    const frag = document.createDocumentFragment();
    const parts = String(text).split(/_{2,}/);
    parts.forEach((part, i) => {
      if (i > 0) frag.appendChild(el("span", { class: "blank", text: "____" }));
      if (part) frag.appendChild(document.createTextNode(part));
    });
    return frag;
  }

  function submitClaim(answer, moleEl) {
    if (ctx.questionLocked) return;
    ctx.questionLocked = true; // first valid hit locks the whole wave
    ctx.lastHitEl = moleEl || null;
    const result = engine.submitAnswer(answer);
    if (!result.accepted) {
      ctx.questionLocked = false;
      ctx.lastHitEl = null;
    }
  }

  /* ----------------------------- feedback ------------------------------ */

  function showFeedback(feedback) {
    // ONE contained card, rebuilt from a clean state every time — no ghost
    // states, no strips: reset classes and text before rendering either state.
    const card = $("#feedback");
    card.classList.remove("is-correct", "is-wrong");
    $("#feedback-title").textContent = "";
    $("#feedback-detail").textContent = "";

    card.classList.add(feedback.correct ? "is-correct" : "is-wrong");
    $("#feedback-icon-use").setAttribute("href", feedback.correct ? "#i-check-circle" : "#i-x-circle");
    $("#feedback-title").textContent = feedback.correct ? "Correct!" : "Not quite";

    const detail = $("#feedback-detail");
    if (!feedback.correct) {
      detail.appendChild(el("div", {
        class: "feedback-card__line feedback-card__line--ok",
        text: "Correct: " + (feedback.correction || feedback.correctAnswer || ""),
      }));
      if (feedback.explanation) {
        detail.appendChild(el("div", {
          class: "feedback-card__line feedback-card__line--rule",
          text: "Rule: " + feedback.explanation,
        }));
      }
    } else {
      detail.appendChild(el("div", {
        class: "feedback-card__line",
        text: feedback.correction || feedback.explanation || "Well done!",
      }));
    }
    $("#feedback-continue").textContent = feedback.isFinalQuestion ? "Results" : "Next";
    card.hidden = false;
  }

  function hideFeedback() {
    $("#feedback").hidden = true;
  }

  function answerText(value) {
    if (typeof value === "boolean") return value ? "Correct" : "Incorrect";
    return String(value);
  }

  // Identify the one target whose hit the ENGINE would have judged correct
  // for THIS interaction — never "the grammatically nice sentence". For
  // sentence waves that is the instruction-satisfying target flagged at
  // wave-build time (with "hit the mistake" prompts this is the sentence WITH
  // the mistake); for option questions it is the engine's revealed
  // correctAnswer text. No grammar rules live here.
  function findCorrectTarget(feedback) {
    const q = ctx.question;
    const entries = ctx.activeMoles || [];
    if (q && q.type === "correct_incorrect") {
      const hit = entries.find((m) => m.satisfies === true && m.el.isConnected);
      return hit ? hit.el : null;
    }
    const expected = feedback && typeof feedback.correctAnswer === "string" ? feedback.correctAnswer : "";
    if (!expected.trim()) return null;
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
    const hit = entries.find((m) => m.el.isConnected && norm(m.text) === norm(expected));
    return hit ? hit.el : null;
  }

  function addMoleMark(mole, kind) {
    if (mole.querySelector(".mole__mark")) return;
    mole.appendChild(el("span", {
      class: "mole__mark mole__mark--" + kind,
      "aria-hidden": "true",
    }, [icon(kind, 15)]));
  }

  // Reveal beat for the correct target: green ring + glowing bubble, happy
  // Prairie Dog, check badge and a small "Correct answer" label. It stays up
  // (never ducks away) while the correction card is on screen.
  function revealCorrectTarget(mole) {
    if (!mole.isConnected) return;
    mole.classList.add("is-correct", "is-revealed-correct");
    setMoleArt(mole, PRAIRIE_DOG_ASSETS.correct.thumbsUp);
    mole.classList.add("is-bounce");
    addMoleMark(mole, "check");
    const bubble = mole.querySelector(".mole__bubble");
    if (bubble && !bubble.querySelector(".mole__tag")) {
      bubble.appendChild(el("span", { class: "mole__tag", text: "Correct answer" }));
    }
  }

  function markAnswer(feedback) {
    ctx.marked = {
      learnerValue: feedback.learnerAnswer,
      correctValue: feedback.correctAnswer,
      correct: feedback.correct,
    };

    // The selected mole performs the Prairie Dog reaction driven by the
    // ENGINE result (learner action, not sentence grammar). On a wrong answer
    // the actual correct target is revealed in green while unrelated targets
    // only fade — visual hierarchy: green reveal > red mistake > dimmed rest.
    // Nothing ducks away until the learner presses Next.
    const chosenEl = ctx.lastHitEl;
    const correctEl = feedback.correct ? null : findCorrectTarget(feedback);
    const moles = [...document.querySelectorAll('#yard .mole')];

    moles.forEach((mole) => {
      if (mole === chosenEl) {
        mole.classList.add('is-hit');
        if (feedback.correct) {
          playCorrectReaction(mole, feedback.streak || 0);
          setTimeout(() => mole.classList.add('is-down'), 560);
        } else {
          mole.classList.add('is-wrong');
          addMoleMark(mole, 'x');
          playWrongReaction(mole, feedback.lives !== undefined ? feedback.lives : 1);
          // no is-down: the learner must keep seeing what they chose
        }
      } else if (correctEl && mole === correctEl) {
        // green lands just after the red hit so the eye travels
        // "my mistake" -> "the correct answer"
        setTimeout(() => revealCorrectTarget(mole), REVEAL_DELAY.correctTarget);
      } else if (feedback.correct) {
        mole.classList.add('is-dim');
        setTimeout(() => mole.classList.add('is-down'), 260);
      } else {
        mole.classList.add('is-faded'); // clearly secondary, still visible
      }
    });

    // paddles only exist in the no-decoy-data fallback
    const good = $("#answer-correct");
    const bad = $("#answer-incorrect");
    if (!$("#binary").hidden) {
      const pickedGood = feedback.learnerAnswer === true;
      [good, bad].forEach((p) => p.classList.remove("is-picked-good", "is-picked-bad", "is-dim"));
      if (feedback.correct) {
        good.classList.add("is-picked-good");
        bad.classList.add("is-dim");
      } else {
        (pickedGood ? good : bad).classList.add("is-picked-bad");
        (pickedGood ? bad : good).classList.remove("is-dim");
      }
    }
    $("#binary").hidden = true;
  }

  /* ------------------------------ results ------------------------------ */

  function renderResults(result) {
    ctx.pendingResult = null;
    const body = $("#results-body");
    clearNode(body);
    const level = engine.getLevel(ctx.levelId || result.levelId);
    const next = engine.getNextUnlockedActivity();

    if (result.passed) {
      Sound.play("complete");
      const medal = result.stars >= 3 ? "medal-3" : result.stars === 2 ? "medal-2" : "medal-1";
      body.appendChild(el("div", { class: "results__celebrate" }, [
        el("img", { src: PRAIRIE_DOG_ASSETS.correct.celebrate, alt: "" }),
      ]));
      body.appendChild(el("div", { class: "results__medal" }, [
        el("img", { src: REWARDS + medal + ".png", alt: result.stars + " star medal" }),
      ]));
      body.appendChild(el("h2", { class: "results__title", text: "Challenge Complete!" }));
      body.appendChild(starsRow(result.stars, result.maxStars || 3, true));
    } else {
      body.appendChild(el('div', { class: 'results__mascot' }, [
        el('img', { src: PRAIRIE_DOG_ASSETS.wrong.crying, alt: '' }),
      ]));
      body.appendChild(el("h2", { class: "results__title", text: "Almost there!" }));
    }

    const grid = el("div", { class: "results__grid" });
    const addTile = (label, value) =>
      grid.appendChild(el("div", { class: "result-tile" }, [
        el("span", { class: "result-tile__label", text: label }),
        el("span", { class: "result-tile__value", text: value }),
      ]));
    addTile("Accuracy", Math.round(result.accuracy) + "%");
    addTile("Score", String(result.score));
    addTile("Correct", result.correctCount + " / " + result.totalQuestions);
    if (result.passed) {
      addTile("Best streak", String(result.bestStreak));
      addTile("Lives left", result.livesRemaining + " / " + result.maxLives);
    }
    body.appendChild(grid);
    if (!result.passed) {
      body.appendChild(el("p", {
        class: "results__required",
        text: "You needed " + result.passingPercentage + "% to pass" +
          (result.unansweredCount > 0 ? " · " + result.unansweredCount + " question" + (result.unansweredCount > 1 ? "s" : "") + " left unanswered" : ""),
      }));
    }

    const actions = el("div", { class: "results__actions" });
    if (result.passed) {
      actions.appendChild(el("button", {
        class: "btn btn--primary",
        text: continueLabel(result, next),
        onclick: () => continueAfterPass(result),
      }));
      actions.appendChild(el("button", {
        class: "btn btn--secondary",
        text: "Play Again",
        onclick: () => { Sound.play("click"); engine.retryChallenge(); },
      }));
    } else {
      actions.appendChild(el("button", {
        class: "btn btn--primary",
        text: "Try Again",
        onclick: () => { Sound.play("click"); engine.retryChallenge(); },
      }));
      if (result.wrongCount > 0) {
        actions.appendChild(el("button", {
          class: "btn btn--secondary",
          text: "Review Mistakes",
          onclick: () => { ctx.reviewReturn = "results"; renderReview(result); },
        }));
      }
      actions.appendChild(el("button", {
        class: "btn btn--ghost",
        text: "Back to Level",
        onclick: () => { ctx.levelId = result.levelId; renderLevel(); },
      }));
    }
    body.appendChild(actions);
    showScreen("results");
  }

  function continueLabel(result, next) {
    if (ctx.gameCompleted) return "Finish";
    const levelDone = engine.getLevelProgress(result.levelId).completed;
    if (levelDone && ctx.levelJustCompleted === result.levelId) return "Level Complete!";
    return next ? "Next: " + next.challengeTitle : "Continue";
  }

  function continueAfterPass(result) {
    Sound.play("click");
    // Finishing all LOADED content is only full-game completion when the
    // declared level count has actually shipped; otherwise it's a level win
    // with more content on the way.
    const info = engine.getGameInfo();
    const contentComplete = (info.declaredTotalLevels || 0) <= info.levelsLoaded;
    if (ctx.gameCompleted && contentComplete) { renderLevelComplete(result, "game"); return; }
    const levelDone = engine.getLevelProgress(result.levelId).completed;
    if (levelDone && ctx.levelJustCompleted === result.levelId) {
      renderLevelComplete(result, ctx.gameCompleted ? "partial" : "level");
      return;
    }
    const next = engine.getNextUnlockedActivity();
    if (next) openIntro(next.levelId, next.challengeId);
    else renderMap();
  }

  /* --------------------------- review screen --------------------------- */

  function renderReview(result) {
    const list = $("#review-list");
    clearNode(list);
    const review = (result && result.review) ? result.review : engine.getAttemptReview();
    const mistakes = review.filter((entry) => !entry.correct);

    if (!mistakes.length) {
      list.appendChild(el("li", { class: "review-empty", text: "No mistakes this time. Well done!" }));
    } else {
      mistakes.forEach((entry) => {
        const item = el("li", { class: "review-item" });
        const question = (entry.text || entry.prompt || "");
        if (entry.text && entry.text.includes("___")) {
          const holder = el("div", { class: "review-item__question" });
          String(question).split(/_{2,}/).forEach((part, i) => {
            if (i > 0) holder.appendChild(el("span", { class: "blank", text: "____" }));
            if (part) holder.appendChild(document.createTextNode(part));
          });
          item.appendChild(holder);
        } else {
          item.appendChild(el("div", { class: "review-item__question", text: question || entry.prompt || "" }));
        }
        item.appendChild(el("div", { class: "review-item__row review-item__row--you" }, [
          el("span", { text: "You chose: " }),
          document.createTextNode(answerText(entry.learnerAnswer)),
        ]));
        item.appendChild(el("div", { class: "review-item__row review-item__row--correct" }, [
          el("span", { text: "Correct: " }),
          document.createTextNode(entry.correctAnswer || ""),
        ]));
        if (entry.explanation) {
          item.appendChild(el("div", { class: "review-item__rule" }, [ document.createTextNode(entry.explanation) ]));
        }
        list.appendChild(item);
      });
    }
    showScreen("review");
  }

  /* ------------------------- level complete screen --------------------- */

  function renderLevelComplete(result, outcome) {
    // outcome: "game" = every declared level shipped and finished,
    //          "partial" = last loaded level finished, more content coming,
    //          "level" = one level of several finished.
    const body = $("#level-complete-body");
    clearNode(body);
    const progress = engine.getLevelProgress(result.levelId);
    const level = engine.getLevel(result.levelId);
    const fullGame = outcome === "game";

    body.appendChild(el("div", { class: "level-complete__banner" }, [
      el("img", { src: fullGame ? REWARDS + "trophy-gold.png" : REWARDS + "banner.png", alt: "" }),
    ]));
    body.appendChild(el("h2", {
      class: "level-complete__title",
      text: fullGame ? "Grammar Quest Complete!" : "Level " + result.levelId + " Complete!",
    }));
    body.appendChild(el("p", {
      class: "level-complete__subtitle",
      text: fullGame
        ? "You finished every challenge. Amazing work!"
        : outcome === "partial"
          ? "More levels coming soon"
          : (level ? level.title : ""),
    }));
    body.appendChild(el("div", { class: "level-complete__chest" }, [
      el("img", { src: fullGame ? PRAIRIE_DOG_ASSETS.correct.celebrate : REWARDS + "chest.png", alt: "" }),
    ]));

    const stats = el("div", { class: "level-complete__stats" });
    stats.appendChild(el("span", { class: "stat-chip", text: progress.completedChallenges + " / " + progress.totalChallenges + " challenges" }));
    stats.appendChild(el("span", { class: "stat-chip", text: progress.stars + " / " + progress.maxStars + " stars" }));
    body.appendChild(stats);
    body.appendChild(el("img", { class: "level-complete__sparkles", src: REWARDS + "sparkles.png", alt: "" }));

    const levels = engine.getLevels();
    const hasNextLevel = levels.some((l) => l.id === result.levelId + 1);
    const actions = el("div", { class: "level-complete__actions" });
    actions.appendChild(el("button", {
      class: "btn btn--primary",
      text: fullGame ? "Back to Home" : hasNextLevel ? "Continue to Level " + (result.levelId + 1) : "Continue",
      onclick: () => {
        Sound.play("click");
        if (fullGame) { renderHome(); return; }
        if (!hasNextLevel) { renderMap(); return; }
        const next = engine.getNextUnlockedActivity();
        if (next) openIntro(next.levelId, next.challengeId);
        else openLevel(result.levelId + 1);
      },
    }));
    actions.appendChild(el("button", {
      class: "btn btn--secondary",
      text: "Replay Level",
      onclick: () => { Sound.play("click"); ctx.levelId = result.levelId; renderLevel(); },
    }));
    body.appendChild(actions);
    showScreen("level-complete");
  }

  /* ============================ engine wiring =========================== */

  function wireEngine() {
    engine.on(E.GAME_READY, () => { renderHome(); });

    engine.on(E.ERROR, (payload) => {
      if (engine.status === "error") {
        $("#error-message").textContent = friendlyError(payload);
        showScreen("error");
      } else {
        toast(payload && payload.message ? payload.message : "Something went wrong", "wrong");
      }
    });

    engine.on(E.CHALLENGE_STARTED, (payload) => {
      ctx.levelId = payload.levelId;
      ctx.challengeId = payload.challengeId;
      ctx.gameCompleted = false;
      ctx.levelJustCompleted = null;
      setupGameScreen(payload);
      Sound.play("challengeStart");
    });

    engine.on(E.QUESTION_CHANGED, (payload) => { renderQuestion(payload); });

    engine.on(E.ANSWER_SUBMITTED, (feedback) => {
      ctx.questionLocked = true;
      // Reveal everything at the hammer's impact frame so the dog reacts
      // exactly as the head lands (immediate when no swing is playing,
      // e.g. keyboard-submitted fallback paddles).
      HammerCursor.impact(() => {
        markAnswer(feedback);
        Sound.play(feedback.correct ? "correct" : "wrong");
        if (feedback.pointsAwarded > 0) popupScore("+" + feedback.pointsAwarded, feedback.correct);
        if (!feedback.correct) popupScore("−1 ♥", false, true);
        if (feedback.correct) {
          showFeedback(feedback);
          engine.advanceQuestion(FEEDBACK_DELAY.correct);
        } else {
          // Wrong answers teach: the green correct-target reveal (scheduled
          // inside markAnswer) lands first and the correction card follows
          // once it has settled. Nothing auto-advances — Next is learner-
          // driven, so the correct sentence stays readable as long as needed.
          setTimeout(() => {
            if (ctx.screen !== "game" || !ctx.questionLocked) return;
            showFeedback(feedback);
            HammerCursor.sync(); // card is up: back to a normal cursor for Next
          }, REVEAL_DELAY.feedbackCard);
        }
        HammerCursor.sync(); // during the reveal the hammer stays the cursor
      });
    });

    engine.on(E.SCORE_CHANGED, (payload) => {
      const node = $("#hud-score");
      if (node.textContent !== String(payload.score)) {
        node.textContent = String(payload.score);
        node.classList.remove("bump");
        void node.offsetWidth;
        node.classList.add("bump");
      }
    });

    engine.on(E.STREAK_CHANGED, (payload) => {
      // streak lives INSIDE the HUD next to the score — never floats over gameplay
      const chip = $("#hud-streak");
      if (!chip) return;
      if (payload.streak < 2) { chip.hidden = true; return; }
      $("#hud-streak-count").textContent = "\u00d7" + payload.streak;
      chip.hidden = false;
      chip.classList.remove("bump");
      void chip.offsetWidth;
      chip.classList.add("bump");
      if (STREAK_MILESTONES.includes(payload.streak)) Sound.play("streak");
    });

    engine.on(E.LIVES_CHANGED, (payload) => {
      const hearts = $("#hud-hearts");
      clearNode(hearts);
      hearts.appendChild(heartsRow(payload.lives, payload.maxLives));
      hearts.classList.toggle("is-low", payload.lives === 1);
      if (payload.lost) {
        // the heart just after the remaining ones is the one that was lost
        const lostHeart = hearts.children[payload.lives];
        if (lostHeart) {
          lostHeart.classList.remove("heart--empty");
          lostHeart.classList.add("heart--full", "heart--lost");
          setTimeout(() => {
            lostHeart.classList.remove("heart--full", "heart--lost");
            lostHeart.classList.add("heart--empty");
          }, 420);
        }
        // Sequenced cue: wrong-answer sound lands first, heart pop follows.
        window.grammarQuestAudio.play("heartLost", { delay: 150 });
      }
    });

    engine.on(E.TIMER_TICK, (payload) => {
      $("#hud-timer").textContent = fmtTime(payload.remainingSeconds);
      updateTimerClass(payload.remainingSeconds, payload.totalSeconds);
    });

    engine.on(E.TIMER_LOW, () => Sound.play("timer-low"));

    engine.on(E.PAUSED, () => {
      HammerCursor.sync(); // paused: back to a normal cursor over the arena
      if (ctx.screen === "game" && ctx.modalStack[ctx.modalStack.length - 1] !== "pause") {
        openModal("pause");
      }
    });

    engine.on(E.RESUMED, () => {
      HammerCursor.sync(); // HUD already reflects ticks; re-arm the hammer
    });

    engine.on(E.CHALLENGE_UNLOCKED, (payload) => {
      Sound.play("unlock");
      toast("Unlocked: " + payload.challengeTitle, "lock-open");
    });

    engine.on(E.LEVEL_UNLOCKED, (payload) => {
      Sound.play("unlock");
      toast("Level " + payload.levelId + " unlocked!", "star-full");
    });

    engine.on(E.GAME_COMPLETED, () => { ctx.gameCompleted = true; });

    engine.on(E.CHALLENGE_FINISHED, (result) => {
      ctx.pendingResult = result;
      const levelProgress = engine.getLevelProgress(result.levelId);
      if (result.passed && levelProgress.completed) ctx.levelJustCompleted = result.levelId;
      // Let the last feedback card breathe before switching screens. Losing
      // the last life waits longer so the wrong-answer reveal (green correct
      // target + correction card) can actually be read before the results.
      setTimeout(() => {
        if (ctx.pendingResult === result && ctx.screen === "game") {
          hideFeedback();
          renderResults(result);
        }
      }, result.reason === "no_lives"
        ? REVEAL_DELAY.failScreen
        : result.reason === "timeout" ? 700 : 1200);
    });

    engine.on(E.CHALLENGE_ABORTED, () => {
      closeAllModals();
      renderLevel();
    });

    engine.on(E.PROGRESS_RESET, () => {
      ctx.gameCompleted = false;
      ctx.levelJustCompleted = null;
    });
  }

  function friendlyError(payload) {
    const reason = payload && payload.reason ? String(payload.reason) : "";
    if (/fetch|network|load/i.test(reason)) return "We couldn\u2019t reach the question data. Check your connection and try again.";
    if (/invalid game data/i.test(reason)) return "The question file seems broken. The game team has been notified.";
    return "Something went wrong while loading. Try again in a moment.";
  }

  function popupScore(text, isCorrect, isLife) {
    const layer = $("#score-popups");
    const yard = $("#yard");
    const anchor = document.querySelector("#yard .mole.is-hit .mole__bubble") ||
      document.querySelector("#yard .mole.is-hit");
    let xPct = 50, yPct = 34;
    if (anchor && yard) {
      const rect = anchor.getBoundingClientRect();
      const yardRect = yard.getBoundingClientRect();
      xPct = ((rect.left + rect.width / 2 - yardRect.left) / yardRect.width) * 100;
      yPct = ((rect.top - yardRect.top) / yardRect.height) * 100;
    }
    const popup = el("span", {
      class: "score-popup" + (isLife ? " score-popup--life" : ""),
      style: "left:" + xPct.toFixed(1) + "%; top:" + yPct.toFixed(1) + "%",
      text: text,
    });
    layer.appendChild(popup);
    setTimeout(() => popup.remove(), 950);
  }

  /* ----------------------------- DOM wiring ---------------------------- */

  function wireDom() {
    // Real-controls island inside the whack arena: these keep the native
    // cursor and hide the hammer overlay while hovered.
    const pausePill = $("#hud-pause");
    if (pausePill) pausePill.classList.add("use-default-cursor");
    const feedbackCard = $("#feedback");
    if (feedbackCard) feedbackCard.classList.add("use-default-cursor");

    HammerCursor.bindArena();

    $("#home-continue").addEventListener("click", () => {
      Sound.play("click");
      const next = engine.getNextUnlockedActivity();
      if (next) openIntro(next.levelId, next.challengeId);
      else renderMap();
    });
    $("#home-map").addEventListener("click", () => { Sound.play("click"); renderMap(); });
    $("#map-home").addEventListener("click", () => { Sound.play("click"); renderHome(); });
    $("#level-back").addEventListener("click", () => { Sound.play("click"); renderMap(); });
    $("#intro-back").addEventListener("click", () => { Sound.play("click"); ctx.levelId ? renderLevel() : renderMap(); });
    $("#intro-start").addEventListener("click", () => {
      Sound.play("click");
      const result = engine.startChallenge(ctx.levelId, ctx.challengeId);
      if (result && !result.started) toast(result.reason || "Challenge unavailable", "lock-closed");
    });

    $("#answer-correct").addEventListener("click", () => submit(true));
    $("#answer-incorrect").addEventListener("click", () => submit(false));

    $("#feedback-continue").addEventListener("click", () => {
      Sound.play("click");
      hideFeedback();
      if (ctx.pendingResult) {
        const result = ctx.pendingResult;
        ctx.pendingResult = null;
        renderResults(result);
        return;
      }
      engine.nextQuestion();
    });

    $("#hud-pause").addEventListener("click", () => {
      const outcome = engine.pause();
      if (!outcome.paused) toast(outcome.reason || "Cannot pause now", "pause");
    });

    $("#pause-resume").addEventListener("click", () => {
      closeModal();
      engine.resume();
    });
    $("#pause-restart").addEventListener("click", () => {
      closeAllModals();
      engine.retryChallenge();
    });
    $("#pause-exit").addEventListener("click", () => {
      closeAllModals();
      engine.abortChallenge();
    });

    $("#home-help").addEventListener("click", () => openModal("help"));
    $("#help-close").addEventListener("click", closeModal);

    // Sound controls are optional: the host platform (Boston English Center)
    // may own sound instead of the game, so these elements can be absent.
    const homeSound = $("#home-sound");
    if (homeSound) {
      homeSound.addEventListener("click", () => {
        uiSettings.sound = !uiSettings.sound;
        saveSettings();
        syncSoundIcon();
        toast(uiSettings.sound ? "Sound on" : "Sound off", uiSettings.sound ? "sound-on" : "sound-off");
      });
    }

    $("#confirm-cancel").addEventListener("click", closeModal);
    $("#confirm-ok").addEventListener("click", () => {
      closeAllModals();
      engine.resetProgress();
      toast("Progress reset", "restart");
      renderHome();
    });

    $("#error-retry").addEventListener("click", () => { boot(); });

    $("#review-back").addEventListener("click", () => {
      Sound.play("click");
      if (ctx.reviewReturn === "results" && engine.getLastResult()) renderResults(engine.getLastResult());
      else if (ctx.levelId) renderLevel();
      else renderMap();
    });

    document.addEventListener("keydown", onKeydown);

    // Debounced relayout on window resize and device rotation…
    const queueRelayout = () => {
      clearTimeout(ctx.resizeTimer);
      ctx.resizeTimer = setTimeout(onResize, 150);
    };
    window.addEventListener("resize", queueRelayout);
    window.addEventListener("orientationchange", queueRelayout);
    // …and when the map's own box changes (platform container resizes the
    // game without touching the window).
    if (window.ResizeObserver) {
      ctx.mapResizeObserver = new ResizeObserver(queueRelayout);
      ctx.mapResizeObserver.observe(document.querySelector(".map-viewport"));
    }
  }

  function syncSoundIcon() {
    // Sound controls live with the platform, not in-game; kept as a no-op so
    // existing call sites stay valid if a toggle ever returns.
  }

  function onKeydown(event) {
    const topModal = ctx.modalStack[ctx.modalStack.length - 1];
    if (event.key === "Escape") {
      if (topModal === "pause") { closeModal(); engine.resume(); return; }
      if (topModal) { closeModal(); return; }
      if (!$("#feedback").hidden) { $("#feedback-continue").click(); return; }
      if (ctx.screen === "game" && engine.status === "playing") { engine.pause(); }
      return;
    }
    if (topModal) return;

    if (ctx.screen === "game") {
      if (!$("#feedback").hidden && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        $("#feedback-continue").click();
        return;
      }
      if (ctx.questionLocked || engine.status !== "playing") return;
      const q = ctx.question;
      if (!q) return;
      // number keys whack the Nth visible target of the current wave
      if (Array.isArray(ctx.activeMoles) && ctx.activeMoles.length) {
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < ctx.activeMoles.length) {
          ctx.activeMoles[index].el.click();
          return;
        }
      }
      if (q.type === "correct_incorrect" && !$("#binary").hidden) {
        if (event.key === "1" || event.key === "ArrowLeft") submitClaim(true);
        if (event.key === "2" || event.key === "ArrowRight") submitClaim(false);
      }
    }
  }

  function onResize() {
    if (ctx.screen === "map") {
      const vp = document.querySelector(".map-viewport");
      const w = vp ? vp.clientWidth : 0;
      const h = vp ? vp.clientHeight : 0;
      if (w > 0 && h > 0) {
        const tier = mapTierFor(w, h);
        const tierChanged = tier !== ctx.mapTier;
        const widthChanged = w !== ctx.mapRenderWidth;
        // The desktop panorama aligns nodes through the cover crop, so its
        // height matters too. Vertical tiers ignore height-only changes
        // (mobile URL bar) so the scroll position never jumps.
        const heightChanged = tier === "desktop" && h !== ctx.mapRenderHeight;
        if (tierChanged) warmMapArt(tier);
        if (tierChanged || widthChanged || heightChanged) {
          // Full re-lay out: swaps background, node coordinates and trail for
          // the new tier. Progress and the selected level live in the engine
          // and ctx, so nothing is reset.
          renderMap();
        }
      }
    }
    if (ctx.screen === "game" && ctx.question && $("#feedback").hidden) {
      // question visible and unanswered: re-render for the new field tier
      const state = engine.getPublicState();
      if (state.question && !state.question.locked) {
        renderQuestion({
          question: engine.getCurrentQuestion(),
          questionNumber: state.question.number,
          totalQuestions: state.question.total,
          answeredCount: state.answeredCount,
        });
      }
    }
  }

  function preload() {
    // Warm the Adventure Map artwork this device class will actually show,
    // so the map never flashes the wrong background first.
    warmMapArt(mapTierFor(window.innerWidth, window.innerHeight));
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    Object.values(PRAIRIE_DOG_ASSETS.neutral)
      .concat(Object.values(PRAIRIE_DOG_ASSETS.correct))
      .concat(Object.values(PRAIRIE_DOG_ASSETS.wrong))
      .concat(finePointer ? [HAMMER_URL] : []) // desktop only: ready before the first hover
      .concat(['assets/images/mascots/prairie-dog-hero.png']) // intro hero
      .forEach((src) => { const img = new Image(); img.src = src; });
  }

  /* -------------------------------- boot ------------------------------- */

  async function boot() {
    showScreen("loading");
    $("#loading-status").textContent = "Loading Grammar Quest\u2026";
    try {
      await engine.init({ url: "data/questions.json" });
      loadSentencePools();
    } catch (err) {
      console.error("[GrammarQuest UI] init failed:", err);
      $("#error-message").textContent = "We couldn't load the game data. " +
        (location.protocol === "file:" ? "Serve the folder over http (for example with the Live Server extension) and reload." : "Please try again.");
      showScreen("error");
    }
  }

  // Presentation-only sentence pools per level, used to build decoy targets
  // for whack-a-mole waves. The engine never sees this data; it keeps
  // validating every submitted claim against its own question state.
  function loadSentencePools() {
    ctx.sentencePool = {};
    fetch("data/questions.json")
      .then((res) => res.json())
      .then((data) => {
        (data.levels || []).forEach((level) => {
          const pool = [];
          (level.challenges || []).forEach((challenge) => {
            (challenge.questions || []).forEach((question) => {
              if (question.type === "correct_incorrect" && question.text &&
                  !pool.some((p) => p.text === question.text.trim())) {
                pool.push({ text: question.text.trim(), isCorrect: question.isCorrect === true });
              }
            });
          });
          ctx.sentencePool[String(level.id)] = pool;
        });
      })
      .catch(() => { /* waves degrade to single-target fallback */ });
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyMotionPreference();
    syncSoundIcon();
    wireEngine();
    wireDom();
    preload();
    boot();
    try { window.grammarQuestAudio.preload(); } catch (err) {
      console.warn("[GrammarQuest audio] manager missing — game runs silent");
    }
  });
})();
