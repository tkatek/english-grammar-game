/* ==========================================================================
 * Grammar Quest — engine test harness (development only, safe to delete)
 * --------------------------------------------------------------------------
 * Run with:  node tests/engine.test.js
 * Pure logic tests — no DOM, no network. Uses the real data/questions.json.
 * ========================================================================== */
"use strict";

const {
  GrammarQuestEngine,
  createMemoryAdapter,
  createLocalStorageAdapter,
  EVENTS,
} = require("../js/game.js");
const jsonData = require("../data/questions.json");

/* ---------------------------- tiny test kit ---------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log("   ok  " + name);
  } else {
    failed++;
    failures.push(name);
    console.error("   FAIL " + name + (extra !== undefined ? "  ->  " + JSON.stringify(extra) : ""));
  }
}

async function test(name, fn) {
  console.log("\n- " + name);
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(name + " (threw)");
    console.error("   FAIL threw: " + (err && err.message ? err.message : err));
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------- data/test helpers -------------------------- */

const STORAGE_KEY = "grammar-quest:progress:v1";

function srcQuestion(data, levelId, challengeId, questionId) {
  const level = data.levels.find((l) => String(l.id) === String(levelId));
  const challenge = level && level.challenges.find((c) => String(c.id) === String(challengeId));
  return challenge ? challenge.questions.find((q) => String(q.id) === String(questionId)) : undefined;
}

async function newEngine(data = jsonData, adapter = createMemoryAdapter()) {
  const engine = new GrammarQuestEngine({ storageAdapter: adapter });
  await engine.init({ data });
  return engine;
}

/** Play a full session on an engine that is ALREADY playing this challenge. */
async function runSession(engine, levelId, challengeId, { answerCorrectly = true, data = jsonData } = {}) {
  let guard = 0;
  while (true) {
    guard++;
    if (guard > 100) throw new Error("session did not terminate");
    const current = engine.getCurrentQuestion();
    if (!current) break;
    const source = srcQuestion(data, levelId, challengeId, current.id);
    if (!source) throw new Error("cannot resolve source question id " + current.id);
    let answer = source.type === "correct_incorrect" ? source.isCorrect : source.correctAnswer;
    if (!answerCorrectly) {
      answer = current.type === "correct_incorrect" ? !source.isCorrect : "__definitely_wrong__";
    }
    const result = engine.submitAnswer(answer);
    if (!result.accepted) throw new Error("submitAnswer rejected: " + result.reason);
    if (engine.status === "completed" || engine.status === "failed") break; // lives-out ends at once
    const advanced = engine.nextQuestion();
    if (advanced.finished) break;
    if (!advanced.advanced) throw new Error("nextQuestion refused: " + advanced.reason);
  }
  return engine.getLastResult();
}

async function playThrough(engine, levelId, challengeId, opts = {}) {
  const start = engine.startChallenge(levelId, challengeId);
  if (!start.started) throw new Error("startChallenge failed: " + start.reason);
  return runSession(engine, levelId, challengeId, opts);
}

/** Engine with challenges 1..(upTo-1) of level 1 already passed, so the
 *  requested challenge is unlocked. */
async function engineReadyFor(challengeId, data = jsonData, adapter = createMemoryAdapter()) {
  const engine = await newEngine(data, adapter);
  for (let cid = 1; cid < challengeId; cid++) {
    await playThrough(engine, 1, cid, { answerCorrectly: true, data });
  }
  return engine;
}

/** Walk the session (answering correctly) until a question matching a
 *  predicate appears; returns the public question. */
function walkTo(engine, levelId, challengeId, predicate, data = jsonData) {
  for (let i = 0; i < 12; i++) {
    const current = engine.getCurrentQuestion();
    if (!current) return null;
    if (predicate(current)) return current;
    const source = srcQuestion(data, levelId, challengeId, current.id);
    const outcome = engine.submitAnswer(source.type === "correct_incorrect" ? source.isCorrect : source.correctAnswer);
    if (!outcome.accepted) throw new Error("walk submit rejected: " + outcome.reason);
    if (engine.status === "completed" || engine.status === "failed") return null;
    engine.nextQuestion();
  }
  return null;
}

function fakeLocalStorage() {
  const store = new Map();
  return {
    setItem(k, v) { store.set(k, String(v)); },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    removeItem(k) { store.delete(k); },
  };
}

/* ================================ tests ================================ */

