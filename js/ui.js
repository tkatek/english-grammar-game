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

  // Hole anchor positions on the gameplay background (percent of field),
  // detected from the painted artwork: two rows of three holes.
  const SLOTS_DESKTOP = [
    { x: 28.4, y: 49.4 }, { x: 49.7, y: 49.4 }, { x: 71.1, y: 49.4 },
    { x: 32.0, y: 67.0 }, { x: 53.8, y: 67.0 }, { x: 75.7, y: 67.0 },
  ];
  // Narrow fields re-grid the targets instead of cramming six desktop holes.
  const FIELD_MOBILE_BREAK = 620;

  // Node positions on the painted island map (percent of map canvas).
  const MAP_PATH = [
    { x: 14, y: 24 }, { x: 38, y: 17 }, { x: 62, y: 10 }, { x: 84, y: 24 },
    { x: 70, y: 42 }, { x: 46, y: 40 }, { x: 18, y: 45 }, { x: 10, y: 68 },
    { x: 35, y: 74 }, { x: 58, y: 60 }, { x: 80, y: 74 }, { x: 52, y: 90 },
    { x: 14, y: 88 },
  ];

  const FEEDBACK_DELAY = { correct: 2400, wrong: 4200 };
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

  const starsRow = (earned, max, animate) => {
    const row = el("div", { class: "map-node__stars" + (animate ? " results__stars" : "") });
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
    mapScrollTarget: null,
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
    if (!ctx.modalStack.length) $("#modal-root").hidden = true;
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
    const canvas = $("#map-canvas");
    clearNode(canvas);

    const levels = engine.getLevels();
    const next = engine.getNextUnlockedActivity();
    const info = engine.getGameInfo();
    const nodeCount = levels.length + (info.declaredTotalLevels > levels.length ? 1 : 0);

    levels.forEach((level, index) => {
      const pos = MAP_PATH[index % MAP_PATH.length];
      const progress = engine.getLevelProgress(level.id);
      const isCurrent = !!next && next.levelId === level.id;
      const perfect = progress.completed && progress.stars >= progress.maxStars && progress.maxStars > 0;

      let state = "map-node--unlocked";
      if (!level.unlocked) state = "map-node--locked";
      else if (perfect) state = "map-node--perfect";
      else if (progress.completed) state = "map-node--completed";
      else if (isCurrent) state = "map-node--current";

      const disc = el("div", { class: "map-node__disc", role: "button", tabindex: level.unlocked ? 0 : -1 });
      if (!level.unlocked) {
        disc.appendChild(iconImg("lock-closed", 34));
      } else {
        disc.appendChild(el("span", { text: String(level.id) }));
      }

      const node = el("button", {
        class: "map-node " + state,
        style: "left:" + pos.x + "%; top:" + pos.y + "%",
        "aria-label": level.unlocked
          ? "Level " + level.id + ": " + level.title + (progress.completed ? " (completed)" : "")
          : "Level " + level.id + " locked",
        onclick: () => {
          if (!level.unlocked) { toast("Pass the previous level to unlock this island", "lock-closed"); return; }
          Sound.play("click");
          openLevel(level.id);
        },
      }, [
        disc,
        progress.completed ? starsRow(progress.stars, progress.maxStars, false) : null,
        el("span", { class: "map-node__label", text: level.unlocked ? level.title : "Locked" }),
      ]);
      canvas.appendChild(node);
      if (isCurrent) ctx.mapScrollTarget = node;
    });

    if (nodeCount > levels.length) {
      const pos = MAP_PATH[levels.length % MAP_PATH.length];
      canvas.appendChild(el("div", {
        class: "map-node map-node--locked",
        style: "left:" + pos.x + "%; top:" + pos.y + "%",
      }, [
        el("div", { class: "map-node__disc" }, [iconImg("lock-closed", 34)]),
        el("span", { class: "map-node__label", text: "Coming soon" }),
      ]));
    }

    canvas.appendChild(el("div", { class: "map-legend" }, [
      el("span", { text: "★ Stars per level" }),
    ]));

    showScreen("map");
    requestAnimationFrame(() => sizeMapCanvas());
  }

  // On portrait screens the painted map keeps its island aspect and scrolls
  // horizontally so nodes never shrink to pinpoints; wide screens fit fully.
  function sizeMapCanvas() {
    const canvas = $("#map-canvas");
    const viewport = canvas.parentElement;
    if (!canvas || !viewport) return;
    const fullWidth = viewport.clientHeight * (1672 / 941);
    const wide = Math.max(viewport.clientWidth, Math.min(fullWidth, viewport.clientWidth * 1.6));
    canvas.style.width = wide > viewport.clientWidth ? Math.round(wide) + "px" : "100%";
    if (ctx.mapScrollTarget && wide > viewport.clientWidth) {
      ctx.mapScrollTarget.scrollIntoView({ inline: "center", block: "center", behavior: "auto" });
      ctx.mapScrollTarget = null;
    }
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
        challenge.completed ? starsRow(challenge.highestStars, 3, false) : null,
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

  function fieldTier() {
    const field = $("#field");
    ctx.layoutMobile = field.clientWidth > 0 && field.clientWidth < FIELD_MOBILE_BREAK;
    return ctx.layoutMobile ? "mobile" : "desktop";
  }

  function setupGameScreen(payload) {
    ctx.challenge = payload;
    ctx.marked = null;
    ctx.pendingResult = null;
    ctx.question = null;
    ctx.questionLocked = false;

    $("#hud-level").textContent = "Level " + payload.levelId;
    $("#hud-challenge").textContent = payload.challengeTitle;
    $("#hud-timer-wrap").hidden = !payload.settings.timeLimitSeconds;
    $("#hud-timer").textContent = payload.settings.timeLimitSeconds ? fmtTime(payload.settings.timeLimitSeconds) : "";
    updateTimerClass(payload.settings.timeLimitSeconds, payload.settings.timeLimitSeconds);

    const hearts = $("#hud-hearts");
    clearNode(hearts);
    hearts.appendChild(heartsRow(payload.settings.lives, payload.settings.lives));

    $("#hud-score").textContent = "0";
    setProgress(0, payload.totalQuestions, 1);
    $("#streak-badge").hidden = true;
    $("#final-ribbon").hidden = !(payload.challengeType === "mixed" || /final/i.test(payload.challengeTitle || ""));

    const field = $("#field");
    field.classList.toggle("field--speed", payload.challengeType === "speed_round");
    field.classList.toggle("field--final", $("#final-ribbon").hidden === false);

    hideFeedback();
    showScreen("game");
    fieldTier();
  }

  function setProgress(answered, total, currentNumber) {
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    $("#hud-progress-fill").style.width = pct + "%";
    $("#hud-progress-label").textContent = Math.min(currentNumber, total) + " / " + total;
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

    const field = $("#field");
    const tier = fieldTier();
    const q = payload.question;

    $("#prompt-bar").textContent = q.prompt || "";
    const sentenceCard = $("#sentence-card");
    const slots = $("#slots");
    const choiceStack = $("#choice-stack");
    const binary = $("#binary-actions");
    clearNode(slots); clearNode(choiceStack); clearNode(sentenceCard);
    sentenceCard.hidden = true;
    binary.hidden = true;

    if (q.type === "correct_incorrect") {
      if (tier === "desktop") {
        // The sentence pops out of a hole like an arcade target.
        const slotPos = SLOTS_DESKTOP[Math.floor(Math.random() * 3)]; // top row only
        const slot = makeSlot(slotPos);
        slot.querySelector(".slot__target").classList.add("slot__target--sentence");
        slot.querySelector(".slot__target").textContent = q.text || "";
        slot.querySelector(".slot__target").removeAttribute("onclick");
        slot.querySelector(".slot__target").setAttribute("aria-hidden", "true");
        slots.appendChild(slot);
      } else {
        sentenceCard.hidden = false;
        sentenceCard.textContent = q.text || "";
      }
      binary.hidden = false;
    } else if (q.type === "missing_word") {
      sentenceCard.hidden = false;
      sentenceCard.appendChild(renderSentenceWithBlank(q.text || ""));
      const options = Array.isArray(q.options) ? q.options : [];
      if (tier === "desktop" && options.length > 0) {
        const picked = pickSlots(options.length);
        options.forEach((option, i) => {
          slots.appendChild(makeWordSlot(picked[i], option));
        });
      } else {
        binary.hidden = true;
        options.forEach((option) => {
          choiceStack.appendChild(el("button", {
            class: "choice-card",
            text: option,
            onclick: () => submit(option),
          }));
        });
      }
    } else if (q.type === "multiple_choice") {
      (Array.isArray(q.options) ? q.options : []).forEach((option) => {
        choiceStack.appendChild(el("button", {
          class: "choice-card",
          text: option,
          onclick: () => submit(option),
        }));
      });
    } else {
      // Unknown format: degrade gracefully instead of a blank field.
      sentenceCard.hidden = false;
      sentenceCard.textContent = q.prompt || "Choose the correct answer.";
      (Array.isArray(q.options) ? q.options : ["true", "false"]).forEach((option) => {
        choiceStack.appendChild(el("button", { class: "choice-card", text: String(option), onclick: () => submit(option) }));
      });
    }

    setProgress(payload.answeredCount, payload.totalQuestions, payload.questionNumber);
    hideFeedback();
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

  function pickSlots(count) {
    const positions = SLOTS_DESKTOP.slice();
    // shuffle then take `count`, preferring a spread across both rows
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    return positions.slice(0, Math.min(count, positions.length));
  }

  function makeSlot(pos) {
    return el("div", {
      class: "slot",
      style: "left:" + pos.x + "%; top:" + pos.y + "%",
    }, [
      el("div", { class: "slot__hole" }),
      el("div", { class: "slot__target", role: "button", tabindex: "0" }),
    ]);
  }

  function makeWordSlot(pos, option) {
    const slot = makeSlot(pos);
    const target = slot.querySelector(".slot__target");
    target.textContent = option;
    target.setAttribute("aria-label", "Answer: " + option);
    target.addEventListener("click", () => submit(option));
    target.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); submit(option); }
    });
    return slot;
  }

  function submit(answer) {
    if (ctx.questionLocked) return;
    ctx.questionLocked = true; // block rapid double taps until the next question
    const result = engine.submitAnswer(answer);
    if (!result.accepted) ctx.questionLocked = false;
  }

  /* ----------------------------- feedback ------------------------------ */

  function showFeedback(feedback) {
    const overlay = $("#feedback");
    const card = overlay.querySelector(".feedback__card");
    overlay.className = "feedback " + (feedback.correct ? "feedback--correct" : "feedback--wrong");
    $("#feedback-icon").src = ICONS + (feedback.correct ? "star-full" : "wrong") + ".png";
    $("#feedback-title").textContent = feedback.correct ? "Correct!" : "Not quite";

    const body = $("#feedback-body");
    clearNode(body);
    if (!feedback.correct) {
      body.appendChild(el("div", { class: "feedback__row" }, [
        el("span", { class: "feedback__label", text: "Your answer" }),
        el("span", { class: "feedback__value feedback__value--no", text: answerText(feedback.learnerAnswer) }),
      ]));
      body.appendChild(el("div", { class: "feedback__row" }, [
        el("span", { class: "feedback__label", text: "Correct" }),
        el("span", { class: "feedback__value feedback__value--ok", text: feedback.correctAnswer || "" }),
      ]));
    } else {
      body.appendChild(el("div", { class: "feedback__row" }, [
        el("span", { class: "feedback__label", text: feedback.correction ? "Correct sentence" : "Nice!" }),
        el("span", { class: "feedback__value feedback__value--ok", text: feedback.correction || feedback.correctAnswer || "" }),
      ]));
    }
    if (feedback.explanation) {
      body.appendChild(el("div", { class: "feedback__rule" }, [
        el("strong", { text: "Rule: " }),
        document.createTextNode(feedback.explanation),
      ]));
    }
    $("#feedback-continue").textContent = feedback.isFinalQuestion ? "See results" : "Continue";
    overlay.hidden = false;
    card.scrollTop = 0;
  }

  function hideFeedback() {
    $("#feedback").hidden = true;
  }

  function answerText(value) {
    if (typeof value === "boolean") return value ? "Correct" : "Incorrect";
    return String(value);
  }

  function markTargets(feedback) {
    ctx.marked = {
      learnerValue: feedback.learnerAnswer,
      correctValue: feedback.correctAnswer,
      correct: feedback.correct,
    };
    const apply = (node, value) => {
      const text = String(value);
      if (text === String(feedback.learnerAnswer) && !feedback.correct) node.classList.add("is-wrong");
      else if (text === String(feedback.learnerAnswer) && feedback.correct) node.classList.add("is-correct");
      else node.classList.add("is-dimmed");
    };
    document.querySelectorAll("#slots .slot__target").forEach((node) => {
      if (node.classList.contains("slot__target--sentence")) return;
      apply(node, node.textContent);
    });
    document.querySelectorAll("#choice-stack .choice-card").forEach((node) => apply(node, node.textContent));

    const correctBtn = $("#answer-correct");
    const wrongBtn = $("#answer-incorrect");
    if (!correctBtn.hidden || ctx.question?.type === "correct_incorrect") {
      const pickedCorrect = feedback.learnerAnswer === true;
      [correctBtn, wrongBtn].forEach((btn) => btn.classList.remove("is-picked-correct", "is-picked-wrong", "is-dimmed"));
      if (feedback.correct) {
        correctBtn.classList.add("is-picked-correct");
        wrongBtn.classList.add("is-dimmed");
      } else {
        (pickedCorrect ? correctBtn : wrongBtn).classList.add("is-picked-wrong");
        (pickedCorrect ? wrongBtn : correctBtn).classList.remove("is-dimmed");
      }
    }
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
      markTargets(feedback);
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
      const badge = $("#streak-badge");
      if (payload.streak >= 2) {
        badge.hidden = false;
        $("#streak-count").textContent = "×" + payload.streak;
        if (STREAK_MILESTONES.includes(payload.streak)) {
          Sound.play("streak");
          badge.classList.remove("is-milestone");
          void badge.offsetWidth;
          badge.classList.add("is-milestone");
        }
      } else {
        badge.hidden = true;
        badge.classList.remove("is-milestone");
      }
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
    const field = $("#field");
    const anchor = document.querySelector("#slots .slot__target.is-correct, #choice-stack .choice-card.is-correct") ;
    let xPct = 50, yPct = 30;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const fieldRect = field.getBoundingClientRect();
      xPct = ((rect.left + rect.width / 2 - fieldRect.left) / fieldRect.width) * 100;
      yPct = ((rect.top - fieldRect.top) / fieldRect.height) * 100;
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
      if (ctx.modalStack.length === 0 && engine.status === "paused") openModal("pause");
    });
    $("#home-settings").addEventListener("click", () => openModal("settings"));
    $("#home-help").addEventListener("click", () => openModal("help"));
    $("#help-close").addEventListener("click", closeModal);

    $("#home-sound").addEventListener("click", () => {
      uiSettings.sound = !uiSettings.sound;
      saveSettings();
      syncSoundIcon();
      toast(uiSettings.sound ? "Sound on" : "Sound off", uiSettings.sound ? "sound-on" : "sound-off");
    });

    const soundSwitch = $("#setting-sound");
    soundSwitch.addEventListener("click", () => {
      uiSettings.sound = !uiSettings.sound;
      saveSettings();
      syncSettingsModal();
    });
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
    $("#home-sound img").src = ICONS + (uiSettings.sound ? "sound-on" : "sound-off") + ".png";
  }

  function syncSettingsModal() {
    $("#setting-sound").setAttribute("aria-checked", String(uiSettings.sound));
    $("#setting-anim").setAttribute("aria-checked", String(uiSettings.animations));
    syncSoundIcon();
  }

  function onKeydown(event) {
    const topModal = ctx.modalStack[ctx.modalStack.length - 1];
    if (event.key === "Escape") {
      if (topModal === "pause") { closeModal(); engine.resume(); return; }
      if (topModal) { closeModal(); if (engine.status === "paused") openModal("pause"); return; }
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
    if (ctx.screen === "map") sizeMapCanvas();
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
    ["assets/images/bg-gameplay.jpg", "assets/images/bg-map.jpg",
     MASCOTS + "dragon.png", ICONS + "heart-full.png", ICONS + "heart-empty.png",
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
