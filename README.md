# Grammar Quest

A production-ready, dependency-free English grammar whack-a-mole game. Pure
HTML/CSS/JS — no build step, no framework, no backend.

## Run locally

Any static file server works (the game fetches JSON, so `file://` will not):

```
npx serve english-grammar-game
# or: python -m http.server --directory english-grammar-game
```

## Deploy

- **GitHub Pages / Netlify / Vercel**: push the folder, point the site at it.
  No environment variables or server code are needed; each player's progress
  lives in their own browser localStorage.
- **Apache**: `.htaccess` in this folder sets cache headers
  (HTML revalidates, images/audio cache 7 days).
- After replacing images in place, bump nothing — filenames are stable and
  hashed content changes propagate via the `must-revalidate` on HTML/CSS/JS.

## Architecture

| File | Role |
| --- | --- |
| `index.html` | Screens, SVG icon sprite, static markup |
| `js/loader.js` | WebP detection, asset preload (retry + progress), loading screen |
| `js/game.js` | Engine: rules, scoring, timers, progress persistence (UI-free) |
| `js/ui.js` | Presentation: renders screens, wires engine events |
| `js/audio.js` | SFX manager (unlock-on-gesture, soft-stop, failure-tolerant) |
| `css/style.css` | Theme, screens, responsive tiers (mobile ≤600 / tablet ≤1024 / desktop) |
| `data/questions.json` | Levels, challenges, questions |
| `tests/engine.test.js` | Engine logic tests: `node tests/engine.test.js` |

## Performance notes

- All raster art ships as right-sized WebP with PNG/JPEG fallbacks
  (`image-set` in CSS, `GQAssets.url()` in JS, `onerror` in HTML).
- Boot loads **only** essentials (question data + field artwork + neutral
  prairie dogs); reaction art, map artwork and rewards warm in the background.
- `questions.json` is fetched once and shared between the engine and the
  decoy-sentence pool builder.
- Animations are transform/opacity only; the hammer cursor runs a single
  rAF loop; timers are deadline-based and pause-proof.

## Data & storage

- Progress: `localStorage` key `grammar-quest:progress:v1` (versioned,
  self-repairing — corrupted data downgrades to a fresh start).
- UI settings: `grammar-quest:ui-settings:v1` (sound/animations).
- A future per-user key can be passed as `new GrammarQuestEngine({ playerId })`
  — multiple users on shared browsers stay independent via separate keys.
