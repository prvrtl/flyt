#!/usr/bin/env node
// Orchestrator: runs every check across every page in one browser session
// per page, prints a PASS/FAIL table, and exits non-zero on any failure.
'use strict';

const {
  launchBrowser,
  newContext,
  openPage,
  waitForApp,
} = require('./lib/harness');
const { runLayoutChecks } = require('./checks/layout');
const {
  runWatchFunctional,
  checkYtdAppHidden,
  checkWatchToWatchNavigation,
  checkHomeNavigation,
  checkFeedToWatchNavigation,
  checkShortsRedirect,
  checkLiveRedirect,
  checkTrackingParamsStripped,
  checkCardTitleHeight,
  checkInfiniteScroll,
  checkUnhandledPage,
  checkUnhandledLinkRouting,
  checkResponsive,
  checkDescriptionTimestampSeek,
  checkCommentBodyLinks,
  checkCommentsOffCopy,
  checkUserRouteClientSide,
  checkFiltersInUrl,
  checkSearchSuggestions,
  checkSuggestionsDontResurrectAfterSubmit,
  checkAboutTab,
  checkVideoCrossfade,
  checkCrossfadeSkipsWithPiP,
  checkWatchLoadSkeleton,
  checkSkeletonReducedMotion,
  checkColdLoadSkeleton,
  checkBootLoaderColdLoad,
  checkBootLoaderFeedColdLoad,
  checkBootLoaderReducedMotion,
  checkBootLoaderNoSpaReappear,
  checkAudioTrackSelector,
  checkThumbFlyAnimation,
  checkTheaterMode,
  checkAbLoop,
  checkWatchResponsive,
  checkNoScrollWatch,
  checkWatchPopups,
  checkCommentsSortVisibility,
  checkDescriptionChips,
  checkPlaybackSpeed,
  checkSpaceToggle,
  checkTranscript,
  checkTranscriptProvedUnavailable,
  checkTranscriptOffByDefault,
  checkVolumeBoost,
  checkToolsRow,
  checkA11yTabStops,
  checkPopupDialogSemantics,
  checkRailTabAria,
  checkAudioOnly,
  checkAccountMenu,
  checkRailAlignment,
  checkNativeRoutePassthrough,
  checkSettings,
  checkCommandPalette,
  checkHoverStates,
  checkFrameExport,
  checkDislikeEstimate,
  checkDislikesOptOut,
  checkSponsorBlock,
  checkSponsorBlockDisabled,
  checkWatchMetaReveals,
  checkSubscribeConfirmsOnPopup,
  checkItubeToggle,
  checkFeedFilter,
  checkMiniPlayer,
  checkMiniExpandSeamless,
  checkSearchNoRefetch,
  checkTranscriptLazy,
  checkThumbSizing,
  checkMiniListenerLeak,
  checkListSkeleton,
  checkFlyOffscreenGuard,
  checkBackForwardCache,
  checkMediaSession,
  checkAutoplayNext,
  checkFollowingPage,
  checkPlaylistsPage,
  checkChannelSubscribeState,
  checkWatchSubscribeState,
} = require('./checks/functional');
const { takeSnapshot, saveScreenshot, diffSnapshot } = require('./checks/snapshot');
const { checkVideoAds, checkFeedAds, checkAdStateMachine } = require('./checks/ads');
const { runChannelChecks } = require('./checks/channels');
const { checkGeometry } = require('./checks/geometry');
const { checkNodeBudget } = require('./checks/perf');
const { checkGatedFeeds, checkHeaderSignIn, checkWatchActions } = require('./checks/signedout');
const { checkSubscriptionsChronological, checkHomeOrderNotSorted } = require('./checks/feedorder');

const PAGES = {
  home: 'https://www.youtube.com/',
  search: 'https://www.youtube.com/results?search_query=liquid+glass+design',
  channel: 'https://www.youtube.com/@mkbhd/videos',
  watch: 'https://www.youtube.com/watch?v=aircAruvnKk',
  // A public playlist (3Blue1Brown, "Neural networks") — the /playlist route
  // renders through the same feed mount as the sidebar's Watch later, so this
  // covers a code path nothing else touched.
  playlist: 'https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi',
  // A route Flyt deliberately does not implement: it must render the
  // "isn't available in Flyt yet" card and STILL keep ytd-app hidden.
  unhandled: 'https://www.youtube.com/premium',
};

// Pages that are feeds of clickable video cards — the ones where the
// feed -> watch hard-navigation regression can be observed.
const FEED_PAGES = new Set(['home', 'search', 'channel', 'playlist']);

// Pages with a paginated list behind an IntersectionObserver sentinel.
const SCROLLING_PAGES = new Set(['search', 'channel']);

// A regular video used for the /shorts/<id> redirect check (the redirect is
// id-preserving, so any watchable id proves it).
const SHORTS_REDIRECT_ID = 'aircAruvnKk';

