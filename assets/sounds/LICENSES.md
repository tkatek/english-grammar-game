# Grammar Quest — Sound Effects Licenses & Sources

All sound effects in this folder were downloaded from **Mixkit**
(https://mixkit.co/free-sound-effects/) on **2026-09-27** and are used under
the **Mixkit Sound Effects Free License**:

- Free for commercial and non-commercial use
- No attribution required
- Unlimited use across web, games, apps
- The only restrictions (not applicable to this game): the sounds themselves
  may not be redistributed/resold as standalone sound effects or compiled
  into competing sound-effect libraries.

License reference: https://mixkit.co/free-sound-effects/license/

Preview MP3s are served from `assets.mixkit.co`; each file below keeps its
Mixkit item id so the original page can always be found at
`https://mixkit.co/free-sound-effects/<slug>/` (searchable by id).

| Local file | Mixkit id | Original asset title | License | Downloaded |
|---|---|---|---|---|
| `ui-click.mp3` | 1109 | Select click | Mixkit Sound Effects Free License | 2026-09-27 |
| `target-pop.mp3` | 2356 | Dry pop up notification alert | Mixkit Sound Effects Free License | 2026-09-27 |
| `hammer-swing.mp3` | 1496 | Magical swish | Mixkit Sound Effects Free License | 2026-09-27 |
| `hammer-impact.mp3` | 2072 | Small hit in a game | Mixkit Sound Effects Free License | 2026-09-27 |
| `answer-correct.mp3` | 2870 | Correct answer tone | Mixkit Sound Effects Free License | 2026-09-27 |
| `answer-wrong.mp3` | 946 | Wrong answer fail notification | Mixkit Sound Effects Free License | 2026-09-27 |
| `streak.mp3` | 871 | Fairy magic sparkle | Mixkit Sound Effects Free License | 2026-09-27 |
| `heart-lost.mp3` | 2876 | Funny fail low tone | Mixkit Sound Effects Free License | 2026-09-27 |
| `timer-warning.mp3` | 211 | Retro arcade casino notification | Mixkit Sound Effects Free License | 2026-09-27 |
| `challenge-start.mp3` | 2574 | Software interface start | Mixkit Sound Effects Free License | 2026-09-27 |
| `challenge-complete.mp3` | 2059 | Game level completed | Mixkit Sound Effects Free License | 2026-09-27 |
| `challenge-failed.mp3` | 2042 | Player losing or failing | Mixkit Sound Effects Free License | 2026-09-27 |
| `star-earned.mp3` | 2350 | Magic sparkle whoosh | Mixkit Sound Effects Free License | 2026-09-27 |
| `level-unlock.mp3` | 254 | Unlock new item game notification | Mixkit Sound Effects Free License | 2026-09-27 |
| `level-complete.mp3` | 2063 | Completion of a level | Mixkit Sound Effects Free License | 2026-09-27 |

## Intentionally omitted

- `score-pop.mp3` — omitted deliberately: the answer-correct chime already
  carries the reward moment; adding a second cue on the `+points` popup made
  the moment feel noisy during QA (the spec allows preferring answer-correct).
- `map-select.mp3` — the existing ui-click on map node selection already
  covers this; a second near-identical click adds nothing.
- Background music — out of scope for this task (SFX only).

## Loudness

No waveform editor was available in the build environment, so per-file
perceived loudness was equalized in code instead: every file was decoded and
measured (RMS/peak via `AudioContext`), and `js/audio.js` carries
RMS-calibrated per-sound volumes plus `maxMs` soft-stop caps that trim the
long tails some Mixkit previews include (e.g. hammer-swing, timer-warning).
