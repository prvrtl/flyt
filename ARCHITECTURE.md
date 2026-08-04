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
  related rail. Posting a top-level comment is supported when signed in
  (`comment/create_comment`); replies are read-only.
- **Routing + feeds** — a client-side router over `history.pushState` +
  `popstate`, with per-route mount/cleanup: watch, home, search, channel, the
  `/feed/*` browse ids, `/playlist?list=…`, and an explicit "not available
  in Flyt yet" card for anything unhandled. `/shorts/<id>` is rewritten to
  `/watch?v=<id>`.
- **Playback & discovery polish** — autoplay-next, the playlist queue rail,
  comment replies, comment sort, and search filters (sort / upload date /
  duration).
- **Feed curation** — a hover cluster on every card: "Not interested", "Don't
  recommend channel", and a quick Unfollow, each appearing only when it can
  actually act. The two dismissals drop the card out of the grid; all three
  offer Undo.

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

**Dismissal feedback tokens.** The cross on each card posts to
`/youtubei/v1/feedback` with `{ feedbackTokens: [token] }`; the call is
confirmed by `feedbackResponses[].isProcessed`. The tokens are minted per card
and ride along in the feed payload, on two unrelated shapes:

    videoRenderer.menu.menuRenderer.items[].menuServiceItemRenderer
      .serviceEndpoint.feedbackEndpoint.feedbackToken        (search, channel, related)

    lockupViewModel.metadata.lockupMetadataViewModel.menuButton.buttonViewModel
      .onTap.innertubeCommand.showSheetCommand.panelLoadingStrategy.inlineContent
      .sheetViewModel.content.listViewModel.listItems[].listItemViewModel
      .rendererContext.commandContext.onTap.innertubeCommand
      .feedbackEndpoint.feedbackToken                        (home feed)

Each card carries **two** of them and the row labels are localized, so the rows
are told apart by their stable icon name, never by their text: `HIDE` is "Not
interested" (this video), `REMOVE` is "Don't recommend channel". Matching on the
label would work only on an English account.

Matching the *icon* and not merely "has a `feedbackEndpoint`" is load-bearing.
What each surface actually ships (verified signed-in):

| Surface | Row carrying a `feedbackEndpoint` | Icon | Cross |
|---|---|---|---|
| Home | Not interested / Don't recommend channel | `HIDE` / `REMOVE` | both |
| Subscriptions | Hide | `HIDE` only | video only — shift falls back to it |
| History | **Remove from watch history** | `DELETE` | skipped |
| Watch Later | Remove from… (`playlistEditEndpoint`) | `DELETE` | skipped |
| Search | none | — | no cross, same as YouTube |

History's row is a genuine `feedbackEndpoint` — an extractor keyed on endpoint
type instead of icon would put a "don't recommend" cross on History that
silently deletes watch history.

