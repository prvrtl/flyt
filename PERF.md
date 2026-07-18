# Flyt — performance, measured

Measured, not estimated. Where something is not proven, it says so.

Every number below is for **Flyt** (the app) and was produced by
`tests/bench.js`, which is committed. Reproduce with:

```
cd tests && node bench.js --runs=3 --page=watch
```

## Method

Playwright (Chromium, headed, focused window — so `requestAnimationFrame` is not
throttled), viewport 1512x900, logged out. The script is injected via
`addInitScript`, i.e. at **document-start** — the same moment a userscript
manager runs it, so cold-load effects are real and not simulated.

Each surface is loaded twice per run — once stock, once with Flyt — in a fresh
browser context. 3 runs each; the table reports the **median across runs**. After
load the page is scrolled (8 x 900px) to make lazy content populate, then a
scripted scroll of 150 rAF frames records real frame intervals.

Each mode is scrolled on the element that actually scrolls in it: Flyt scrolls
its own `.content` pane, stock scrolls the document. Scrolling the window under
Flyt would move nothing and would silently measure an idle page.

## Watch page

The table below was produced by `tests/bench.js` against the current
architecture (tools-tray layout, theater mode, mini-player); re-run
`node bench.js` yourself before citing a number if precision matters for a
specific claim.

| Metric | Stock | Flyt | Change |
|---|---|---|---|
| DOM nodes, whole document | 22,107 | 6,865 | **−69%** |
| DOM nodes, `ytd-app` subtree | 21,094 | 5,477 | −74% |
| DOM nodes, Flyt's own UI | 0 | 365 | — |
| Frame time, median | 7.0 ms | 6.9 ms | ~0 |
| **Frame time, p95** | **20.6 ms** | **8.0 ms** | **−61%** |
| **Worst frame** | **27.0 ms** | **8.4 ms** | **−69%** |
| Janky frames (>16.7 ms) of 149 | 9 | **0** | −100% |
| Long tasks | 15 | 7 | −53% |
| Long-task time, total | 2,382 ms | 982 ms | **−59%** |

Per-run p95 — stock 20.9 / 20.6 / 19.9 ms, Flyt 8.0 / 7.8 / 8.0 ms. Per-run
total nodes — stock 22,435 / 22,107 / 22,084, Flyt 6,865 / 6,852 / 6,867. Tight,
no overlap, repeatable.

The median frame is identical in both — both hit budget most of the time. What
changes is the *bad* frames, the ones you actually feel: p95 more than halves and
janky frames disappear entirely.

### Where the node reduction actually comes from

Flyt prunes nothing. `ytd-app` is still in the document, parked offscreen,
because the player must keep laying out to decode.

The nodes go away for a different reason: Flyt renders its own UI, so YouTube's
components never get scrolled, hovered, or brought into view, and therefore never
lazy-render their offscreen content. Comments, the related rail and the feed rows
are the bulk of a stock watch page, and under Flyt YouTube never builds them —
its subtree settles at 5,477 nodes instead of 21,094.

So the win is **work that never happens**, not work that is undone. Any future
change that causes `ytd-app` to hydrate its lists (scrolling it, making it
visible, forcing layout on it) gives all of this back.

### Two metrics deliberately NOT reported, because they are noise

- **JS heap.** Per-run ranges overlap completely across modes; GC timing
  dominates the signal.
- **First contentful paint.** Network-dominated; per-run ranges overlap. Earlier
  versions of this file claimed −26% and then −12% FCP. **Both were noise.**
  Retracted, and not re-introduced.

Node count and frame timing are tight and repeatable. Those are the only numbers
worth trusting here.

**Never trust a single run.** An earlier one-shot measurement produced a "4.1 ms
p95 regression" that vanished entirely under repetition — it was GC noise. One
stock run above also threw a single 173 ms worst frame that neither of its
siblings reproduced; that is why the table reports a median across runs and not
a best or a worst.

## Home page

The home page is **not** the win, and it never was. Logged out, YouTube serves no
video grid at all (it returns a `feedNudgeRenderer` instead), so there is very
little on either side to be fast or slow about. The weight — comments, related,
player chrome — lives on the watch page, and that is where the gains are.

Numbers for it are omitted rather than dressed up. Run
`node bench.js --page=home` if you want them for a given session; do not put them
in a headline.

## Caveats

- **`scheduler.yield`.** The restore-from-cache pump and the comments
  append loop yield between chunks via `scheduler.yield` where available. This
  is an input-responsiveness win on Chromium only — it lets a pending click or
  keystroke jump ahead of the next chunk instead of waiting behind it. Safari
  has no `scheduler` API and falls back to `setTimeout(0)`, which is the same
  scheduling behavior Flyt already used before this change — no regression,
  no measured improvement claimed there.
- **Chromium, not Safari.** Safari is the target; these numbers are a proxy. The
  DOM and script work are identical across both, but frame timing is
  engine-specific.
- **Logged out.** A logged-in feed is heavier, so the node reduction is likely a
  floor.
- WebKit-specific behaviour (`webkitPresentationMode` PiP, native fullscreen)
  still needs manual spot checks in Safari.

