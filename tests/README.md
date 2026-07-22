# Flyt test pipeline

A Playwright-based test harness for `flyt.user.js`. It runs the userscript
against **live youtube.com**, logged out, exactly the way a userscript
manager would (`document-start` injection via `addInitScript`).

This suite exists because a broken layout once shipped that passed every
ad-hoc check ("sidebar has `overflow:auto`", "page doesn't scroll") while the
sidebar was visibly floating in the middle of the screen. The checks here
assert **geometry and relationships between elements** (bounding boxes,
alignment, containment), not CSS properties — that class of bug fails loudly
now. See the self-test below for proof.

Pixel-diffing screenshots against live YouTube is not done on purpose:
content changes hourly, so any pixel baseline would fail constantly. Instead
`checks/snapshot.js` records **layout geometry** (position/size, rounded to
4px) which is content-independent — the sidebar is always 200px wide no
matter what video is playing.

## Setup

```
cd tests
npm install
```

## Running

```
npm test                    # everything: layout + functional + snapshot + errors, all 4 pages
npm test -- --page=watch    # just the watch page
npm test -- --check=layout  # just the layout check, all pages
npm run test:update         # regenerate committed geometry baselines in baselines/
npm run test:visual         # snapshot check only (also writes screenshots to artifacts/)
npm run test:selftest       # proves the harness actually catches a real bug (see below)
```

Screenshots land in `artifacts/` (gitignored) for human eyeballing — they are
never diffed automatically.

Runs **WebKit by default** — the primary user runs Safari, and several bugs
only ever reproduced on Safari's engine while Chromium stayed green. Set
`FLYT_BROWSER=chromium` to compare engines (Chromium gets `--mute-audio
--autoplay-policy=no-user-gesture-required` so the watch page can autoplay
without a user gesture). `HEADED=1` opens a visible window for either engine.

## Pages under test (all logged out)

| name    | url                                                    | notes |
|---------|---------------------------------------------------------|-------|
| home    | https://www.youtube.com/                                 | **legitimately empty** when logged out — tests only assert the shell renders without errors, never "home has cards" |
| search  | https://www.youtube.com/results?search_query=liquid+glass+design | has results |
| channel | https://www.youtube.com/@mkbhd/videos                     | has videos |
| watch   | https://www.youtube.com/watch?v=aircAruvnKk               | has full player + comments |

## What each check guarantees

### `checks/layout.js` — layout invariants (the heart of this)

Walks every visible element inside `#itube` (skipping `display:none`,
`visibility:hidden`, zero-area elements, and the OSD which is intentionally
hidden via `visibility:hidden` until shown) and asserts:

- **no-horizontal-overflow** — `#itube`, `.sidebar`, `.content`, `.watch-right`
  never scroll horizontally.
- **within-viewport** — nothing renders left of 0 or past the viewport's
  right edge.
- **sidebar-pinned** — `.sidebar` is pinned to `left:0`, `width:200`, and
  `.content` starts exactly where `.sidebar` ends. This is the literal check
  that would have caught the shipped bug.
- **no-region-overlap** / **hd-above-body** — the sidebar and content never
  overlap, and the header sits fully above the body.
- **no-collapsed-content** — thumbnails and key containers have a minimum
  height so a broken image/collapsed flex item doesn't silently render at
  0-2px.
- **thumbnail-aspect** — every card/related thumbnail is close to 16:9, so a
  squashed image is caught even though it "has size."
- **grid-alignment** — cards in the first grid row share the same top,
  the same width, and equal gaps between neighbours.
- **spacing-scale** — every non-zero padding/margin/gap in the whole tree is
  one of the design system's allowed values (2, 4, 6, 8, 10, 12, 14, 16, 18,
  20, 22, 24, 32, 40, 48px). Catches ad-hoc 13px/17px drift.
- **legibility** — text color is never identical to its effective
  background color (walks up the tree for the first non-transparent bg).
- **text-not-clipped** — titles/comment text either fit their box or
  declare a line-clamp (deliberate clamping is fine; silent clipping is not).

### `checks/functional.js` — behaviour

- Watch page: video mounts inside `#itube-stage`, decodes and plays, fills
  the stage; `#itube-play`/stage click/`#itube-bar` click all behave
  correctly; keyboard shortcuts (`l`, `ArrowDown`, `m`, `/`) work; volume
  persists across reload; the OSD cue shows on seek; the overflow menu and
  quality selector populate; comments stay collapsed until clicked; the
  actions row renders; **liking while logged out always reverts** — the UI
  must never claim a like succeeded when the network call actually failed.
- Navigation: clicking a related video (watch → watch) and clicking sidebar
  Home both produce **zero main-frame document loads** — pure client-side
  routing. iframe/ad `document` responses are filtered out by frame identity
  to avoid false positives.
- `ytd-app` (YouTube's own UI) is never visible on any page.
- Zero page errors and zero console errors matching
  `/itube|innerHTML|Trusted Types/i` on every page.

### `checks/snapshot.js` — layout-geometry snapshot

Records `{x, y, w, h}` (rounded to 4px) for a fixed list of structural
selectors, plus counts of `.c`/`.row`/`.comment-row`, and diffs against
`baselines/<page>.json`. A geometry deviation of more than 4px fails with a
readable diff. `npm run test:update` rewrites the baselines. A full-page
screenshot is also saved to `artifacts/` for human eyeballing — it is never
part of the pass/fail decision.

## Self-test: proving the pipeline actually works

`npm run test:selftest` loads the watch page, waits for it to mount, then
injects the **exact CSS that shipped the broken layout**:

```css
#itube .body { max-width: 1720px; margin: 0 auto; }
```

That rule floats `.sidebar` away from `left: 0`. The self-test then runs the
layout check and asserts it reports a `sidebar-pinned` violation. If it
doesn't, the self-test itself fails loudly — that's the signal that this
whole pipeline stopped being trustworthy.

## Hard rules this suite follows

- Never modifies `flyt.user.js`. If a check finds a real bug in the
  userscript, it's reported, not silently fixed.
- The userscript is injected via `page.addInitScript` at `document-start`,
  exactly how a userscript manager runs it.
- `tests/` has its own `package.json` — the root repo intentionally has no
  build system and stays that way.