// A known multi-audio-track video (dubbed languages + original), used by
// checkAudioTrackSelector — the default watch fixture above is single-track.
const MULTI_AUDIO_VIDEO_ID = '0e3GPea1Tyg';

const ERROR_PATTERN = /itube|innerHTML|Trusted Types/i;

function parseArgs(argv) {
  const args = { page: null, check: null, update: false, force: false, selftest: false };
  for (const a of argv) {
    if (a === '--update') args.update = true;
    else if (a === '--force') args.force = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a.startsWith('--page=')) args.page = a.slice('--page='.length);
    else if (a.startsWith('--check=')) args.check = a.slice('--check='.length);
  }
  return args;
}

function fmt(v) {
  return `check=${v.check} ${v.detail}`;
}

// The run-once feature checks below (as opposed to the per-page layout/
// snapshot/functional/etc. checks in runPageChecks) each want their own
// fresh browser context rather than sharing one of the five PAGES' contexts,
// so historically each was its own hand-rolled `if (!args.page && (!args.check
// || args.check === 'functional')) { ... }` block in main() — ~15 lines of
// copy-pasted try/catch/status/table/console boilerplate per check, and with
// no way to select just one of them (every subname besides 'functional'
// itself matched nothing, in either this dispatch or the per-page one).
// FUNCTIONAL_ENTRIES is that dispatch as data: `subname` is what
// `--check=<subname>` selects (stable — external docs/muscle-memory may
// already reference these), `page`/`check` are the SUMMARY table's row
// identifiers (also kept stable), `errCheck` is the violation `check` name
// used when the function itself throws, and `run` is the check invocation
// (closing over whatever extra fixture id/constant it needs). `arg` picks
// whether `run` receives the shared per-run `browser` or `context`.
const FUNCTIONAL_ENTRIES = [
  { subname: 'shorts', label: `shorts (https://www.youtube.com/shorts/${SHORTS_REDIRECT_ID})`, page: 'shorts', check: 'functional', errCheck: 'shorts-redirect', arg: 'context', run: (context) => checkShortsRedirect(context, SHORTS_REDIRECT_ID) },
  { subname: 'live', label: `live (https://www.youtube.com/live/${SHORTS_REDIRECT_ID})`, page: 'shorts', check: 'functional', errCheck: 'live-redirect', arg: 'context', run: (context) => checkLiveRedirect(context, SHORTS_REDIRECT_ID) },
  { subname: 'tracking-params', label: 'tracking params scrubbed from URL', page: 'watch', check: 'functional', errCheck: 'tracking-params-stripped', arg: 'context', run: (context) => checkTrackingParamsStripped(context, SHORTS_REDIRECT_ID) },
  { subname: 'card-title', label: 'card titles reserve two lines (uniform grid rows)', page: 'channel', check: 'functional', errCheck: 'card-title-height', arg: 'context', run: (context) => checkCardTitleHeight(context) },
  { subname: 'audiotrack', label: `audio track selector (https://www.youtube.com/watch?v=${MULTI_AUDIO_VIDEO_ID})`, page: 'audiotrack', check: 'functional', errCheck: 'audio-track-selector', arg: 'browser', run: (browser) => checkAudioTrackSelector(browser) },
  {
    subname: 'thumbfly',
    label: 'thumbnail fly-in animation',
    page: 'thumbfly',
    check: 'functional',
    errCheck: 'thumb-fly-animation',
    arg: 'browser',
    // Unlike the rest of the table, this needs its own fresh watch page (not
    // just a fresh context) before the checked function runs.
    run: async (browser) => {
      const context = await newContext(browser);
      try {
        const { page } = await openPage(context, PAGES.watch);
        await waitForApp(page, { timeout: 30000 });
        return await checkThumbFlyAnimation(page);
      } finally {
        await context.close();
      }
    },
  },
  { subname: 'dislikeestimate', label: 'dislike estimate (Return YouTube Dislike, mocked)', page: 'dislikeestimate', check: 'functional', errCheck: 'dislike-estimate', arg: 'browser', run: (browser) => checkDislikeEstimate(browser) },
  { subname: 'dislikes-opt-out', label: 'dislikes opt-out (itube-dislikes=0, no RYD fetch)', page: 'dislikes-opt-out', check: 'functional', errCheck: 'dislikes-opt-out', arg: 'browser', run: (browser) => checkDislikesOptOut(browser) },
  { subname: 'sponsorblock', label: 'sponsorblock auto-skip (mocked)', page: 'sponsorblock', check: 'functional', errCheck: 'sponsorblock', arg: 'browser', run: (browser) => checkSponsorBlock(browser) },
  { subname: 'sponsorblock-disabled', label: 'sponsorblock disabled (itube-skip-sponsors=0, no fetch)', page: 'sponsorblock-disabled', check: 'functional', errCheck: 'sponsorblock-disabled', arg: 'browser', run: (browser) => checkSponsorBlockDisabled(browser) },
  { subname: 'watchmeta', label: 'watch meta reveals (viewModel owner shape)', page: 'watchmeta', check: 'reveals', errCheck: 'watch-meta-reveals', arg: 'browser', run: (browser) => checkWatchMetaReveals(browser) },
  { subname: 'subscribe', label: 'subscribe confirms on notification popup (signed-in path)', page: 'subscribe', check: 'confirms', errCheck: 'subscribe-confirms-on-popup', arg: 'browser', run: (browser) => checkSubscribeConfirmsOnPopup(browser) },
  { subname: 'toggle', label: 'Flyt enable/disable toggle', page: 'toggle', check: 'functional', errCheck: 'itube-toggle', arg: 'browser', run: (browser) => checkItubeToggle(browser) },
  { subname: 'speed', label: 'playback speed', page: 'speed', check: 'functional', errCheck: 'playback-speed', arg: 'browser', run: (browser) => checkPlaybackSpeed(browser) },
  { subname: 'space-toggle', label: 'Space play/pause after button click (coalesced togglePlayback)', page: 'space-toggle', check: 'functional', errCheck: 'space-toggle', arg: 'browser', run: (browser) => checkSpaceToggle(browser) },
  { subname: 'transcript', label: 'transcript', page: 'transcript', check: 'functional', errCheck: 'transcript', arg: 'browser', run: (browser) => checkTranscript(browser) },
  { subname: 'transcript-unavailable', label: 'transcript proved unavailable', page: 'transcript', check: 'functional', errCheck: 'transcript-proved-unavailable', arg: 'browser', run: (browser) => checkTranscriptProvedUnavailable(browser) },
  { subname: 'transcript-default-off', label: 'transcript off by default', page: 'transcript', check: 'functional', errCheck: 'transcript-default-off', arg: 'browser', run: (browser) => checkTranscriptOffByDefault(browser) },
  { subname: 'transcript-lazy', label: 'transcript lazy', page: 'transcript-lazy', check: 'functional', errCheck: 'transcript-lazy', arg: 'browser', run: (browser) => checkTranscriptLazy(browser) },
  { subname: 'boost', label: 'volume boost', page: 'boost', check: 'functional', errCheck: 'volume-boost', arg: 'browser', run: (browser) => checkVolumeBoost(browser) },
  { subname: 'miniplayer', label: 'mini-player', page: 'miniplayer', check: 'functional', errCheck: 'mini-player', arg: 'browser', run: (browser) => checkMiniPlayer(browser) },
  { subname: 'mini-expand-seamless', label: 'mini-player expand (seamless)', page: 'mini-expand-seamless', check: 'functional', errCheck: 'mini-expand-seamless', arg: 'browser', run: (browser) => checkMiniExpandSeamless(browser) },
  { subname: 'mini-listener-leak', label: 'mini-player listener leak', page: 'mini-listener-leak', check: 'functional', errCheck: 'mini-listener-leak', arg: 'browser', run: (browser) => checkMiniListenerLeak(browser) },
  { subname: 'search-no-refetch', label: 'search no-refetch', page: 'search-no-refetch', check: 'functional', errCheck: 'search-no-refetch', arg: 'browser', run: (browser) => checkSearchNoRefetch(browser) },
  { subname: 'back-forward-cache', label: 'back/forward cache', page: 'back-forward-cache', check: 'functional', errCheck: 'back-forward-cache', arg: 'browser', run: (browser) => checkBackForwardCache(browser) },
  { subname: 'thumb-sizing', label: 'thumb sizing', page: 'thumb-sizing', check: 'functional', errCheck: 'thumb-sizing', arg: 'browser', run: (browser) => checkThumbSizing(browser) },
  { subname: 'toolsrow', label: 'tools row', page: 'toolsrow', check: 'functional', errCheck: 'tools-row', arg: 'browser', run: (browser) => checkToolsRow(browser) },
  { subname: 'a11y-tabstops', label: 'a11y: collapsed tools tray tab stops', page: 'a11y-tabstops', check: 'functional', errCheck: 'a11y-tabstops', arg: 'browser', run: (browser) => checkA11yTabStops(browser) },
  { subname: 'a11y-popup-dialog', label: 'a11y: popup dialog semantics', page: 'a11y-popup-dialog', check: 'functional', errCheck: 'a11y-popup-dialog', arg: 'browser', run: (browser) => checkPopupDialogSemantics(browser) },
  { subname: 'a11y-rail-tabs', label: 'a11y: rail tab aria', page: 'a11y-rail-tabs', check: 'functional', errCheck: 'a11y-rail-tabs', arg: 'browser', run: (browser) => checkRailTabAria(browser) },
  { subname: 'watchresponsive', label: 'watch responsive layout', page: 'watchresponsive', check: 'functional', errCheck: 'watch-responsive', arg: 'browser', run: (browser) => checkWatchResponsive(browser) },
  { subname: 'commentssort', label: 'comments sort visibility', page: 'commentssort', check: 'functional', errCheck: 'comments-sort-visibility', arg: 'browser', run: (browser) => checkCommentsSortVisibility(browser) },
  { subname: 'descriptionchips', label: 'description link chips', page: 'descriptionchips', check: 'functional', errCheck: 'description-chips', arg: 'browser', run: (browser) => checkDescriptionChips(browser) },
  { subname: 'noscrollwatch', label: 'watch page fits without scrolling', page: 'noscrollwatch', check: 'functional', errCheck: 'no-scroll-watch', arg: 'browser', run: (browser) => checkNoScrollWatch(browser) },
  { subname: 'watchpopups', label: 'watch popups (description/transcript/comments)', page: 'watchpopups', check: 'functional', errCheck: 'watch-popups', arg: 'browser', run: (browser) => checkWatchPopups(browser) },
  { subname: 'audioonly', label: 'audio only', page: 'audioonly', check: 'functional', errCheck: 'audio-only', arg: 'browser', run: (browser) => checkAudioOnly(browser) },
  { subname: 'native-passthrough', label: 'native routes (/account etc.) pass through to YouTube', page: 'home', check: 'functional', errCheck: 'native-route-passthrough', arg: 'browser', run: (browser) => checkNativeRoutePassthrough(browser) },
  { subname: 'rail-alignment', label: 'collapsed rail centers brand/avatar/nav', page: 'home', check: 'functional', errCheck: 'rail-alignment', arg: 'browser', run: (browser) => checkRailAlignment(browser) },
  { subname: 'account', label: 'account menu', page: 'account', check: 'functional', errCheck: 'account-menu', arg: 'browser', run: (browser) => checkAccountMenu(browser) },
  { subname: 'settings', label: 'settings', page: 'settings', check: 'functional', errCheck: 'settings', arg: 'browser', run: (browser) => checkSettings(browser) },
  { subname: 'cmdk', label: 'command palette', page: 'cmdk', check: 'functional', errCheck: 'cmdk', arg: 'browser', run: (browser) => checkCommandPalette(browser) },
  { subname: 'feedfilter', label: 'feed filter', page: 'feedfilter', check: 'functional', errCheck: 'feedfilter', arg: 'browser', run: (browser) => checkFeedFilter(browser) },
  { subname: 'frameexport', label: 'frame export', page: 'frameexport', check: 'functional', errCheck: 'frame-export', arg: 'browser', run: (browser) => checkFrameExport(browser) },
  { subname: 'theater', label: 'theater mode', page: 'theater', check: 'functional', errCheck: 'theater-mode', arg: 'browser', run: (browser) => checkTheaterMode(browser) },
  { subname: 'abloop', label: 'A-B repeat loop', page: 'abloop', check: 'functional', errCheck: 'ab-loop', arg: 'browser', run: (browser) => checkAbLoop(browser) },
  { subname: 'coldload', label: 'cold-load skeleton (https://www.youtube.com/watch?v=aircAruvnKk)', page: 'coldload', check: 'skeleton', errCheck: 'cold-load-skeleton', arg: 'context', run: (context) => checkColdLoadSkeleton(context) },
  // The three boot-loader checks cover the window BEFORE the app shell even
  // exists (a separate concern from the watch-meta skeleton above), each
  // opening its own fresh page for the same reason checkColdLoadSkeleton
  // does — the sampler has to be installed before any page script runs.
  { subname: 'bootloader-cold-watch', label: 'boot loader: cold watch load', page: 'bootloader', check: 'cold-watch', errCheck: 'boot-loader-cold-watch', arg: 'context', run: (context) => checkBootLoaderColdLoad(context) },
  { subname: 'bootloader-cold-feed', label: 'boot loader: cold home load', page: 'bootloader', check: 'cold-feed', errCheck: 'boot-loader-cold-feed', arg: 'context', run: (context) => checkBootLoaderFeedColdLoad(context) },
  { subname: 'bootloader-reduced-motion', label: 'boot loader: reduced motion', page: 'bootloader', check: 'reduced-motion', errCheck: 'boot-loader-reduced-motion', arg: 'context', run: (context) => checkBootLoaderReducedMotion(context) },
  // MediaSession metadata/queue-action wiring: see checkMediaSession's own
  // comment for why this needs its own watch page rather than folding into
  // runWatchFunctional.
  { subname: 'mediasession', label: 'media session metadata', page: 'mediasession', check: 'functional', errCheck: 'mediasession', arg: 'browser', run: (browser) => checkMediaSession(browser) },
  // Autoplay-to-next: see checkAutoplayNext's own comment for why this needs
  // two fresh contexts (the itube-autoplay pref is read once at document-
  // start and can't be toggled after mount) rather than folding into
  // runWatchFunctional.
  { subname: 'autoplaynext', label: 'autoplay to next video', page: 'autoplaynext', check: 'functional', errCheck: 'autoplay-next', arg: 'browser', run: (browser) => checkAutoplayNext(browser) },
  { subname: 'following', label: 'Following page (sortable channels table, mocked guide/browse)', page: 'following', check: 'functional', errCheck: 'following-page', arg: 'browser', run: (browser) => checkFollowingPage(browser) },
  { subname: 'playlists', label: 'Playlists library (nav row + signed-out prompt)', page: 'playlists', check: 'functional', errCheck: 'playlists-page', arg: 'browser', run: (browser) => checkPlaylistsPage(browser) },
  { subname: 'geometry', label: 'Geometry invariants (sidebar column system, grid rhythm, watch columns, actions row)', page: 'geometry', check: 'functional', errCheck: 'geometry', arg: 'browser', run: (browser) => checkGeometry(browser) },
  { subname: 'channel-subscribe-state', label: 'channel page subscribe state derived from guide cache', page: 'channel', check: 'functional', errCheck: 'channel-subscribe-state', arg: 'browser', run: (browser) => checkChannelSubscribeState(browser) },
  { subname: 'watch-subscribe-state', label: 'watch page subscribe state derived from guide cache', page: 'watch', check: 'functional', errCheck: 'watch-subscribe-state', arg: 'browser', run: (browser) => checkWatchSubscribeState(browser) },
];

