# Flyt — performance, measured

Measured, not estimated. Where something is not proven, it says so — and where
a claim in here turned out to be wrong, the correction stays visible rather than
being quietly overwritten (see the channel grid).

Every number here was produced by `tests/bench.js`, which is committed.
Reproduce with:

```
cd tests && node bench.js --runs=3 --page=watch
cd tests && node bench.js --runs=3 --page=channel
```

## Method

Playwright **WebKit**, headless, viewport 1512x900, logged out. WebKit is the
engine that matters: the primary user runs Safari. `FLYT_BROWSER=chromium`
compares engines, `HEADED=1` opens a window.

The script is injected via `addInitScript`, i.e. at **document-start** — the
same moment a userscript manager runs it, so cold-load effects are real and not
simulated.

Each surface is loaded twice per run — once stock, once with Flyt — in a fresh
browser context. 3 runs each; the table reports the **median across runs**.
After load the page is scrolled (8 x 900px) to make lazy content populate, then
a scripted scroll of 150 rAF frames records real frame intervals.

Each mode is scrolled on the element that actually scrolls in it: Flyt scrolls
its own `.content` pane, stock scrolls the document. Scrolling the window under
Flyt would move nothing and would silently measure an idle page.

### Two metrics this engine cannot report

- **`Frame time, median`.** Headless WebKit reports rAF timestamps at 1ms
  granularity and pins the frame clock near vsync, so the median reads
  ~14-15 ms in *both* modes on every surface. It is not a signal here. The
  numbers that do separate the two engines' work are **node count**, **janky
  frames**, and **worst frame**.
- **Long tasks.** `PerformanceObserver`'s `longtask` entry type is
  Chromium-only. WebKit neither throws nor delivers entries, so an earlier
  version of this file reported "0 long tasks" for both modes as though that
  were a measurement. `bench.js` now prints `unsupported on this engine`
  instead of a zero.

## Watch page — the win

| Metric | Stock | Flyt | Change |
|---|---|---|---|
| DOM nodes, whole document | 22,377 | 6,692 | **−70%** |
| DOM nodes, `ytd-app` subtree | 21,347 | 5,202 | −76% |
| DOM nodes, Flyt's own UI | 0 | 547 | — |
| Frame time, p95 | 23.0 ms | 15.0 ms | −35% |
| **Worst frame** | **39.0 ms** | **21.0 ms** | **−46%** |
| **Janky frames (>16.7 ms) of 149** | **50** | **1** | **−98%** |

Per-run p95 — stock 23 / 23 / 22 ms, Flyt 15 / 15 / 15 ms. Tight, no overlap,
repeatable.

The headline is the jank: stock drops 50 frames of 149 during a scroll, Flyt
drops 1. This is the surface the whole architecture exists for, and it is where
the difference is least arguable.

### Where the node reduction comes from

Flyt prunes nothing. `ytd-app` is still in the document, parked offscreen,
because the player must keep laying out to decode.

The nodes go away for a different reason: Flyt renders its own UI, so YouTube's
components never get scrolled, hovered, or brought into view, and therefore
never lazy-render their offscreen content. Comments, the related rail and the
feed rows are the bulk of a stock watch page, and under Flyt YouTube never
builds them — its subtree settles at ~5,200 nodes instead of ~21,300.

So the win is **work that never happens**, not work that is undone. Any future
change that causes `ytd-app` to hydrate its lists (scrolling it, making it
visible, forcing layout on it) gives all of this back.

## Search page — a modest win

| Metric | Stock | Flyt | Change |
|---|---|---|---|
| DOM nodes, whole document | 10,051 | 7,805 | −22% |
| DOM nodes, `ytd-app` subtree | 9,152 | 6,415 | −30% |
| Janky frames of 149 | 2 | 1 | parity |

Scroll jank is at parity — both surfaces are already smooth. The node reduction
is real but much smaller than the watch page's, because YouTube renders enough
of its own result list eagerly that parking it offscreen doesn't prevent it.
Stock's own node count swings run to run (14,256 / 8,875 / 10,051) with how far
its lazy rendering got, so treat −22% as an order of magnitude, not a figure.

## Channel grid — was slower than stock; now beats it

| Metric | Stock | Flyt | Change |
|---|---|---|---|
| DOM nodes, whole document | 6,549 | 5,208 | −20% |
| DOM nodes, `ytd-app` subtree | 5,584 | 2,927 | −48% |
| Frame time, p95 | 15.0 ms | 15.0 ms | parity |
| Worst frame | 25.0 ms | **18.0 ms** | −28% |
| **Janky frames of 149** | **3** | **2** | −33% |

