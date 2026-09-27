/* ==========================================================================
 * Grammar Quest — central audio manager (SFX only, no music)
 * --------------------------------------------------------------------------
 * One module owns every sound: loading, volume, playback, platform control.
 * ui.js only ever calls grammarQuestAudio.play("<name>") — no scattered
 * Audio objects anywhere else.
 *
 * Design rules (production):
 *  - Sound is an ENHANCEMENT: any failure (missing file, decode error,
 *    autoplay block) logs a console.warn and the game continues untouched.
 *  - No visible sound UI. The Boston English Center platform owns global
 *    audio preferences; this module exposes programmatic hooks only:
 *      grammarQuestAudio.setEnabled(false)   // platform mutes the game
 *      grammarQuestAudio.setMasterVolume(0.5)
 *  - Autoplay policy: nothing plays before the learner's first real
 *    interaction. A one-time pointerdown/keydown unlocks the Audio
 *    elements (required on iOS), with no "click to enable sound" popup.
 *  - Long preview tails are soft-stopped via maxMs (volume ramp + pause),
 *    keeping each cue inside its role length without re-encoding files.
 *  - Overlapping playback uses lightweight clones of the preloaded
 *    elements (cheap, keeps decodes warm); clones are GC'd on "ended".
 *  - Sounds respect hidden tabs: active clones pause on visibilitychange
 *    and nothing replays stale queues on return.
 *
 * All files are Mixkit MP3s under the Mixkit Sound Effects Free License
 * (commercial use allowed, no attribution required) — see
 * assets/sounds/LICENSES.md for per-file provenance.
 * ========================================================================== */