// Runs one FUNCTIONAL_ENTRIES entry: invokes it with the right arg (browser or
// the shared per-run context), normalizes its result (a bare violations array
// OR a { violations, skipped, detail } object — both shapes are in use across
// the checks above), prints its row, and pushes it onto the summary table.
// Returns true if the entry FAILED, so callers can fold that into `anyFail`.
async function runFunctionalEntry(entry, { browser, context, table }) {
  console.log(`\n--- ${entry.label} ---`);
  let result;
  try {
    result = await entry.run(entry.arg === 'context' ? context : browser);
  } catch (err) {
    console.error(`  ERROR running the ${entry.subname} check: ${err.stack || err}`);
    result = [{ check: entry.errCheck, detail: String(err.message || err).split('\n')[0] }];
  }
  const violations = Array.isArray(result) ? result : (result.violations || []);
  const skipped = !Array.isArray(result) && !!result.skipped;
  const detail = !Array.isArray(result) && result.detail ? result.detail : '';
  const status = violations.length ? 'FAIL' : (skipped ? 'SKIP' : 'PASS');
  table.push({ page: entry.page, check: entry.check, status, count: violations.length });
  const countSuffix = violations.length ? ` (${violations.length} violation${violations.length === 1 ? '' : 's'})` : '';
  const detailSuffix = detail ? ` — ${detail}` : '';
  console.log(`  ${entry.label}: ${status}${countSuffix}${detailSuffix}`);
  for (const v of violations) console.log(`    page=${entry.page} ${fmt(v)}`);
  return status === 'FAIL';
}