This was an open regression for three versions (Flyt 17–18 ms p95 and 6–8 janky
frames against stock's 15 ms and 3), and **the explanation recorded here was
wrong**. It said the cause was probably architectural — Flyt scrolls an
`overflow: auto` pane while stock scrolls the document. That is now disproven.

### How it was actually diagnosed

Two experiments, because bisecting CSS properties one at a time had already
failed to move the number: `content-visibility`, `contain`, the scrollbar
gradient and the thumbnail fade were each toggled off and none of them
accounted for the gap. (`contain` turned out to be *helping*: removing it made
things worse.)

**One: is it the scroller?** Flyt's real 120-card grid and its whole stylesheet
were lifted out of a live page into two standalone documents with identical
content — one scrolling the document, one scrolling a fixed `overflow: auto`
pane — and given the same scripted scroll in the same engine on the same
machine.

| scroller | p95 | worst | janky of 149 |
|---|---|---|---|
| document | 15.0 ms | 24.0 ms | 1 |
| pane | 15.0 ms | 17.0 ms | 1 |

The pane is if anything *better*. So the pane hypothesis is dead. But look at
the absolute figures: the same cards manage **1** janky frame standalone and
**6–8** inside the live page. Whatever the cost was, it was not the grid and not
the scroller.

**Two: what else is on the live page?** The parked `ytd-app` — YouTube's own UI,
still being laid out and painted offscreen. Confirmed by making it dormant:

| variant | janky of 149 |
|---|---|
| baseline | 6 |
| `ytd-app { display: none }` | 4 |
| **`ytd-app { content-visibility: hidden }`** | **3** |

So the fix is to stop the engine rendering YouTube's parked UI on routes where
Flyt is not using its player. See "Playback intent" and the `flyt-yt-dormant`
rule in ARCHITECTURE.md for why this has to be route-scoped: it skips
DESCENDANT layout, and `#movie_player` must keep laying out to decode.
`checkYtDormancy` asserts the gate on every transition, including that playback
recovers *after* a spell of dormancy.

The lesson worth keeping: a plausible architectural story survived three
releases because it was never tested. Lifting the real markup into a controlled
harness took one probe and killed it.

## Grid first paint — above-the-fold thumbnails

The card grid (`.grid` + `.c`) is shared by home, channel, the `/feed/*` views,
playlists and Following, so it is measured on the channel page: home renders a
grid only when signed in, and logged out there is nothing to measure.

Every grid `<img>` used to get `loading="lazy"`, including the four in the first
row that are on screen the moment the grid paints. That is a pessimisation, not
a saving — the browser still fetches a lazy in-viewport image, just
deprioritised behind everything else, so the thumbnails the user is looking at
arrived last. The first row is now `loading="eager"` + `fetchpriority="high"`
(`EAGER_THUMBS`); everything below it stays lazy.

Metric: page wall-clock from the grid having its first four cards to those four
thumbnails being decoded and complete. The delta is what is reported, because
it subtracts the boot/network variance that dominates the absolute number.

| | first 4 decoded, after cards exist |
|---|---|
| all-lazy (before) | 199 ms |
| **first row eager** | **144 ms** |

Per-run deltas — before 199 / 244 / 189 / 182 / 232 ms, after 123 / 115 / 152 /
159 / 144 ms. The ranges do not overlap. 4 of 30 images are eager, confirmed by
reading the attribute back rather than assuming it was applied.

### Thumbnail sizing: measured, and deliberately left alone

`GRID_THUMB_W` is a fixed 340 that ignores the real column width, which looks
like an obvious thing to derive from layout. It is not worth doing: the grid
payload's thumbnail ladder tops out at **336px** for these renderers (the URLs
are `sqp`-signed, server-cropped variants), and `pickThumbUrl` already falls
back to the largest rung when the target exceeds it. So the delivered image is
336px wide at every desktop width regardless of what is asked for — over-fetch
is 1.07-1.24x linear, and at one-column widths the box is *larger* than
anything on offer. Deriving the target from the column width would change which
rung is requested exactly never. The ladder is the constraint, not the constant.

Fetching a bigger variant would mean synthesising URLs (`hq720.jpg`,
`maxresdefault.jpg`) outside the signed set — those 404 for plenty of videos,
and `fadeInImg`'s error handler reveals the element anyway, so a miss shows an
empty box. Not done.

