/* ==========================================================================
 * Grammar Quest — asset loader & loading screen controller
 * --------------------------------------------------------------------------
 * Owns everything that must happen BEFORE gameplay may start:
 *   - WebP support detection (synchronous, canvas-based)
 *   - GQAssets.url(png)     -> ".webp" variant when the browser supports it
 *   - GQAssets.loadJson()   -> fetch + parse with bounded retries
 *   - GQAssets.preload()    -> weighted, progress-tracked image preload with
 *                              per-asset retries and cache dedupe
 *   - GQAssets.warm()       -> fire-and-forget background warming (lazy tier)
 *   - GQLoader              -> the loading screen: real percentage, rotating
 *                              status messages, slow-connection detection and
 *                              a Retry button that never traps the player on
 *                              an infinite spinner.
 * The module is dependency-free and fails silent: a missing nonessential
 * image degrades visuals, never gameplay.
 * ========================================================================== */
(function () {
  "use strict";

  /* ------------------------- WebP detection ------------------------- */
  // One synchronous canvas check (~0 ms) run before any URL is picked.
  var webpSupported = (function () {
    try {
      var canvas = document.createElement("canvas");
      if (!canvas.getContext || !canvas.getContext("2d")) return false;
      return canvas.toDataURL("image/webp").indexOf("data:image/webp") === 0;
    } catch (err) {
      return false;
    }
  })();

  /* Pick from an explicit { webp, png|jpg } pair. */
  function pick(pair) {
    if (!pair) return null;
    if (webpSupported && pair.webp) return pair.webp;
    return pair.png || pair.jpg || pair.webp || null;
  }

  /* ".png" -> ".webp" for single-path call sites (all JS-referenced
   * raster art is PNG-based; jpg art lives in CSS via image-set). */
  function url(src) {
    if (typeof src !== "string" || !webpSupported) return src;
    return /\.png$/i.test(src) ? src.slice(0, -4) + ".webp" : src;
  }

  /* --------------------------- cached loads --------------------------- */
  var imageCache = new Map(); // src -> Promise<boolean>  (true = decoded)

  function loadImage(src, retries) {
    var attempts = 1 + (retries || 0);
    if (imageCache.has(src)) return imageCache.get(src);
    var promise = new Promise(function (resolve) {
      var attempt = 0;
      var tryLoad = function () {
        var img = new Image();
        img.decoding = "async";
        img.onload = function () { resolve(true); };
        img.onerror = function () {
          attempt += 1;
          if (attempt < attempts) {
            // Brief pause before a retry dodges transient socket drops
            // without making the loader feel slow.
            setTimeout(tryLoad, 350 * attempt);
          } else {
            resolve(false);
          }
        };
        img.src = src;
      };
      tryLoad();
    });
    imageCache.set(src, promise);
    return promise;
  }

  function loadJson(src, retries, onProgress) {
    var attempts = 1 + (retries || 0);
    var attempt = 0;
    return new Promise(function (resolve, reject) {
      var tryFetch = function () {
        fetch(src, { cache: "default" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status + " for " + src);
            // Byte-streamed progress when the browser exposes the body
            // reader (real percentage on slow connections). Content-Length
            // is the compressed transfer size — still an honest ratio.
            if (onProgress && res.body && typeof res.body.getReader === "function") {
              var total = Number(res.headers.get("Content-Length")) || 0;
              var loaded = 0;
              var reader = res.body.getReader();
              var chunks = [];
              var pump = function () {
                return reader.read().then(function (step) {
                  if (step.done) {
                    onProgress(1);
                    var blob = new Blob(chunks);
                    return blob.text().then(function (text) {
                      try { resolve(JSON.parse(text)); }
                      catch (err) { throw new Error("invalid JSON in " + src); }
                    });
                  }
                  chunks.push(step.value);
                  loaded += step.value.length;
                  if (total > 0) onProgress(Math.min(0.99, loaded / total));
                  return pump();
                });
              };
              return pump().catch(function (err) {
                // Reader failures (mid-transfer abort) fall through to the
                // shared retry path below.
                throw err;
              });
            }
            return res.json();
          })
          .then(resolve)
          .catch(function (err) {
            attempt += 1;
            if (onProgress) onProgress(0);
            if (attempt < attempts) setTimeout(tryFetch, 400 * attempt);
            else reject(err);
          });
      };
      tryFetch();
    });
  }

  /* ---------------------- weighted preload batch ---------------------- */
  /* items: [{ src, weight }] — every item must load; onProgress(ratio 0..1)
   * fires after each settle. Resolves with the list of failed srcs (empty
   * when everything loaded). Cached images resolve instantly. */
  function preload(items, onProgress) {
    var totalWeight = items.reduce(function (sum, it) { return sum + (it.weight || 1); }, 0) || 1;
    var doneWeight = 0;
    var failures = [];
    var settled = 0;
    return new Promise(function (resolve) {
      if (!items.length) { resolve([]); return; }
      items.forEach(function (it) {
        loadImage(it.src, it.retries !== undefined ? it.retries : 2).then(function (ok) {
          if (!ok) failures.push(it.src);
          settled += 1;
          doneWeight += it.weight || 1;
          if (onProgress) onProgress(doneWeight / totalWeight, it.src, ok);
          if (settled === items.length) resolve(failures);
        });
      });
    });
  }

  /* Fire-and-forget warming for nonessential art (results, next screens). */
  function warm(srcs) {
    (srcs || []).forEach(function (src) { loadImage(url(src), 1); });
  }

  /* ======================== loading screen ======================== */

  var STATUS_MESSAGES = [
    "Preparing your adventure\u2026",
    "Waking the prairie dogs\u2026",
    "Polishing the grammar rules\u2026",
    "Almost ready\u2026",
  ];

  var els = {};
  var state = {
    active: false,
    ratio: 0,
    messageTimer: 0,
    stallTimer: 0,
    lastProgressAt: 0,
    finishedAt: 0,
    onRetry: null,
  };

  function dom() {
    if (!els.root) {
      els.root = document.getElementById("screen-loading");
      els.bar = document.getElementById("loading-bar-fill");
      els.track = document.getElementById("loading-progressbar");
      els.pct = document.getElementById("loading-pct");
      els.status = document.getElementById("loading-status");
      els.retry = document.getElementById("loading-retry");
    }
    return !!els.root;
  }

  function setRatio(ratio) {
    state.ratio = ratio;
    var pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    if (els.bar) els.bar.style.width = pct + "%";
    if (els.track) els.track.setAttribute("aria-valuenow", String(pct));
    if (els.pct) els.pct.textContent = pct + "%";
  }

  function status(text) {
    if (els.status && text) els.status.textContent = text;
  }

  function showRetry(message) {
    status(message || "We couldn\u2019t load everything. Check your connection and try again.");
    if (els.retry) els.retry.hidden = false;
    stopTimers();
  }

  function startMessages() {
    var index = 0;
    stopTimers();
    state.messageTimer = setInterval(function () {
      // Messages only advance while work is genuinely still in flight.
      if (state.finishedAt) return;
      index = Math.min(index + 1, STATUS_MESSAGES.length - 1);
      status(STATUS_MESSAGES[index]);
    }, 2600);
  }

  function stopTimers() {
    clearInterval(state.messageTimer);
    clearInterval(state.stallTimer);
    state.messageTimer = 0;
    state.stallTimer = 0;
  }

  var GQLoader = {
    /** Show the loading screen and begin tracking. Safe to call repeatedly. */
    begin(onRetry) {
      if (!dom()) return;
      state.active = true;
      state.finishedAt = 0;
      state.lastProgressAt = Date.now();
      state.onRetry = typeof onRetry === "function" ? onRetry : null;
      if (els.retry) {
        els.retry.hidden = true;
      els.retry.onclick = function () {
        if (!state.onRetry) return;
        els.retry.hidden = true;
        els.root.classList.remove("is-done", "is-failed");
        setRatio(0);
        status(STATUS_MESSAGES[0]);
        startMessages();
        state.lastProgressAt = Date.now();
        GQLoader.watchStalls();
        state.onRetry();
      };
      }
      els.root.hidden = false;
      els.root.classList.remove("is-done", "is-failed");
      setRatio(0);
      status(STATUS_MESSAGES[0]);
      startMessages();
      this.watchStalls();
    },

    /** Progress tick from the boot sequence (ratio 0..1). */
    progress(ratio) {
      if (!state.active) return;
      state.lastProgressAt = Date.now();
      setRatio(ratio);
    },

    /** Everything essential loaded: brief fade-out, then resolve. No
     *  artificial delay — the transition itself is the only beat (~340ms). */
    finish(transitionMs) {
      if (!state.active || state.finishedAt) return Promise.resolve();
      state.finishedAt = Date.now();
      setRatio(1);
      status("Let\u2019s go!");
      stopTimers();
      var self = this;
      return new Promise(function (resolve) {
        if (els.root) els.root.classList.add("is-done");
        setTimeout(function () {
          if (els.root) els.root.hidden = true;
          state.active = false;
          resolve();
        }, transitionMs || 340);
      });
    },

    /** A critical asset failed its retries: surface the Retry button. */
    fail(message) {
      if (!state.active) return;
      stopTimers();
      if (els.root) els.root.classList.add("is-failed");
      showRetry(message);
    },

    /** Slow-connection watchdog: no progress for 25s -> tell the player and
     *  offer Retry instead of an infinite spinner. Never cancels loads. */
    watchStalls() {
      if (state.stallTimer || !state.active) return;
      state.stallTimer = setInterval(function () {
        if (!state.active || state.finishedAt) { stopTimers(); return; }
        var stalledFor = Date.now() - state.lastProgressAt;
        if (stalledFor > 25000) {
          showRetry("Your connection seems very slow. You can keep waiting or retry.");
          // Keep the button visible but allow continued waiting: a load that
          // eventually succeeds still completes normally.
          state.lastProgressAt = Date.now();
          state.stallTimer = 0;
        } else if (stalledFor > 10000) {
          status("Still loading\u2026 your connection is a little slow");
        }
      }, 2000);
    },
  };

  window.GQAssets = { url, pick, loadImage, loadJson, preload, warm, webpSupported };
  window.GQLoader = GQLoader;
})();