Undo needs no extra round trip — the undo token is pre-minted inside the
feedback endpoint's own `actions[].replaceEnclosingAction…buttonRenderer
.serviceEndpoint.undoFeedbackEndpoint.undoToken`, and is posted to the same
`feedback` endpoint in the same `feedbackTokens` array.

**Signed-out payloads carry no feedback tokens at all**, which is why the cross
is gated on token presence rather than on `loggedOut()` — token presence is the
real precondition, and it is the only thing a logged-out test can drive (see
`checkDismissCross`, which mocks a search continuation to inject them).

**The cluster is three separate buttons, not one button with modifiers.** Each
appears only when it can act: "Not interested" needs the `HIDE` token, "Don't
recommend channel" needs the `REMOVE` one, and Unfollow needs `subscribedByGuide`
to return an explicit `true` — it answers `null` while the guide is still
loading or has given up, and offering to unfollow a channel you don't follow
would be worse than not offering at all. Unfollow also needs a session, so it
is the one action in the cluster gated on `loggedOut()`.

Unfollow posts the card's UC id to `subscription/unsubscribe`. That id comes
from `channelIdFrom`, reading `browseEndpoint.browseId` off the *same* endpoint
`channelHrefFrom` already reads — `channelHref` is usually a `/@handle`, and
resolving a handle would cost a `navigation/resolve_url` round trip per card.
Undo re-subscribes, and puts the channel back in the sidebar using a snapshot
of its guide entry taken *before* unsubscribing: `updateGuideOnSubscribeChange`
needs a title and avatar to re-add, and after the removal they no longer exist
anywhere.

Unfollow deliberately does **not** remove the card. Dropping a subscription
says nothing about the video being looked at, and vanishing it would be a
worse surprise than a row that stays put.

The two dismissals are optimistic: the card fades out immediately and is re-inserted at
its original index if the call fails or Undo is pressed. Dismissed ids also go
into a session `dismissedIds` set consulted by `isFeedFiltered`, because
YouTube keeps serving a dismissed video in later continuations until it rebuilds
the feed server-side — without it the card walks straight back in on the next
scroll.

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

The comment composer is held to the same rule twice over. Its
`createCommentParams` is cleared on every reset, because a stale one would post
the comment to the *previous* video — the one failure here that silently does
the wrong thing instead of erroring. And a submit that resolves after a
navigation is dropped rather than prepended to the new video's list.

## The watch column is split around the video

Title, channel identity and view/date stats read **above** the stage; the
actions strip and the tools popover stay **below** it. That makes the video's
top edge a function of everything above it, so everything above it is
height-stable by construction:

- `.watch-headblock` wraps title + meta and reserves the two-line-title case
  once (`min-height`), so a one-line title spends the slack *below* the author
  row instead of between the two — carried on `.watch-title` itself, that gap
  read as a hole. It is also `display: flow-root`: while the title is still
  empty, early in every navigation, `.watch-meta`'s top margin otherwise
  collapses out through the wrapper and drops the video 14px until the title
  lands.
- `.watch-head` reserves the identity line's 34px, because `showMetaSkeleton`
  sets its contents to `display: none`.
- The loading skeleton is absolutely positioned, so it overlays the rows it
  stands in for rather than stacking above them.
- The tools row is a popover — as an in-flow `max-height` accordion it moved
  the stage ~155px on every open.

The stage's shadow lives on `.stage-wrap`, never on `#itube-stage`: the stage
carries `clip-path: inset(0 round …)`, and a clip-path clips the element's own
box-shadow away, so the same declaration there paints nothing at all.

**The video's height cap is `100vh − --stage-chrome`, not a flat `82vh`.** The
shell does not scroll; only `.content` does, and the watch page is meant to fit
inside it. `82vh` was right when the video sat at the top of the column with
just the 24px inset above it, but with a header block above it that leaves room
only on a viewport ~1316px tall — every wider-than-tall window scrolled the
whole page, and collapsing the rail made it worse because the column width
stops being the binding constraint. `--stage-chrome` is the sum of what the
column spends around the video (padding, header block, both gaps, the actions
strip), so the cap follows the layout instead of being guessed.

**The tools menu is `position: fixed`, and `display: none` when closed.** It is
the same component as `.tool-menu` — one column of label/value rows, right-edge
aligned to the Tools button, flipping above it when there is no room below.
Both properties are there for the same reason: an absolutely positioned
descendant still extends its scroll container's `scrollHeight`, so a *closed*
one at `opacity: 0` added 44px of scrollable area, and an *open* absolute one
added its full height (900 → 1018) and made a page that fits scrollable.
`display` removes the first, `fixed` removes the second. It stays inside
`.watch-below` in the DOM rather than moving to the app root, so it is still
torn down with the view. `.shown` is added a frame before `.open` so the fade
has two rendered states to transition between, and so the menu is measurable
before it is positioned.

## The heading is seeded from the card that was clicked

Nothing cleared the watch heading on an SPA hop, so the **previous** video's
title stayed up for the whole `next` round trip — measured at 1108ms, during
which the page looked like it had not navigated. The card being clicked has
already rendered the correct title, so the click handler harvests it and
`renderWatchFor` paints it immediately; `renderMeta` overwrites it from the
payload when that lands. Same measurement with the seed: 119ms.

