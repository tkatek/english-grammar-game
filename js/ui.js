/* ==========================================================================
 * Grammar Quest — UI layer (presentation only)
 * --------------------------------------------------------------------------
 * Subscribes to the game engine (js/game.js) and renders screens. Contains
 * no game rules: all state transitions go through engine action methods.
 * Screens: loading, home, map, level, intro, game, results, review,
 * level-complete, error + modals (pause / settings / help / confirm).
 * ========================================================================== */
(function () {
  "use strict";

  const engine = window.grammarQuest;
  const E = engine.EVENTS;

  /* ----------------------------- constants ----------------------------- */

  // Hole grid on the whack field (percent of the yard).
  // Desktop coordinates map onto the six holes painted in the supplied
  // gameplay artwork (detected from the image: top row ~49% height,
  // bottom row ~67%); unused painted holes stay empty for breathing room.
  // Mobile uses its own responsive grid (3 up top + 1 below) so targets
  // never crowd a narrow screen.
  const HOLE_LAYOUTS = {
    desktop: [
      { x: 28.4, y: 49.4, row: "top" }, { x: 49.7, y: 49.4, row: "top" }, { x: 71.1, y: 49.4, row: "top" },
      { x: 32.0, y: 67.0, row: "bottom" }, { x: 53.8, y: 67.0, row: "bottom" }, { x: 75.7, y: 67.0, row: "bottom" },
    ],
    mobile: [
      { x: 25, y: 50, row: "top" }, { x: 50, y: 50, row: "top" }, { x: 75, y: 50, row: "top" },
      { x: 50, y: 80, row: "bottom" },
    ],
  };
  const MOLE_CAST = ["owl", "fox", "dragon", "book"];
  const YARD_MOBILE_BREAK = 620;

  // The Adventure Map is built on the vertical fantasy artwork
  // (assets/images/bg-map-journey.webp|jpg, 941x1672). The canvas always
  // keeps the artwork's aspect, so the painting is never stretched; nodes,
  // locks, stars and labels stay real DOM elements layered on top.
  const MAP_ART_W = 941;
  const MAP_ART_H = 1672;
  const MAP_ART_ASPECT = MAP_ART_H / MAP_ART_W;

  // Island landing spots in the artwork, bottom -> top, as % of the canvas —
  // calibrated against the painting's actual terrain (sampled pixel bands):
  // the lush left foreground island, the wide earthen island, the waterfall
  // island, a small green ledge, the stone-and-green island, and the castle.
  // Index 0 is the hero / current level; the trail's stub ends at the castle.
  const MAP_ANCHORS = [
    { x: 21, y: 86.5 },   // foreground island (hero / current level)
    { x: 39, y: 72.5 },   // wide earthen island
    { x: 19, y: 59 },     // island with the waterfall
    { x: 28, y: 50 },     // small green island
    { x: 46, y: 39.5 },   // stone-and-green island
    { x: 66, y: 28.5 },   // castle island — the destination
  ];
  const MAP_CASTLE = { x: 66, y: 24 }; // where the trail stub fades out

  // When more levels load than the artwork has islands, the canvas grows and
  // nodes continue on evenly spaced rows through the middle band.
  const MAP_OVERFLOW_LANES = [50, 40, 60, 38, 62, 42, 58, 36, 64, 44, 56, 46, 54];
  const MAP_OVERFLOW_ROW = 150;
  const MAP_OVERFLOW_TOP = 170;
  const MAP_OVERFLOW_BOTTOM = 118;
  const MAP_SOON_MAX = 3; // locked "on the way" islands above loaded levels

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  const FEEDBACK_DELAY = { correct: 1700, wrong: 3800 };
  const STREAK_MILESTONES = [3, 5, 10];
  const SETTINGS_KEY = "grammar-quest:ui-settings:v1";
  const SOUND_NAMES = ["correct", "wrong", "streak", "timer-low", "complete", "unlock", "click"];

  const ICONS = "assets/icons/";
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

  const iconImg = (name, size, alt) =>
    el("img", { src: ICONS + name + ".png", alt: alt || "", width: size, height: size, loading: "lazy" });

  const starsRow = (earned, max, animate, cls) => {
    const row = el("div", { class: (cls || "map-jnode__stars") + (animate ? " results__stars" : "") });
    for (let i = 1; i <= max; i++) {
      const isFull = i <= earned;
      row.appendChild(el("img", {
        src: ICONS + (isFull ? "star-full" : "star-empty") + ".png",
        alt: "",
        class: (animate && isFull ? "star--earn" : "") + (animate && !isFull ? " star--empty" : ""),
      }));
    }
    return row;
  };

  const heartsRow = (lives, max) => {
    const row = el("div", { class: "hud__hearts" });
    for (let i = 1; i <= max; i++) {
      const full = i <= lives;
      row.appendChild(el("img", {
        src: ICONS + (full ? "heart-full" : "heart-empty") + ".png",
        alt: full ? "Life remaining" : "Life lost",
        class: full ? "heart--full" : "heart--empty",
      }));
    }
    if (lives === 1) row.classList.add("is-low");
    return row;
  };

  /* ------------------------------ UI state ----------------------------- */

  const ctx = {
    screen: "loading",
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
    mapRenderWidth: 0,        // last width the map was laid out for
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

  /* ------------------------------- sound ------------------------------- */

  const Sound = {
    available: new Set(),
    async init() {
      // Only enable hooks whose files actually exist — no invented 404s.
      await Promise.all(SOUND_NAMES.map(async (name) => {
        try {
          const res = await fetch("assets/sounds/" + name + ".mp3", { method: "HEAD" });
          if (res.ok) this.available.add(name);
        } catch (err) { /* missing file: hook stays disabled */ }
      }));
    },
    play(name) {
      if (!uiSettings.sound || !this.available.has(name)) return;
      try {
        const audio = new Audio("assets/sounds/" + name + ".mp3");
        audio.volume = 0.5;
        audio.play().catch(() => { /* autoplay policy: ignore */ });
      } catch (err) { /* never break gameplay for audio */ }
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
  }

  /* ------------------------------- toasts ------------------------------ */

  let toastTimer = null;
  function toast(message, iconName) {
    const box = $("#toast");
    clearNode(box);
    if (iconName) box.appendChild(iconImg(iconName, 26));
    box.appendChild(el("span", { text: message }));
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
  }

  /* ------------------------------- modals ------------------------------ */

  const MODALS = { pause: "#modal-pause", settings: "#modal-settings", help: "#modal-help", confirm: "#modal-confirm" };

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

  /* =============================== HOME =============================== */

  function renderHome() {
    const overall = engine.getOverallProgress();
    const next = engine.getNextUnlockedActivity();
    const stats = $("#home-stats");
    clearNode(stats);

    const started = overall.completedChallenges > 0;
    if (started) {
      stats.appendChild(el("li", { class: "stat-chip" }, [
        el("span", { text: "Level " + (next ? next.levelId : overall.totalLevels) }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        iconImg("star-full", 20),
        el("span", { class: "stat-chip__value", text: overall.totalStars + " stars" }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        el("span", { text: overall.completedChallenges + "/" + overall.totalChallenges + " challenges" }),
      ]));
    } else {
      stats.appendChild(el("li", { class: "stat-chip" }, [
        iconImg("trophy", 20),
        el("span", { text: overall.totalChallenges + " challenges await" }),
      ]));
      stats.appendChild(el("li", { class: "stat-chip" }, [
        iconImg("star-full", 20),
        el("span", { text: "Up to " + overall.maxTotalStars + " stars" }),
      ]));
    }

    const continueBtn = $("#home-continue");
    continueBtn.textContent = started ? "Continue" : "Start Adventure";
    showScreen("home");
  }

  /* =============================== MAP ================================ */

  function renderMap() {
    const overall = engine.getOverallProgress();
    $("#map-stars span").textContent = String(overall.totalStars);
    ctx.mapRenderWidth = window.innerWidth;
    const canvas = $("#map-canvas");
    clearNode(canvas);
    canvas.classList.remove("map-canvas--journey");
    canvas.style.height = "";
    canvas.style.width = "";
    renderJourneyMap(canvas);
  }

  /* ----- The vertical journey over the fantasy artwork ------------------
   * One layout for every screen size: a tall climb from the foreground
   * island (bottom) to the castle (top). Level 1 / the current level owns
   * the big foreground island; future levels alternate up the artwork's
   * island column. All values come from the engine (levels, progress,
   * unlocks) — nothing about progression is baked into the artwork.
   * -------------------------------------------------------------------- */

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

    // Show the screen first so the canvas has a real width to measure, then
    // lay out synchronously (reading clientWidth forces layout — no rAF hop,
    // which would stall in background tabs and leave the map hidden).
    showScreen("map");

    const width = canvas.clientWidth || 360;
    const artHeight = Math.round(width * MAP_ART_ASPECT);

    let height;
    if (entries.length <= MAP_ANCHORS.length) {
      // Nodes sit on the artwork's islands; the canvas IS the artwork.
      height = artHeight;
      entries.forEach((entry) => {
        const a = MAP_ANCHORS[entry.i];
        entry.laneX = a.x / 100;
        entry.y = (a.y / 100) * height;
      });
    } else {
      // More levels than islands: extend the climb beyond the artwork's
      // natural bands (background-size: cover crops in from the sides).
      height = Math.max(
        artHeight,
        MAP_OVERFLOW_TOP + MAP_OVERFLOW_BOTTOM + (entries.length - 1) * MAP_OVERFLOW_ROW
      );
      entries.forEach((entry) => {
        entry.laneX = MAP_OVERFLOW_LANES[entry.i % MAP_OVERFLOW_LANES.length] / 100;
        entry.y = height - MAP_OVERFLOW_BOTTOM - entry.i * MAP_OVERFLOW_ROW;
      });
    }

    canvas.classList.add("map-canvas--journey", "is-positioning");
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

    drawJourneyPath(canvas, entries, height);
    canvas.classList.remove("is-positioning");

    // Where to park the view: the learner's current island (or the top of
    // their climb when everything is done), kept in the lower-middle.
    let focusY = null;
    const current = entries.find((e) => e.kind === "level" && e.isCurrent);
    if (current) focusY = current.y;
    else {
      const lastLevel = [...entries].reverse().find((e) => e.kind === "level");
      if (lastLevel) focusY = lastLevel.y;
      else if (entries.length) focusY = entries[entries.length - 1].y;
    }
    const viewport = canvas.parentElement;
    if (focusY != null && viewport) {
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
      locked ? iconImg("lock-closed", 34) : el("span", { text: String(level.id) }),
    ]);

    const kids = [disc];
    if (level && entry.progress.completed) kids.push(starsRow(entry.rating, 3, false, "map-jnode__stars"));
    if (label) kids.push(el("span", { class: "map-jnode__label", text: label }));

    return el("button", {
      class: "map-jnode " + state + (newly ? " map-jnode--newly" : ""),
      style: "left:" + Math.round(entry.laneX * 100) + "%; top:" + entry.y + "px",
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
  // the SVG, so the dots visually end at each disc edge). A short stub fades
  // out towards the castle at the top of the artwork.
  function drawJourneyPath(canvas, entries, height) {
    const W = canvas.clientWidth || 360;
    const f = (n) => Math.round(n * 10) / 10;
    const pts = entries.map((e) => ({ x: e.laneX * W, y: e.y }));
    const last = pts[pts.length - 1];

    const svg = svgEl("svg", {
      class: "map-path",
      viewBox: "0 0 " + Math.round(W) + " " + height,
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });
    svg.appendChild(svgEl("path", {
      class: "map-path__stub",
      d: "M" + f(last.x) + " " + f(last.y - 46)
        + " Q " + f(last.x) + " " + f((last.y + MAP_CASTLE.y * height / 100) / 2)
        + " " + f(MAP_CASTLE.x / 100 * W) + " " + f(MAP_CASTLE.y / 100 * height),
    }));
    if (pts.length > 1) {
      let d = "M" + f(pts[0].x) + " " + f(pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const k = (a.y - b.y) * 0.55; // curve scaled to the actual island gap
        d += " C " + f(a.x) + " " + f(a.y - k) + ", " + f(b.x) + " " + f(b.y + k) + ", " + f(b.x) + " " + f(b.y);
      }
      svg.appendChild(svgEl("path", { class: "map-path__glow", d }));
      svg.appendChild(svgEl("path", { class: "map-path__dash", d }));
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
            !challenge.unlocked ? iconImg("lock-closed", 26)
              : challenge.completed ? iconImg("star-full", 26)
              : isFinal ? iconImg("trophy", 26) : null,
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

    $("#intro-level-title").textContent = "Level " + levelId + " · " + meta.levelTitle;
    $("#intro-kicker").textContent = "Challenge " + challengeId + (meta.difficulty ? " · " + meta.difficulty : "");
    $("#intro-title").textContent = meta.title;
    $("#intro-instruction").textContent = INTRO_COPY[meta.type] || INTRO_COPY.default;

    const chips = $("#intro-chips");
    clearNode(chips);
    chips.appendChild(el("li", { class: "stat-chip" }, [
      iconImg("timer", 20),
      el("span", { text: meta.settings.timeLimitSeconds ? fmtTime(meta.settings.timeLimitSeconds) : "No timer" }),
    ]));
    chips.appendChild(el("li", { class: "stat-chip" }, [
      iconImg("heart-full", 20),
      el("span", { text: meta.settings.lives + " lives" }),
    ]));
    chips.appendChild(el("li", { class: "stat-chip" }, [
      iconImg("star-full", 20),
      el("span", { text: "Pass " + meta.settings.passingPercentage + "%" }),
    ]));
    chips.appendChild(el("li", { class: "stat-chip" }, [
      iconImg("trophy", 20),
      el("span", { text: meta.effectiveQuestionCount + " questions" }),
    ]));

    const mascot = meta.difficulty === "hard" || /final/i.test(meta.title || "") ? "dragon"
      : meta.difficulty === "medium" ? "fox" : "owl";
    $("#intro-mascot").src = MASCOTS + mascot + ".png";

    showScreen("intro");
  }

  /* ============================== GAMEPLAY ============================= */

  function yardTier() {
    const yard = $("#yard");
    return yard && yard.clientWidth > 0 && yard.clientWidth < YARD_MOBILE_BREAK ? "mobile" : "desktop";
  }

  function shuffleList(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function nextMascot() {
    ctx.moleIndex = ((ctx.moleIndex || 0) + 1) % MOLE_CAST.length;
    return MOLE_CAST[ctx.moleIndex];
  }

  function setupGameScreen(payload) {
    ctx.challenge = payload;
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
    $("#streak-pop").hidden = true;

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

  function renderQuestion(payload) {
    ctx.question = payload.question;
    ctx.questionLocked = false;
    ctx.marked = null;
    ctx.tapMeansCorrect = true;

    const yard = $("#yard");
    const binary = $("#binary");
    const tier = yardTier();
    const q = payload.question;
    clearNode(yard);
    hideFeedback();
    binary.hidden = true;

    const setText = (sel, value) => { $(sel).textContent = value; };
    const setShown = (sel, shown) => { $(sel).hidden = !shown; };

    if (q.type === "correct_incorrect") {
      // One mascot pops up with the sentence; tap it or use the paddles.
      ctx.tapMeansCorrect = !/mistake|wrong/i.test(q.prompt || "");
      setText("#instruction-text", q.prompt || "Is this sentence correct?");
      setText("#instruction-hint", ctx.tapMeansCorrect
        ? "Whack the mole if the sentence is correct"
        : "Whack the mole if the sentence has a mistake");
      setShown("#instruction-hint", true);
      setShown("#instruction-sentence", false);

      // Single-sentence questions pop from one hole — front (bottom) row on
      // desktop for depth, mirroring the reference's foreground animal.
      const pool = tier === "mobile"
        ? HOLE_LAYOUTS.mobile
        : HOLE_LAYOUTS.desktop.filter((h) => h.row === "bottom")
          .concat(HOLE_LAYOUTS.desktop.filter((h) => h.row === "top"));
      let hole = pool[Math.floor(Math.random() * pool.length)];
      if (ctx.lastHoleKey && hole.x === ctx.lastHoleKey.x && hole.y === ctx.lastHoleKey.y) {
        hole = pool[(pool.indexOf(hole) + 1) % pool.length];
      }
      ctx.lastHoleKey = hole;
      yard.appendChild(makeHole(hole));
      yard.appendChild(makeMole(hole, {
        bubble: q.text || "",
        mascot: nextMascot(),
        label: q.text || "The sentence",
        onTap: () => submit(ctx.tapMeansCorrect),
      }));
      binary.hidden = false;
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
  }

  // Several mascots pop out of top-row holes, one per option. On phones the
  // whole mobile grid is drawn (extra hole stays empty) like the reference.
  function spawnOptionMoles(yard, tier, q) {
    const options = Array.isArray(q.options) ? q.options.slice(0, 3) : [];
    if (tier === "mobile") {
      HOLE_LAYOUTS.mobile.forEach((hole) => yard.appendChild(makeHole(hole)));
      const top = HOLE_LAYOUTS.mobile.filter((h) => h.row === "top");
      const holes = shuffleList(top).slice(0, Math.max(1, options.length));
      options.forEach((option, i) => {
        yard.appendChild(makeMole(holes[i], {
          bubble: String(option),
          mascot: MOLE_CAST[i % MOLE_CAST.length],
          label: "Answer: " + option,
          delay: i * 90,
          onTap: () => submit(option),
        }));
      });
      return;
    }
    const pool = HOLE_LAYOUTS.desktop.filter((h) => h.row === "top");
    const holes = shuffleList(pool).slice(0, Math.max(1, options.length));
    options.forEach((option, i) => {
      yard.appendChild(makeHole(holes[i]));
      yard.appendChild(makeMole(holes[i], {
        bubble: String(option),
        mascot: MOLE_CAST[i % MOLE_CAST.length],
        label: "Answer: " + option,
        delay: i * 90,
        onTap: () => submit(option),
      }));
    });
  }

  function makeHole(pos) {
    return el("div", {
      class: "hole",
      style: "left:" + pos.x + "%; top:" + pos.y + "%",
    }, [el("div", { class: "hole__pit" })]);
  }

  function makeMole(pos, options) {
    const delay = options.delay || 0;
    const mole = el("button", {
      class: "mole",
      // bottom:(100-y)% pins the mascot's feet at the hole centre line
      style: "left:" + pos.x + "%; bottom:" + (100 - pos.y) + "%",
      "aria-label": options.label,
    }, [
      el("span", { class: "mole__clip" }, [
        el("img", {
          class: "mole__img",
          src: MASCOTS + options.mascot + ".png",
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
    mole.addEventListener("click", () => {
      if (ctx.questionLocked) return;
      mole.classList.add("is-hit");
      options.onTap();
    });
    return mole;
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

  function submit(answer) {
    if (ctx.questionLocked) return;
    ctx.questionLocked = true; // block rapid double taps until the next question
    const result = engine.submitAnswer(answer);
    if (!result.accepted) ctx.questionLocked = false;
  }

  /* ----------------------------- feedback ------------------------------ */

  function showFeedback(feedback) {
    const coach = $("#feedback");
    coach.classList.toggle("coach--wrong", !feedback.correct);
    $("#feedback-icon").src = ICONS + (feedback.correct ? "star-full" : "wrong") + ".png";
    $("#feedback-title").textContent = feedback.correct ? "Correct!" : "Not quite";

    let detail = "";
    if (!feedback.correct) {
      detail = "Correct: " + (feedback.correctAnswer || "");
      if (feedback.explanation) detail += " — " + feedback.explanation;
    } else {
      detail = feedback.correction || feedback.explanation || "Well done!";
    }
    $("#feedback-detail").textContent = detail;
    $("#feedback-continue").textContent = feedback.isFinalQuestion ? "Results" : "Next";
    coach.hidden = false;
  }

  function hideFeedback() {
    $("#feedback").hidden = true;
  }

  function answerText(value) {
    if (typeof value === "boolean") return value ? "Correct" : "Incorrect";
    return String(value);
  }

  function markAnswer(feedback) {
    ctx.marked = {
      learnerValue: feedback.learnerAnswer,
      correctValue: feedback.correctAnswer,
      correct: feedback.correct,
    };
    const same = (a, b) => String(a) === String(b);

    // moles: hit reaction on the chosen one, dim + duck the rest
    const moles = [...document.querySelectorAll("#yard .mole")];
    moles.forEach((mole) => {
      const bubble = mole.querySelector(".mole__bubble");
      const value = bubble ? bubble.textContent : "";
      const isChosen = same(value, answerText(feedback.learnerAnswer)) ||
        (ctx.question && ctx.question.type === "correct_incorrect" && mole.classList.contains("is-hit"));
      if (isChosen) {
        mole.classList.add("is-hit", feedback.correct ? "is-correct" : "is-wrong");
      } else {
        mole.classList.add("is-dim");
        setTimeout(() => mole.classList.add("is-down"), 260);
      }
      if (isChosen) setTimeout(() => mole.classList.add("is-down"), feedback.correct ? 620 : 900);
    });

    // paddles (binary questions)
    const good = $("#answer-correct");
    const bad = $("#answer-incorrect");
    if (ctx.question && ctx.question.type === "correct_incorrect") {
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
      body.appendChild(el("div", { class: "results__medal" }, [
        el("img", { src: REWARDS + medal + ".png", alt: result.stars + " star medal" }),
      ]));
      body.appendChild(el("h2", { class: "results__title", text: "Challenge Complete!" }));
      body.appendChild(starsRow(result.stars, result.maxStars || 3, true));
    } else {
      body.appendChild(el("div", { class: "results__mascot" }, [
        el("img", { src: MASCOTS + "fox.png", alt: "" }),
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
    if (ctx.gameCompleted) { renderLevelComplete(result, true); return; }
    const levelDone = engine.getLevelProgress(result.levelId).completed;
    if (levelDone && ctx.levelJustCompleted === result.levelId) {
      renderLevelComplete(result, false);
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

  function renderLevelComplete(result, gameComplete) {
    const body = $("#level-complete-body");
    clearNode(body);
    const progress = engine.getLevelProgress(result.levelId);
    const level = engine.getLevel(result.levelId);

    body.appendChild(el("div", { class: "level-complete__banner" }, [
      el("img", { src: gameComplete ? REWARDS + "trophy-gold.png" : REWARDS + "banner.png", alt: "" }),
    ]));
    body.appendChild(el("h2", {
      class: "level-complete__title",
      text: gameComplete ? "Grammar Quest Complete!" : "Level " + result.levelId + " Complete!",
    }));
    body.appendChild(el("p", {
      class: "level-complete__subtitle",
      text: gameComplete ? "You finished every challenge. Amazing work!" : (level ? level.title : ""),
    }));
    body.appendChild(el("div", { class: "level-complete__chest" }, [
      el("img", { src: gameComplete ? MASCOTS + "owl.png" : REWARDS + "chest.png", alt: "" }),
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
      text: gameComplete ? "Back to Home" : ctx.gameCompleted || !hasNextLevel ? "Continue" : "Continue to Level " + (result.levelId + 1),
      onclick: () => {
        Sound.play("click");
        if (gameComplete || ctx.gameCompleted) { renderHome(); return; }
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
    });

    engine.on(E.QUESTION_CHANGED, (payload) => { renderQuestion(payload); });

    engine.on(E.ANSWER_SUBMITTED, (feedback) => {
      ctx.questionLocked = true;
      markAnswer(feedback);
      showFeedback(feedback);
      Sound.play(feedback.correct ? "correct" : "wrong");
      if (feedback.pointsAwarded > 0) popupScore("+" + feedback.pointsAwarded, feedback.correct);
      if (!feedback.correct) popupScore("−1 ♥", false, true);
      const delay = feedback.correct ? FEEDBACK_DELAY.correct : FEEDBACK_DELAY.wrong;
      engine.advanceQuestion(delay);
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
      if (payload.streak < 2) return;
      const pop = $("#streak-pop");
      $("#streak-pop-count").textContent = "×" + payload.streak;
      pop.classList.remove("is-out");
      pop.hidden = false;
      clearTimeout(ctx.streakTimer);
      ctx.streakTimer = setTimeout(() => {
        pop.classList.add("is-out");
        setTimeout(() => { pop.hidden = true; }, 280);
      }, 1500);
      if (STREAK_MILESTONES.includes(payload.streak)) Sound.play("streak");
    });

    engine.on(E.LIVES_CHANGED, (payload) => {
      const hearts = $("#hud-hearts");
      clearNode(hearts);
      const row = heartsRow(payload.lives, payload.maxLives);
      if (payload.lost) {
        const lostIndex = payload.lives; // the heart just after remaining ones
        const lostImg = row.children[lostIndex];
        if (lostImg) {
          lostImg.classList.remove("heart--empty");
          lostImg.src = ICONS + "heart-full.png";
          lostImg.classList.add("heart--lost");
          setTimeout(() => {
            lostImg.src = ICONS + "heart-empty.png";
            lostImg.classList.add("heart--empty");
          }, 420);
        }
      }
      hearts.appendChild(row);
    });

    engine.on(E.TIMER_TICK, (payload) => {
      $("#hud-timer").textContent = fmtTime(payload.remainingSeconds);
      updateTimerClass(payload.remainingSeconds, payload.totalSeconds);
    });

    engine.on(E.TIMER_LOW, () => Sound.play("timer-low"));

    engine.on(E.PAUSED, () => {
      if (ctx.screen === "game" && ctx.modalStack[ctx.modalStack.length - 1] !== "pause") {
        openModal("pause");
      }
    });

    engine.on(E.RESUMED, () => { /* HUD already reflects ticks */ });

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
      // Let the last feedback card breathe before switching screens.
      setTimeout(() => {
        if (ctx.pendingResult === result && ctx.screen === "game") {
          hideFeedback();
          renderResults(result);
        }
      }, result.reason === "no_lives" || result.reason === "timeout" ? 700 : 1200);
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
    $("#pause-settings").addEventListener("click", () => openModal("settings"));
    $("#pause-exit").addEventListener("click", () => {
      closeAllModals();
      engine.abortChallenge();
    });

    $("#settings-close").addEventListener("click", () => {
      closeModal();
    });
    $("#home-settings").addEventListener("click", () => openModal("settings"));
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

    const soundSwitch = $("#setting-sound");
    if (soundSwitch) {
      soundSwitch.addEventListener("click", () => {
        uiSettings.sound = !uiSettings.sound;
        saveSettings();
        syncSettingsModal();
      });
    }
    $("#setting-anim").addEventListener("click", () => {
      uiSettings.animations = !uiSettings.animations;
      saveSettings();
      applyMotionPreference();
      syncSettingsModal();
    });

    $("#settings-reset").addEventListener("click", () => {
      $("#confirm-text").textContent = "This clears all stars, scores and unlocked levels on this device.";
      openModal("confirm");
    });
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

    window.addEventListener("resize", () => {
      clearTimeout(ctx.resizeTimer);
      ctx.resizeTimer = setTimeout(onResize, 150);
    });
  }

  function syncSoundIcon() {
    const icon = $("#home-sound img");
    if (icon) icon.src = ICONS + (uiSettings.sound ? "sound-on" : "sound-off") + ".png";
  }

  function syncSettingsModal() {
    const soundSwitch = $("#setting-sound");
    if (soundSwitch) soundSwitch.setAttribute("aria-checked", String(uiSettings.sound));
    const animSwitch = $("#setting-anim");
    if (animSwitch) animSwitch.setAttribute("aria-checked", String(uiSettings.animations));
    syncSoundIcon();
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
      if (q.type === "correct_incorrect") {
        if (event.key === "1" || event.key === "ArrowLeft") submit(true);
        if (event.key === "2" || event.key === "ArrowRight") submit(false);
      } else if (Array.isArray(q.options)) {
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < q.options.length) submit(q.options[index]);
      }
    }
  }

  function onResize() {
    if (ctx.screen === "map" && window.innerWidth !== ctx.mapRenderWidth) {
      // Width changed (rotation, desktop window resize): re-lay out the map
      // for the new size/mode. Height-only changes (mobile URL bar) are
      // ignored so the scroll position never jumps.
      renderMap();
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
    ["assets/images/bg-map-journey.jpg",
     MASCOTS + "dragon.png", MASCOTS + "owl.png", MASCOTS + "fox.png", MASCOTS + "book.png",
     ICONS + "heart-full.png", ICONS + "heart-empty.png",
     ICONS + "star-full.png", ICONS + "timer.png"].forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }

  /* -------------------------------- boot ------------------------------- */

  async function boot() {
    showScreen("loading");
    $("#loading-status").textContent = "Loading Grammar Quest\u2026";
    try {
      await engine.init({ url: "data/questions.json" });
    } catch (err) {
      console.error("[GrammarQuest UI] init failed:", err);
      $("#error-message").textContent = "We couldn't load the game data. " +
        (location.protocol === "file:" ? "Serve the folder over http (for example with the Live Server extension) and reload." : "Please try again.");
      showScreen("error");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyMotionPreference();
    syncSoundIcon();
    syncSettingsModal();
    wireEngine();
    wireDom();
    preload();
    boot();
    Sound.init();
  });
})();