// Runs every applicable check against a single page inside one browser
// session, and returns { results: [{name, violations}], errors }.
async function runPageChecks(context, pageName, url, { checkFilter, update, force }) {
  const { page, errors } = await openPage(context, url);
  await waitForApp(page, { timeout: 30000 });

  const results = [];
  const want = (name) => !checkFilter || checkFilter === name;

  // Grid/list content (search results, channel videos, related videos)
  // fetches and renders a moment after waitForApp resolves. Give it a real
  // chance to settle before either layout or snapshot measure it, so both
  // checks see the same "loaded" page regardless of check order.
  await page.waitForFunction(() => {
    const grid = document.querySelector('.grid');
    if (grid && grid.children.length === 0) return false;
    return true;
  }, { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('.c, .rc, .row, #itube-stage', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Layout and snapshot read passive page state, so they must run BEFORE
  // functional — functional clicks around (expands comments, navigates to a
  // different video, reloads), which mutates the DOM and would otherwise
  // make the snapshot/layout measurements depend on functional's test order
  // instead of the page's natural first-load state.
  if (want('layout')) {
    const violations = await runLayoutChecks(page);
    results.push({ name: 'layout', violations });
  }

  if (want('snapshot')) {
    let snap = await takeSnapshot(page);
    let violations = diffSnapshot(pageName, snap, { update, force });
    // COUNTS are the one part of the snapshot that is a race, not a
    // measurement: a grid/rail keeps filling after the settle above, and under
    // full-suite load (five pages sharing one browser, ads and video decoding
    // in flight) the first sample can land mid-fill — which is exactly the
    // observed flake where channel/playlist failed in a full run and passed in
    // isolation. Geometry is stable at first paint; counts are not. So a count
    // violation is re-sampled ONCE after a real settle before it is believed.
    // A genuinely empty rail still fails: the floor is >= 1 and re-sampling an
    // empty grid returns 0 again.
    if (!update && violations.some((v) => v.check === 'snapshot-count')) {
      const first = violations.filter((v) => v.check === 'snapshot-count').map((v) => v.detail);
      await page.waitForTimeout(3000);
      const resampled = await takeSnapshot(page);
      const after = diffSnapshot(pageName, resampled, { update, force });
      const stillFailing = after.filter((v) => v.check === 'snapshot-count');
      console.log(`  ${pageName} / snapshot: count re-sample after settle — first pass: [${first.join(' ; ')}] -> counts now ${JSON.stringify(resampled.counts)} (${stillFailing.length} still below floor)`);
      snap = resampled;
      violations = after;
    }
    await saveScreenshot(page, pageName);
    results.push({ name: 'snapshot', violations });
  }

  // Responsive runs after the passive measurements (it resizes the viewport,
  // and restores it afterwards) but before functional, which navigates away.
  if (want('responsive')) {
    const violations = await checkResponsive(page);
    results.push({ name: 'responsive', violations });
  }

  // Passive too: counts nodes, clicks nothing. `perfViolations` is held by
  // reference: on the watch page a second pass appends to it once comments are
  // on screen (they do not exist until something expands them, and expanding
  // them here would break functional.js's "comments are collapsed by default"
  // assertion).
  let perfViolations = null;
  if (want('perf')) {
    perfViolations = await checkNodeBudget(page, pageName);
    results.push({ name: 'perf', violations: perfViolations });
  }

  if (want('functional')) {
    let violations = [];
    violations = violations.concat(await checkYtdAppHidden(page));
    if (pageName === 'unhandled') {
      violations = violations.concat(await checkUnhandledPage(page));
    }
    if (pageName === 'watch') {
      violations = violations.concat(await runWatchFunctional(page));
      violations = violations.concat(await checkWatchToWatchNavigation(page));
      violations = violations.concat(await checkVideoCrossfade(page));
      violations = violations.concat(await checkWatchLoadSkeleton(page));
      violations = violations.concat(await checkSkeletonReducedMotion(page));
      violations = violations.concat(await checkCrossfadeSkipsWithPiP(page));
      violations = violations.concat(await checkDescriptionTimestampSeek(page));
      violations = violations.concat(await checkCommentsOffCopy(page));
      const commentsTab = await page.$('.rail-tab:has-text("Comments")');
      const disabled = commentsTab ? await page.evaluate((el) => el.disabled, commentsTab) : true;
      if (commentsTab && !disabled) {
        const opened = await page.evaluate(() => document.querySelectorAll('.comment-row').length > 0);
        if (!opened) await commentsTab.click().catch(() => {});
        await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 15000 }).catch(() => {});
        violations = violations.concat(await checkCommentBodyLinks(page));
        const upNextTab = await page.$('.rail-tab:has-text("Up next")');
        if (upNextTab) await upNextTab.click();
      }
      // Runs last on watch (it navigates to yet another related video): with
      // comments already expanded above, the page is tall enough to scroll
      // deep and reproduce the owner-reported off-screen fly glitch.
      violations = violations.concat(await checkFlyOffscreenGuard(page));
    }
    if (SCROLLING_PAGES.has(pageName)) {
      violations = violations.concat(await checkInfiniteScroll(page, pageName));
    }
    if (pageName === 'search') {
      violations = violations.concat(await checkFiltersInUrl(page));
      violations = violations.concat(await checkSearchSuggestions(page));
      violations = violations.concat(await checkSuggestionsDontResurrectAfterSubmit(page));
    }
    if (pageName === 'channel') {
      violations = violations.concat(await checkAboutTab(page));
    }
    if (pageName !== 'watch') {
      violations = violations.concat(await checkHomeNavigation(page));
    }
    // Runs once (on home): clicking a route Flyt doesn't implement must be a
    // client-side route, while /redirect?q= must stay a native navigation.
    if (pageName === 'home') {
      violations = violations.concat(await checkUnhandledLinkRouting(page));
      violations = violations.concat(await checkUserRouteClientSide(page));
      violations = violations.concat(await checkBootLoaderNoSpaReappear(page));
      violations = violations.concat(await checkListSkeleton(page));
    }
    results.push({ name: 'functional', violations });
  }

  // Channel links run after functional (which navigates away) and before
  // hardnav, and they re-open the page under test themselves — they click
  // through to a channel page, so they cannot leave the page where they found
  // it.
  // `unhandled` is the one page with no cards and no author anywhere on it by
  // design, so there is nothing for these to assert.
  if (want('channels') && pageName !== 'unhandled') {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 });
    await page.waitForSelector('.c, .rc, .row, #itube-stage', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const violations = await runChannelChecks(page, pageName, url);
    results.push({ name: 'channels', violations });

    // Comment rows are cards too, and they are the one card kind that does not
    // exist at first paint. Budget them once they are actually rendered.
    if (pageName === 'watch' && perfViolations) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForApp(page, { timeout: 30000 });
      await page.evaluate(() => {
        const tab = Array.from(document.querySelectorAll('.rail-tab')).find((t) => t.textContent.includes('Comments'));
        if (tab) tab.click();
      }).catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 15000 }).catch(() => {});
      for (const v of await checkNodeBudget(page, pageName)) perfViolations.push(v);
    }
  }

  // Hard-navigation is its own check so it reads as its own row in the
  // summary table: it is the highest-value regression in the suite, and
  // burying it inside `functional` would hide it. It runs LAST on the page
  // because it navigates to /watch and walks the history stack.
  if (want('hardnav') && FEED_PAGES.has(pageName)) {
    // The preceding functional checks click "Home", so re-open the page under
    // test rather than asserting on whatever route we happen to be sitting on.
    // (When hardnav is the only check requested, the page is still pristine.)
    if (checkFilter !== 'hardnav') {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForApp(page, { timeout: 30000 });
      await page.waitForSelector('.c, .row', { timeout: 8000 }).catch(() => {});
    }
    const violations = await checkFeedToWatchNavigation(page, pageName);
    results.push({ name: 'hardnav', violations });
  }

  if (want('errors')) {
    const violations = [];
    for (const err of errors.pageErrors) {
      violations.push({ check: 'no-page-errors', detail: err.split('\n')[0] });
    }
    for (const msg of errors.consoleErrors) {
      if (ERROR_PATTERN.test(msg)) {
        violations.push({ check: 'no-console-errors', detail: msg });
      }
    }
    results.push({ name: 'errors', violations });
  }

  await page.close();
  return results;
}