This is deliberately the *title only*. The identity row keeps its skeleton
because the card does not know the follower count, and the reaction buttons
stay **confirm-first** — they show a pending ring and update only once the
server agrees, which `pendingRing` covers. Optimism is right where the data is
already known and wrong where it would assert a write that may fail.

## Flyt owns the tab title

`ytd-app` is still alive behind the app and writes `document.title` on its own
schedule: once when it finally follows our `pushState`, and again on every
signed-in notification-count change — which is what puts a
`(12) <the previous video> - YouTube` back in the tab minutes after navigating.
The tell is the suffix: ` - YouTube`, never ` — Flyt`, so it is an overwrite
rather than a stale value of ours.

`setTitle` therefore records the title it wants and installs a
`MutationObserver` that puts it back whenever anything else changes it. It
observes `document.head` rather than the `<title>` element, because `ytd-app`
can replace that element outright and an observer bound to the old node would
then be watching something nothing writes to. Re-applying inside the callback
re-triggers the observer exactly once, and the equality check stops it there.

This replaced a single re-apply on a 1500ms timer, which could only ever win
the race by luck.

## The rail collapses by viewport OR by choice

The narrow rail is a `.rail-collapsed` class on the app root, not a media
query. `syncRail()` applies it when the window is under 1101px **or** when the
user collapsed it (`itube-rail` in localStorage), which keeps one definition of
what "collapsed" means rather than two copies free to drift. Below the
breakpoint the viewport wins outright and the toggle is hidden: there is no room
for the wide rail there, so the control would offer a choice it cannot honour —
and a user who collapsed the rail on a small window would otherwise find it
stuck that way on a large one.

## The parked ytd-app is made dormant off-watch

`ytd-app` stays in the document (see "The one thing we cannot do"), but on any
route where Flyt is **not** driving YouTube's player it also gets
`content-visibility: hidden`, via `body.flyt-yt-dormant`. It was the single
biggest remaining scroll cost — worth roughly half the janky frames on the
channel grid, which is how a three-version-old "Flyt scrolls worse than stock"
regression turned into Flyt beating stock. PERF.md has the experiment.

Two things make this safe, and both are load-bearing:

- **It is `content-visibility`, not `display: none`.** `display: none` throws
  away layout state; `content-visibility: hidden` keeps the box and its
  explicit 1280x720 while skipping its contents.
- **It is gated on the player being idle,** because it skips DESCENDANT layout
  and `#movie_player` must keep laying out to decode. The predicate asks the DOM
  — *is a `<video>` currently adopted into `#itube-stage` or `#itube-mini`?* —
  rather than deriving it from route plus `miniActive`. Deriving it lost a race:
  leaving a watch page calls `route()` (which would mark it dormant) BEFORE
  `activateMini()` runs (which un-marks it), so the player's container was
  briefly un-rendered while its video was mid-reparent.

`checkYtDormancy` asserts the gate across every transition — watch, watch with
the video handed to the mini-player, a feed with nothing playing, and back to
watch — and asserts that playback still decodes and advances *after* a spell of
dormancy, which is the part most likely to break.

## idle() and soon() are different intents

Safari implements neither `requestIdleCallback` nor `scheduler.postTask`, so
`idle()` is a flat `setTimeout(cb, 200)` there. That is right for deferred
background work (the account menu, the guide fetch, the watch-later set — none
of which should compete with first paint) and wrong for user-visible rendering,
where it is pure added latency. Appending a continuation and restoring a cached
list use `soon()` (next frame) instead; `tryAppend` already refuses to run
during an active scroll, so leaving the current task is all they need.

## Playback intent: one reconciler, two lifetimes

