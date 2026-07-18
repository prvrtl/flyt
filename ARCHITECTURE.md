# Flyt — architecture

## The shift

Flyt renders its own UI from YouTube's *data*, not its DOM. Zero `ytd-*`
components are reused. Restyling YouTube's own DOM has a ceiling — the layout,
the components and the player chrome would still be YouTube's, so the result
would always look like YouTube wearing a costume.

## Feasibility (verified, not assumed)

Measured live before any of this was written:

| Question | Answer |
|---|---|
| Is the page data available as JSON? | **Yes** — `ytInitialData`, `ytInitialPlayerResponse` |
| Can we call YouTube's own API ourselves? | **Yes** — InnerTube (`/youtubei/v1/*`) with the page's `INNERTUBE_API_KEY` + context returns 200 with real results |
| Can the `<video>` be moved into our own player? | **Yes** — re-parented into our container, `readyState` stayed 4, playback intact |

## The one thing we cannot do

**We cannot play YouTube video without YouTube's player object.** Streams are
signature-protected and delivered adaptively over MSE; there is no supported way
to fetch and decode them ourselves, and working around that would be both
fragile and a licensing problem.

So the YouTube player stays — as a **headless playback engine**:

- Its UI (`.ytp-*` chrome) is never rendered.
- Its `<video>` element is **moved into our own stage**.
- We drive it through the player API (`setVolume`, `seekTo`,
  `setPlaybackQualityRange`, `toggleSubtitles`, …) and the media element.

Every control the user sees is ours. Nothing is a reskin of `.ytp-*`.

## Layers

    ┌─────────────────────────────────────────────┐
    │  Flyt UI          our components, our CSS  │  ← 100% ours
    ├─────────────────────────────────────────────┤
    │  Flyt data        ytInitialData +          │
    │                    InnerTube fetches        │  ← ours
    ├─────────────────────────────────────────────┤
    │  YouTube engine    player object + <video>  │  ← borrowed, headless
    │                    (MSE, DRM, signatures)   │
    └─────────────────────────────────────────────┘

YouTube's `ytd-app` is parked offscreen (not `display: none` — the player must
keep laying out to decode) and its `<video>` is adopted by our stage.

## What the app covers

- **Shell + home** — app root, design system, home feed rendered from data.
- **Watch + player** — our stage, our controls, full API sync: video adopted
  into our stage, readyState 4; seek, volume round-trip 42→42, mute, speed
  1.5x, 9 quality levels, 30 caption tracks, no stall.
- **Search + channel** — InnerTube-driven: search 26 results, channel 90
  videos, both our UI.
- **Comments + related** — continuations, bounded: 20 comments/page, cap 50,
  related rail.
- **Routing + feeds** — a client-side router over `history.pushState` +
  `popstate`, with per-route mount/cleanup: watch, home, search, channel, the
  `/feed/*` browse ids, `/playlist?list=…`, and an explicit "not available
  in Flyt yet" card for anything unhandled. `/shorts/<id>` is rewritten to
  `/watch?v=<id>`.
- **Playback & discovery polish** — autoplay-next, the playlist queue rail,
  comment replies, comment sort, and search filters (sort / upload date /
  duration).

## Data shapes (learned the hard way)

YouTube is migrating renderers to **`lockupViewModel`**. In that shape the object
carrying `videoId` is only a watch endpoint — it has NO title and NO thumbnail,
so a walker keyed on `videoId` silently returns zero items. The real data lives
elsewhere on the lockup:

    lockupViewModel.contentId                                  → video id
    lockupViewModel.metadata.lockupMetadataViewModel.title.content  → title
    lockupViewModel.contentImage.thumbnailViewModel.image.sources[] → thumbnail
    …overlays[] text matching /^\d+:\d\d/                      → duration

The extractor handles BOTH shapes. Channel pages already use lockups; search and
home are migrating. If a view suddenly renders zero items, this is the first
thing to check.

