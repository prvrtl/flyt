# RECOVERY.md — fixing Flyt after YouTube changes something

Flyt renders its own UI from YouTube's **data** (`ytInitialData`, InnerTube
`/youtubei/v1/*`, the `#movie_player` object). It therefore breaks whenever
YouTube changes a payload shape, a player method, a DOM hook, an endpoint, or an
event. This file is the map from *"something is broken"* to *"here is the exact
line that depends on the thing YouTube changed, and here is how to re-point it."*

Read `ARCHITECTURE.md` for **why** the app is shaped this way; this file is the
**recovery runbook**. All `file:line` refer to `flyt.user.js` (currently
~9,340 lines) unless noted. Test checks live in `tests/checks/*.js`, dispatched
by `tests/run.js`.

---

## Step 0 — is it actually a YouTube change?

The Playwright suite hits **live youtube.com, logged out**. A red run can be
YouTube serving different data that hour, not a code bug.

1. **Re-run** the failing check in isolation: `cd tests && node run.js --page=<page> --check=<check>`, or `--check=<subname>` for one named functional check (see `FUNCTIONAL_ENTRIES` in `tests/run.js` for the full list). A failure that clears on re-run was a live-data flake (empty related rail, re-ranked feed, an ad that did/didn't serve). The suite's own comments call these out.
2. If it fails **consistently**, it is a real coupling break — continue below.
3. Reproduce against the real site with the userscript injected before diagnosing shape (see Step 3 for capturing a live payload).

Distinguish the three break classes early, because they live in different places:

| Class | Looks like | Where to look |
|---|---|---|
| **Payload shape** (most common) | A section renders empty / a card is missing a field / an extractor returns `null` | §3 renderer/viewModel keys; the extractor functions |
| **Player API** | Video/controls dead, volume/seek/speed/captions no-op, autoplay stuck | §4 player object |
| **DOM / CSS / event** | Nav does a full reload, ads not blanked, captions unstyled, real YouTube flashes | §5 DOM hooks, §6 events |

---

## Step 1 — triage by symptom (which test is red → which coupling → which function)

| Symptom / red check | Likely coupling that moved | Inspect | Re-map hint |
|---|---|---|---|
| Feed/search/channel cards missing or empty (`snapshot` counts below floor, `checkInfiniteScroll`) | `lockupViewModel` / `videoRenderer` field paths, or the continuation token path | `extractVideos` (3765), `lockupItem` (3731), `findContinuationToken` (3891) | §3; capture a `browse`/`search` response, diff the item shape |
| Watch title/owner/stats blank, skeleton never reveals (`runWatchFunctional`, `checkWatchLoadSkeleton`) | `videoPrimaryInfoRenderer` / `videoSecondaryInfoRenderer` / `videoOwnerRenderer`, or `ytInitialPlayerResponse.videoDetails` | `renderMeta` (7585), `resolveOwnerChannelId` (3556) | §3 watch metadata; note reveal is gated on a non-empty owner name, not a terminal skeleton lock |
| Related rail empty, watch→watch nav broken (`checkWatchToWatchNavigation`) | `next` response shape or `loadVideoById`/`yt-navigate` | `renderWatchFor` (8920), `ytNavigate` (9012) | §1 `next`, §6 events |
| Comments don't load / authors not links (`checkCommentBodyLinks`, `checkCommentsOffCopy`) | `commentEntityPayload` (VM) or `commentThreadRenderer` (legacy), comments continuation | `commentEntityMap` (3955), `extractComment` (4015), `findCommentsToken` (3926) | §3 comments |
| Comments rail tab stuck disabled / wrong count (`commentssort`, `runWatchFunctional`) | `getCommentsCount`/`getCommentsCountLabel` reading `commentsHeaderRenderer.countText`, or the rail-tab wiring | `getCommentsCount`/`getCommentsCountLabel` (4075/4081), `railTabs`/`setRailTab` (7365/7418) | §3 comments; comments are a rail **tab**, not a separate page section |
| Like/dislike/save/**subscribe** silently revert when signed in | The mutation **confirmation** check no longer matches the response | `mutationConfirmed` (3625), `subscribeConfirmed` (3638) | §1 mutations; YouTube dropped the confirming field — loosen the check (see box below) |
| Channel header/tabs/About blank (`runChannelChecks`, `checkAboutTab`) | `c4TabbedHeaderRenderer`/`pageHeaderRenderer`, `aboutChannelViewModel`, or the `/about` HTML marker | `paintHeader` (6013), `loadAbout`/`fetchAboutPage` (6251/6142) | §3 channel, §7 HTML scrape |
| Nav does a full page reload / real YouTube flashes (`checkFeedToWatchNavigation`, `hardnav`, `checkYtdAppHidden`) | `ytd-app` gone/renamed, `yt-navigate` detail shape, or `#movie_player` id | `ytNavigate` (9012), park CSS (2726), `player` (6372) | §5, §6; watch the `bootWatch` timeout → hard-nav fallback (9047) |
| Ads not skipped/blanked (`checkVideoAds`, `checkAdStateMachine`) | `ad-showing`/`ad-interrupting` class or the skip-button selectors | `adShowing` check (6421), `clickSkipAd` (6424) | §5 ads; **`getAdState` is deliberately not used** — the class is the signal |
| No API calls at all, everything empty | `window.ytcfg.data_` shape (`INNERTUBE_API_KEY`/`INNERTUBE_CONTEXT`) or the SAPISID cookie | `cfg` (3324), `innertube` (3344), `sapisidHash` (3328) | §2 |
| Sidebar subscriptions empty | `guide` endpoint / `guideEntryRenderer` / `ytInitialGuideData` | `fetchGuideChannels` (4814), `collectGuideChannels` (4796) | §3; **UNGUARDED** — no test catches this |
| Sidebar subs not in chronological order (`checkSubscriptionsChronological`) | `parseRelativeTime`/`sortByRecency`, or a locale whose relative-time phrasing isn't matched | `parseRelativeTime` (3696), `sortByRecency` (3718) | §3; en/de/uk/ru only — ranked feeds (home) are deliberately exempt, guarded separately by `checkHomeOrderNotSorted` |
| Transcript pill never appears / never loads (`transcript`, `transcript-lazy`, `transcript-unavailable`) | `getPlayerResponse()`/`window.ytInitialPlayerResponse` no longer carries `captions.playerCaptionsTracklistRenderer`, or the caption `baseUrl` fetch shape changed | `waitForPlayerResponse` (7866), `loadTranscript` (7883), pill gate in `resetTranscript` (7844) | §3 transcript — no `innertube('player')` call exists; this is read straight off the player response, then `baseUrl + '&fmt=json3'` is fetched directly |
| Description links/chips missing (`descriptionchips`) | `attributedDescription`/description `runs` shape | `buildDescriptionSegments` (7446), `buildRunsSegments`/`buildAttributedSegments` (3969/3982) | §3 description |
| Mini-player won't collapse/expand, or expand causes a visible reload (`miniplayer`, `mini-expand-seamless`) | Mini-player DOM (`miniExpand`/`miniBar`, 5346–5354) or the no-reload nav gate | `ensureWatchPlayback` (9091), `watchNav` (9117) | §4/§6; expand must hit the `getVideoData().video_id === videoId` branch (9096) and skip `loadVideoById` entirely |
| Back/forward re-fetches instead of restoring, or duplicates items (`back-forward-cache`) | `listCache`/`keyFor`/`touchListCache` LRU, or `seen` re-arming on restore | `listCache` (5476), `keyFor` (9158), nav dispatch (9182–9202) | §3; channel pages are deliberately NOT cached (see ARCHITECTURE.md) |
| List/watch skeletons never show or never clear (`checkListSkeleton`, `checkWatchLoadSkeleton`) | Skeleton builders or the show/clear wiring | `createCardSkeleton`/`createRowSkeleton`/`createRelatedSkeleton` (4238/4247/4259), `showSkeleton`/`clearSkeleton` (5571/5568) | §3 |
| Theater mode broken (no scrim fade, cursor-hide stuck, layout classes wrong) (`checkTheaterMode`) | Theater CSS classes or the enter/exit scrim sequencing | `theaterPref`/`setTheaterPref` (31/32), theater CSS block (1153+) | §5; see ARCHITECTURE.md "Theater mode v2" |
| Autoplay-to-next never fires or fires on the wrong video (`checkAutoplayNext`) | The `itube-autoplay` pref read, or the end-of-video → next-id resolution | `autoplayEnabled` read (8061), end-of-playback hook (~8666) | §3; the pref is read once at document-start, so a toggle mid-session needs a fresh context to observe (see the test's own comment) |
| Privacy opt-out ignored — RYD or SponsorBlock still fetches with the toggle off (`sponsorblock-disabled`, `dislikes-opt-out`) | `dislikesEnabled()`/`sponsorSkipOn()` gate stripped from the fetch path | `dislikesEnabled` (35) gating `fetchDislikes` (3403), `sponsorSkipOn` (33) gating `sbLoad` (8068) | §2.4; both gates must short-circuit **before** any network call, not just before rendering the result |

> **The mutation-confirmation trap.** Optimistic actions (like/dislike/save/
> subscribe) flip the UI, call InnerTube, then **revert unless the response
> confirms**. Two ways this bit us, both making a *successful* action look
> broken: (1) requiring a confirming field YouTube stopped sending
> (`subscribeConfirmed` once demanded `updateSubscribeButtonAction.subscribed`);
> and (2) mis-reading a normal success signal as a failure — a successful
> subscribe response carries an `openPopupAction` (the notification popup) and
> client signals, and the "blocked" detector used to treat ANY
> `openPopupAction`/`CLIENT_SIGNAL` as blocked, so the button flipped then
> snapped back (you'd be subscribed after a refresh). The "blocked" signal is now
> narrowed to **`signInEndpoint` only** (`mutationConfirmed` 3625,
> `subscribeConfirmed` 3638), and `subscribeConfirmed` reverts only on a
> `signInEndpoint` or an *explicitly contradicting* `updateSubscribeButtonAction`
> (3644). Guarded by `checkSubscribeConfirmsOnPopup` (fakes LOGGED_IN + mocks a
> success-with-popup response); the real signed-in network path is still
> otherwise **UNGUARDED** — the suite runs logged out.

---

## Step 2 — the coupling map

Everything Flyt depends on in YouTube. A change to any of these can break it.
Verified against the code; spot-check the `file:line` before trusting a row —
line numbers drift as the file changes.

### 2.1 InnerTube endpoints — all via `innertube(endpoint, body)` (3344)
URL: `/youtubei/v1/<endpoint>?key=<INNERTUBE_API_KEY>&prettyPrint=false`, POST,
`credentials:'include'`, body `{ context: INNERTUBE_CONTEXT, ...body }`. Any
failure returns `null` → caller shows empty/error state.

| Endpoint (body keys) | file:line | Consumer | Guarded by |
|---|---|---|---|
| `browse` (`browseId` / `continuation` / `browseId,params`) | multiple call sites throughout home/feed/channel mounts | home / feed / channel mounts | functional, channels, signedout |
| `search` (`query[,params]` / `continuation`) | ~5804 | `mountSearch` | `checkFiltersInUrl`, `checkSearchSuggestions` |
| `next` (`videoId[,playlistId]` / `continuation`) | watch meta+related, queue, comments, replies (near 8920, 3891, 4060) | watch meta, related, queue, comments, replies | `runWatchFunctional`, `checkWatchToWatchNavigation` (replies UNGUARDED) |
| `guide` (`{}`) | 4817 | sidebar subs | **UNGUARDED** |
| `navigation/resolve_url` (`url`) | 5888 | channel handle→UC id | `runChannelChecks` |
| `like/like` · `like/dislike` · `like/removelike` (`target:{videoId}`) | 7058, 7076 | like/dislike | signedout (signed-in UNGUARDED) |
| `subscription/subscribe` · `/unsubscribe` (`channelIds:[id], params`) | 6098–6099, 7125–7126 | subscribe | signedout (signed-in UNGUARDED) |
| `browse/edit_playlist` (`playlistId:'WL', actions:[…]`) | 7095 | Watch Later save | signedout (signed-in UNGUARDED) |

### 2.2 Global objects & cookies
| Thing | file:line | Consumer |
|---|---|---|
| `window.ytcfg.data_` → `INNERTUBE_API_KEY`, `INNERTUBE_CONTEXT`, `LOGGED_IN` | 3324, 3346, 3326 | `cfg`, `innertube`, `loggedOut` |
| Cookie `__Secure-3PAPISID` / `SAPISID` → `SAPISIDHASH` auth header | 3328–3335 | `sapisidHash` (authed endpoints) |
| `window.ytInitialData` | 7585 default param and many `findNode(data, …)` call sites | cold mounts, watch meta, comments |
| `window.ytInitialPlayerResponse.{playabilityStatus.status, videoDetails.*}` | consumed via `waitForPlayerResponse` (7866) and directly in `renderMeta` (7585+) | `renderMeta`, transcript, `playabilityStatus` |
| `window.ytInitialGuideData` | 4796, 4815 (fast path), 5143 | guide fast path (UNGUARDED) |

### 2.3 Renderer / viewModel / entityPayload keys
Walked by `walk`/`findNode` (3449/3463), which **skips ad subtrees** (`AD_KEYS`
3423, `AD_KEY_RE` 3445). Each key is a hard string literal — a rename here
silently drops data.

- **List items:** `lockupViewModel` (video: `.contentId`, `.metadata.lockupMetadataViewModel.title.content`, `.contentImage.thumbnailViewModel.image.sources`, `.metadata.metadataRows`, avatar via `.metadata.image.decoratedAvatarViewModel…onTap` / `.avatarStackViewModel`) — `lockupItem` (3731); classic `videoRenderer` fields extracted alongside it in `extractVideos` (3765); resume % via `thumbnailOverlayResumePlaybackRenderer.percentDurationWatched` (3798, UNGUARDED).
- **Playlists:** `playlistRenderer`/`gridPlaylistRenderer`/`compactPlaylistRenderer` and `lockupViewModel` playlist variant (`extractPlaylists`, near `extractVideos`), queue `playlistPanelVideoRenderer` + `.playlist.playlistId/.contents`.
- **Continuations:** `continuationItemRenderer.continuationEndpoint.continuationCommand.token` (`findContinuationToken` 3891); comments section `itemSectionRenderer.sectionIdentifier==='comment-item-section'` (`findCommentsToken` 3926); comment sort `sortFilterSubMenuRenderer` (3944, UNGUARDED).
- **Watch meta:** `videoPrimaryInfoRenderer` (7588), `videoSecondaryInfoRenderer.owner.videoOwnerRenderer` (7589/7616), like state `segmentedLikeDislikeButtonViewModel` (3565, legacy `topLevelButtons[].toggleButtonRenderer`), subscribed `subscribeButtonRenderer`/ViewModel `.subscribed` (3653), chapters `engagementPanels[]…macroMarkersListItemRenderer.timeDescription` (6552).
- **Watch owner is mid-migration to viewModels** — some videos still expose `videoOwnerRenderer.{title.runs, thumbnail, subscriberCountText, navigationEndpoint.browseEndpoint}` (3557, 7616); others moved the SAME fields to viewModel equivalents under `owner`. `renderMeta` (7585) and `resolveOwnerChannelId` (3556) read BOTH shapes with `||` fallbacks, and on a cold load `ytInitialPlayerResponse.videoDetails.{author,channelId}` backstops name/id (but NOT on SPA nav — `details` is null there). Guarded by `checkWatchMetaReveals` against a known new-shape fixture. **The reveal must never gate terminally on the name** — an empty owner reveals anyway on the authoritative (`data !== ytInitialData`) render so the skeleton is never stuck.
- **Comments:** `frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload` (`commentEntityMap` 3955) + properties/author/toolbar reads in `extractComment` (4015); legacy `commentThreadRenderer` handled alongside it; count `commentsHeaderRenderer.countText` (`getCommentsCount` 4075, `getCommentsCountLabel` 4081) — feeds the comments **rail tab** label/enabled-state (`railTabs` 7365, `setRailTab` 7418), not a separate page section.
- **Channel:** `metadata.channelMetadataRenderer.externalId` (5883), `c4TabbedHeaderRenderer`/`pageHeaderRenderer` (6016–6017), `aboutChannelViewModel`/`channelAboutFullMetadataRenderer` (inside `fetchAboutPage` 6142), `guideEntryRenderer` (4800), `playlistHeaderRenderer.title` (6297, UNGUARDED).
- **Prompts / endpoints:** `backgroundPromoRenderer`/`feedNudgeRenderer`/`signInEndpoint`/`openPopupAction` (3608/3620), `updateSubscribeButtonAction.subscribed` (3644), and navigation endpoints `browseEndpoint`/`watchEndpoint`/`urlEndpoint` used by `channelHrefFrom` (3488), `buildRunsSegments`/`buildAttributedSegments` (3969/3982), `buildDescriptionSegments` (7446).

### 2.4 Third-party: Return YouTube Dislike (estimate only) and SponsorBlock
`fetchDislikes(videoId)` (3403) hits `GET https://returnyoutubedislikeapi.com/votes?videoId=<id>`,
`credentials:'omit'` (deliberately — a third-party host must never see YouTube
auth cookies), reads the `dislikes` field, `null` on any failure/timeout/
`deleted:true`/non-finite value. Gated on `dislikesEnabled()` (35, reads
localStorage `itube-dislikes`) — **the gate is checked before the fetch, not
just before rendering**, so opting out (`itube-dislikes=0`) means zero network
calls, guarded by `checkDislikesOptOut`. Consumed from `refreshActions` (7176)
with a per-video generation guard (`dislikeCountGeneration` 7010) so a slow
response for a video the user already navigated away from can't paint. Renders
into `dislikeLabel` with `dislikeBtn.title = 'Estimated dislikes · Return
YouTube Dislike'` (7201) — the `~` prefix and title are the only "this is an
estimate" labeling; do not drop them. On `null` the label is left **empty**,
never `0` or `NaN`. This is a genuine privacy tradeoff (video IDs leave the
page to a third party) the user explicitly accepted; if the endpoint
disappears or CSP starts blocking it, the feature should degrade to no-count,
not break the rest of the watch page. Guarded only by a mocked functional test
(`checkDislikeEstimate`); the real network call against the live RYD service is
otherwise UNGUARDED (see Blind spots).

SponsorBlock auto-skip works the same way: `sbLoad(videoId)` (8068) hits
`https://sponsor.ajay.app/api/skipSegments/<sha256-prefix>?categories=…`,
`credentials:'omit'`, gated on `sponsorSkipOn()` (33, localStorage
`itube-skip-sponsors`) checked **before** the fetch — opting out means zero
requests, guarded by `checkSponsorBlockDisabled`. Segments are cached per
video id (`sbCache`) and rendered as skip markers on the seek bar.

### 2.5 Player object (`#movie_player`, `player()` at 6372) & `<video>`
Every player call is optional-chained/`typeof`-guarded → a removed method
no-ops or falls back to the raw `<video>`. Key ones: `getVolume`/`setVolume`/
`isMuted`/`mute`/`unMute` (6396–6404, 8477–8512), `getVideoData().{video_id,isLive}`
(3538, 7669, 8206…), `loadVideoById` (called from `requestPlayback` 9091 — the
SPA-nav gate; see `ensureWatchPlayback` 9096 for the no-reload short-circuit),
`playVideo` (resumePlayback, 9066+), `setPlaybackRate` (8136),
`toggleSubtitles`/manual captions toggle (7140, 8855), `seekToLiveHead` (8489,
UNGUARDED), `previous/nextVideo` (8504–8505 — mini-player prev/next controls
only; MediaSession queue actions deliberately do NOT call these, see
ARCHITECTURE.md), `getPlayerResponse().storyboards…` (near 6593, UNGUARDED),
`.classList.contains('ad-showing'/'ad-interrupting')` (6421),
`getAvailableAudioTracks`/`getAudioTrack`/`setAudioTrack` (`syncAudioTrack`
6779, UNGUARDED via optional-chaining — feeds the Audio track row in the
Tools tray, hidden unless the video exposes more than one track).
`<video>`: `.currentTime/.duration/.paused/.readyState/.volume/.muted/.buffered`
and `.requestVideoFrameCallback` (6532, crossfade).
**Invariant:** `#movie_player` shadows `addEventListener`— bind its (and the
re-parented `<video>`'s crossfade) events via
`EventTarget.prototype.addEventListener.call(...)` or they no-op.

### 2.6 DOM / CSS hooks into YouTube's markup
`#movie_player` (queried in `player()` 6372), `ytd-app` (queried at 9013;
parked `left:-99999px !important` **not** `display:none` at 2726 — it must
keep laying out to decode), `<video>` re-parented into `#itube-stage`
(`adoptVideo` 6444), ad classes `ad-showing`/`ad-interrupting` (6421) via a
MutationObserver on `#movie_player`, skip-ad selectors
(`.ytp-skip-ad-button, .ytp-skip-ad, …` 6411–6414), caption container
`.ytp-caption-window-container` (`CAPTION_CONTAINER` 6450), search suggest host
`suggestqueries-clients6.youtube.com/complete/search?...&xhr=t` (4516).

### 2.7 Events & navigation
Dispatch `yt-navigate` on `ytd-app` with `detail.endpoint.{commandMetadata…webPageType:'WEB_PAGE_TYPE_WATCH', watchEndpoint:{videoId,playlistId}}`
(`ytNavigate` 9012) to boot YouTube's router and construct `#movie_player`;
listen `yt-navigate-finish` (8595, 9307); capture-phase `popstate` (9300);
`history.pushState/replaceState`; link interception gated by `NATIVE_NAV_RE`
(9140, tested at 9278). Fallback when the boot never lands: `bootWatch` (9047)
timeout → `location.assign` hard nav.

### 2.8 HTML scraping (the only one)
About tab: `fetch(channelBase()+'/about')` then extract `ytInitialData` from the
HTML via the marker string `'var ytInitialData = '` + a hand-written balanced-
brace scanner + `JSON.parse` (`fetchAboutPage` 6142). Breaks if the assignment
becomes `window["ytInitialData"] =` or a differently-quoted literal → returns
`null` → "Couldn't load channel info."

---

## Step 3 — re-mapping a changed data shape

1. **Capture the real payload.** In a normal browser tab on youtube.com (userscript can be off), open DevTools and grab the object Flyt reads:
   - Page data: `copy(window.ytInitialData)` / `copy(window.ytInitialPlayerResponse)`.
   - An InnerTube response: in the Network tab, find the `/youtubei/v1/<endpoint>` request Flyt makes (same `key`), copy its JSON response. Or replay it: `fetch('/youtubei/v1/next?key='+ytcfg.data_.INNERTUBE_API_KEY+'&prettyPrint=false',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({context:ytcfg.data_.INNERTUBE_CONTEXT, videoId:'<id>'})}).then(r=>r.json()).then(copy)`.
2. **Diff against the documented path.** Find the extractor from §2 and walk the captured object along the same path. The break is usually a **renamed wrapper** (e.g. `videoRenderer` → some `lockupViewModel`) or a **relocated field**. `findNode`/`walk` search the whole tree for a predicate, so a moved-but-same-key node still resolves; a **renamed key** does not.
3. **Fix the extractor**, preserving the fallback chain (new shape first, old shape as `||` fallback — see how `renderMeta` falls back from `videoSecondaryInfoRenderer` to `videoDetails`, or `readLikeState` from `segmentedLikeDislikeButtonViewModel` to `topLevelButtons`). Keep both so older payloads still work. **No `innerHTML`** — build DOM the same way (see invariants).
4. **Re-point, don't restyle.** Flyt renders its own DOM; you are only changing which *data path* feeds it. Do not start reading YouTube's rendered DOM instead.
5. **Add/adjust a test.** If the broken coupling was UNGUARDED (§ below), add a check in the matching `tests/checks/*.js` that would have caught it — assert the extractor yields a non-empty value on the live page. Prove it RED against the broken code, GREEN against the fix (the suite's discipline: a check that can't fail is worthless).
6. **Verify:** `cd tests && npm test` (full suite green), `npm run test:selftest` (checks can still fail), `node bench.js` (no perf regression).

---

## Invariants — never violate (these are load-bearing)

1. **No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`eval`/`new Function`.** youtube.com enforces Trusted Types; any of these throws and kills the view. Build DOM with `createElement`/`textContent`/`replaceChildren`.
2. **`#movie_player` shadows `addEventListener`** — bind its events via `EventTarget.prototype.addEventListener.call(player, …)` or they silently do nothing.
3. **Never cycle `loadModule`/`unloadModule('captions')`** — it stalls the player at `readyState 0`. Toggle captions only via `toggleSubtitles`.
4. **`ytd-app` is parked offscreen (`left:-99999px`), never `display:none`** — the player must keep laying out to decode. `display:none` stops decode.
5. **`ytd-app` must exist** for `yt-navigate` to boot YouTube's router and build `#movie_player`; without it Flyt falls back to full page loads.
6. **Volume:** element volume = ratio × player volume (loudness normalization); persist writes debounced ≥300ms or the sliders drift. **Ad mute must not be persisted.**
7. **No per-card work / no per-frame steady-state cost / no animations** except the deliberate thumbnail fade and the watch crossfade/skeleton. Performance is the product; `perf` + `layout` + `bench.js` enforce it.
8. **No code comments in `flyt.user.js`** — it must read as human-written. (Comments in `tests/**` are expected.)
9. **Generation-guard discipline on every async watch path.** `renderGeneration`, `transcriptGeneration`, `commentsGeneration`, and the list-view `seen`/continuation generation are bumped on every navigation/reset. Anything that awaits across a navigation boundary (an `innertube()` fetch, a `yieldTask()`/`scheduler.yield` chunk) must re-check its captured `gen` against the live counter before touching shared state or the DOM — otherwise a fetch that resolves after the user already navigated away appends stale rows or renders stale content. The `updateQueue`/`onNavigateFinish` guards follow the same discipline.
10. **Popover/anchor menu UA behavior.** Popover menus (account menu, search-suggest, Quality/Speed tool menus) call `showPopover()`/`hidePopover()` manually rather than using a native `popovertarget` invoker relationship — see ARCHITECTURE.md for the light-dismiss race this leaves theoretically open and the fallback fix if it ever surfaces.
11. **`window.CSS` gotcha:** never reference the bare identifier `CSS` anywhere in `flyt.user.js` — the file declares a top-level `const CSS` (the CSS-in-JS stylesheet, ~331) later in the same IIFE scope, so an earlier bare reference hits its temporal dead zone and throws at runtime. `node --check` does not catch this. Always use `window.CSS`.
12. **`@grant none` is load-bearing.** Flyt reads `window.ytInitialData`/`window.ytcfg`/`#movie_player` directly in the page's own JS context. Any `@grant` other than `none` (even just declaring one `GM_*` grant) switches Tampermonkey/Userscripts.app into a sandboxed/isolated world where the script no longer shares `window` with the page, and every one of these reads breaks.

---

## Blind spots — couplings NO test will catch

If one of these breaks, the suite stays green and only a human notices. Check
these manually after any large YouTube change, and prefer adding a guard when
you touch them:

- **Sidebar subscriptions** (`guide` endpoint, `guideEntryRenderer`, `ytInitialGuideData`).
- **Comment replies** (`next` reply continuation) and **comment sort** (`sortFilterSubMenuRenderer`).
- **Continue-watching** resume % (`thumbnailOverlayResumePlaybackRenderer`).
- **Player quality menu** (`getAvailableQualityLevels`, `setPlaybackQualityRange`), **live edge** (`seekToLiveHead`), **seek preview** storyboards, **audio track selector** (`getAvailableAudioTracks`).
- **Signed-in mutation success** for like/dislike/save/subscribe — only the signed-out prompt is guarded, so a reverting-on-success regression (the subscribe trap above) ships green.
- **Playlist header title**, **caption CSS restyle**, **`video.buffered`** bar.
- **Return YouTube Dislike and SponsorBlock live network calls** — the mocked functional tests prove the render/gating path, not that `returnyoutubedislikeapi.com`/`sponsor.ajay.app` themselves are still reachable/shaped the same; a real outage or schema change just silently empties the count or skips no segments (by design, see 2.4).
- **Chronological subs sort locales** — `parseRelativeTime` only understands en/de/uk/ru phrasing; an unrecognized locale's relative-time string silently fails to parse and that item sorts as if it had no timestamp.