Nothing calls `playVideo`/`pauseVideo`/`video.play()`/`video.pause()` directly.
Everything goes through `setIntent()` + `reconcilePlayback()`, and that is
deliberate: Flyt drives **two** layers (YouTube's player API and the raw media
element) against a controller that reasserts its own state, so a
fire-and-forget command is not enough — the intent has to be *held*.

It used to be four mechanisms each enforcing half the problem: a
`userPausedPlayback` flag, a `'play'` handler that undid unwanted plays, a
`tick()` backstop that undid them again after an element swap, and a
`resumeVideoId`/`resumeUntil` window that was the only thing enforcing "keep
playing" — and only for a few seconds after a navigation. **Three enforcers for
pause, none for play.** A user pressing Space got no enforcement at all, so when
the player paused the element a beat later nothing put it back; under load it
won about one run in three.

Two pieces of state, with different lifetimes — do not merge them:

- **`userPaused`** — the user's standing preference. Sticky, no deadline. A
  navigation that assumes "playing" must never resurrect a video the user
  paused ten seconds ago, so this outlives any enforcement window. Cleared only
  by an explicit play or by loading a different video. (Merging it into the
  bounded intent reintroduces the "jumps back to playing" bug — that is exactly
  what `pause-survives-resume` caught when it was tried.)
- **`intent` + `intentUntil` + `intentCorrections`** — what we are currently
  arguing with the player about. Bounded by a deadline *and* a correction cap,
  so a real disagreement (or a `play()` the autoplay policy refuses) stops
  instead of trading commands forever.