Channel tabs: never hardcode the `params` blob. Read the browseEndpoint params
off the page and pick the tab by **base64-decoding** them and matching the tab
name (`videos`, `shorts`, `streams`) — locale-independent, survives redesigns.

**Chronological subscriptions.** YouTube's Subscriptions feed is
engagement-ranked, not chronological, so Flyt re-sorts it: `parseRelativeTime`
parses each item's published-time string ("3 hours ago", "vor 3 Stunden",
"3 години тому", "3 часа назад" — en/de/uk/ru only) into a rough age, and
`sortByRecency` orders the extracted items by it before rendering. This is
applied ONLY to the Subscriptions feed (`isSubscriptions`) — ranked feeds like
Home are deliberately exempt (`checkHomeOrderNotSorted` asserts Home is left
alone), because re-sorting a feed YouTube didn't mean to be chronological
would just replace one arbitrary order with another. An item whose
relative-time string doesn't match any of the four locales silently fails to
parse and sorts as if undated — there is no guard for a fifth locale.

**Seamless mini-player expand.** The mini-player's expand control does
NOT reload the video: `ensureWatchPlayback` checks
`player().getVideoData().video_id === videoId` and, when it already matches,
skips `loadVideoById` entirely and just resumes/keeps playing through the
existing player instance. This is the same no-reload invariant the SPA watch
nav already relied on, extended to mini-player expand specifically so
collapsing to mini and expanding back is instant and glitch-free
(`checkMiniExpandSeamless`). Calling `loadVideoById` when the id already
matches would restart the stream and flash a fresh buffering state for no
reason.

## Comment replies (resolved — was a known gap)

Replies work. Each thread with replies renders a `.comment-replies-btn` that
fetches the reply continuation on click and appends the replies inline (capped
at `MAX_REPLIES`).

This was a gap for a while and the history is worth keeping, because the trap is
still there: `commentThreadRenderer` has **no `replies` key** in the current
shape, so extracting the token from the thread wrapper is the obvious move and
it is wrong — the first attempt at it broke comment extraction entirely (20 rows
-> 0). The token lives on a separate structure in the response, not on the
thread. If replies regress, that is the distinction to re-check.

## Player bar and Tools tray

The on-video bar (`#itube-bar`) is a two-row grid: the seek bar spans the
FULL width of the bar in its own grid row (`grid-template-areas: 'seek seek
seek' 'left center right'`), with prev/play/next/time on the left, the LIVE
badge centered, and time/mute/volume/PiP/theater/frame-save/fullscreen on the
right. What is **not** on it: quality, speed, captions, audio track, A-B
repeat, autoplay, SponsorBlock, volume boost, and audio-only all live off the
bar entirely, in a **Tools tray** (`.watch-tools`, an expandable row under the
watch header, toggled via a "Tools" button and built with `inert` so its
collapsed contents are never tab-reachable — guarded by `checkA11yTabStops`).
The bar's job is playback transport and stream-adjacent state (mute, PiP,
theater, live), not the settings menu.

## Mini-player

Navigating away from the watch page (to home/search/a feed) while a video is
playing re-parents the SAME `<video>` element into a small floating `#itube-mini`
box instead of stopping it — the video is never paused or reloaded, just moved
in the DOM. It carries its own play/pause, expand and close controls and is
draggable. Expand hands off to `expandMini` → `watchNav(miniVideoId)`, which is
the seamless path described above: because the player's current video
id already matches, the watch page reassembles around the still-playing video
instead of restarting it. Closing the mini-player pauses the video and hands
it back to the (offscreen, parked) `#movie_player` element rather than
destroying it.

## Back/forward list cache