## Metrics deliberately NOT reported, because they are noise

- **JS heap.** Per-run ranges overlap completely across modes; GC timing
  dominates the signal.
- **First contentful paint.** Network-dominated; per-run ranges overlap.
  Earlier versions of this file claimed −26% and then −12% FCP. **Both were
  noise.** Retracted, and not re-introduced.

**Never trust a single run.** An earlier one-shot measurement produced a
"4.1 ms p95 regression" that vanished entirely under repetition — it was GC
noise. That is why every table here is a median across runs and not a best or
a worst.

## Home page

The home page is **not** the win, and it never was. Logged out, YouTube serves
no video grid at all (it returns a `feedNudgeRenderer` instead), so there is
very little on either side to be fast or slow about. Numbers for it are omitted
rather than dressed up. Run `node bench.js --page=home` if you want them for a
given session; do not put them in a headline.

## View Transitions: measured, and deliberately NOT adopted

Safari 26.5 has `document.startViewTransition`, and a native crossfade on SPA
route changes is the obvious modern thing to reach for. Measured before
adopting, because a view transition snapshots the **whole document** — and this
document contains YouTube's parked `ytd-app` and, on watch, a live `<video>`.

Cost of `vt.ready` for a trivial DOM change, i.e. snapshot and capture only:

| route | `ytd-app` state | `vt.ready` |
|---|---|---|
| feed | dormant (`content-visibility: hidden`) | 4-8 ms |
| watch | rendered | 14-21 ms |

So the price tracks exactly what is being snapshotted: cheap where the parked
app is dormant, 2-4x higher on watch where it is not — and there it lands at or
over a 16.7 ms frame, which is the wrong place to spend a frame.

**Not adopted**, for two reasons. The cost is worst precisely on the surface
that matters most, and the effect on live playback is **unverified**: in the
probe the stream never left `readyState 0`, so nothing can be concluded about
snapshotting a decoding `<video>` — and an early read of that same probe looked
like "transitions stopped playback", which was a misreading of the probe's own
log order. If this is revisited, scope it to feed-to-feed navigation (where it
is nearly free) and verify playback in real Safari, not headless.

## What this engine actually implements

Adopting a "modern" API is only worth it if the target engine has it. Probed on
the Playwright WebKit build the suite runs, which reports itself as Safari 26.5
— the same major version as the primary user's browser:

| available | absent |
|---|---|
| `@starting-style` | `requestIdleCallback` |
| `transition-behavior: allow-discrete` | `scheduler.yield`, `scheduler.postTask` |
| View Transitions (`document.startViewTransition`) | `longtask` performance entry |
| scroll-driven animations (`animation-timeline: scroll()`) | `interpolate-size`, `calc-size()` |
| container queries, `:has()`, `scrollbar-gutter` | the `overlay` property |
| `field-sizing`, `text-wrap: pretty` | |

Three of those absences have already cost something real:

- **No `requestIdleCallback`** meant `idle()` degraded to a flat
  `setTimeout(cb, 200)`. Correct for deferred background work, wrong for the two
  user-visible render paths it also gated — appending a continuation and
  restoring a cached list — where it was 200 ms of latency before cards
  appeared for no benefit. Those now use `soon()` (next frame); see the split in
  the script.
- **No `overlay` property** means popover exit animations are impossible: the
  account and tool menus animate in via `@starting-style` but cannot animate
  out, because `hidePopover()` drops them from the top layer and nothing can
  hold them there. Documented at the rule rather than left looking broken.
- **No `interpolate-size`/`calc-size()`** means `.watch-tools` cannot animate to
  `height: auto` and has to keep transitioning `max-height`.

## Caveats

- **`scheduler.yield`.** The restore-from-cache pump and the comments append
  loop yield between chunks via `scheduler.yield` where available. This is an
  input-responsiveness win on Chromium only. Safari has no `scheduler` API and
  falls back to `setTimeout(0)`, which is the same scheduling behavior Flyt
  already used — no regression, no measured improvement claimed there.
- **Headless, not real Safari.** Playwright's WebKit is the same engine family,
  but frame timing in a headless build is not Safari.app. The 1ms granularity
  and pinned frame clock described above are headless artifacts.
- **Logged out.** A logged-in feed is heavier, so the node reduction is likely
  a floor.
- WebKit-specific behaviour (`webkitPresentationMode` PiP, native fullscreen)
  still needs manual spot checks in Safari.