`setIntent(playing, { user: true })` marks an explicit gesture, which is
authoritative. An inferred intent — a re-nav assuming playback — is declined
when the user has that same video deliberately paused. `reconcilePlayback()`
only issues a command when actual state disagrees with intent, which is what
makes it safe to call from the very `play`/`pause` events it causes; it bails on
`adShowing()` (ads must play out or `killAd` can't seek past them) and never
re-plays an `ended` video.

## Hand-offs run on transitions, not on timers

`afterTransition(el, prop, fallbackMs, fn)` fires `fn` once, on whichever comes
first: the element's real `transitionend`, or a deadline. Everything that hands
off between two animations uses it — the theater scrim, both modal close paths
(`wireOverlay`, `wirePopup`), the video crossfade teardown.

A bare `setTimeout` is wrong in *both* directions here. Late: under main-thread
load it slips, and the theater sequence sat with an opaque scrim up and the
layout not yet swapped. Early: the timer starts when it is armed but the
transition only starts on the next frame, so a delayed `rAF` could fire the
hand-off while the scrim was still translucent — showing the exact flash the
scrim exists to hide. The timer remains only as the guarantee that `fn` runs at
all (a transition that never starts because the element is `display: none`, or
one the compositor drops).

Theater also dedups against the in-flight **target**, not the applied state:
while the scrim is up `theaterOn` is still the old value, so comparing against
it let repeated clicks restart the sequence and hold the app under a black
cover.

## Accent: a solid anchor plus a gradient, not one or the other

The default theme is an aurora sweep — light green to cyan to light blue — but
`--accent` is a **solid** (the sweep's cyan midpoint) and `--accent-grad` is the
sweep. That split is forced, not stylistic: most of the accent's work is
`color`, `border-color`, `outline` and `box-shadow`, none of which accept a
gradient, and `rgba(var(--accent-rgb), …)` needs a triple to derive
`--hairline`/`--surface`/`--hover`/`--glow` from.

So the gradient goes only on **filled signature surfaces** — the brand tile and
BETA badge, the Flyt power track, Follow, the Up-next NEXT badge, the active
settings toggle, the resume and Following progress fills, the unhandled-page
button. Thin 2px things (the channel-tab underline, A-B and SponsorBlock
markers) stay solid, where a three-stop gradient would be invisible anyway.

**Every gradient surface must set `background-color: var(--accent-solid)` as
well as `background-image: var(--accent-grad)`.** A bare `background:` gradient
computes `background-color` to `transparent`, and the layout check's WCAG
contrast walker resolves an element's effective background by walking up for the
first opaque colour — so a gradient-only surface would have its dark
`--on-accent` text measured against the page behind it and reported as a
contrast failure. The solid is also the honest fallback, and it is the sweep's
midpoint, so the measured ratio is representative. The dark foreground clears
4.5:1 against all three stops (13.3:1 green end, 7.7:1 blue end).

Picking any other swatch **flattens** the sweep to that one colour
(`setAccent` sets `--accent-grad` to the hex). A gradient auto-generated from an
arbitrary hue would be a guess. Only a hex is persisted, so the default's hex
re-derives its sweep on restore — `DEFAULT_ACCENT` and `ACCENT_GRADIENT` in the
script must stay in step with the stylesheet's tokens, and `docs/index.html`
carries its own hand-synced copy (no build step).

## Light theme: the accent splits again, into fill and ink

`#itube.light` restates the surface tokens; everything token-driven flips for
free. Two things do not.

**The accent splits into a fill and an ink.** The aurora stops are tuned to sit
on a near-black page. As a *fill* they are unchanged in light mode — the same
`--accent-grad`, and `--on-accent` (`#04141c`) still clears 7.6:1 against the
palest stop, so every gradient surface is pixel-identical in both themes. As
*text* the default cyan is ~1.7:1 on white, so light mode darkens `--accent`
and `--accent-rgb` (the 46 `color`/`border`/`outline`/`box-shadow` sites) to
`#1a6666`. `--accent-bright`/`--accent-rgb-bright` keep the undarkened value
for the overlays below.

`accentInk()` derives that darkening at runtime, so a colour picked in the
wheel gets it too. It scales the colour toward black (hue preserved, so Violet
stays violet) and keeps the lightest value clearing 4.6:1. The reference
background is **not** the page: accent text mostly lands on accent-*tinted*
chrome (`.hd-signin`, the active nav row), and tinting with the ink drags the
backdrop toward the very colour being measured. Targeting white scored 4.7:1
there but 3.45:1 on a 20% tint — so the backdrop is derived from the candidate,
which makes the check self-consistent. `--accent-grad-ink` is the same
treatment applied stop-by-stop, for the one place the gradient is text rather
than a fill: the wordmark, which clips it with `background-clip: text`.

**Overlays on video stay dark in both themes.** `#itube-bar`, `#itube-preview`,
`#itube-mini`, `#itube-cue`, `.stage-audio` and `.itube-fly` sit on artwork,
not on the page, and their own backgrounds are literal darks. In light mode
they must restate the tokens the theme just inverted — otherwise `#0f1218` body
text and a 4.5:1-on-white accent land on near-black. Custom properties inherit,
so naming the container covers its subtree; `#itube-bar` alone accounts for the
seek rail, the A/B markers and every bar button. The same applies to the
thumbnail furniture (`.row-dur`, `.qa-btn`, `.wl-quick`, `.c-progress`), which
never used tokens and so needed no change.

The default is **dark**, not `system`: Flyt has always been dark, and flipping
every existing install on an update is not an upgrade. `system` tracks
`prefers-color-scheme` live; an explicit pick ignores it. `#itube-boot` mounts
at document-start, before `#itube` exists, so it reads the pref itself and
carries its own `.light` — otherwise a light-mode user gets a black flash.

`setAccent` writes `--accent` *inline*, which outranks the `.light` block, so
`applyTheme` must toggle the class and then re-run `setAccent` — a class flip
alone leaves the previous theme's ink behind.

## Home feed re-ranking

`rankBatch()` is a **perturbation** of YouTube's order, never a sort from
scratch. YouTube has corpus-wide signals this app cannot see — freshness,
upload velocity, cross-user quality — so the payload's own position is the
prior, and the only thing done to it is pushing items **down**. Demotion-only
is what makes it safe: sorting by `(originalIndex + demotion)` is trivially a
permutation, movement is bounded by `RANK_MAX_SHIFT`, every move is
explainable, and the worst case is slightly-shuffled YouTube rather than a
wrecked feed.

Ranking is **per batch**, like `sortByRecency`. You cannot pull item #200 above
item #3 without prefetching pages first, which would trade instant paint for
ranking quality. Already-painted cards are never reshuffled.

**Home is the only surface that ranks.** Subscriptions stays chronological,
search is left alone because the user stated an intent, and the watch rail is
untouched because its first card is what autoplay actually plays — reordering
it would silently change playback, not just presentation.

Nothing in the ranker reads `views` or `duration`: both are localized display
strings with no parser in this file, and misparsing them is how the view count
once landed in the channel slot on a non-English UI.

`RANK_STATE_MAX` bounds the per-mount channel tally, and the cap is enforced on
**insert**. `followingStatsCache` caps only on persist, which is the shape of
bug this avoids.

## Player chrome: floating capsules, not a bar

The controls are grouped the way Apple's player groups them — translucent
capsules pinned to the stage's corners plus a centre transport cluster —
instead of one full-width strip holding twelve controls in a row.
`#itube-tools` (PiP, frame export) top-left, `#itube-sound` (volume) top-right,
`#itube-viewer` (theater, fullscreen) bottom-right, `#itube-transport`
(prev/play/next) dead centre, and `#itube-bar` reduced to the bottom rail:
elapsed · scrubber · duration.

**Every element id survived the regrouping** — it is a parentage change only,
so handlers and selectors elsewhere still resolve. `#itube-bar` deliberately
stays the bottom rail rather than growing to cover the stage, because its rect
is what `bar-click-no-toggle` clicks and a full-stage bar would put that click
on the play button.

Three things that are easy to get wrong here, all of which did go wrong once:

- **`PLAYER_CHROME_SEL`, not `#itube-bar`.** Click-to-pause and
  dblclick-to-fullscreen on the stage, and the keyboard handler's "is a player
  button focused" test, all have to know what counts as chrome. While that was
  literally `'#itube-bar'`, clicking the relocated play button toggled playback
  **twice** — once via the button, once via the stage underneath — which
  presented as "the video refuses to stay playing", and cascaded into the
  theater idle checks (they require `!wired.paused`).
- **`#itube-transport` must not swallow clicks.** It is a layout box with no
  surface of its own sitting exactly where people click the video to pause, so
  it is `pointer-events: none` with its buttons opting back in. The capsules
  keep pointer-events because they *are* painted surfaces.
- **Fixed grid tracks in the transport.** `prev`/`next` are `display:none` on
  anything that isn't a playlist, and a flex cluster then centres "play + next"
  as a unit, putting play off-centre on every ordinary video. Three explicit
  columns with explicit placement keep play on the centre line.

`backdrop-filter` over playing video makes the compositor re-sample and blur
the frame every tick, so it is confined to three small capsules — and the whole
chrome is `visibility: hidden` (and therefore not composited) whenever the
controls are idle.

## One material for floating surfaces, and Reduce Transparency

Every surface that floats over content — the search-suggest dropdown, the
Settings sheet, the command palette, the popup panels, and the player's corner
capsules — uses the same translucent fill plus `backdrop-filter: blur()`.
Before, only the suggest dropdown was vibrant and the sheets were flat
`--raised`, which is the kind of inconsistency that reads as unfinished rather
than as a choice.

`@media (prefers-reduced-transparency: reduce)` turns all of it off. On macOS
vibrancy is a system-level accessibility preference (System Settings >
Accessibility > Display), so honouring it is the native behaviour rather than a
nicety — and it is the one accessibility switch that also makes the app
cheaper, because every `backdrop-filter` stops compositing a blurred backdrop.
Surfaces go **opaque** in that mode rather than merely losing their blur, which
would leave them as murk.

**Measured cost of the player capsules' blur.** `tests/bench-blur.js` samples
rAF deltas over a playing video in five conditions: controls hidden, shown,
shown-with-blur-forced-off, and the same pair in theater mode (the largest
composited area). Median 14ms and p95 16ms in *every* condition, headless and
headed; janky-frame counts vary non-monotonically between them (theater *with*
blur scored better than without on one run). The honest reading is that the
cost is **below this instrument's resolution**, not that it is free — WebKit
pins the frame clock near vsync, which `bench.js` documents about itself. The
capsules are also `visibility: hidden`, and therefore uncomposited, whenever
the controls are idle.

## Player context menu

Right-clicking the stage used to raise **Safari's native `<video>` menu** —
"Show Controls", "Enter Viewer", "Show Media Statistics" — offering to drive a
player Flyt has already taken over, and advertising that there is a raw
`<video>` underneath. `.itube-ctx` replaces it.

Three constraints shape where it lives:

- **It is a child of `#itube-stage`.** `toggleFullscreen()` fullscreens the
  stage, and only the fullscreen element's subtree renders, so a menu parented
  to `#itube` would vanish exactly when it is most wanted. The stage also clips
  its own corners, so the menu clamps itself to the stage box rather than the
  viewport.
- **It is in `PLAYER_CHROME_SEL`.** Everything inside the stage sits above the
  click-to-pause handler; without this, activating an entry would toggle
  playback as well. Same trap that broke playback in 0.0.34.
- **Escape is owned by `closeTopOverlay()`**, not by a listener of its own.
  `onKeydown` calls `stopImmediatePropagation()`, so a separate handler races
  it and loses. The menu is checked first in that priority stack, so Escape
  dismisses it before exiting theater.

Every entry proxies the button that already implements it (`ui.pip.click()`,
`ui.fs.click()`, …) so there is no second code path for PiP/fullscreen/theater/
frame-export to drift out of sync with the buttons.

**Copy link** builds `https://youtu.be/<id>` here rather than lifting YouTube's
share-sheet URL, which appends `?si=<tracking>`. (Flyt's own Share button was
already clean for the same reason — it constructs a watch URL instead of
asking YouTube for one.)

## Boot splash

The splash is the header's brand tile at splash scale — same squircle, same
sweep, same play glyph — plus the wordmark. It was a bare gradient square,
which reads as a failed image rather than a logo.

Its fade is deliberately **asymmetric**. The backdrop is opaque from the first
frame and never fades in: it exists to cover YouTube's own page, and fading it
would let that page show through. Only `.itube-boot-inner` animates, and only
after a ~160ms beat — a boot that finishes inside that beat (a warm load) shows
a calm empty field instead of a logo that appears and vanishes. On the way out
the contents rise and grow slightly while the backdrop fades, and the element is
held for 380ms so the transition finishes; removing it early turns the fade
into a cut, which is invisible in a screenshot and only shows in the timing.

`#itube-boot` is outside `#itube`, so it can read neither the theme tokens nor
the in-app reduce-motion class. It carries literal colours, its own `.light`
variant, and its own `.no-motion` flag read from localStorage at
document-start. A custom accent sets `--itube-boot-accent` and
`--itube-boot-sweep: none` **on the overlay**, so the tile, its glow, the
wordmark and the progress pip all turn together — set per-element, they
disagreed and left a violet tile wearing a cyan halo.

## Motion policy

Motion is allowed but **compositor-only**: `opacity` and `transform`, never
`left`/`top`/`width`/`background-position`. Animating a layout or paint
property means the main thread re-does layout or repaint every frame, which is
the exact cost this app exists to avoid — the boot progress bar (`left`), the
skeleton shimmer (`background-position`) and the power-toggle knob (`left`)
were each converted to `transform` for that reason.

There is exactly one deliberate exception, and it is scoped so tightly that it
should stay the only one: the **pending ring** on confirm-first buttons (like,
dislike, Save, Follow, quick Watch Later) animates a registered `@property`
angle (`--itube-arc`) inside a `conic-gradient`, which repaints every frame.
It buys the one thing a transform cannot give: the outline stays still while a
light travels *along* it. The first version rotated the pseudo-element instead,
and a rotated rounded rectangle only reads correctly when it is a circle — on a
pill-shaped button it tumbled. The paint is affordable because the painted area
is a single ~90×34px button and it lives only for the length of one request.
Do not reuse the pattern on anything large, numerous, or long-lived.

Note that `#itube.itube-reduce-motion *` does **not** match pseudo-elements;
the selector list has to name `*::before` / `*::after` explicitly, which is why
the pending ring was the first thing to keep moving with the in-app setting on.

Every modal surface enters and leaves the same way: `.open` flips `display`,
then a `.show` class added one frame later drives opacity+scale — that
two-step is what makes a `display: none` element transitionable at all. It
lives in `wireOverlay` (settings, command palette) and `wirePopup`
(description, transcript, shortcuts). Anything new that opens over the page
should reuse one of those rather than toggling `display` directly.

The two fly-to-stage moves (thumbnail → stage, mini-player → stage) and the
theater scrim are the only bespoke motion. Everything animated is disabled
under `prefers-reduced-motion` **and** under Flyt's own reduce-motion setting
(`#itube.itube-reduce-motion *`); elements appended outside `#itube` (the fly
clone, the theater scrim) check `prefersReducedMotion()` in JS instead,
because that class selector cannot reach them.

## Card grid: the painted box is wider than the track

Every `.c` has `padding: 8px` with `margin: -8px`, so its hover/focus surface
overhangs its grid track by 8px on all four sides. Any grid gap therefore
*spends 16px on the card itself* — a 16px column gap left neighbouring cards'
painted boxes exactly flush, so hovering one read as a slab spanning two cards.
The gap is a uniform `24px`, which puts a real 8px between painted boxes in both
directions. **A grid gap below 24px in this app is a bug**, not a density
choice. Column counts are unchanged from the old 24/16 at every breakpoint from
480 to 1512.

The first `EAGER_THUMBS` thumbnails of a fresh list (and of Continue watching,
which sits above it) are `loading="eager"` + `fetchpriority="high"`; the rest
are lazy. `loading="lazy"` on an in-viewport image does not skip the fetch, it
just deprioritises it — see PERF.md.

## `content-visibility: auto` is not a free win

It is applied to `.row` and `.comment-row` but deliberately **NOT** to `.c`,
the grid card. On a dense auto-fill grid it is a net loss on WebKit: every card
crossing the relevance boundary is laid out or skipped mid-scroll, and because
a grid item's height feeds its row's height, each transition re-sizes the
track. Removing it from `.c` cut janky frames from 17 to 11 of 149 on the
channel grid; see PERF.md for the isolation table. Before adding it anywhere
new, measure that surface on WebKit — do not assume the Chromium result.

## Non-negotiables (carried over — every one of these has bitten us)

- No `innerHTML` anywhere. Trusted Types is enforced on youtube.com.
- Reveal a stylesheet-hidden element by adding a class, never by clearing an
  inline `display` — `el.style.display = ''` falls back to the stylesheet's
  `display: none`. This shipped: every long comment was clamped to four lines
  with a permanently invisible "Show more" button.
- Player position must repaint on `seeking`/`seeked`, not only `timeupdate` —
  timeupdate stops while a seek re-buffers, so a jump to an unbuffered position
  left the clock and the seek bar showing the OLD position until playback
  resumed. On a slow connection that reads as a scrub that did nothing and then
  lurched.
- Ads share the content `<video>`, so an ad's `ended` fires on the element
  Flyt's own listeners are bound to. Every per-video handler must bail on
  `adActive` — the autoplay-next handler didn't, and a pre-roll navigated
  straight to the next video and corrupted history.
- `#movie_player` shadows `addEventListener` — bind via
  `EventTarget.prototype.addEventListener.call(player, …)`.
- Never cycle `loadModule`/`unloadModule('captions')` — stalls the player at
  readyState 0.
- Volume: element volume = ratio × player volume (loudness normalisation);
  debounce ≥300ms or the sliders drift.
- Never sweep the DOM while the user is scrolling.
