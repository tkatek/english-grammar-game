/* ==========================================================================
 * Grammar Quest — tap-to-hear pronunciation (Web Speech API)
 * --------------------------------------------------------------------------
 * Speaks sentences with the browser's built-in speechSynthesis: no audio
 * files, no network, no library. An English voice is picked automatically
 * (British preferred — Boston English Center), and the rate is slightly
 * slowed for learners. Sentences containing "___" blanks are read with a
 * short pause in place of the blank so missing-word questions sound natural.
 *
 * Rules:
 *  - Speech is an ENHANCEMENT: every call is guarded, and a missing or
 *    failing synthesis engine never throws into gameplay.
 *  - One voice at a time: a new tap cancels whatever is still playing.
 *  - Nothing keeps talking after the tab is hidden.
 *  - speak() is fully async — there is zero gameplay cost until tapped.
 * ========================================================================== */
(function () {
  "use strict";

  var synth = (typeof window !== "undefined" && window.speechSynthesis) || null;
  var supported = !!(synth && typeof window.SpeechSynthesisUtterance === "function");
  var voice = null;

  if (supported) {
    var pickVoice = function () {
      var voices = (synth.getVoices && synth.getVoices()) || [];
      // Preference ladder: natural British -> any natural English ->
      // any British -> any English. First match wins.
      var wants = [
        [/en[-_]GB/i, /google|natural|online|liberty|hazel|george|sonia|ryan/i],
        [/^en/i, /google|natural|online/i],
        [/en[-_]GB/i, /./],
        [/^en/i, /./],
      ];
      voice = null;
      for (var w = 0; w < wants.length && !voice; w++) {
        for (var i = 0; i < voices.length; i++) {
          if (wants[w][0].test(voices[i].lang || "") && wants[w][1].test(voices[i].name || "")) {
            voice = voices[i];
            break;
          }
        }
      }
    };
    pickVoice();
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", pickVoice); // Chrome loads voices late
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { try { synth.cancel(); } catch (err) { /* ignore */ } }
    });
  }

  function speakPart(text, onEnd) {
    var utterance = new window.SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.lang = voice ? voice.lang : "en-GB";
    utterance.rate = 0.92; // slightly slower than conversation speed
    utterance.pitch = 1;
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
    synth.speak(utterance);
  }

  /**
   * Speak a text. "___" blanks become short pauses (~0.45s) so missing-word
   * sentences are heard the way they are written. onDone() fires when the
   * whole text has finished (or failed silently).
   */
  function speak(text, onDone) {
    if (!supported) { if (onDone) onDone(); return; }
    var parts = String(text || "")
      .replace(/_{2,}/g, "___")
      .split("___")
      .map(function (part) { return part.replace(/\s+/g, " ").trim(); })
      .filter(Boolean);
    if (!parts.length) { if (onDone) onDone(); return; }
    try {
      synth.cancel();
      // Chrome occasionally drops an utterance queued in the same tick as
      // cancel(); a 60ms breath avoids the classic silent-speech bug.
      var index = 0;
      var next = function () {
        if (index >= parts.length) { if (onDone) onDone(); return; }
        var part = parts[index++];
        speakPart(part, function () {
          if (index < parts.length) setTimeout(next, 450); // the blank's pause
          else if (onDone) onDone();
        });
      };
      setTimeout(next, 60);
    } catch (err) {
      if (onDone) onDone();
    }
  }

  function stop() {
    if (!supported) return;
    try { synth.cancel(); } catch (err) { /* ignore */ }
  }

  window.GQSpeech = { supported: supported, speak: speak, stop: stop };
})();