Home, search, and the `/feed/*` + `/playlist` views keep an LRU (cap 8) of
their last-rendered state, keyed by the same route key the router already
uses (`keyFor`/`currentKey`). Leaving one of these views stashes its extracted
item objects (never DOM nodes), continuation token, and `content.scrollTop`;
Back/Forward to that exact key restores from memory — zero network, no
skeleton flash — feeding the cached items back through the normal windowed
append path in chunks (not one synchronous dump) and re-arming `seen` so
`fetchMore` continuations don't duplicate. A forward click (new pushState) or
any fresh navigation to a cached key always refetches and replaces the entry.
Channel pages are deliberately NOT cached: the header (avatar, subscriber
count, about copy) is populated as a side effect of `fetchInitial`/`paintHeader`
rather than being data owned by the list, so a bare item-cache restore would
leave a stale or blank header — caching it properly would mean caching the
header payload too, which is a bigger change than this mechanism is worth
right now.

## Theater mode, MediaSession, and popover menus

Theater's ambient-glow canvas is gone; the surround is a static CSS vignette
and enter/exit goes through an opaque scrim (fade in, swap layout classes,
fade out) instead of an instant class toggle, so `.content`'s `overflow` is
always set before the scrim starts fading out (no scrollbar flash). The idle
timer that hides the bar also toggles a `.itube-cursor-hide` class on
`.watch-left` (`cursor: none` on it and descendants) in theater/fullscreen —
extended from the existing hide-timer guards (never while paused, never while
the bar is hovered), not a second parallel timer.

**MediaSession queue actions must route through `watchNav`, never
`player.previousVideo()/nextVideo()`.** Those methods drive the parked,
offscreen `ytd-app` player instance directly — calling them changes what the
headless engine plays without going through Flyt's own router/state, so
Flyt's UI (title, queue highlight, related list) desyncs from what's
actually playing. `previoustrack`/`nexttrack` resolve the prev/next id from
Flyt's own `currentPlaylist`/`firstRelatedId` state and call `watchNav(id,
listId)` — the same client-side navigation a queue-panel click uses — and are
only registered (non-null) when Flyt actually knows a prev/next item exists.

**Popover menus (account menu, search-suggest, Quality/Speed tool menus)**
call `showPopover()`/`hidePopover()` manually from our own click handlers
rather than declaring a native `popovertarget`/`popoverTargetElement` invoker
relationship. This is a theoretical light-dismiss race: a browser that treats
the trigger button as an ordinary outside click (not a recognized invoker)
could auto-close the popover on `pointerdown` and then have our own `click`
handler read stale open-state and immediately reopen it, making the button
unable to close its own menu. Probed against Chromium 149 (the current
Playwright-bundled build) with a real trusted click on both the account
avatar and the Quality pill while open — it reliably closes, not reopens — so
no native-invoker rework has been done. If this class of bug ever surfaces
(different engine, different Chromium build), the fix is to set
`btn.popoverTargetElement = menu` (and drop the manual open call on that
button) so the browser's own invoker-aware toggle semantics take over instead
of racing our JS.

**Generation counters guard every per-video async path.** `renderGeneration`,
`transcriptGeneration`, and `commentsGeneration` are bumped on every
navigation/reset; anything that awaits across a navigation boundary (an
`innertube()` fetch, a `yieldTask()` chunk) must re-check its captured `gen`
against the live counter before touching shared state or the DOM — otherwise
a fetch that resolves after the user has already navigated to a different
video appends stale rows (comments) or renders a stale transcript.

## Non-negotiables (carried over — every one of these has bitten us)

- No `innerHTML` anywhere. Trusted Types is enforced on youtube.com.
- No animation/transition except the deliberate thumbnail fade.
- `#movie_player` shadows `addEventListener` — bind via
  `EventTarget.prototype.addEventListener.call(player, …)`.
- Never cycle `loadModule`/`unloadModule('captions')` — stalls the player at
  readyState 0.
- Volume: element volume = ratio × player volume (loudness normalisation);
  debounce ≥300ms or the sliders drift.
- Never sweep the DOM while the user is scrolling.