// Injects the exact CSS bug that shipped (`.body { max-width: 1720px;
// margin: 0 auto; }`, which floats the sidebar into the middle of the
// screen) AFTER the app has mounted, then asserts the layout check catches
// it via the sidebar-pinned violation. This is the proof the pipeline is
// worth anything: if this fails, the checks aren't actually looking at
// geometry.
//
// The bug only manifests when the viewport is wider than the 1720px
// max-width (on a normal 1440px viewport `margin: 0 auto` has no leftover
// space to redistribute, so nothing moves) — this is exactly the wide
// desktop monitor scenario it originally shipped under, so the self-test
// runs in its own wide context rather than the default 1440px one.
async function runSelftest(browser) {
  const context = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
  const { page } = await openPage(context, PAGES.watch);
  await waitForApp(page, { timeout: 30000 });

  await page.addStyleTag({ content: '#itube .body { max-width: 1720px; margin: 0 auto; }' });
  await page.waitForTimeout(200);

  const violations = await runLayoutChecks(page);
  await context.close();

  const caught = violations.some((v) => v.check === 'sidebar-pinned');
  return { caught, violations };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();

  const browser = await launchBrowser();

  if (args.selftest) {
    console.log('=== SELF-TEST: injecting the shipped `.body { max-width: 1720px; margin: 0 auto }` bug ===');
    const { caught, violations } = await runSelftest(browser);
    for (const v of violations) console.log('  ' + fmt(v));
    console.log('');
    if (caught) {
      console.log('SELF-TEST PASSED: layout check detected the sidebar-pinned violation.');
    } else {
      console.log('SELF-TEST FAILED: layout check did NOT catch the injected bug. The pipeline is not trustworthy.');
    }
    await browser.close();
    console.log(`\nTotal runtime: ${((Date.now() - start) / 1000).toFixed(1)}s`);
    process.exit(caught ? 0 : 1);
  }

  const context = await newContext(browser);

  // `--check=ads` and `--check=signedout` run only their own suites, which own
  // their contexts — there is no point opening every page just to run zero
  // per-page checks on it.
  const OWN_CONTEXT_CHECKS = new Set(['ads', 'signedout', 'hover', 'feedorder', ...FUNCTIONAL_ENTRIES.map((e) => e.subname)]);
  const pageNames = OWN_CONTEXT_CHECKS.has(args.check) ? [] : (args.page ? [args.page] : Object.keys(PAGES));
  for (const name of pageNames) {
    if (!PAGES[name]) {
      console.error(`Unknown page "${name}". Known pages: ${Object.keys(PAGES).join(', ')}`);
      process.exit(2);
    }
  }

  const table = [];
  let anyFail = false;

  for (const pageName of pageNames) {
    const url = PAGES[pageName];
    console.log(`\n--- ${pageName} (${url}) ---`);
    let results;
    try {
      results = await runPageChecks(context, pageName, url, { checkFilter: args.check, update: args.update, force: args.force });
    } catch (err) {
      console.error(`  ERROR running checks for ${pageName}: ${err.stack || err}`);
      table.push({ page: pageName, check: 'harness', status: 'FAIL' });
      anyFail = true;
      continue;
    }
    for (const { name, violations } of results) {
      const status = violations.length === 0 ? 'PASS' : 'FAIL';
      if (status === 'FAIL') anyFail = true;
      table.push({ page: pageName, check: name, status, count: violations.length });
      console.log(`  ${pageName} / ${name}: ${status}${violations.length ? ` (${violations.length} violation${violations.length === 1 ? '' : 's'})` : ''}`);
      for (const v of violations) {
        console.log(`    page=${pageName} ${fmt(v)}`);
      }
    }
  }

  // The run-once feature checks: each wants its own fresh context/page rather
  // than sharing one of the five PAGES' contexts (a reload, a mocked route, a
  // specific fixture video, prefs read once at document-start, …). Selecting
  // a single one via --check=<subname> runs ONLY that check (see
  // OWN_CONTEXT_CHECKS above, which keeps the per-page loop from opening
  // anything when a subname is given); omitting --check or passing
  // --check=functional runs all of them, exactly as before the table existed.
  for (const entry of FUNCTIONAL_ENTRIES) {
    if (args.page) continue;
    if (args.check && args.check !== 'functional' && args.check !== entry.subname) continue;
    if (await runFunctionalEntry(entry, { browser, context, table })) anyFail = true;
  }

  // The signed-out suite runs once, in its own contexts: it opens the
  // account-gated feeds (subscriptions/history/library/Watch later), which are
  // not in PAGES because they render no content at all when logged out — which
  // is the entire point of the check.
  if (!args.page && (!args.check || args.check === 'signedout')) {
    for (const [name, fn] of [['feeds', checkGatedFeeds], ['header', checkHeaderSignIn], ['actions', checkWatchActions]]) {
      console.log(`\n--- signedout / ${name} ---`);
      let res;
      try {
        res = await fn(browser);
      } catch (err) {
        console.error(`  ERROR running the signedout/${name} check: ${err.stack || err}`);
        res = { violations: [{ check: 'signedout-' + name, detail: String(err.message || err).split('\n')[0] }], detail: '' };
      }
      const status = res.violations.length ? 'FAIL' : 'PASS';
      if (status === 'FAIL') anyFail = true;
      table.push({ page: 'signedout', check: name, status, count: res.violations.length });
      console.log(`  signedout / ${name}: ${status} — ${res.detail}`);
      for (const v of res.violations) console.log(`    page=signedout ${fmt(v)}`);
    }
  }

  // Subscriptions ordering runs once, in its own context: it mocks the
  // FEsubscriptions browse call (the live feed only renders a sign-in prompt
  // logged out — see checks/signedout.js) to prove the chronological sort
  // actually reaches the DOM, plus a source-level guard that the sort never
  // leaks into home/search/channel.
  if (!args.page && (!args.check || args.check === 'feedorder')) {
    for (const [name, fn] of [['subscriptions', checkSubscriptionsChronological], ['home-unsorted', checkHomeOrderNotSorted]]) {
      console.log(`\n--- feedorder / ${name} ---`);
      let res;
      try {
        res = await fn(browser);
      } catch (err) {
        console.error(`  ERROR running the feedorder/${name} check: ${err.stack || err}`);
        res = { violations: [{ check: 'feedorder-' + name, detail: String(err.message || err).split('\n')[0] }], detail: '' };
      }
      const status = res.violations.length ? 'FAIL' : 'PASS';
      if (status === 'FAIL') anyFail = true;
      table.push({ page: 'feedorder', check: name, status, count: res.violations.length });
      console.log(`  feedorder / ${name}: ${status} — ${res.detail}`);
      for (const v of res.violations) console.log(`    page=feedorder ${fmt(v)}`);
    }
  }

  // Ad removal runs once, in its own contexts (it seeds a known volume into
  // localStorage before load and hooks fetch to see the raw ad payloads), and
  // it is the one check that can legitimately be SKIPPED: YouTube may serve no
  // ad at all on a given run. A skip is reported, never laundered into a pass.
  if (!args.page && (!args.check || args.check === 'ads')) {
    for (const [name, fn] of [['statemachine', checkAdStateMachine], ['video', checkVideoAds], ['feed', checkFeedAds]]) {
      console.log(`\n--- ads / ${name} ---`);
      // The live-ad "video" check observes the ad being blanked/fast-forwarded,
      // which needs real compositing — headless Chromium plays the ad but does
      // not composite it the same way, so the neutralisation can't be observed.
      // Skip it headless (the default) and direct to HEADED=1; the state-machine
      // and feed-ad checks work headless and still run.
      if (name === 'video' && !process.env.HEADED) {
        console.log('  ads / video: SKIP — ad compositing is unreliable headless; run `HEADED=1 npm test` to verify ad handling');
        table.push({ page: 'ads', check: name, status: 'SKIP', count: 0 });
        continue;
      }
      let res;
      try {
        res = await fn(browser);
      } catch (err) {
        console.error(`  ERROR running the ads/${name} check: ${err.stack || err}`);
        res = { violations: [{ check: 'ads-' + name, detail: String(err.message || err).split('\n')[0] }], skipped: false, detail: '' };
      }
      const status = res.violations.length ? 'FAIL' : (res.skipped ? 'SKIP' : 'PASS');
      if (status === 'FAIL') anyFail = true;
      table.push({ page: 'ads', check: name, status, count: res.violations.length });
      console.log(`  ads / ${name}: ${status} — ${res.detail}`);
      for (const v of res.violations) console.log(`    page=ads ${fmt(v)}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('page'.padEnd(10) + 'check'.padEnd(14) + 'status');
  for (const row of table) {
    console.log(row.page.padEnd(10) + row.check.padEnd(14) + row.status);
  }

  await browser.close();
  console.log(`\nTotal runtime: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
