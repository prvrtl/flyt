# Flyt

Flyt replaces YouTube's web UI with its own. It doesn't restyle YouTube's DOM —
it renders a fresh app from YouTube's *data* (`ytInitialData` plus authenticated
InnerTube `/youtubei/v1/*` calls) and borrows YouTube's player as a headless
playback engine, re-parenting the `<video>` into Flyt's own stage. The real
`ytd-app` is parked off-screen (never `display:none` — the player has to keep
laying out to decode).

It's one vanilla JS file, no framework, no build step, no dependencies:
**`flyt.user.js`** (`@run-at document-start`, matches `youtube.com/*`, excludes
`/embed/*` and `/live_chat*`). Read `ARCHITECTURE.md` before changing anything
structural; `RECOVERY.md` is the runbook for when a YouTube payload change breaks
something.

## Things that will bite you

- **No `innerHTML`.** youtube.com enforces Trusted Types — build DOM with
  `createElement` / `textContent` / `replaceChildren`.
- **`#movie_player` shadows `addEventListener`.** Bind player events with
  `EventTarget.prototype.addEventListener.call(player, …)` or they silently do
  nothing.
- **Never cycle `loadModule`/`unloadModule('captions')`** — it wedges the player
  at `readyState` 0.
- **Don't write a bare `CSS`.** The file declares a top-level `const CSS` (the
  stylesheet template) partway down, so an earlier reference hits its temporal
  dead zone and throws at runtime; `node --check` won't catch it. Use
  `window.CSS`.
- **Volume** = element volume × player volume (loudness normalization); debounce
  the sync ≥300ms or the sliders drift.
- No animations or transitions except the deliberate thumbnail fade and the
  two fly-to-stage moves (thumbnail → stage, mini-player → stage).
- **Never use `element.animate()`.** On Safari, YouTube loads its
  web-animations polyfill, which hijacks `animate()` in the page context and
  completes instantly — both flies teleported there for months. CSS
  transitions only.

## Tests

Playwright, against live youtube.com, logged out, script injected at
document-start the way a userscript manager would. **WebKit by default** —
the primary user runs Safari, and several bugs only reproduce there
(`FLYT_BROWSER=chromium` to compare engines).

```
cd tests && npm install   # once
cd tests && npm test      # everything
```

Useful flags: `--page=watch`, `--check=<name>`. The `functional` check is itself
a table of ~50 named sub-checks — pass `--check=<subname>` (e.g. `transcript`,
`miniplayer`, `following`) to run one; see `FUNCTIONAL_ENTRIES` in `tests/run.js`.
`npm run test:update` rewrites geometry baselines but refuses structural geometry
without `--force`.

The suite hits the live site, so a red can just be YouTube changing a payload —
re-run before believing it.

## Conventions

Tunables are a few `const`s at the top of the file (`MAX_COMMENTS`, …); there's no
config system. The app itself carries almost no comments — the reasoning lives in
`ARCHITECTURE.md` and `RECOVERY.md`. The test files do carry comments: each says
which real bug it's there to catch. Match that when adding tests.