(function () {
  "use strict";

  /* name -> file, volume, soft-stop cap.
   * Volumes are RMS-calibrated (measured via AudioContext decode) so cues
   * share a consistent perceived loudness; maxMs trims preview tails. */
  var SOUNDS = {
    uiClick:           { file: "ui-click.mp3",           vol: 0.30, maxMs: 300 },
    targetPop:         { file: "target-pop.mp3",         vol: 0.30, maxMs: 0 },
    hammerSwing:       { file: "hammer-swing.mp3",       vol: 0.38, maxMs: 450 },
    hammerImpact:      { file: "hammer-impact.mp3",      vol: 0.42, maxMs: 650 },
    answerCorrect:     { file: "answer-correct.mp3",     vol: 0.45, maxMs: 1500 },
    answerWrong:       { file: "answer-wrong.mp3",       vol: 0.28, maxMs: 1500 },
    streak:            { file: "streak.mp3",             vol: 0.42, maxMs: 0 },
    heartLost:         { file: "heart-lost.mp3",         vol: 0.27, maxMs: 900 },
    timerWarning:      { file: "timer-warning.mp3",      vol: 0.50, maxMs: 850 },
    challengeStart:    { file: "challenge-start.mp3",    vol: 0.40, maxMs: 1200 },
    challengeComplete: { file: "challenge-complete.mp3", vol: 0.46, maxMs: 2200 },
    challengeFailed:   { file: "challenge-failed.mp3",   vol: 0.32, maxMs: 1800 },
    starEarned:        { file: "star-earned.mp3",        vol: 0.34, maxMs: 1400 },
    levelUnlock:       { file: "level-unlock.mp3",       vol: 0.48, maxMs: 1600 },
    levelComplete:     { file: "level-complete.mp3",     vol: 0.46, maxMs: 2400 },
  };

  var BASE = "assets/sounds/";
  var masterVolume = 1;
  var enabled = true; // platform can flip this later; no UI touches it
  var unlocked = false;
  var store = {};      // name -> { audio, ready, failed }
  var active = new Set(); // currently playing clones

  function warnOnce(name, msg) {
    if (!store[name] || !store[name].warned) {
      if (store[name]) store[name].warned = true;
      console.warn("[GrammarQuest audio] " + name + ": " + msg);
    }
  }

  function preload(names) {
    (names || Object.keys(SOUNDS)).forEach(function (name) {
      if (store[name]) return;
      var def = SOUNDS[name];
      var entry = { ready: false, failed: false, warned: false };
      try {
        var audio = new Audio(BASE + def.file);
        audio.preload = "auto";
        audio.addEventListener("canplaythrough", function () { entry.ready = true; });
        audio.addEventListener("error", function () {
          entry.failed = true;
          warnOnce(name, "file missing or undecodable — sound stays silent");
        });
        entry.audio = audio;
        // Kick the load explicitly (some browsers are lazy without it).
        audio.load();
      } catch (err) {
        entry.failed = true;
        warnOnce(name, "Audio() unavailable: " + err.message);
      }
      store[name] = entry;
    });
  }

  /* iOS/Safari unlock: Audio elements must play once inside a real user
   * gesture before later programmatic plays are allowed. We play each
   * preloaded element muted for a few milliseconds, then reset it. */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    Object.keys(store).forEach(function (name) {
      var a = store[name].audio;
      if (!a) return;
      try {
        var v = a.volume;
        a.muted = true;
        var p = a.play();
        if (p && p.then) {
          p.then(function () {
            a.pause();
            a.currentTime = 0;
            a.muted = false;
            a.volume = v;
          }).catch(function () { a.muted = false; });
        } else {
          a.pause();
          a.muted = false;
        }
      } catch (err) { /* unlock is best-effort */ }
    });
  }

  /* Soft-stop: ramp the clone's volume to zero, then pause and reset.
   * Keeps long preview tails inside their role length without clicks. */
  function softStop(clone) {
    var start = null;
    function ramp(ts) {
      if (!start) start = ts;
      var k = 1 - Math.min(1, (ts - start) / 90);
      try { clone.volume = Math.max(0, clone.volume * k); } catch (err) { return; }
      if (k > 0) requestAnimationFrame(ramp);
      else { try { clone.pause(); } catch (err) {} }
    }
    requestAnimationFrame(ramp);
  }

  /* opts: { volume: 0..1 override, delay: ms before playing } */
  function play(name, opts) {
    if (!enabled) return;
    var def = SOUNDS[name];
    if (!def) { console.warn("[GrammarQuest audio] unknown sound: " + name); return; }
    if (!store[name]) preload([name]);
    var entry = store[name];
    if (entry.failed) return;            // graceful: stay silent forever
    if (!entry.ready && !unlocked) return; // not warmed yet — skip quietly
    var when = function () {
      try {
        var clone = entry.audio.cloneNode(true);
        clone.volume = Math.min(1, (opts && opts.volume !== undefined ? opts.volume : def.vol) * masterVolume);
        active.add(clone);
        var done = function () { active.delete(clone); };
        clone.addEventListener("ended", done);
        clone.addEventListener("error", done);
        var p = clone.play();
        if (p && p.catch) p.catch(function () { done(); /* autoplay block: ignore */ });
        if (def.maxMs > 0) {
          setTimeout(function () {
            if (!clone.paused) { softStop(clone); }
            setTimeout(done, 200);
          }, def.maxMs);
        }
      } catch (err) {
        warnOnce(name, "playback failed: " + err.message);
      }
    };
    if (opts && opts.delay > 0) setTimeout(when, opts.delay);
    else when();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      active.forEach(function (c) { try { c.pause(); } catch (err) {} });
      active.clear();
    }
  }

  function setMasterVolume(v) {
    masterVolume = Math.min(1, Math.max(0, Number(v) || 0));
  }

  // Pause everything when the tab hides; nothing replays on return.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      active.forEach(function (c) { try { c.pause(); } catch (err) {} });
      active.clear();
    }
  });

  // Unlock on the first genuine interaction (no popup, no auto-play).
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("keydown", unlock, { once: true });

  window.grammarQuestAudio = {
    preload: preload,
    play: play,
    setEnabled: setEnabled,
    setMasterVolume: setMasterVolume,
    get enabled() { return enabled; },
  };
})();