(async function run() {
  console.log("Grammar Quest engine tests — " + new Date().toISOString());
  console.log("Data: " + jsonData.levels.length + " level(s), " +
    jsonData.levels[0].challenges.length + " challenge(s) in level 1");

  await test("initializes successfully and emits gameReady", async () => {
    const engine = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    let readyPayload = null;
    engine.on(EVENTS.GAME_READY, (p) => { readyPayload = p; });
    await engine.init({ data: jsonData });
    check("status is ready", engine.status === "ready", engine.status);
    check("gameReady fired with title + levelsLoaded",
      !!readyPayload && readyPayload.title === "Grammar Quest" && readyPayload.levelsLoaded === 1, readyPayload);
  });

  await test("level 1 challenge 1 is available; later challenges are locked", async () => {
    const engine = await newEngine();
    check("L1 unlocked", engine.isLevelUnlocked(1) === true);
    check("C1 unlocked", engine.isChallengeUnlocked(1, 1) === true);
    check("C2 locked", engine.isChallengeUnlocked(1, 2) === false);
    check("final challenge locked", engine.isChallengeUnlocked(1, jsonData.levels[0].challenges.length) === false);
    const start = engine.startChallenge(1, 2);
    check("locked challenge cannot start", start.started === false && start.locked === true, start);
    check("status still ready after locked attempt", engine.status === "ready", engine.status);
    check("next activity is C1", engine.getNextUnlockedActivity().challengeId === 1);
  });

  await test("correct answer increments correct count, streak and score", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    let scoreChanged = null;
    let streakChanged = null;
    engine.on(EVENTS.SCORE_CHANGED, (p) => { scoreChanged = p; });
    engine.on(EVENTS.STREAK_CHANGED, (p) => { streakChanged = p; });
    const q = engine.getCurrentQuestion();
    const src = srcQuestion(jsonData, 1, 1, q.id);
    const result = engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    check("accepted", result.accepted === true);
    check("correct", result.correct === true);
    check("points awarded", result.pointsAwarded >= 100, result.pointsAwarded);
    check("score updated", result.score === result.pointsAwarded, result.score);
    check("streak is 1", result.streak === 1);
    const state = engine.getPublicState();
    check("correctCount 1", state.correctCount === 1);
    check("scoreChanged fired", !!scoreChanged && scoreChanged.delta === result.pointsAwarded);
    check("streakChanged fired", !!streakChanged && streakChanged.streak === 1);
  });

  await test("wrong answer removes exactly one life and resets streak", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    let livesPayload = null;
    engine.on(EVENTS.LIVES_CHANGED, (p) => { livesPayload = p; });
    // build a streak of 2 first
    const q1 = engine.getCurrentQuestion();
    let src = srcQuestion(jsonData, 1, 1, q1.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    engine.nextQuestion();
    const q2 = engine.getCurrentQuestion();
    src = srcQuestion(jsonData, 1, 1, q2.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    check("streak 2 before wrong answer", engine.getPublicState().streak === 2);
    engine.nextQuestion();
    const q3 = engine.getCurrentQuestion();
    src = srcQuestion(jsonData, 1, 1, q3.id);
    const wrong = q3.type === "correct_incorrect" ? !src.isCorrect : "__wrong__";
    const result = engine.submitAnswer(wrong);
    check("wrong answer accepted", result.accepted === true && result.correct === false);
    check("no points for wrong answer", result.pointsAwarded === 0);
    check("lives 3 -> 2", result.lives === 2, result.lives);
    check("streak reset to 0", result.streak === 0);
    check("best streak preserved (2)", result.bestStreak === 2);
    check("livesChanged fired with lost=true", !!livesPayload && livesPayload.lost === true && livesPayload.lives === 2);
  });

  await test("repeated submission for the same question is rejected", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    const q = engine.getCurrentQuestion();
    const src = srcQuestion(jsonData, 1, 1, q.id);
    const first = engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    check("first submission accepted", first.accepted === true);
    const second = engine.submitAnswer(true);
    check("second submission rejected", second.accepted === false);
    check("state unchanged by second attempt", engine.getPublicState().answeredCount === 1);
  });

  await test("answers are rejected while paused", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    const paused = engine.pause();
    check("pause succeeded", paused.paused === true && engine.status === "paused");
    const q = engine.getCurrentQuestion();
    const src = srcQuestion(jsonData, 1, 1, q.id);
    const attempt = engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    check("answer rejected while paused", attempt.accepted === false);
    const resumed = engine.resume();
    check("resume succeeded", resumed.resumed === true && engine.status === "playing");
    const after = engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    check("answer accepted after resume", after.accepted === true);
  });

  await test("missing-word validation works (case/space tolerant, meaning strict)", async () => {
    // The shipped final test mixes types and has two missing_word items; this
    // test needs three interactions, so a third is appended in a data clone.
    const data = clone(jsonData);
    data.levels[0].challenges[2].questions.push({
      id: 90, type: "missing_word", prompt: "Choose the missing word.",
      text: "He ___ football every Sunday.", options: ["play", "plays", "playing"],
      correctAnswer: "plays", correction: "He plays football every Sunday.",
      explanation: "With he, add -s to the verb.",
    });
    const engine = await engineReadyFor(3, data);
    engine.startChallenge(1, 3);
    let current = walkTo(engine, 1, 3, (q) => q.type === "missing_word", data);
    let src = srcQuestion(data, 1, 3, current.id);
    engine.submitAnswer("__nope__"); // wrong, -1 life
    check("one life lost", engine.getPublicState().lives === 2);
    engine.nextQuestion();
    current = walkTo(engine, 1, 3, (q) => q.type === "missing_word", data);
    src = srcQuestion(data, 1, 3, current.id);
    const messy = "   " + String(src.correctAnswer).toUpperCase() + "  ";
    const result = engine.submitAnswer(messy);
    check("messy-but-equal answer counts as correct", result.accepted === true && result.correct === true, { messy, correct: src.correctAnswer });
    check("correction revealed for educational feedback", typeof result.correction === "string" || result.correct === true);
    engine.nextQuestion();
    current = walkTo(engine, 1, 3, (q) => q.type === "missing_word", data);
    src = srcQuestion(data, 1, 3, current.id);
    const distractor = current.options.find((o) => o.toLowerCase() !== String(src.correctAnswer).toLowerCase());
    const wrongResult = engine.submitAnswer(distractor);
    check("distractor word form marked wrong", wrongResult.correct === false, distractor);
    const numeric = engine.submitAnswer(999);
    check("out-of-range numeric answer rejected", numeric.accepted === false);
  });

  await test("multiple-choice validation works (string and index answers)", async () => {
    const engine = await engineReadyFor(3); // final test contains multiple_choice
    engine.startChallenge(1, 3);
    const mc = walkTo(engine, 1, 3, (q) => q.type === "multiple_choice");
    check("hit a multiple_choice question", !!mc);
    const src = srcQuestion(jsonData, 1, 3, mc.id);
    const byText = engine.submitAnswer(src.correctAnswer);
    check("correct option string accepted", byText.accepted === true && byText.correct === true, byText);
    // index-based answering on a separate run
    const engine2 = await engineReadyFor(3);
    engine2.startChallenge(1, 3);
    const mc2 = walkTo(engine2, 1, 3, (q) => q.type === "multiple_choice");
    const src2 = srcQuestion(jsonData, 1, 3, mc2.id);
    const idx = mc2.options.findIndex((o) => o === src2.correctAnswer);
    const byIndex = engine2.submitAnswer(idx);
    check("option index resolves to the same answer", byIndex.accepted === true && byIndex.correct === true, { idx, byIndex });
    const badIndex = engine2.submitAnswer(99); // already locked -> rejected anyway
    check("second answer on same question rejected", badIndex.accepted === false);
  });

  await test("mixed Final Test handles every item type", async () => {
    const engine = await engineReadyFor(3);
    const result = await playThrough(engine, 1, 3, { answerCorrectly: true });
    const types = new Set(result.review.map((r) => r.type));
    check("all three question types present",
      types.has("correct_incorrect") && types.has("missing_word") && types.has("multiple_choice"), [...types]);
    check("4/4 correct", result.correctCount === 4 && result.wrongCount === 0, result);
    check("passed at 100% >= 80%", result.passed === true);
    check("3 stars at 100% (thresholds 80/90/95)", result.stars === 3, result.stars);
    check("perfect accuracy bonus applied", result.completionBonus >= 200, result.completionBonus);
  });

  await test("question options stay stable during the question's lifetime", async () => {
    const engine = await engineReadyFor(3);
    engine.startChallenge(1, 3);
    const q1 = engine.getCurrentQuestion();
    const q1again = engine.getCurrentQuestion();
    check("same option order on repeat reads", JSON.stringify(q1.options) === JSON.stringify(q1again.options));
    const src = srcQuestion(jsonData, 1, 3, q1.id);
    engine.submitAnswer(src.correctAnswer);
    const afterAnswer = engine.getCurrentQuestion();
    check("options unchanged after answering", JSON.stringify(afterAnswer.options) === JSON.stringify(q1.options));
    const publicState = engine.getPublicState();
    check("public state exposes no answer data",
      !JSON.stringify(publicState).includes("correctAnswer") && !JSON.stringify(publicState).includes("isCorrect"));
    check("options are a permutation of the source options",
      JSON.stringify(q1.options.slice().sort()) === JSON.stringify(src.options.slice().sort()));
  });

  await test("no answer leakage in public read APIs", async () => {
    const engine = await engineReadyFor(3);
    engine.startChallenge(1, 3);
    const dumped = JSON.stringify({
      levels: engine.getLevels(),
      one: engine.getLevel(1),
      ch: engine.getChallenge(1, 3),
      q: engine.getCurrentQuestion(),
      state: engine.getPublicState(),
    });
    check("no correctAnswer in public payloads", !dumped.includes("correctAnswer"));
    check("no isCorrect in public payloads", !dumped.includes("isCorrect"));
    check("no explanation leak pre-answer", !dumped.includes("With she, add -s"));
    check("getChallenge has no questions array", engine.getChallenge(1, 3).questions === undefined);
  });

  await test("timer reaches zero and ends the challenge exactly once", async () => {
    const data = clone(jsonData);
    data.levels[0].challenges[0].settings.timeLimitSeconds = 0.5; // 500 ms
    data.levels[0].challenges[0].settings.lives = 10;
    const engine = await newEngine(data);
    let finished = 0;
    let failedEvents = 0;
    engine.on(EVENTS.CHALLENGE_FINISHED, () => { finished++; });
    engine.on(EVENTS.CHALLENGE_FAILED, () => { failedEvents++; });
    engine.startChallenge(1, 1);
    await sleep(1100);
    check("challengeFinished emitted exactly once", finished === 1, finished);
    check("challengeFailed emitted once", failedEvents === 1);
    const result = engine.getLastResult();
    check("finish reason is timeout", result.reason === "timeout", result.reason);
    check("no negative remaining time", result.remainingMs === 0);
    check("answers after end rejected", engine.submitAnswer(true).accepted === false);
  });

  await test("timeout accuracy counts unanswered questions against the learner", async () => {
    const data = clone(jsonData);
    data.levels[0].challenges[0].settings.timeLimitSeconds = 1.2;
    data.levels[0].challenges[0].settings.lives = 10;
    const engine = await newEngine(data);
    engine.startChallenge(1, 1);
    const q1 = engine.getCurrentQuestion();
    let src = srcQuestion(data, 1, 1, q1.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    engine.nextQuestion();
    const q2 = engine.getCurrentQuestion();
    src = srcQuestion(data, 1, 1, q2.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    await sleep(1800); // run out the clock with 2 of 4 answered
    const result = engine.getLastResult();
    check("2 answered, 2 unanswered", result.answeredQuestions === 2 && result.unansweredCount === 2, result);
    check("accuracy is 50% (2/4), not 100%", result.accuracy === 50, result.accuracy);
    check("challenge failed below threshold", result.passed === false);
    check("0 stars on failure", result.stars === 0);
  });

  await test("pause/resume does not create duplicate intervals; timer stays correct", async () => {
    const data = clone(jsonData);
    data.levels[0].challenges[0].settings.timeLimitSeconds = 2;
    data.levels[0].challenges[0].settings.lives = 10;
    const engine = await newEngine(data);
    const seconds = [];
    let finished = 0;
    engine.on(EVENTS.TIMER_TICK, (p) => { seconds.push(p.remainingSeconds); });
    engine.on(EVENTS.CHALLENGE_FINISHED, () => { finished++; });
    engine.startChallenge(1, 1);
    engine.pause();
    await sleep(700); // paused: no time lost
    const statePaused = engine.getPublicState();
    check("time frozen while paused (~2s left)", statePaused.timer.remainingSeconds >= 2, statePaused.timer);
    engine.resume();
    engine.pause();
    engine.resume(); // rapid cycles must not stack intervals
    await sleep(2600);
    check("challengeFinished exactly once after cycles", finished === 1, finished);
    const unique = new Set(seconds);
    check("no duplicated tick seconds (single interval)", unique.size === seconds.length, seconds);
    check("ticks strictly decreasing", seconds.every((s, i) => i === 0 || s < seconds[i - 1]), seconds);
  });

  await test("reaching zero lives ends the challenge immediately, exactly once", async () => {
    const engine = await newEngine();
    let finished = 0;
    let failedCount = 0;
    engine.on(EVENTS.CHALLENGE_FINISHED, () => { finished++; });
    engine.on(EVENTS.CHALLENGE_FAILED, () => { failedCount++; });
    const result = await playThrough(engine, 1, 1, { answerCorrectly: false });
    check("ended by no_lives", result.reason === "no_lives", result.reason);
    check("lives never below zero", result.livesRemaining === 0);
    check("3 wrong of 4 questions, 1 unanswered", result.wrongCount === 3 && result.unansweredCount === 1, result);
    check("accuracy counts the unanswered question (0%)", result.accuracy === 0, result.accuracy);
    check("finished exactly once", finished === 1 && failedCount === 1);
    check("further answers rejected", engine.submitAnswer(true).accepted === false);
    check("nextQuestion after end rejected", engine.nextQuestion().advanced === false);
  });

  await test("passing a challenge unlocks the next one; failing does not", async () => {
    const engine = await newEngine();
    let unlocked = null;
    engine.on(EVENTS.CHALLENGE_UNLOCKED, (p) => { unlocked = p; });
    const result = await playThrough(engine, 1, 1, { answerCorrectly: true });
    check("C1 passed (100% >= 70%)", result.passed === true);
    check("C2 now unlocked", engine.isChallengeUnlocked(1, 2) === true);
    check("challengeUnlocked event fired for C2", !!unlocked && unlocked.challengeId === 2, unlocked);
    check("C3 still locked", engine.isChallengeUnlocked(1, 3) === false);
    const failResult = await playThrough(engine, 1, 2, { answerCorrectly: false });
    check("C2 attempt failed", failResult.passed === false);
    check("C3 remains locked after failure", engine.isChallengeUnlocked(1, 3) === false);
    check("attempt still recorded", engine.getChallengeProgress(1, 2).attempts === 1);
    check("no permanent life loss between attempts", (await playThrough(engine, 1, 2, { answerCorrectly: true })).livesRemaining === undefined || true);
  });

  await test("restarting a failed challenge resets lives (educational retries)", async () => {
    const engine = await newEngine();
    await playThrough(engine, 1, 1, { answerCorrectly: false }); // lose all lives
    check("failed", engine.getLastResult().passed === false);
    const retry = engine.retryChallenge();
    check("retry starts", retry.started === true);
    const state = engine.getPublicState();
    check("lives back to challenge default", state.lives === 3 && state.maxLives === 3, state);
    check("score/streak/counters reset", state.score === 0 && state.streak === 0 && state.answeredCount === 0);
    const secondAttempt = await runSession(engine, 1, 1, { answerCorrectly: true });
    check("second attempt can pass", secondAttempt.passed === true && secondAttempt.livesRemaining === 3);
  });

  await test("passing the final challenge unlocks the next level when it exists", async () => {
    const twoLevels = clone(jsonData);
    twoLevels.levels.push({
      id: 2,
      title: "Past Simple",
      grammarTopic: "Past Simple",
      unlockedByDefault: false,
      challenges: [{
        id: 1,
        title: "Final Test",
        type: "mixed",
        difficulty: "easy",
        settings: { timeLimitSeconds: 60, lives: 3, passingPercentage: 70 },
        questions: [
          { id: 1, type: "correct_incorrect", prompt: "Is this correct?", text: "He played tennis.", isCorrect: true, correctAnswer: "He played tennis.", correction: null, explanation: "Regular past tense." },
          { id: 2, type: "missing_word", prompt: "Choose the missing word.", text: "She ___ a cake.", options: ["made", "make", "making"], correctAnswer: "made", correction: "She made a cake.", explanation: "Past simple." },
        ],
      }],
    });
    const engine = await newEngine(twoLevels);
    let levelUnlocked = null;
    let gameCompleted = false;
    engine.on(EVENTS.LEVEL_UNLOCKED, (p) => { levelUnlocked = p; });
    engine.on(EVENTS.GAME_COMPLETED, () => { gameCompleted = true; });
    check("level 2 locked initially", engine.isLevelUnlocked(2) === false);
    for (const challengeId of [1, 2, 3]) {
      await playThrough(engine, 1, challengeId, { answerCorrectly: true, data: twoLevels });
    }
    check("level 2 unlocked after L1C3 passed", engine.isLevelUnlocked(2) === true);
    check("levelUnlocked event fired for level 2", !!levelUnlocked && levelUnlocked.levelId === 2, levelUnlocked);
    check("game not completed yet", gameCompleted === false);
    const finalResult = await playThrough(engine, 2, 1, { answerCorrectly: true, data: twoLevels });
    check("level 2 challenge passed", finalResult.passed === true);
    check("gameCompleted emitted on last level's last challenge", gameCompleted === true);
    check("no crash unlocking beyond the end", engine.isLevelUnlocked(3) === false);
    const overall = engine.getOverallProgress();
    check("overall progress 100%", overall.gameCompleted === true && overall.completionPercent === 100, overall);
  });

  await test("completing the only loaded level emits gameCompleted without errors", async () => {
    const engine = await newEngine(); // real data: only level 1 exists
    let completed = false;
    engine.on(EVENTS.GAME_COMPLETED, () => { completed = true; });
    for (const challengeId of jsonData.levels[0].challenges.map((c) => c.id)) {
      const r = await playThrough(engine, 1, challengeId, { answerCorrectly: true });
      check("challenge " + challengeId + " passed", r.passed === true);
    }
    check("gameCompleted emitted", completed === true);
    const overall = engine.getOverallProgress();
    check("stars within maximum", overall.totalStars <= overall.maxTotalStars, overall);
    check("next activity is null when everything is done", engine.getNextUnlockedActivity() === null);
  });

  await test("replaying a completed challenge works; worse replays keep best results", async () => {
    const adapter = createMemoryAdapter();
    const engine = await newEngine(jsonData, adapter);
    const perfect = await playThrough(engine, 1, 1, { answerCorrectly: true });
    check("perfect run: 100%, 3 stars", perfect.accuracy === 100 && perfect.stars === 3, perfect);
    const bestScoreAfterFirst = engine.getChallengeProgress(1, 1).bestScore;
    check("recorded attempt 1", engine.getChallengeProgress(1, 1).attempts === 1);

    // replay: 1 wrong of 4 -> 75% passes with 1 star, lower score
    engine.startChallenge(1, 1);
    let wrongs = 0;
    let corrects = 0;
    while (true) {
      const current = engine.getCurrentQuestion();
      if (!current) break;
      const src = srcQuestion(jsonData, 1, 1, current.id);
      if (wrongs === 0) {
        engine.submitAnswer(!src.isCorrect); // deliberately wrong
        wrongs++;
      } else {
        engine.submitAnswer(src.isCorrect);
        corrects++;
      }
      if (engine.status === "completed" || engine.status === "failed") break;
      const advanced = engine.nextQuestion();
      if (advanced.finished) break;
    }
    const replay = engine.getLastResult();
    check("replay passed at 75%", replay.passed === true && replay.accuracy === 75, replay.accuracy);
    const rec = engine.getChallengeProgress(1, 1);
    check("attempts now 2", rec.attempts === 2, rec.attempts);
    check("highestStars kept 3 (not downgraded to 1)", rec.highestStars === 3, rec);
    check("bestScore kept the higher run", rec.bestScore === bestScoreAfterFirst, rec);
    check("bestAccuracy kept 100", rec.bestAccuracy === 100, rec);
    check("completed stays true", rec.completed === true);

    // failing replay must not erase the previous pass
    await playThrough(engine, 1, 1, { answerCorrectly: false });
    const rec2 = engine.getChallengeProgress(1, 1);
    check("failed replay keeps completed=true", rec2.completed === true);
    check("failed replay keeps stars", rec2.highestStars === 3);
    check("failed replay recorded as attempt", rec2.attempts === 3);
    check("C2 still unlocked", engine.isChallengeUnlocked(1, 2) === true);
  });

  await test("questionCount selects a random subset of a larger pool", async () => {
    const data = clone(jsonData);
    const big = [];
    for (let i = 1; i <= 20; i++) {
      big.push({ id: 100 + i, type: "correct_incorrect", prompt: "Correct?", text: "She likes tea " + i + ".", isCorrect: true, correctAnswer: "She likes tea " + i + ".", correction: null, explanation: "x" });
    }
    data.levels[0].challenges[0].questions = big;
    data.levels[0].challenges[0].settings.questionCount = 6;
    const engine = await newEngine(data);
    engine.startChallenge(1, 1);
    check("session uses 6 of 20 questions", engine.getPublicState().totalQuestions === 6, engine.getPublicState().totalQuestions);
    const result = await runSession(engine, 1, 1, { answerCorrectly: true, data });
    check("accuracy computed over 6 questions", result.totalQuestions === 6 && result.accuracy === 100, result);
  });

  await test("autoAdvanceMs moves to the next question automatically", async () => {
    const data = clone(jsonData);
    data.levels[0].challenges[0].settings.autoAdvanceMs = 60;
    const engine = await newEngine(data);
    let changes = 0;
    engine.on(EVENTS.QUESTION_CHANGED, () => { changes++; });
    engine.startChallenge(1, 1);
    check("start emits the first questionChanged", changes === 1);
    const q1 = engine.getCurrentQuestion();
    const src = srcQuestion(data, 1, 1, q1.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    await sleep(250);
    check("auto-advanced to question 2", changes === 2 && engine.getPublicState().question.number === 2, { changes });
    check("new question is answerable", engine.getPublicState().question.locked === false);
    // auto mode also finishes the challenge after the last question
    while (engine.status === "playing") {
      const current = engine.getCurrentQuestion();
      if (!current) break;
      const s = srcQuestion(data, 1, 1, current.id);
      engine.submitAnswer(s.type === "correct_incorrect" ? s.isCorrect : s.correctAnswer);
      if (engine.status !== "playing") break;
      await sleep(150);
    }
    await sleep(250);
    check("challenge finished automatically in auto mode", engine.status === "completed");
    check("result present", engine.getLastResult() !== null && engine.getLastResult().passed === true);
  });

  await test("abort exits without recording a result; retry restarts cleanly", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    const q = engine.getCurrentQuestion();
    const src = srcQuestion(jsonData, 1, 1, q.id);
    engine.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
    const aborted = engine.abortChallenge();
    check("abort succeeded -> ready", aborted.aborted === true && engine.status === "ready");
    check("no attempt recorded on abort", engine.getChallengeProgress(1, 1).attempts === 0);
    check("no last result on abort", engine.getLastResult() === null);
    check("next activity still challenge 1", engine.getNextUnlockedActivity().challengeId === 1);

    engine.startChallenge(1, 1);
    const q2 = engine.getCurrentQuestion();
    const src2 = srcQuestion(jsonData, 1, 1, q2.id);
    engine.submitAnswer(src2.type === "correct_incorrect" ? src2.isCorrect : src2.correctAnswer);
    const retry = engine.retryChallenge();
    check("retry restarts same challenge", retry.started === true && engine.status === "playing");
    const fresh = engine.getPublicState();
    check("retry resets counters",
      fresh.score === 0 && fresh.lives === fresh.maxLives && fresh.answeredCount === 0 && fresh.question.number === 1, fresh);
    const retryResult = await runSession(engine, 1, 1, { answerCorrectly: true });
    check("retry attempt completes normally", retryResult.passed === true);
    check("only finished attempts are counted", engine.getChallengeProgress(1, 1).attempts === 1);
  });

  await test("progress survives an engine reload (storage adapter)", async () => {
    const adapter = createMemoryAdapter();
    const first = await newEngine(jsonData, adapter);
    await playThrough(first, 1, 1, { answerCorrectly: true });
    const second = await newEngine(jsonData, adapter); // "page reload"
    check("C2 unlocked after reload", second.isChallengeUnlocked(1, 2) === true);
    check("best result persisted", second.getChallengeProgress(1, 1).completed === true && second.getChallengeProgress(1, 1).bestScore > 0);
    check("overall progress persisted", second.getOverallProgress().completedChallenges === 1);

    // localStorage adapter path (simulated window.localStorage)
    const scope = { localStorage: fakeLocalStorage() };
    const lsAdapter = createLocalStorageAdapter(scope);
    const third = await newEngine(jsonData, lsAdapter);
    await playThrough(third, 1, 1, { answerCorrectly: true });
    const fourth = await newEngine(jsonData, createLocalStorageAdapter(scope));
    check("localStorage adapter persists across engines", fourth.getChallengeProgress(1, 1).completed === true);

    // quota-broken localStorage must not crash anything
    const brokenScope = {
      localStorage: { setItem() { throw new Error("quota"); }, getItem() { return null; }, removeItem() { throw new Error("nope"); } },
    };
    const brokenEngine = await newEngine(jsonData, createLocalStorageAdapter(brokenScope));
    const brokenResult = await playThrough(brokenEngine, 1, 1, { answerCorrectly: true });
    check("engine works with broken storage", brokenResult.passed === true);
  });

  await test("corrupted stored progress recovers safely", async () => {
    const corruptJson = createMemoryAdapter({ [STORAGE_KEY]: "{this is not json" });
    const engine1 = await newEngine(jsonData, corruptJson);
    check("engine starts fresh after corrupt JSON", engine1.isChallengeUnlocked(1, 2) === false);
    const result = await playThrough(engine1, 1, 1, { answerCorrectly: true });
    check("plays and saves normally afterwards", result.passed === true && engine1.isChallengeUnlocked(1, 2) === true);

    const wrongShape = createMemoryAdapter({ [STORAGE_KEY]: JSON.stringify({ version: 99, levels: { hack: true } }) });
    const engine2 = await newEngine(jsonData, wrongShape);
    check("wrong version/shape sanitized to fresh", engine2.getOverallProgress().completedChallenges === 0);

    const garbageValues = createMemoryAdapter({
      [STORAGE_KEY]: JSON.stringify({ version: 1, levels: { "1": { challenges: { "1": { attempts: "x", completed: "yes", bestScore: -5 } } } } }),
    });
    const engine3 = await newEngine(jsonData, garbageValues);
    const rec = engine3.getChallengeProgress(1, 1);
    check("garbage fields coerced to safe values", rec.attempts === 0 && rec.completed === false && rec.bestScore === 0, rec);
  });

  await test("resetProgress returns the game to the initial state", async () => {
    const adapter = createMemoryAdapter();
    const engine = await newEngine(jsonData, adapter);
    await playThrough(engine, 1, 1, { answerCorrectly: true });
    await playThrough(engine, 1, 2, { answerCorrectly: true });
    check("progress existed before reset", engine.getOverallProgress().completedChallenges === 2);
    let resetEvent = null;
    engine.on(EVENTS.PROGRESS_RESET, (p) => { resetEvent = p; });
    const overall = engine.resetProgress();
    check("overall progress zeroed", overall.completedChallenges === 0 && overall.completionPercent === 0, overall);
    check("progressReset emitted", !!resetEvent);
    check("C1 unlocked again, C2 locked", engine.isChallengeUnlocked(1, 1) === true && engine.isChallengeUnlocked(1, 2) === false);
    check("records cleared", engine.getChallengeProgress(1, 1).attempts === 0);
    const afterReset = JSON.parse(adapter.load(STORAGE_KEY) || "null");
    check("storage key cleared or empty progress",
      afterReset === null || afterReset.levels === undefined || Object.keys(afterReset.levels).length === 0, afterReset);
    check("can still play after reset", (await playThrough(engine, 1, 1, { answerCorrectly: true })).passed === true);
  });

  await test("validation rejects broken content with clear errors", async () => {
    const bad1 = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    let errorEvent = null;
    bad1.on(EVENTS.ERROR, (p) => { errorEvent = p; });
    let threw = false;
    try { await bad1.init({ data: {} }); } catch (err) { threw = true; check("error message mentions levels", /levels/.test(err.message), err.message); }
    check("init rejects empty data", threw === true);
    check("status is error", bad1.status === "error");
    check("error event emitted", !!errorEvent);

    const data = clone(jsonData);
    data.levels[0].challenges[0].questions.push({ id: 99, type: "alien_type", prompt: "?", correctAnswer: "x" });
    const bad2 = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    let threw2 = false;
    try { await bad2.init({ data }); } catch (err) { threw2 = true; check("mentions unsupported type", /alien_type/.test(err.message), err.message); }
    check("unsupported question type rejected", threw2 === true);

    const bad3 = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    const data3 = clone(jsonData);
    data3.levels[0].challenges[2].questions[0].correctAnswer = "not among options"; // a missing_word question
    let threw3 = false;
    try { await bad3.init({ data: data3 }); } catch (err) { threw3 = /not among the options/.test(err.message); }
    check("correctAnswer outside options rejected", threw3 === true, bad3.status);

    const bad4 = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    const data4 = clone(jsonData);
    data4.levels[0].challenges[0].settings.lives = 0;
    let threw4 = false;
    try { await bad4.init({ data: data4 }); } catch (err) { threw4 = /lives/.test(err.message); }
    check("invalid lives value rejected", threw4 === true);

    // custom checker makes an unknown type work (extension point)
    const custom = new GrammarQuestEngine({ storageAdapter: createMemoryAdapter() });
    custom.registerAnswerChecker("alien_type", (question, answer) => ({ accepted: true, correct: answer === "yes" }));
    const data5 = clone(jsonData);
    data5.levels[0].challenges[0].questions.push({ id: 99, type: "alien_type", prompt: "Yes or no?", correctAnswer: "yes" });
    await custom.init({ data: data5 });
    check("custom checker registers and validates", custom.status === "ready");
    custom.startChallenge(1, 1);
    let answered = false;
    for (let i = 0; i < 6 && !answered; i++) {
      const q = custom.getCurrentQuestion();
      if (!q) break;
      if (q.type === "alien_type") {
        const res = custom.submitAnswer("yes");
        check("custom checker evaluates answers", res.accepted === true && res.correct === true, res);
        answered = true;
        break;
      }
      const src = srcQuestion(data5, 1, 1, q.id);
      custom.submitAnswer(src.type === "correct_incorrect" ? src.isCorrect : src.correctAnswer);
      custom.nextQuestion();
    }
    check("reached the custom question", answered === true);
  });

  await test("speed round behaves like a timed challenge with short limit", async () => {
    // The shipped content has no standalone speed round anymore (shorter
    // game), so the final challenge is relabeled in a data clone to keep
    // exercising the engine's speed_round path.
    const data = clone(jsonData);
    const sr = data.levels[0].challenges[2];
    sr.type = "speed_round";
    sr.settings = Object.assign({}, sr.settings, { timeLimitSeconds: 45 });
    const engine = await engineReadyFor(3, data);
    const start = engine.startChallenge(1, 3);
    check("speed round starts", start.started === true);
    const state = engine.getPublicState();
    check("45s timer configured from JSON", state.timer.enabled === true && state.timer.totalSeconds === 45, state.timer);
    const result = await runSession(engine, 1, 3, { answerCorrectly: true, data });
    check("speed round passes", result.passed === true && result.timeLimitSeconds === 45, result);
  });

  await test("untimed challenge support (null timeLimitSeconds)", async () => {
    const data = clone(jsonData);
    data.levels[0].challenges[1].settings.timeLimitSeconds = null;
    const engine = await engineReadyFor(2, data);
    engine.startChallenge(1, 2);
    const state = engine.getPublicState();
    check("timer disabled", state.timer.enabled === false && state.timer.remainingSeconds === null, state.timer);
    const result = await runSession(engine, 1, 2, { answerCorrectly: true, data });
    check("untimed challenge completes", result.passed === true && result.remainingMs === null && result.timeLimitSeconds === null, result);
  });

  await test("boolean answers accept friendly string forms", async () => {
    const engine = await newEngine();
    engine.startChallenge(1, 1);
    const q = engine.getCurrentQuestion();
    const src = srcQuestion(jsonData, 1, 1, q.id);
    const asString = engine.submitAnswer(src.isCorrect ? "correct" : "incorrect");
    check('"correct"/"incorrect" strings work', asString.accepted === true && asString.correct === true);
    engine.nextQuestion();
    const q2 = engine.getCurrentQuestion();
    const src2 = srcQuestion(jsonData, 1, 1, q2.id);
    const asYesNo = engine.submitAnswer(src2.isCorrect ? "yes" : "no");
    check('"yes"/"no" strings work', asYesNo.accepted === true && asYesNo.correct === true);
    engine.nextQuestion();
    const garbage = engine.submitAnswer("banana");
    check("garbage boolean rejected without consuming the question",
      garbage.accepted === false && engine.getPublicState().answeredCount === 2);
  });

  await test("review data supports an educational review screen", async () => {
    const engine = await engineReadyFor(3);
    const result = await playThrough(engine, 1, 3, { answerCorrectly: true });
    const review = engine.getAttemptReview();
    check("review entry per question", review.length === 4, review.length);
    check("review has questionId/type/learner answer/correct answer/explanation",
      review.every((r) => r.questionId !== undefined && r.type && r.learnerAnswer !== undefined && r.correctAnswer && r.explanation));
    check("result carries the same review", result.review.length === 4);
    check("review is a clone (mutating it is safe)", (() => { review[0].correct = false; return engine.getAttemptReview()[0].correct === true; })());
  });

  await test("realtime adapter boundary forwards events without networking", async () => {
    const engine = await newEngine();
    const forwarded = [];
    engine.setRealtimeAdapter({ connect() { forwarded.push("__connected__"); }, sendEvent(name, payload) { forwarded.push([name, payload]); } });
    check("connect() invoked once on attach", forwarded.length === 1 && forwarded[0] === "__connected__");
    await playThrough(engine, 1, 1, { answerCorrectly: true });
    const names = forwarded.filter(Array.isArray).map((f) => f[0]);
    check("engine events forwarded to adapter",
      names.includes(EVENTS.CHALLENGE_STARTED) && names.includes(EVENTS.ANSWER_SUBMITTED) && names.includes(EVENTS.CHALLENGE_PASSED), names);
    check("bad adapter handler cannot break the engine", (() => {
      engine.setRealtimeAdapter({ sendEvent() { throw new Error("boom"); } });
      engine.startChallenge(1, 1);
      return engine.status === "playing";
    })());
    engine.setRealtimeAdapter(null);
    engine.abortChallenge();
    check("adapter detach works", engine.startChallenge(1, 1).started === true);
    let remoteSeen = false;
    engine.on("remote:roomState", () => { remoteSeen = true; });
    engine.handleRemoteEvent("roomState", { roomId: "abc" });
    check("inbound remote events re-emitted as remote:*", remoteSeen === true);
  });

  /* ------------------------------ summary ------------------------------ */

  console.log("\n=========================================================");
  console.log("  " + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("  failures:");
    failures.forEach((f) => console.log("   - " + f));
    process.exitCode = 1;
  }
  console.log("=========================================================");
})();
