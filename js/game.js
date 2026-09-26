/* ==========================================================================
 * Grammar Quest — game engine (logic only, UI-independent)
 * --------------------------------------------------------------------------
 * Architecture:
 *   - data/questions.json  = educational content (levels, challenges, questions)
 *   - js/game.js           = rules + state (this file). Emits events; never
 *                            touches the DOM. The future UI subscribes to
 *                            events and calls the public action methods.
 *   - Player progress      = persisted through a storage adapter
 *                            (localStorage today, API adapter later).
 *
 * Core guarantees:
 *   - The JSON source is never mutated; every play session works on clones.
 *   - Public question payloads never contain correct answers before the
 *     learner has answered.
 *   - One answer per question (question locks on accept), one finish per
 *     challenge, timers are deadline-based and throttle-proof.
 * ========================================================================== */
(function (root) {
  "use strict";

  /* ======================================================================
   * 1. Constants
   * ====================================================================== */

  const ENGINE_VERSION = "1.0.0";

  const STATUS = Object.freeze({
    IDLE: "idle",
    LOADING: "loading",
    READY: "ready",
    PLAYING: "playing",
    PAUSED: "paused",
    COMPLETED: "completed",
    FAILED: "failed",
    ERROR: "error",
  });

  // Which status transitions the engine permits. Anything not listed is
  // blocked with a console warning so invalid flows fail loudly in dev.
  const ALLOWED_TRANSITIONS = {
    [STATUS.IDLE]: [STATUS.LOADING, STATUS.ERROR],
    [STATUS.LOADING]: [STATUS.READY, STATUS.ERROR],
    [STATUS.READY]: [STATUS.PLAYING, STATUS.LOADING, STATUS.ERROR],
    [STATUS.PLAYING]: [STATUS.PAUSED, STATUS.COMPLETED, STATUS.FAILED, STATUS.READY, STATUS.LOADING, STATUS.ERROR],
    [STATUS.PAUSED]: [STATUS.PLAYING, STATUS.COMPLETED, STATUS.FAILED, STATUS.READY, STATUS.LOADING, STATUS.ERROR],
    [STATUS.COMPLETED]: [STATUS.PLAYING, STATUS.READY, STATUS.LOADING, STATUS.ERROR],
    [STATUS.FAILED]: [STATUS.PLAYING, STATUS.READY, STATUS.LOADING, STATUS.ERROR],
    [STATUS.ERROR]: [STATUS.LOADING],
  };

  const EVENTS = Object.freeze({
    GAME_READY: "gameReady",
    LEVEL_STARTED: "levelStarted",
    CHALLENGE_STARTED: "challengeStarted",
    QUESTION_CHANGED: "questionChanged",
    ANSWER_SUBMITTED: "answerSubmitted",
    ANSWER_CORRECT: "answerCorrect",
    ANSWER_WRONG: "answerWrong",
    SCORE_CHANGED: "scoreChanged",
    STREAK_CHANGED: "streakChanged",
    LIVES_CHANGED: "livesChanged",
    TIMER_TICK: "timerTick",
    TIMER_LOW: "timerLow",
    PAUSED: "paused",
    RESUMED: "resumed",
    CHALLENGE_PASSED: "challengePassed",
    CHALLENGE_FAILED: "challengeFailed",
    CHALLENGE_FINISHED: "challengeFinished",
    CHALLENGE_ABORTED: "challengeAborted",
    CHALLENGE_UNLOCKED: "challengeUnlocked",
    LEVEL_UNLOCKED: "levelUnlocked",
    GAME_COMPLETED: "gameCompleted",
    PROGRESS_CHANGED: "progressChanged",
    PROGRESS_RESET: "progressReset",
    ERROR: "error",
  });

  const PROGRESS_VERSION = 1;
  const DEFAULT_STORAGE_KEY = "grammar-quest:progress:v1";

  // Engine-level fallbacks. Anything here can be overridden by
  // game.defaultSettings or per-challenge settings in questions.json.
  const ENGINE_DEFAULTS = {
    lives: 3,
    passingPercentage: 70,
    maxStars: 3,
    starThresholds: { oneStar: 70, twoStars: 80, threeStars: 90 },
    timeLimitSeconds: null,   // null/absent = untimed challenge
    questionCount: null,      // null/absent = use the whole question pool
    autoAdvanceMs: 0,         // 0 = the UI drives advancement via nextQuestion()
    lowTimeThresholdSeconds: 5,
    scoring: {
      baseScore: 100,
      streakBonusPerStep: 20,
      streakBonusCap: 200,
      speedBonusMax: 50,        // timed challenges only
      remainingLifeBonus: 50,   // awarded on a passed, fully-completed run
      remainingLifeBonusCap: 150,
      perfectAccuracyBonus: 200,
    },
  };

  const STAR_KEY_ORDER = ["oneStar", "twoStars", "threeStars", "fourStars", "fiveStars"];

  /* ======================================================================
   * 2. Small utilities
   * ====================================================================== */

  function now() { return Date.now(); }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function toPercent(part, total) {
    return total > 0 ? (part / total) * 100 : 0;
  }

  // Pure deep merge for settings: override wins, plain objects merge
  // recursively, arrays and primitives are replaced. Never mutates inputs.
  function deepMerge(base, override) {
    if (override === undefined) return base;
    if (!isPlainObject(base) || !isPlainObject(override)) return override;
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }

  // Fisher-Yates on a copy — never mutates the input array.
  function shuffle(source) {
    const arr = source.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /* ======================================================================
   * 3. Answer normalization + checkers
   * ====================================================================== */

  // Normalization is intentionally light: whitespace + quote style only.
  // Case-folding happens at comparison time (and can be disabled per
  // question with caseSensitive:true) so it never alters grammar meaning.
  function normalizeText(value) {
    if (typeof value !== "string") return value;
    return value
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function answersMatch(expected, given, caseSensitive) {
    if (typeof expected !== "string" || typeof given !== "string") return false;
    let a = normalizeText(expected);
    let b = normalizeText(given);
    if (!caseSensitive) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    return a === b;
  }

  function toBooleanAnswer(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (["true", "correct", "yes", "right", "1"].includes(v)) return true;
      if (["false", "incorrect", "wrong", "no", "0"].includes(v)) return false;
    }
    return undefined;
  }

  // Registry of per-type checkers so future formats (drag & drop, typing
  // with accents, audio…) can be added with registerAnswerChecker() without
  // touching the engine core.
  const answerCheckers = new Map();

  answerCheckers.set("correct_incorrect", (question, userAnswer) => {
    if (typeof question.isCorrect !== "boolean") {
      return { accepted: false, correct: false, reason: 'question of type "correct_incorrect" needs a boolean "isCorrect"' };
    }
    const given = toBooleanAnswer(userAnswer);
    if (given === undefined) {
      return { accepted: false, correct: false, reason: "answer must be true/false (or \"correct\"/\"incorrect\")" };
    }
    return { accepted: true, correct: given === question.isCorrect };
  });

  const textChecker = (question, userAnswer) => {
    const expected = question.correctAnswer;
    if (typeof expected !== "string" || !expected.trim()) {
      return { accepted: false, correct: false, reason: 'question needs a non-empty string "correctAnswer"' };
    }
    if (typeof userAnswer !== "string" || !userAnswer.trim()) {
      return { accepted: false, correct: false, reason: "answer must be a non-empty string" };
    }
    return { accepted: true, correct: answersMatch(expected, userAnswer, question.caseSensitive === true) };
  };

  answerCheckers.set("missing_word", textChecker);
  answerCheckers.set("multiple_choice", textChecker);

  // Single strategy entry point used everywhere — answer logic is never
  // spread across the engine. Pure: (question, answer) -> outcome.
  function checkAnswer(question, userAnswer) {
    if (!isPlainObject(question)) {
      return { accepted: false, correct: false, reason: "invalid question object" };
    }
    const checker = answerCheckers.get(question.type);
    if (!checker) {
      return { accepted: false, correct: false, reason: 'unsupported question type "' + question.type + '"' };
    }
    const outcome = checker(question, userAnswer);
    return { ...outcome, type: question.type };
  }

  /* ======================================================================
   * 4. Scoring / stars (pure functions, tunable through settings.scoring)
   * ====================================================================== */

  function calculateAnswerScore(options) {
    const cfg = { ...ENGINE_DEFAULTS.scoring, ...(options.scoring || {}) };
    if (!options.correct) return 0;
    let points = cfg.baseScore;
    if (cfg.streakBonusPerStep > 0 && options.streakAfter > 1) {
      points += Math.min(cfg.streakBonusCap, cfg.streakBonusPerStep * (options.streakAfter - 1));
    }
    // Speed bonus only exists on timed challenges and scales down linearly.
    if (
      cfg.speedBonusMax > 0 &&
      options.timeLimitMs > 0 &&
      typeof options.timeRemainingMs === "number" &&
      options.timeRemainingMs > 0
    ) {
      points += Math.round(cfg.speedBonusMax * clamp(options.timeRemainingMs / options.timeLimitMs, 0, 1));
    }
    return Math.max(0, Math.round(points));
  }

  function calculateCompletionBonus(options) {
    const cfg = { ...ENGINE_DEFAULTS.scoring, ...(options.scoring || {}) };
    let bonus = 0;
    if (cfg.remainingLifeBonus > 0 && options.maxLives > 0) {
      bonus += Math.min(cfg.remainingLifeBonusCap, cfg.remainingLifeBonus * options.livesRemaining);
    }
    if (cfg.perfectAccuracyBonus > 0 && options.accuracy >= 100) {
      bonus += cfg.perfectAccuracyBonus;
    }
    return Math.round(bonus);
  }

  // Accepts starThresholds as {oneStar,twoStars,…} or as an ascending array.
  function starThresholdList(settings) {
    const st = settings && settings.starThresholds;
    let list = [];
    if (Array.isArray(st)) {
      list = st.map(Number).filter((n) => Number.isFinite(n));
    } else if (isPlainObject(st)) {
      list = STAR_KEY_ORDER
        .filter((key) => st[key] !== undefined && st[key] !== null)
        .map((key) => Number(st[key]))
        .filter((n) => Number.isFinite(n));
    } else {
      // No thresholds supplied: passing is worth one star, nothing more.
      const p = Number(settings && settings.passingPercentage);
      if (Number.isFinite(p)) list = [p];
    }
    return list.sort((a, b) => a - b);
  }

  function calculateStars(accuracyPercent, settings) {
    const maxStars = Math.max(0, Math.floor(Number(settings && settings.maxStars) || 0));
    const thresholds = starThresholdList(settings);
    let stars = 0;
    for (const t of thresholds) {
      if (accuracyPercent >= t) stars++;
      else break;
    }
    return clamp(stars, 0, maxStars);
  }

  /* ======================================================================
   * 5. Content validation
   * ====================================================================== */

  function validateSettings(settings, where, errors, warnings) {
    if (settings.timeLimitSeconds !== undefined && settings.timeLimitSeconds !== null) {
      const t = Number(settings.timeLimitSeconds);
      if (!Number.isFinite(t) || t <= 0) errors.push(where + ".timeLimitSeconds must be a positive number (seconds) or null");
    }
    if (settings.lives !== undefined && settings.lives !== null) {
      const l = Number(settings.lives);
      if (!Number.isInteger(l) || l < 1) errors.push(where + ".lives must be an integer ≥ 1");
    }
    if (settings.passingPercentage !== undefined && settings.passingPercentage !== null) {
      const p = Number(settings.passingPercentage);
      if (!Number.isFinite(p) || p < 0 || p > 100) errors.push(where + ".passingPercentage must be between 0 and 100");
    }
    if (settings.maxStars !== undefined && settings.maxStars !== null) {
      const m = Number(settings.maxStars);
      if (!Number.isInteger(m) || m < 0) errors.push(where + ".maxStars must be an integer ≥ 0");
    }
    if (settings.starThresholds !== undefined && settings.starThresholds !== null) {
      const list = starThresholdList({ starThresholds: settings.starThresholds, passingPercentage: settings.passingPercentage });
      for (let i = 1; i < list.length; i++) {
        if (list[i] < list[i - 1]) {
          errors.push(where + ".starThresholds must be non-decreasing — " + list.join(", "));
          break;
        }
      }
    }
    if (settings.questionCount !== undefined && settings.questionCount !== null) {
      const q = Number(settings.questionCount);
      if (!Number.isInteger(q) || q < 1) errors.push(where + ".questionCount must be an integer ≥ 1");
    }
    if (settings.autoAdvanceMs !== undefined && settings.autoAdvanceMs !== null) {
      const a = Number(settings.autoAdvanceMs);
      if (!Number.isFinite(a) || a < 0) warnings.push(where + ".autoAdvanceMs should be a number ≥ 0 ms");
    }
  }

  function validateQuestion(question, where, supportedTypes, errors, warnings, seenQuestionIds) {
    if (!isPlainObject(question)) {
      errors.push(where + " must be an object");
      return;
    }
    if (question.id === undefined || question.id === null) {
      errors.push(where + ".id is required");
    } else if (seenQuestionIds) {
      const key = String(question.id);
      if (seenQuestionIds.has(key)) warnings.push("duplicate question id " + key + " at " + where + " (review records may be ambiguous)");
      seenQuestionIds.add(key);
    }
    if (typeof question.type !== "string" || !question.type.trim()) {
      errors.push(where + ".type is required");
      return;
    }
    if (!supportedTypes.has(question.type)) {
      errors.push(where + ': unsupported question type "' + question.type + '"');
      return;
    }
    if (typeof question.prompt !== "string" || !question.prompt.trim()) {
      warnings.push(where + ".prompt is missing — the UI will show the question text only");
    }
    if (question.type === "correct_incorrect") {
      if (typeof question.isCorrect !== "boolean") errors.push(where + ": \"correct_incorrect\" questions need a boolean isCorrect");
      if (typeof question.correctAnswer !== "string" || !question.correctAnswer.trim()) {
        warnings.push(where + ": no correctAnswer text to reveal after answering");
      }
    } else {
      // missing_word / multiple_choice / any custom text-based format
      if (typeof question.correctAnswer !== "string" || !question.correctAnswer.trim()) {
        errors.push(where + ': "' + question.type + '" questions need a non-empty correctAnswer');
      }
      if (Array.isArray(question.options)) {
        if (question.options.length === 0) {
          errors.push(where + ": options array must not be empty");
        } else if (
          typeof question.correctAnswer === "string" &&
          !question.options.some((opt) => answersMatch(question.correctAnswer, String(opt), false))
        ) {
          errors.push(where + ": correctAnswer \"" + question.correctAnswer + "\" is not among the options");
        }
        if (question.options.some((opt) => typeof opt !== "string")) {
          warnings.push(where + ": options should all be strings");
        }
      } else if (question.type === "multiple_choice") {
        errors.push(where + ': "multiple_choice" questions need an options array');
      } else {
        warnings.push(where + ": no options array — the learner will type the answer");
      }
    }
    if (question.explanation !== undefined && typeof question.explanation !== "string") {
      warnings.push(where + ".explanation should be a string");
    }
  }

  // Validates the whole questions.json document. Returns { ok, errors, warnings }.
  // Errors = engine refuses to start; warnings = engine continues with fallbacks.
  function validateGameData(data, supportedTypes) {
    const errors = [];
    const warnings = [];
    if (!isPlainObject(data)) {
      return { ok: false, errors: ["game data must be a JSON object"], warnings };
    }
    if (!isPlainObject(data.game)) {
      errors.push('missing "game" object');
    } else {
      if (data.game.title !== undefined && typeof data.game.title !== "string") {
        warnings.push("game.title should be a string");
      }
      const total = Number(data.game.totalLevels);
      if (data.game.totalLevels !== undefined && !Number.isFinite(total)) {
        warnings.push("game.totalLevels is not a number");
      }
      if (isPlainObject(data.game.defaultSettings)) {
        validateSettings(data.game.defaultSettings, "game.defaultSettings", errors, warnings);
      }
    }
    if (!Array.isArray(data.levels) || data.levels.length === 0) {
      errors.push('"levels" must be a non-empty array');
      return { ok: false, errors, warnings };
    }

    const levelIds = new Set();
    data.levels.forEach((level, i) => {
      const where = "levels[" + i + "]";
      if (!isPlainObject(level)) {
        errors.push(where + " must be an object");
        return;
      }
      if (level.id === undefined || level.id === null) {
        errors.push(where + ".id is required");
        return;
      }
      const levelKey = String(level.id);
      if (levelIds.has(levelKey)) errors.push("duplicate level id " + levelKey);
      levelIds.add(levelKey);
      if (typeof level.title !== "string" || !level.title.trim()) {
        warnings.push(where + ".title is missing");
      }
      if (!Array.isArray(level.challenges) || level.challenges.length === 0) {
        errors.push(where + ".challenges must be a non-empty array");
        return;
      }
      const challengeIds = new Set();
      level.challenges.forEach((challenge, j) => {
        const cWhere = where + ".challenges[" + j + "]";
        if (!isPlainObject(challenge)) {
          errors.push(cWhere + " must be an object");
          return;
        }
        if (challenge.id === undefined || challenge.id === null) {
          errors.push(cWhere + ".id is required");
          return;
        }
        const cKey = String(challenge.id);
        if (challengeIds.has(cKey)) errors.push("duplicate challenge id " + cKey + " in level " + levelKey);
        challengeIds.add(cKey);
        if (!Array.isArray(challenge.questions) || challenge.questions.length === 0) {
          errors.push(cWhere + ".questions must be a non-empty array");
        } else {
          const questionIds = new Set();
          challenge.questions.forEach((q, k) => {
            validateQuestion(q, cWhere + ".questions[" + k + "]", supportedTypes, errors, warnings, questionIds);
          });
        }
        if (isPlainObject(challenge.settings)) {
          validateSettings(challenge.settings, cWhere + ".settings", errors, warnings);
        }
      });
    });

    const declared = Number(data.game && data.game.totalLevels);
    if (Number.isFinite(declared) && declared > data.levels.length) {
      warnings.push(
        "game declares totalLevels " + declared + " but only " + data.levels.length +
        " level(s) are loaded — progression ends at the last loaded level until more content is added"
      );
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  /* ======================================================================
   * 6. Storage adapters (persistence boundary)
   * ----------------------------------------------------------------------
   * Contract: { load(key) -> string|null|Promise, save(key, str) -> bool|
   * Promise, remove(key) }  — may be swapped for an API adapter later
   * (GET/POST /api/games/grammar-quest/progress) without engine changes.
   * ====================================================================== */

  function createMemoryAdapter(initialStore) {
    const store = isPlainObject(initialStore) ? { ...initialStore } : {};
    return {
      id: "memory",
      load(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      save(key, value) { store[key] = value; return true; },
      remove(key) { delete store[key]; },
    };
  }

  function createLocalStorageAdapter(scope) {
    const target = scope || root;
    const available = (() => {
      try {
        target.localStorage.setItem("__grammar_quest_probe__", "1");
        target.localStorage.removeItem("__grammar_quest_probe__");
        return true;
      } catch (err) {
        return false;
      }
    })();
    if (!available) {
      console.warn("[GrammarQuest] localStorage unavailable — progress will not survive a reload");
      return createMemoryAdapter();
    }
    return {
      id: "localStorage",
      load(key) {
        try { return target.localStorage.getItem(key); } catch (err) { return null; }
      },
      save(key, value) {
        try { target.localStorage.setItem(key, value); return true; }
        catch (err) { console.warn("[GrammarQuest] saving progress failed:", err && err.message); return false; }
      },
      remove(key) {
        try { target.localStorage.removeItem(key); } catch (err) { /* nothing to recover */ }
      },
    };
  }

  function freshProgress() {
    return { version: PROGRESS_VERSION, updatedAt: null, levels: {} };
  }

  // Tolerant reader: repairs what it can, discards what it cannot, and never
  // throws — corrupted storage downgrades to a fresh progress object.
  function sanitizeProgress(parsed) {
    if (!isPlainObject(parsed) || parsed.version !== PROGRESS_VERSION || !isPlainObject(parsed.levels)) {
      console.warn("[GrammarQuest] stored progress has an unrecognized shape — starting fresh");
      return freshProgress();
    }
    const clean = freshProgress();
    Object.keys(parsed.levels).forEach((levelKey) => {
      const level = parsed.levels[levelKey];
      if (!isPlainObject(level) || !isPlainObject(level.challenges)) return;
      Object.keys(level.challenges).forEach((challengeKey) => {
        const rec = level.challenges[challengeKey];
        if (!isPlainObject(rec)) return;
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        clean.levels[levelKey] = clean.levels[levelKey] || { challenges: {} };
        clean.levels[levelKey].challenges[challengeKey] = {
          attempts: Math.max(0, Math.floor(num(rec.attempts))),
          completed: rec.completed === true,
          bestScore: Math.max(0, Math.floor(num(rec.bestScore))),
          bestAccuracy: clamp(num(rec.bestAccuracy), 0, 100),
          highestStars: Math.max(0, Math.floor(num(rec.highestStars))),
          bestStreak: Math.max(0, Math.floor(num(rec.bestStreak))),
          completedAt: Number.isFinite(Number(rec.completedAt)) ? Number(rec.completedAt) : null,
        };
      });
    });
    return clean;
  }

  function getStoredChallenge(progress, levelKey, challengeKey) {
    const level = progress.levels[levelKey];
    return (level && level.challenges && level.challenges[challengeKey]) || null;
  }

  /* ======================================================================
   * 7. Event bus
   * ====================================================================== */

  class EventBus {
    constructor() {
      this._handlers = new Map();
    }
    on(event, callback) {
      if (typeof event !== "string" || typeof callback !== "function") {
        console.warn("[GrammarQuest] on() needs an event name and a function");
        return () => {};
      }
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(callback);
      return () => this.off(event, callback);
    }
    once(event, callback) {
      const wrapped = (payload) => {
        this.off(event, wrapped);
        callback(payload);
      };
      return this.on(event, wrapped);
    }
    off(event, callback) {
      const set = this._handlers.get(event);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this._handlers.delete(event);
    }
    emit(event, payload) {
      const set = this._handlers.get(event);
      if (!set || set.size === 0) return;
      // A broken UI handler must never break engine flow.
      for (const callback of Array.from(set)) {
        try {
          callback(payload);
        } catch (err) {
          console.error('[GrammarQuest] handler for "' + event + '" threw:', err);
        }
      }
    }
  }

  /* ======================================================================
   * 8. Engine
   * ====================================================================== */

  class GrammarQuestEngine {
    /**
     * @param {Object} [options]
     * @param {Object} [options.storageAdapter]  load/save/remove adapter (default: localStorage with memory fallback)
     * @param {string} [options.playerId]        namespaced storage key for a future per-user progress
     * @param {boolean} [options.autoPauseOnHidden] pause the timer when the tab is hidden (default true)
     * @param {Function} [options.fetchFn]       fetch implementation used by init()
     */
    constructor(options = {}) {
      this._eventBus = new EventBus();
      this._playerId = options.playerId ? String(options.playerId) : null;
      this._storageKey = DEFAULT_STORAGE_KEY + (this._playerId ? ":" + this._playerId : "");
      this._storageAdapter = options.storageAdapter || createLocalStorageAdapter();
      this._realtimeAdapter = null;
      this._fetchFn = typeof options.fetchFn === "function" ? options.fetchFn
        : (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
      this._autoPauseOnHidden = options.autoPauseOnHidden !== false;

      this._status = STATUS.IDLE;
      this._data = null;          // deep clone of questions.json — never mutated afterwards
      this._levels = [];          // [{ level, index }] in JSON order (order drives progression)
      this._progress = freshProgress();
      this._session = null;       // active play session (cloned questions, counters, timer)
      this._lastResult = null;
      this._announcedLevels = new Set();

      this._bindVisibility();
    }

    /* -------------------------------------------------------------- *
     * 8.1 Events + adapters
     * -------------------------------------------------------------- */

    on(event, callback) { return this._eventBus.on(event, callback); }
    once(event, callback) { return this._eventBus.once(event, callback); }
    off(event, callback) { this._eventBus.off(event, callback); }
    emit(event, payload) {
      this._eventBus.emit(event, payload);
      this._forwardToRealtime(event, payload);
    }

    get status() { return this._status; }
    get EVENTS() { return EVENTS; }
    get STATUS() { return STATUS; }
    get version() { return ENGINE_VERSION; }

    /** Register an adapter for a future live platform (WebSockets/Echo/…).
     *  The adapter receives every emitted event via sendEvent(name, payload);
     *  inbound server events flow through handleRemoteEvent(). No networking
     *  happens unless platform code provides an adapter. */
    setRealtimeAdapter(adapter) {
      if (adapter !== null && !isPlainObject(adapter)) {
        console.warn("[GrammarQuest] realtime adapter must be an object or null");
        return this;
      }
      this._realtimeAdapter = adapter;
      if (adapter && typeof adapter.connect === "function") {
        try { adapter.connect(); } catch (err) { console.warn("[GrammarQuest] realtime connect() failed:", err); }
      }
      return this;
    }

    /** Inbound server-event hook for future live classrooms. Emits
     *  "remote:<name>" on the bus so platform code can react; the engine
     *  itself never treats remote data as authoritative in single-player. */
    handleRemoteEvent(name, payload) {
      this._eventBus.emit("remote:" + String(name), payload);
    }

    _forwardToRealtime(event, payload) {
      const adapter = this._realtimeAdapter;
      if (adapter && typeof adapter.sendEvent === "function") {
        try { adapter.sendEvent(event, payload); }
        catch (err) { console.warn("[GrammarQuest] realtime sendEvent failed:", err); }
      }
    }

    /** Register a custom answer checker for a new question type, e.g.
     *  engine.registerAnswerChecker("drag_drop", (q, answer) => …). Must be
     *  done before init() so validation accepts the type. */
    registerAnswerChecker(type, checker) {
      if (typeof type !== "string" || typeof checker !== "function") {
        console.warn("[GrammarQuest] registerAnswerChecker(type, fn) needs a type name and a function");
        return false;
      }
      answerCheckers.set(type, checker);
      return true;
    }

    /* -------------------------------------------------------------- *
     * 8.2 Lifecycle
     * -------------------------------------------------------------- */

    _setStatus(next) {
      const current = this._status;
      if (current === next) return true;
      const allowed = ALLOWED_TRANSITIONS[current] || [];
      if (!allowed.includes(next)) {
        console.warn("[GrammarQuest] blocked status transition " + current + " → " + next);
        return false;
      }
      this._status = next;
      return true;
    }

    _bindVisibility() {
      if (!this._autoPauseOnHidden) return;
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      document.addEventListener("visibilitychange", () => {
        // Deadline-based timing survives tab throttling; auto-pause additionally
        // freezes the clock when the learner leaves the page entirely.
        if (document.hidden && this._status === STATUS.PLAYING) this.pause();
      });
    }

    /**
     * Loads and validates the content. Either pass { data } (already-loaded
     * JSON — used by tests/tools) or { url } (default "data/questions.json").
     * Resolves with game info once the engine is READY; rejects on failure
     * after switching to ERROR and emitting an "error" event.
     */
    async init(config = {}) {
      if (this._status === STATUS.LOADING) throw new Error("init() is already in progress");
      if (this._session) this._teardownSession();
      if (this._status === STATUS.PLAYING || this._status === STATUS.PAUSED) {
        this._setStatus(STATUS.READY);
      }
      this._setStatus(STATUS.LOADING);
      try {
        let raw = config.data;
        if (raw === undefined) {
          const url = config.url || "data/questions.json";
          if (typeof this._fetchFn !== "function") {
            throw new Error("fetch is not available — pass { data } to init()");
          }
          const response = await this._fetchFn(url);
          if (!response || !response.ok) {
            throw new Error("failed to load " + url + " (" + (response ? response.status + " " + response.statusText : "no response") + ")");
          }
          raw = await response.json();
        }
        const supportedTypes = new Set(answerCheckers.keys());
        const validation = validateGameData(raw, supportedTypes);
        validation.warnings.forEach((w) => console.warn("[GrammarQuest] " + w));
        if (!validation.ok) {
          throw new Error("invalid game data — " + validation.errors.join(" | "));
        }
        this._installData(raw);
        await this._loadProgressFromStorage();
        this._announcedLevels.clear();
        this._setStatus(STATUS.READY);
        this.emit(EVENTS.GAME_READY, this.getGameInfo());
        return this.getGameInfo();
      } catch (err) {
        this._initError = err;
        this._setStatus(STATUS.ERROR);
        this.emit(EVENTS.ERROR, { message: "initialization failed", reason: err && err.message });
        throw err;
      }
    }

    _installData(raw) {
      this._data = deepClone(raw);
      this._levels = (this._data.levels || []).map((level, index) => ({ level, index }));
    }

    /* -------------------------------------------------------------- *
     * 8.3 Content lookups (order in JSON is authoritative)
     * -------------------------------------------------------------- */

    _findLevel(levelId) {
      const key = String(levelId);
      return this._levels.find((entry) => String(entry.level.id) === key) || null;
    }

    _findChallenge(levelId, challengeId) {
      const entry = this._findLevel(levelId);
      if (!entry) return null;
      const key = String(challengeId);
      const challenges = entry.level.challenges || [];
      const index = challenges.findIndex((c) => String(c.id) === key);
      if (index === -1) return null;
      return { level: entry.level, levelIndex: entry.index, challenge: challenges[index], challengeIndex: index };
    }

    _mergeSettings(challenge) {
      const gameDefaults = (this._data && isPlainObject(this._data.game) && this._data.game.defaultSettings) || {};
      const merged = deepMerge(deepClone(ENGINE_DEFAULTS), deepClone(gameDefaults));
      return deepMerge(merged, deepClone(challenge.settings || {}));
    }

    _isChallengePassedInStore(levelId, challengeId) {
      const rec = getStoredChallenge(this._progress, String(levelId), String(challengeId));
      return !!(rec && rec.completed);
    }

    /* -------------------------------------------------------------- *
     * 8.4 Locking / progression rules (derived from stored passes)
     * -------------------------------------------------------------- */

    isLevelUnlocked(levelId) {
      const entry = this._findLevel(levelId);
      if (!entry) return false;
      if (entry.index === 0) return true;
      if (entry.level.unlockedByDefault === true) return true;
      const previous = this._levels[entry.index - 1].level;
      const lastChallenge = previous.challenges[previous.challenges.length - 1];
      return this._isChallengePassedInStore(previous.id, lastChallenge.id);
    }

    isChallengeUnlocked(levelId, challengeId) {
      const found = this._findChallenge(levelId, challengeId);
      if (!found) return false;
      if (!this.isLevelUnlocked(levelId)) return false;
      if (found.challengeIndex === 0) return true;
      const previous = found.level.challenges[found.challengeIndex - 1];
      return this._isChallengePassedInStore(found.level.id, previous.id);
    }

    /* -------------------------------------------------------------- *
     * 8.5 Session control
     * -------------------------------------------------------------- */

    _teardownSession() {
      if (this._session) this._clearTimers(this._session);
      this._session = null;
    }

    _clearTimers(session) {
      if (session.timer && session.timer.intervalId) {
        clearInterval(session.timer.intervalId);
        session.timer.intervalId = null;
      }
      if (session.advanceTimeout) {
        clearTimeout(session.advanceTimeout);
        session.advanceTimeout = null;
      }
    }

    /**
     * Starts a challenge. Returns { started, reason? } — locked or unknown
     * content is a normal guard (no error event), the UI shows the reason.
     */
    startChallenge(levelId, challengeId) {
      if (this._status !== STATUS.READY && this._status !== STATUS.COMPLETED && this._status !== STATUS.FAILED) {
        const reason = 'cannot start a challenge while status is "' + this._status + '" — call abortChallenge() first';
        console.warn("[GrammarQuest] " + reason);
        return { started: false, reason };
      }
      const found = this._findChallenge(levelId, challengeId);
      if (!found) {
        const reason = "level " + levelId + " / challenge " + challengeId + " does not exist";
        console.warn("[GrammarQuest] " + reason);
        return { started: false, reason };
      }
      if (!this.isChallengeUnlocked(levelId, challengeId)) {
        const reason = "challenge " + challengeId + " of level " + levelId + " is locked — pass the previous challenge first";
        console.warn("[GrammarQuest] " + reason);
        return { started: false, reason, locked: true };
      }

      this._teardownSession(); // stop any lingering timers from a previous session

      const settings = this._mergeSettings(found.challenge);

      // Play-session questions: clones, shuffled order, optional sub-selection
      // via settings.questionCount, and a one-time option shuffle whose order
      // stays stable for the whole lifetime of each question.
      let pool = shuffle((found.challenge.questions || []).map((q) => deepClone(q)));
      const wanted = Number(settings.questionCount);
      if (Number.isFinite(wanted) && wanted > 0 && wanted < pool.length) {
        pool = pool.slice(0, Math.floor(wanted));
      }
      pool.forEach((q) => {
        if (Array.isArray(q.options)) q.options = shuffle(q.options);
      });

      const lives = Math.max(1, Math.floor(Number(settings.lives) || ENGINE_DEFAULTS.lives));
      const timeLimitSeconds = Number(settings.timeLimitSeconds);
      const hasTimer = Number.isFinite(timeLimitSeconds) && timeLimitSeconds > 0;

      this._session = {
        levelId: found.level.id,
        challengeId: found.challenge.id,
        levelIndex: found.levelIndex,
        challengeIndex: found.challengeIndex,
        levelTitle: found.level.title,
        challengeTitle: found.challenge.title,
        challengeType: found.challenge.type || "mixed",
        difficulty: found.challenge.difficulty || null,
        settings,
        questions: pool,
        totalQuestions: pool.length,
        currentIndex: 0,
        locked: false,          // one-answer-per-question lock
        score: 0,
        lives,
        maxLives: lives,
        streak: 0,
        bestStreak: 0,
        correctCount: 0,
        wrongCount: 0,
        answeredCount: 0,
        review: [],
        startTimestamp: now(),
        playClock: { accumulatedMs: 0, lastResumeAt: now() }, // active play time (pauses excluded)
        timer: {
          enabled: hasTimer,
          limitMs: hasTimer ? Math.max(1, Math.round(timeLimitSeconds * 1000)) : 0,
          deadline: null,
          remainingMs: hasTimer ? Math.max(1, Math.round(timeLimitSeconds * 1000)) : null,
          running: false,
          intervalId: null,
          lastEmittedSecond: null,
          lowEmitted: false,
        },
        advanceTimeout: null,
        finishing: false,       // exactly-once guard for end-of-challenge
        finished: false,
        finishReason: null,
      };

      this._setStatus(STATUS.PLAYING);

      if (this._session.timer.enabled) this._startTimer();

      const levelKey = String(found.level.id);
      if (!this._announcedLevels.has(levelKey)) {
        this._announcedLevels.add(levelKey);
        this.emit(EVENTS.LEVEL_STARTED, {
          levelId: found.level.id,
          levelTitle: found.level.title,
          grammarTopic: found.level.grammarTopic || null,
          description: found.level.description || null,
          challengeCount: found.level.challenges.length,
        });
      }

      this.emit(EVENTS.CHALLENGE_STARTED, {
        levelId: this._session.levelId,
        levelTitle: this._session.levelTitle,
        challengeId: this._session.challengeId,
        challengeTitle: this._session.challengeTitle,
        challengeType: this._session.challengeType,
        difficulty: this._session.difficulty,
        totalQuestions: this._session.totalQuestions,
        settings: {
          timeLimitSeconds: hasTimer ? timeLimitSeconds : null,
          lives,
          passingPercentage: settings.passingPercentage,
          maxStars: settings.maxStars,
          questionCount: settings.questionCount ?? null,
          autoAdvanceMs: settings.autoAdvanceMs ?? 0,
        },
      });

      this.emit(EVENTS.QUESTION_CHANGED, this._questionChangedPayload());

      return { started: true, levelId, challengeId };
    }

    pause() {
      if (this._status !== STATUS.PLAYING || !this._session) {
        return { paused: false, reason: 'can only pause while playing (status is "' + this._status + '")' };
      }
      const session = this._session;
      if (session.timer.running) {
        session.timer.remainingMs = Math.max(0, session.timer.deadline - now());
        clearInterval(session.timer.intervalId);
        session.timer.intervalId = null;
        session.timer.running = false;
      }
      session.playClock.accumulatedMs += now() - session.playClock.lastResumeAt;
      session.playClock.lastResumeAt = null;
      this._setStatus(STATUS.PAUSED);
      this.emit(EVENTS.PAUSED, {
        levelId: session.levelId,
        challengeId: session.challengeId,
        remainingSeconds: session.timer.enabled ? Math.ceil(session.timer.remainingMs / 1000) : null,
      });
      return { paused: true };
    }

    resume() {
      if (this._status !== STATUS.PAUSED || !this._session) {
        return { resumed: false, reason: 'can only resume from paused (status is "' + this._status + '")' };
      }
      const session = this._session;
      session.playClock.lastResumeAt = now();
      this._setStatus(STATUS.PLAYING);
      if (session.timer.enabled && !session.timer.running && !session.finished) {
        session.timer.deadline = now() + session.timer.remainingMs;
        session.timer.running = true;
        session.timer.lastEmittedSecond = Math.ceil(session.timer.remainingMs / 1000);
        session.timer.intervalId = setInterval(() => this._onTimerInterval(), 200);
      }
      this.emit(EVENTS.RESUMED, {
        levelId: session.levelId,
        challengeId: session.challengeId,
        remainingSeconds: session.timer.enabled ? Math.ceil(session.timer.remainingMs / 1000) : null,
      });
      return { resumed: true };
    }

    /** Stop the active challenge without recording a result. */
    abortChallenge() {
      if (!this._session || (this._status !== STATUS.PLAYING && this._status !== STATUS.PAUSED)) {
        return { aborted: false, reason: "no active challenge to abort" };
      }
      const session = this._session;
      this._teardownSession();
      this._setStatus(STATUS.READY);
      this.emit(EVENTS.CHALLENGE_ABORTED, {
        levelId: session.levelId,
        challengeId: session.challengeId,
        answeredQuestions: session.answeredCount,
        totalQuestions: session.totalQuestions,
      });
      return { aborted: true };
    }

    /** Restart the current (or last) challenge: reshuffles, resets everything,
     *  keeps historical best progress intact. */
    retryChallenge() {
      const target = this._session
        ? { levelId: this._session.levelId, challengeId: this._session.challengeId }
        : (this._lastResult
          ? { levelId: this._lastResult.levelId, challengeId: this._lastResult.challengeId }
          : null);
      if (!target) {
        return { started: false, reason: "no current or previous challenge to retry" };
      }
      if (this._session && (this._status === STATUS.PLAYING || this._status === STATUS.PAUSED)) {
        this._teardownSession();
        this._setStatus(STATUS.READY);
      }
      return this.startChallenge(target.levelId, target.challengeId);
    }

    /* -------------------------------------------------------------- *
     * 8.6 Timer (deadline-based, throttle-proof)
     * -------------------------------------------------------------- */

    _startTimer() {
      const timer = this._session.timer;
      timer.deadline = now() + timer.limitMs;
      timer.remainingMs = timer.limitMs;
      timer.running = true;
      timer.lastEmittedSecond = Math.ceil(timer.limitMs / 1000);
      timer.intervalId = setInterval(() => this._onTimerInterval(), 200);
    }

    _onTimerInterval() {
      const session = this._session;
      if (!session || !session.timer.running) return;
      const remaining = Math.max(0, session.timer.deadline - now());
      session.timer.remainingMs = remaining;
      const secondsLeft = Math.ceil(remaining / 1000);
      if (secondsLeft !== session.timer.lastEmittedSecond) {
        if (secondsLeft > 0) {
          const low = secondsLeft <= Number(session.settings.lowTimeThresholdSeconds);
          this.emit(EVENTS.TIMER_TICK, {
            levelId: session.levelId,
            challengeId: session.challengeId,
            remainingSeconds: secondsLeft,
            totalSeconds: Math.round(session.timer.limitMs / 1000),
            remainingMs: remaining,
            low,
          });
        }
        session.timer.lastEmittedSecond = secondsLeft;
      }
      if (
        session.timer.enabled &&
        !session.timer.lowEmitted &&
        secondsLeft > 0 &&
        secondsLeft <= Number(session.settings.lowTimeThresholdSeconds)
      ) {
        session.timer.lowEmitted = true;
        this.emit(EVENTS.TIMER_LOW, {
          levelId: session.levelId,
          challengeId: session.challengeId,
          remainingSeconds: secondsLeft,
        });
      }
      if (remaining <= 0) {
        this._finishChallenge("timeout"); // guarded to run once
      }
    }

    _remainingMsNow(session) {
      if (!session || !session.timer.enabled) return null;
      if (!session.timer.running) return Math.max(0, session.timer.remainingMs);
      return Math.max(0, session.timer.deadline - now());
    }

    /* -------------------------------------------------------------- *
     * 8.7 Answering
     * -------------------------------------------------------------- */

    _publicQuestion(question) {
      const payload = {
        id: question.id,
        type: question.type,
        prompt: question.prompt || null,
      };
      if (question.text !== undefined && question.text !== null) payload.text = question.text;
      if (Array.isArray(question.options)) payload.options = question.options.slice();
      return payload; // correctAnswer / isCorrect intentionally omitted
    }

    _questionChangedPayload() {
      const session = this._session;
      return {
        levelId: session.levelId,
        challengeId: session.challengeId,
        question: this._publicQuestion(session.questions[session.currentIndex]),
        questionNumber: session.currentIndex + 1,
        totalQuestions: session.totalQuestions,
        answeredCount: session.answeredCount,
        correctCount: session.correctCount,
        wrongCount: session.wrongCount,
        score: session.score,
        lives: session.lives,
        streak: session.streak,
      };
    }

    /**
     * Submits the learner's answer for the current question.
     * Accepts booleans for correct/incorrect items, option strings for choice
     * items, or a number = index into the displayed options.
     * Returns a structured result; only the first accepted call per question
     * counts (the question locks until nextQuestion()/advanceQuestion()).
     */
    submitAnswer(userAnswer) {
      const reject = (reason) => {
        console.warn("[GrammarQuest] answer rejected: " + reason);
        return { accepted: false, reason };
      };
      if (this._status !== STATUS.PLAYING || !this._session) {
        return reject('cannot answer while status is "' + this._status + '"');
      }
      const session = this._session;
      if (session.finished || session.finishing) return reject("this challenge has already ended");
      if (session.locked) return reject("the current question is already answered — call nextQuestion()");
      const question = session.questions[session.currentIndex];
      if (!question) return reject("no active question");
      if (userAnswer === undefined || userAnswer === null || userAnswer === "") {
        return reject("an answer is required");
      }

      // Resolve numeric selections against the current presentation order.
      let answer = userAnswer;
      if (typeof answer === "number" && Array.isArray(question.options)) {
        const option = question.options[answer];
        if (option === undefined) return reject("option index " + answer + " is out of range");
        answer = String(option);
      }

      const outcome = checkAnswer(question, answer);
      if (!outcome.accepted) return reject(outcome.reason);

      session.locked = true;

      const wasCorrect = outcome.correct === true;
      const previousScore = session.score;
      let pointsAwarded = 0;

      if (wasCorrect) {
        session.streak += 1;
        session.bestStreak = Math.max(session.bestStreak, session.streak);
        session.correctCount += 1;
        pointsAwarded = calculateAnswerScore({
          correct: true,
          streakAfter: session.streak,
          timeRemainingMs: this._remainingMsNow(session),
          timeLimitMs: session.timer.limitMs || 0,
          scoring: session.settings.scoring,
        });
        session.score += pointsAwarded;
      } else {
        session.streak = 0;
        session.wrongCount += 1;
        session.lives = Math.max(0, session.lives - 1);
      }
      session.answeredCount += 1;

      const correctAnswerText =
        (typeof question.correctAnswer === "string" && question.correctAnswer.trim())
        || (question.type === "correct_incorrect" ? (question.isCorrect ? "Correct" : "Incorrect") : "");

      const feedback = {
        accepted: true,
        correct: wasCorrect,
        questionId: question.id,
        type: question.type,
        prompt: question.prompt || null,
        text: question.text || null,
        learnerAnswer: answer,
        correctAnswer: correctAnswerText, // revealed only now, after submission
        correction: question.correction || null,
        explanation: question.explanation || null,
        pointsAwarded,
        score: session.score,
        previousScore,
        streak: session.streak,
        bestStreak: session.bestStreak,
        lives: session.lives,
        maxLives: session.maxLives,
        answeredQuestions: session.answeredCount,
        totalQuestions: session.totalQuestions,
        isFinalQuestion: session.answeredCount >= session.totalQuestions,
        levelId: session.levelId,
        challengeId: session.challengeId,
      };

      session.review.push({
        questionId: question.id,
        type: question.type,
        prompt: question.prompt || null,
        text: question.text || null,
        learnerAnswer: answer,
        correct: wasCorrect,
        correctAnswer: correctAnswerText,
        correction: question.correction || null,
        explanation: question.explanation || null,
        pointsAwarded,
        answeredAt: now(),
      });

      this.emit(EVENTS.ANSWER_SUBMITTED, feedback);
      if (wasCorrect) {
        this.emit(EVENTS.ANSWER_CORRECT, {
          questionId: question.id,
          pointsAwarded,
          score: session.score,
          streak: session.streak,
          explanation: question.explanation || null,
        });
        this.emit(EVENTS.SCORE_CHANGED, { score: session.score, delta: pointsAwarded, previousScore });
        this.emit(EVENTS.STREAK_CHANGED, { streak: session.streak, bestStreak: session.bestStreak });
      } else {
        this.emit(EVENTS.ANSWER_WRONG, {
          questionId: question.id,
          lives: session.lives,
          maxLives: session.maxLives,
          livesLost: 1,
          streak: session.streak,
          learnerAnswer: answer,
          correctAnswer: correctAnswerText,
          correction: question.correction || null,
          explanation: question.explanation || null,
        });
        this.emit(EVENTS.LIVES_CHANGED, { lives: session.lives, maxLives: session.maxLives, lost: true });
        this.emit(EVENTS.STREAK_CHANGED, { streak: session.streak, bestStreak: session.bestStreak });
      }

      // Losing the last life ends the challenge immediately (spec); running
      // out of questions is ended by nextQuestion()/auto-advance so the UI
      // keeps control of the post-answer transition.
      if (session.lives === 0 && !wasCorrect) {
        this._finishChallenge("no_lives");
        return feedback;
      }

      // In auto-advance mode every answered question schedules the step —
      // including the last one, because nextQuestion() then finishes the
      // challenge. Without the timer, the UI calls nextQuestion() itself.
      const autoAdvanceMs = Number(session.settings.autoAdvanceMs) || 0;
      if (autoAdvanceMs > 0 && !session.finished) {
        this._scheduleAdvance(autoAdvanceMs);
      }
      return feedback;
    }

    /** Move to the next question; ends the challenge when the last question
     *  has been answered. Rejected while the current question is unanswered. */
    nextQuestion() {
      if (this._status !== STATUS.PLAYING || !this._session) {
        return { advanced: false, reason: 'no active question flow (status is "' + this._status + '")' };
      }
      const session = this._session;
      if (session.finished || session.finishing) {
        return { advanced: false, reason: "this challenge has already ended" };
      }
      if (session.advanceTimeout) {
        clearTimeout(session.advanceTimeout);
        session.advanceTimeout = null;
      }
      if (!session.locked) {
        return { advanced: false, reason: "answer the current question first" };
      }
      if (session.currentIndex + 1 >= session.totalQuestions) {
        const result = this._finishChallenge("completed");
        return { advanced: false, finished: true, result: this._publicResult(result) };
      }
      session.currentIndex += 1;
      session.locked = false;
      this.emit(EVENTS.QUESTION_CHANGED, this._questionChangedPayload());
      return { advanced: true };
    }

    /** UI-coordinated transition: advance after delayMs (cancels a previous
     *  pending advance). Use this when showing post-answer feedback. */
    advanceQuestion(delayMs = 0) {
      if (!this._session) return { advanced: false, reason: "no active challenge" };
      const delay = Math.max(0, Number(delayMs) || 0);
      if (delay === 0) return this.nextQuestion();
      this._scheduleAdvance(delay);
      return { scheduled: true, delayMs: delay };
    }

    _scheduleAdvance(delayMs) {
      const session = this._session;
      if (!session || session.finished) return;
      if (session.advanceTimeout) clearTimeout(session.advanceTimeout);
      session.advanceTimeout = setTimeout(() => {
        if (!this._session || this._session !== session) return;
        session.advanceTimeout = null;
        this.nextQuestion();
      }, delayMs);
    }

    /* -------------------------------------------------------------- *
     * 8.8 Challenge completion
     * -------------------------------------------------------------- */

    _publicResult(result) {
      return result ? deepClone(result) : null;
    }

    // Result without the review array — used inside getPublicState() so the
    // per-frame HUD payload stays lean and never carries answer data that
    // belongs to the post-challenge review screen.
    _resultSummary(result) {
      if (!result) return null;
      const summary = deepClone(result);
      delete summary.review;
      return summary;
    }

    // Single exit point for every end-of-challenge path (all questions done,
    // lives out, time out). The finishing/finished flags make it idempotent.
    _finishChallenge(reason) {
      const session = this._session;
      if (!session || session.finished || session.finishing) return null;
      session.finishing = true;
      this._clearTimers(session);
      session.finished = true;
      session.finishReason = reason;

      if (this._status === STATUS.PLAYING && session.playClock.lastResumeAt !== null) {
        session.playClock.accumulatedMs += now() - session.playClock.lastResumeAt;
        session.playClock.lastResumeAt = null;
      }

      const total = session.totalQuestions;
      const correct = session.correctCount;
      // Accuracy counts unanswered required questions against the learner:
      // answering 2/2 then timing out with 8 left is 20%, never 100%.
      const accuracy = toPercent(correct, total);
      const passingPercentage = Number(session.settings.passingPercentage);
      const passed = accuracy >= passingPercentage;
      const stars = passed ? calculateStars(accuracy, session.settings) : 0;

      let score = session.score;
      let completionBonus = 0;
      if (passed && reason === "completed") {
        completionBonus = calculateCompletionBonus({
          livesRemaining: session.lives,
          maxLives: session.maxLives,
          accuracy,
          scoring: session.settings.scoring,
        });
        score += completionBonus;
      }

      const result = {
        levelId: session.levelId,
        levelTitle: session.levelTitle,
        challengeId: session.challengeId,
        challengeTitle: session.challengeTitle,
        challengeType: session.challengeType,
        difficulty: session.difficulty,
        passed,
        accuracy: round1(accuracy),
        passingPercentage,
        correctCount: correct,
        wrongCount: session.wrongCount,
        answeredQuestions: session.answeredCount,
        unansweredCount: Math.max(0, total - session.answeredCount),
        totalQuestions: total,
        score,
        baseScore: session.score,
        completionBonus,
        stars,
        maxStars: Math.max(0, Math.floor(Number(session.settings.maxStars) || 0)),
        starThresholds: deepClone(session.settings.starThresholds || null),
        livesRemaining: session.lives,
        maxLives: session.maxLives,
        bestStreak: session.bestStreak,
        elapsedMs: Math.max(0, Math.round(session.playClock.accumulatedMs)),
        remainingMs: session.timer.enabled ? Math.max(0, Math.round(session.timer.remainingMs)) : null,
        timeLimitSeconds: session.timer.enabled ? session.timer.limitMs / 1000 : null,
        reason,
        review: session.review.slice(),
        completedAt: now(),
      };
      this._lastResult = result;
      this._setStatus(passed ? STATUS.COMPLETED : STATUS.FAILED);

      const unlockedEvents = this._recordAttempt(result);

      if (passed) this.emit(EVENTS.CHALLENGE_PASSED, this._publicResult(result));
      else this.emit(EVENTS.CHALLENGE_FAILED, this._publicResult(result));
      this.emit(EVENTS.CHALLENGE_FINISHED, this._publicResult(result));
      unlockedEvents.forEach((e) => this.emit(e.name, e.payload));
      this.emit(EVENTS.PROGRESS_CHANGED, this.getOverallProgress());
      return result;
    }

    // Merges the attempt into stored progress (best values only — a worse
    // replay never overwrites a better result) and derives unlock events.
    _recordAttempt(result) {
      const levelKey = String(result.levelId);
      const challengeKey = String(result.challengeId);
      if (!this._progress.levels[levelKey]) this._progress.levels[levelKey] = { challenges: {} };
      const bucket = this._progress.levels[levelKey];
      const prev = bucket.challenges[challengeKey] || {
        attempts: 0, completed: false, bestScore: 0, bestAccuracy: 0, highestStars: 0, bestStreak: 0, completedAt: null,
      };
      bucket.challenges[challengeKey] = {
        attempts: prev.attempts + 1,
        completed: prev.completed || result.passed,
        bestScore: Math.max(prev.bestScore, result.score),
        bestAccuracy: Math.max(prev.bestAccuracy, result.accuracy),
        highestStars: Math.max(prev.highestStars, result.stars),
        bestStreak: Math.max(prev.bestStreak, result.bestStreak),
        completedAt: result.passed ? (prev.completedAt || result.completedAt) : prev.completedAt,
      };
      this._saveProgressToStorage();

      const events = [];
      if (result.passed) {
        const found = this._findChallenge(result.levelId, result.challengeId);
        if (found) {
          const nextChallenge = found.level.challenges[found.challengeIndex + 1];
          if (nextChallenge) {
            events.push({
              name: EVENTS.CHALLENGE_UNLOCKED,
              payload: {
                levelId: found.level.id,
                levelTitle: found.level.title,
                challengeId: nextChallenge.id,
                challengeTitle: nextChallenge.title,
              },
            });
          } else {
            const nextLevelEntry = this._levels[found.levelIndex + 1];
            if (nextLevelEntry) {
              events.push({
                name: EVENTS.LEVEL_UNLOCKED,
                payload: {
                  levelId: nextLevelEntry.level.id,
                  levelTitle: nextLevelEntry.level.title,
                },
              });
            } else {
              // Last challenge of the last loaded level — game complete,
              // never an attempt to unlock a nonexistent next level.
              events.push({ name: EVENTS.GAME_COMPLETED, payload: this.getOverallProgress() });
            }
          }
        }
      }
      return events;
    }

    /* -------------------------------------------------------------- *
     * 8.9 Progress persistence
     * -------------------------------------------------------------- */

    async _loadProgressFromStorage() {
      let raw = null;
      try {
        raw = await this._storageAdapter.load(this._storageKey);
      } catch (err) {
        console.warn("[GrammarQuest] loading progress failed:", err && err.message);
      }
      if (raw === null || raw === undefined) {
        this._progress = freshProgress();
        return;
      }
      let parsed = raw;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          console.warn("[GrammarQuest] stored progress is corrupted — starting fresh");
          if (typeof this._storageAdapter.remove === "function") {
            try { this._storageAdapter.remove(this._storageKey); } catch (err2) { /* ignore */ }
          }
          this._progress = freshProgress();
          return;
        }
      }
      this._progress = sanitizeProgress(parsed);
    }

    _saveProgressToStorage() {
      this._progress.updatedAt = now();
      try {
        const outcome = this._storageAdapter.save(this._storageKey, JSON.stringify(this._progress));
        if (outcome && typeof outcome.catch === "function") {
          outcome.catch((err) => console.warn("[GrammarQuest] saving progress failed:", err && err.message));
        }
      } catch (err) {
        console.warn("[GrammarQuest] saving progress failed:", err && err.message);
      }
    }

    /** Re-read progress from the adapter (e.g. after an external change). */
    async loadProgress() {
      await this._loadProgressFromStorage();
      this.emit(EVENTS.PROGRESS_CHANGED, this.getOverallProgress());
      return this.getOverallProgress();
    }

    /** Force a progress save (the engine also saves after every attempt). */
    saveProgress() {
      this._saveProgressToStorage();
      return this.getOverallProgress();
    }

    /** Swap the persistence backend (localStorage → API adapter later). */
    setStorageAdapter(adapter) {
      this._storageAdapter = adapter;
      return this.loadProgress();
    }

    /** Wipe all learner progress and return to the initial state. */
    resetProgress() {
      if (this._session && (this._status === STATUS.PLAYING || this._status === STATUS.PAUSED)) {
        this.abortChallenge();
      }
      this._progress = freshProgress();
      this._announcedLevels.clear();
      try {
        this._storageAdapter.remove(this._storageKey);
      } catch (err) {
        console.warn("[GrammarQuest] removing stored progress failed:", err && err.message);
      }
      const overall = this.getOverallProgress();
      this.emit(EVENTS.PROGRESS_RESET, overall);
      this.emit(EVENTS.PROGRESS_CHANGED, overall);
      return overall;
    }

    /* -------------------------------------------------------------- *
     * 8.10 Read-only API for the UI (clones only, no answer leakage)
     * -------------------------------------------------------------- */

    getGameInfo() {
      const game = (this._data && this._data.game) || {};
      return {
        title: game.title || "Grammar Quest",
        id: game.id || null,
        declaredTotalLevels: Number.isFinite(Number(game.totalLevels)) ? Number(game.totalLevels) : null,
        levelsLoaded: this._levels.length,
        challengesLoaded: this._levels.reduce((sum, e) => sum + (e.level.challenges || []).length, 0),
        defaultSettings: deepClone(game.defaultSettings || null),
        engineVersion: ENGINE_VERSION,
        progressVersion: PROGRESS_VERSION,
      };
    }

    getLevels() {
      return this._levels.map(({ level }) => this._levelSummary(level));
    }

    getLevel(levelId) {
      const entry = this._findLevel(levelId);
      return entry ? this._levelSummary(entry.level) : null;
    }

    _levelSummary(level) {
      const challenges = (level.challenges || []).map((challenge) => {
        const rec = getStoredChallenge(this._progress, String(level.id), String(challenge.id));
        return {
          id: challenge.id,
          title: challenge.title,
          type: challenge.type || null,
          difficulty: challenge.difficulty || null,
          questionCount: (challenge.questions || []).length,
          unlocked: this.isChallengeUnlocked(level.id, challenge.id),
          ...(rec ? deepClone(rec) : { attempts: 0, completed: false, bestScore: 0, bestAccuracy: 0, highestStars: 0, bestStreak: 0, completedAt: null }),
        };
      });
      const completedChallenges = challenges.filter((c) => c.completed).length;
      return {
        id: level.id,
        title: level.title,
        grammarTopic: level.grammarTopic || null,
        description: level.description || null,
        difficulty: level.difficulty || null,
        unlocked: this.isLevelUnlocked(level.id),
        completed: challenges.length > 0 && completedChallenges === challenges.length,
        totalChallenges: challenges.length,
        completedChallenges,
        challenges,
      };
    }

    /** Challenge metadata + progress. Deliberately contains no questions. */
    getChallenge(levelId, challengeId) {
      const found = this._findChallenge(levelId, challengeId);
      if (!found) return null;
      const rec = getStoredChallenge(this._progress, String(found.level.id), String(found.challenge.id));
      return {
        levelId: found.level.id,
        levelTitle: found.level.title,
        challengeId: found.challenge.id,
        title: found.challenge.title,
        type: found.challenge.type || null,
        difficulty: found.challenge.difficulty || null,
        questionCount: (found.challenge.questions || []).length,
        unlocked: this.isChallengeUnlocked(levelId, challengeId),
        ...(rec ? deepClone(rec) : { attempts: 0, completed: false, bestScore: 0, bestAccuracy: 0, highestStars: 0, bestStreak: 0, completedAt: null }),
      };
    }

    /** Current question WITHOUT correct answers (safe to hand to a renderer). */
    getCurrentQuestion() {
      if (!this._session || this._session.finished) return null;
      const question = this._session.questions[this._session.currentIndex];
      return question ? this._publicQuestion(question) : null;
    }

    /** Snapshot of everything a HUD needs. Live accuracy here is the accuracy
     *  of answered questions only; final accuracy comes from the result. */
    getPublicState() {
      const session = this._session;
      if (!session) {
        return {
          status: this._status,
          game: { title: this.getGameInfo().title },
          level: null,
          challenge: null,
          question: null,
          score: 0, lives: 0, maxLives: 0, streak: 0, bestStreak: 0,
          correctCount: 0, wrongCount: 0, answeredCount: 0, totalQuestions: 0,
          answeredAccuracy: null,
          timer: { enabled: false, running: false, totalSeconds: null, remainingSeconds: null },
          lastResult: this._resultSummary(this._lastResult),
        };
      }
      const remainingMs = this._remainingMsNow(session);
      return {
        status: this._status,
        game: { title: this.getGameInfo().title },
        level: { id: session.levelId, title: session.levelTitle },
        challenge: {
          id: session.challengeId,
          title: session.challengeTitle,
          type: session.challengeType,
          passingPercentage: Number(session.settings.passingPercentage),
        },
        question: {
          number: session.currentIndex + 1,
          total: session.totalQuestions,
          locked: session.locked,
          answered: session.locked,
        },
        score: session.score,
        lives: session.lives,
        maxLives: session.maxLives,
        streak: session.streak,
        bestStreak: session.bestStreak,
        correctCount: session.correctCount,
        wrongCount: session.wrongCount,
        answeredCount: session.answeredCount,
        totalQuestions: session.totalQuestions,
        answeredAccuracy: session.answeredCount > 0 ? round1(toPercent(session.correctCount, session.answeredCount)) : null,
        timer: {
          enabled: session.timer.enabled,
          running: session.timer.running,
          totalSeconds: session.timer.enabled ? Math.round(session.timer.limitMs / 1000) : null,
          remainingSeconds: session.timer.enabled ? Math.ceil(remainingMs / 1000) : null,
        },
        lastResult: this._resultSummary(this._lastResult),
      };
    }

    getLevelProgress(levelId) {
      const summary = this.getLevel(levelId);
      if (!summary) return null;
      let stars = 0;
      let maxStars = 0;
      const challenges = {};
      this._findLevel(levelId).level.challenges.forEach((challenge) => {
        const rec = getStoredChallenge(this._progress, String(levelId), String(challenge.id));
        const settings = this._mergeSettings(challenge);
        maxStars += Math.max(0, Math.floor(Number(settings.maxStars) || 0));
        if (rec && rec.completed) stars += rec.highestStars;
        challenges[String(challenge.id)] = rec
          ? deepClone(rec)
          : { attempts: 0, completed: false, bestScore: 0, bestAccuracy: 0, highestStars: 0, bestStreak: 0, completedAt: null };
      });
      return {
        levelId,
        title: summary.title,
        unlocked: summary.unlocked,
        completed: summary.completed,
        totalChallenges: summary.totalChallenges,
        completedChallenges: summary.completedChallenges,
        stars,
        maxStars,
        challenges,
      };
    }

    getChallengeProgress(levelId, challengeId) {
      const rec = getStoredChallenge(this._progress, String(levelId), String(challengeId));
      return rec
        ? deepClone(rec)
        : { attempts: 0, completed: false, bestScore: 0, bestAccuracy: 0, highestStars: 0, bestStreak: 0, completedAt: null };
    }

    /** First unlocked-and-not-yet-passed challenge in content order, or null
     *  when everything loaded has been completed. */
    getNextUnlockedActivity() {
      for (const { level } of this._levels) {
        for (const challenge of level.challenges) {
          if (this.isChallengeUnlocked(level.id, challenge.id) && !this._isChallengePassedInStore(level.id, challenge.id)) {
            return {
              levelId: level.id,
              levelTitle: level.title,
              challengeId: challenge.id,
              challengeTitle: challenge.title,
              isNextLevel: level.challenges.indexOf(challenge) === 0,
            };
          }
        }
      }
      return null;
    }

    getOverallProgress() {
      let totalChallenges = 0;
      let completedChallenges = 0;
      let totalStars = 0;
      let maxTotalStars = 0;
      let completedLevels = 0;
      this._levels.forEach(({ level }) => {
        const challenges = level.challenges || [];
        let levelComplete = challenges.length > 0;
        challenges.forEach((challenge) => {
          const settings = this._mergeSettings(challenge);
          maxTotalStars += Math.max(0, Math.floor(Number(settings.maxStars) || 0));
          const rec = getStoredChallenge(this._progress, String(level.id), String(challenge.id));
          if (rec && rec.completed) {
            completedChallenges += 1;
            totalStars += rec.highestStars;
          } else {
            levelComplete = false;
          }
        });
        if (levelComplete) completedLevels += 1;
        totalChallenges += challenges.length;
      });
      return {
        totalLevels: this._levels.length,
        completedLevels,
        totalChallenges,
        completedChallenges,
        completionPercent: round1(toPercent(completedChallenges, totalChallenges)),
        totalStars,
        maxTotalStars,
        gameCompleted: totalChallenges > 0 && completedChallenges === totalChallenges,
      };
    }

    /** Lightweight per-question review of the last attempt (memory only —
     *  deliberately not persisted to keep stored progress small). */
    getAttemptReview() {
      if (this._session) return deepClone(this._session.review);
      return this._lastResult ? deepClone(this._lastResult.review) : [];
    }

    getLastResult() {
      return this._publicResult(this._lastResult);
    }

    /** Validate any questions.json document against the engine's rules. */
    validateData(data) {
      return validateGameData(data, new Set(answerCheckers.keys()));
    }
  }

  /* ======================================================================
   * 9. Export
   * ====================================================================== */

  const defaultEngine = new GrammarQuestEngine();
  root.grammarQuest = defaultEngine;

  // Node/CommonJS export for the test harness and future tooling. In the
  // browser the engine stays available as window.grammarQuest.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      engine: defaultEngine,
      GrammarQuestEngine,
      EventBus,
      checkAnswer,
      calculateStars,
      calculateAnswerScore,
      calculateCompletionBonus,
      validateGameData,
      createMemoryAdapter,
      createLocalStorageAdapter,
      EVENTS,
      STATUS,
      ENGINE_DEFAULTS,
    };
  }

  console.log("Grammar Quest: game.js loaded successfully.");
})(typeof window !== "undefined" ? window : globalThis);
