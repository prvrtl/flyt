// Behavioural checks: does the player actually work, does the custom bar
// respond to input, does navigation stay client-side, does the UI ever lie
// about state (e.g. "liked" when the like call actually failed).
'use strict';

const fs = require('fs');
const { waitForApp, openPage, newContext, SCRIPT_PATH, CONSENT_COOKIES } = require('../lib/harness');

// A known multi-audio-track video (dubbed languages + original). This is the
// only page in the suite that needs a SPECIFIC video rather than any watch
// URL, so it runs once, in its own context, rather than as part of
// runWatchFunctional (which runs against the default single-track video).
const MULTI_AUDIO_VIDEO_ID = '0e3GPea1Tyg';

// Perceived (relative) luminance of a `getComputedStyle(...).color` string
// (rgb()/rgba()), 0 (black) to 1 (white). Used to catch text that inherited
// a near-black color instead of the app's light --text token.
function luminanceOf(colorStr) {
  const m = /rgba?\(([^)]+)\)/.exec(colorStr || '');
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((n) => parseFloat(n));
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function getPlayerVolume(page) {
  return page.evaluate(() => {
    const p = document.getElementById('movie_player');
    if (p && typeof p.getVolume === 'function') return Math.round(p.getVolume());
    const v = document.querySelector('#itube-stage video');
    return v ? Math.round(v.volume * 100) : null;
  });
}

async function isPlayerMuted(page) {
  return page.evaluate(() => {
    const p = document.getElementById('movie_player');
    if (p && typeof p.isMuted === 'function') return p.isMuted();
    const v = document.querySelector('#itube-stage video');
    return v ? v.muted : null;
  });
}

// The <video> node is briefly absent while YouTube's player swaps elements
// around a preroll ad, so a bare querySelector here returns null and every
// caller that reads `.currentTime` off it throws. Poll for it, and if it is
// genuinely gone, return a sentinel rather than null: callers stay
// dereference-safe and the `video-ready` check reports the absence honestly
// instead of the run dying with a TypeError.
async function videoState(page) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      if (!v) return null;
      return { readyState: v.readyState, paused: v.paused, currentTime: v.currentTime, duration: v.duration };
    });
    if (state) return state;
    await page.waitForTimeout(300);
  }
  return { missing: true, readyState: 0, paused: true, currentTime: 0, duration: NaN };
}

// #itube-bar is hidden (opacity 0, visibility hidden, pointer-events none)
// until the stage gets a mousemove — it auto-hides again ~2.8s after the
// last one. Any check that clicks a bar control needs to summon it first.
async function showBar(page) {
  await page.hover('#itube-stage', { position: { x: 200, y: 200 } });
  await page.waitForTimeout(80);
}

// Clicks a card the way a human does: by pointing at a spot inside it.
//
// A card is no longer a single <a>. It is a container whose video link is an
// overlay anchor stretched across it, with the channel name sitting ABOVE that
// overlay as its own link. That is what makes the author reachable without
// nesting one <a> inside another. The consequence for a test is that
// `elementHandle.click()` on the card (or on its title/thumb) fails
// actionability with "…intercepts pointer events" — Playwright is right, the
// overlay does cover it, and that interception is the feature.
//
// So aim the mouse at the coordinates of a specific part of the card and let
// the browser hit-test, exactly like a user. `part` picks WHICH part, which
// matters: pointing at the channel name is supposed to open the CHANNEL, while
// pointing at the title/thumbnail is supposed to open the VIDEO.
async function clickCardPart(page, card, part) {
  const target = await card.$(part);
  const box = await (target || card).boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

// Runs the full watch-page functional suite. Assumes the harness already
// navigated to a /watch URL and waitForApp() resolved.
async function runWatchFunctional(page) {
  const violations = [];
  const report = (check, detail) => violations.push({ check, detail });

  // --- video mounted, decoding, and actually advancing ---
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && v.readyState >= 2;
  }, { timeout: 15000 }).catch(() => {});

  // The <video> must live INSIDE the stage and have real area. (The old check
  // was `if (!videoState(page))`, which became dead code the moment
  // videoState() started returning a sentinel object instead of null — it can
  // never be falsy, so it asserted nothing at all.)
  const placement = await page.evaluate(() => {
    const stage = document.getElementById('itube-stage');
    const v = document.querySelector('video');
    if (!v) return { video: false };
    const r = v.getBoundingClientRect();
    return {
      video: true,
      inStage: !!stage && stage.contains(v) && v !== stage,
      w: r.width,
      h: r.height,
    };
  });
  if (!placement.video) {
    report('video-in-stage', 'expected a <video> element on the watch page, found none');
    return violations;
  }
  if (!placement.inStage) {
    report('video-in-stage', 'expected the <video> to be a descendant of #itube-stage — it is mounted somewhere else, so YouTube still owns the player');
  }
  if (!(placement.w > 0 && placement.h > 0)) {
    report('video-in-stage', `expected the <video> to have non-zero area, got w=${placement.w} h=${placement.h}`);
  }

  const state = await videoState(page);
  if (state.missing) {
    report('video-in-stage', 'expected <video> inside #itube-stage, found none after 10 polls');
    return violations;
  }
  if (state.readyState < 2) {
    report('video-ready', `expected readyState>=2 got readyState=${state.readyState}`);
  }

  // --- AUTOPLAY: the player must start on its own, with NOBODY calling play() ---
  // The old single `video-plays` check called .play() inside its own retry
  // loop, so it REPAIRED the bug it was meant to detect: a player that mounts
  // paused, or whose autoplay wiring is broken, was quietly fixed by the test
  // and then reported green. Observation and intervention are now separate
  // checks.
  //
  // The context launches with --autoplay-policy=no-user-gesture-required and
  // --mute-audio, so the browser is not the thing preventing playback here.
  let autoplayed = false;
  let autoBefore = 0;
  let autoAfter = 0;
  for (let attempt = 0; attempt < 4 && !autoplayed; attempt++) {
    autoBefore = (await videoState(page)).currentTime;
    await page.waitForTimeout(1200);
    autoAfter = (await videoState(page)).currentTime;
    // A preroll ad swapping into the same <video> resets currentTime to ~0.
    // That is a source change, not a stall: resample rather than fail.
    autoplayed = autoAfter > autoBefore;
  }
  if (!autoplayed) {
    const paused = (await videoState(page)).paused;
    report('video-autoplays', `expected the video to be playing on its own (no .play() call from the test), currentTime went ${autoBefore} -> ${autoAfter} over 4 samples, paused=${paused}`);
  }

  // --- PLAYBACK: once told to play, currentTime must actually advance ---
  // Distinct failure from the above: this is "the media pipeline is dead",
  // not "autoplay never fired".
  let advanced = false;
  let lastBefore = 0;
  let lastAfter = 0;
  for (let attempt = 0; attempt < 4 && !advanced; attempt++) {
    if ((await videoState(page)).paused) {
      await page.evaluate(() => document.querySelector('#itube-stage video').play().catch(() => {}));
      await page.waitForTimeout(400);
    }
    lastBefore = (await videoState(page)).currentTime;
    await page.waitForTimeout(1200);
    lastAfter = (await videoState(page)).currentTime;
    advanced = lastAfter > lastBefore;
  }
  if (!advanced) {
    report('video-advances-when-played', `expected currentTime to advance after calling play() over 4 attempts, before=${lastBefore} after=${lastAfter}`);
  }

  // --- video fills the stage ---
  const boxes = await page.evaluate(() => {
    const v = document.querySelector('#itube-stage video');
    const stage = document.getElementById('itube-stage');
    const vr = v.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return { v: { x: vr.left, y: vr.top, w: vr.width, h: vr.height }, s: { x: sr.left, y: sr.top, w: sr.width, h: sr.height } };
  });
  if (Math.abs(boxes.v.w - boxes.s.w) > 2 || Math.abs(boxes.v.h - boxes.s.h) > 2 ||
    Math.abs(boxes.v.x - boxes.s.x) > 2 || Math.abs(boxes.v.y - boxes.s.y) > 2) {
    report('video-fills-stage', `video box ${JSON.stringify(boxes.v)} !== stage box ${JSON.stringify(boxes.s)}`);
  }

  // --- bar exists ---
  const barExists = await page.$('#itube-bar');
  if (!barExists) {
    report('bar-exists', 'expected #itube-bar to exist');
    return violations;
  }

  // --- #itube-play toggles pause ---
  await showBar(page);
  const pausedBefore1 = (await videoState(page)).paused;
  await page.click('#itube-play');
  await page.waitForTimeout(150);
  const pausedAfter1 = (await videoState(page)).paused;
  if (pausedAfter1 === pausedBefore1) {
    report('play-button-toggles', `expected #itube-play click to flip paused, stayed paused=${pausedAfter1}`);
  }

  // --- clicking the stage toggles pause (debounced ~220ms) ---
  const pausedBefore2 = (await videoState(page)).paused;
  await page.click('#itube-stage', { position: { x: 20, y: 20 } });
  await page.waitForTimeout(400);
  const pausedAfter2 = (await videoState(page)).paused;
  if (pausedAfter2 === pausedBefore2) {
    report('stage-click-toggles', `expected stage click to flip paused, stayed paused=${pausedAfter2}`);
  }

  // --- clicking #itube-bar itself (not a control) must NOT toggle pause ---
  await showBar(page);
  const pausedBefore3 = (await videoState(page)).paused;
  const barBox = await page.evaluate(() => {
    const r = document.getElementById('itube-bar').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(barBox.x + barBox.w / 2, barBox.y + 2);
  await page.waitForTimeout(400);
  const pausedAfter3 = (await videoState(page)).paused;
  if (pausedAfter3 !== pausedBefore3) {
    report('bar-click-no-toggle', `expected clicking #itube-bar to leave paused=${pausedBefore3} unchanged, got paused=${pausedAfter3}`);
  }

  // Make sure playback is running before the keyboard tests below.
  if ((await videoState(page)).paused) {
    await page.evaluate(() => document.querySelector('#itube-stage video').play());
    await page.waitForTimeout(200);
  }

  // --- keyboard: 'l' seeks forward ---
  const seekBefore = (await videoState(page)).currentTime;
  let seeked = false;
  let sb = seekBefore;
  let sa = 0;
  for (let attempt = 0; attempt < 3 && !seeked; attempt++) {
    sb = (await videoState(page)).currentTime;
    await page.keyboard.press('l');
    await page.waitForTimeout(250);
    sa = (await videoState(page)).currentTime;
    // A preroll ad swapping into the same <video> resets currentTime to ~0.
    // That is a media-source change, not a broken seek: resample and retry.
    if (sa < sb) continue;
    seeked = sa > sb;
  }
  if (!seeked) {
    report('key-l-seeks-forward', `expected currentTime to increase after 'l' over 3 attempts, before=${sb} after=${sa}`);
  }

  // --- keyboard: ArrowDown lowers volume by exactly 5 ---
  const volBefore = await getPlayerVolume(page);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const volAfter = await getPlayerVolume(page);
  const expectedVol = Math.max(0, volBefore - 5);
  if (volAfter !== expectedVol) {
    report('key-arrowdown-volume', `expected volume=${expectedVol} (${volBefore}-5) got volume=${volAfter}`);
  }

  // --- keyboard: 'm' mutes ---
  await page.keyboard.press('m');
  await page.waitForTimeout(150);
  const muted = await isPlayerMuted(page);
  if (muted !== true) {
    report('key-m-mutes', `expected isMuted()===true after 'm', got ${muted}`);
  }
  // unmute again so later checks aren't affected by mute state.
  await page.keyboard.press('m');
  await page.waitForTimeout(150);

  // --- keyboard: '/' focuses .search ---
  await page.keyboard.press('/');
  await page.waitForTimeout(100);
  const focusedIsSearch = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('search'));
  if (!focusedIsSearch) {
    report('key-slash-focuses-search', `expected document.activeElement to be .search after '/'`);
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());

  // --- volume persistence across reload ---
  await page.evaluate(() => {
    const vol = document.getElementById('itube-vol');
    vol.value = '42';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Volume is persisted to localStorage by a 500ms poll loop in the
  // userscript, so we must wait for at least one tick before reloading.
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && v.readyState >= 2;
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const restoredVol = await getPlayerVolume(page);
  const sliderVol = await page.evaluate(() => Number(document.getElementById('itube-vol').value));
  if (restoredVol !== 42) {
    report('volume-persistence', `expected player.getVolume()===42 after reload, got ${restoredVol}`);
  }
  if (sliderVol !== 42) {
    report('volume-persistence', `expected #itube-vol.value===42 after reload, got ${sliderVol}`);
  }

  // --- OSD: ArrowRight shows #itube-cue with .show ---
  await page.keyboard.press('ArrowRight');
  const cueShown = await page.evaluate(() => {
    const cue = document.getElementById('itube-cue');
    return !!cue && cue.classList.contains('show');
  });
  if (!cueShown) {
    report('osd-shows-on-seek', `expected #itube-cue to have .show right after ArrowRight`);
  }

  // --- tools tray opens, quality tool cycles through a real ladder ---
  // The player-bar "..." settings popup was removed in v4.41 — every control
  // it held (Speed, Quality, Captions, Autoplay, Skip sponsors, Volume boost)
  // now lives only in the Tools row, opened via the "Tools" pill in the
  // action row. This uses a REAL page.click(), not element.click() in
  // page.evaluate(): the synthetic version bypasses hit-testing entirely, so
  // it passed even when the button was covered by an overlay, had
  // pointer-events:none, or was zero-sized — all three of which have
  // actually shipped in this project. The retry loop stays: a preroll ad
  // genuinely can eat the first click.
  let toolsOpen = false;
  let clickError = '';
  for (let attempt = 0; attempt < 3 && !toolsOpen; attempt++) {
    await showBar(page);
    await page.waitForTimeout(100);
    try {
      await page.click('.watch-action-btn[title="Tools"]', { timeout: 2000 });
    } catch (err) {
      // Playwright's actionability check failing IS the finding here: the
      // button is not really clickable by a human either.
      clickError = String(err.message || err).split('\n')[0];
      continue;
    }
    await page.waitForTimeout(300);
    toolsOpen = await page.evaluate(() => document.querySelector('.watch-tools')?.classList.contains('open'));
  }
  if (!toolsOpen) {
    report('tools-tray-opens', `expected .watch-tools to gain .open after a real click on the Tools pill (3 attempts)${clickError ? ` — last click failed: ${clickError}` : ''}`);
  }
  // A single stale label ("Auto" left over from the previous video) used to
  // satisfy the old `> 0` options check on the removed <select>. Real quality
  // data is a ladder of several concrete resolutions. v4.45 replaced the
  // one-click cycle (which got users stuck re-clicking through a whole
  // ladder to find the one they wanted, e.g. stuck on "144p") with a real
  // anchored menu listing every level at once — open it and read the items.
  const YT_QUALITY_LABELS = /^\d+p$|^auto$/i;
  const quality = await page.evaluate(async () => {
    const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Quality'));
    if (!btn) return null;
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const items = Array.from(document.querySelectorAll('.tool-menu.open .tool-menu-item, .tool-menu:popover-open .tool-menu-item'));
    const labels = items.map((it) => it.textContent.trim());
    const activeCount = items.filter((it) => it.classList.contains('active')).length;
    // Prefer a concrete resolution over "Auto": forcing a specific level is
    // applied by the real player far more promptly than waiting for it to
    // renegotiate down to an adaptive "auto" choice, which can lag well past
    // a short fixed wait and isn't the thing this assertion is after.
    const other = items.find((it) => !it.classList.contains('active') && it.textContent.trim() !== 'Auto')
      || items.find((it) => !it.classList.contains('active'));
    const otherLabel = other ? other.textContent.trim() : null;
    other?.click();
    let valAfter = btn.querySelector('.watch-tool-val')?.textContent;
    for (let i = 0; i < 20 && otherLabel && valAfter !== otherLabel; i++) {
      await new Promise((r) => setTimeout(r, 150));
      valAfter = btn.querySelector('.watch-tool-val')?.textContent;
    }
    return { labels, activeCount, otherLabel, valAfter };
  });
  if (!quality) {
    report('quality-options', 'expected a Tools row Quality button to exist, got none');
  } else {
    if (!quality.labels.length) {
      report('quality-menu-opens', 'expected clicking the Quality pill to open a menu listing at least one quality item');
    }
    const badLabels = quality.labels.filter((l) => !YT_QUALITY_LABELS.test((l || '').trim()));
    if (badLabels.length) {
      report('quality-options', `expected every Quality menu item to match /^\\d+p$|^auto$/i, got malformed: [${badLabels.join(', ')}]`);
    }
    if (quality.labels.length && quality.activeCount !== 1) {
      report('quality-menu-marks-current', `expected exactly one .tool-menu-item.active (the current quality) in the Quality menu, got ${quality.activeCount}`);
    }
    if (quality.otherLabel && quality.valAfter !== quality.otherLabel) {
      report('quality-menu-selects', `expected clicking a non-active Quality menu item ("${quality.otherLabel}") to update the pill's value text, got "${quality.valAfter}"`);
    }
  }
  await page.keyboard.press('Escape');

  // --- comments live in the rail's Comments tab, fetched on first activation ---
  const commentsBefore = await page.evaluate(() => document.querySelectorAll('.comment-row').length);
  if (commentsBefore !== 0) {
    report('comments-collapsed-default', `expected 0 .comment-row before activating the Comments tab, got ${commentsBefore}`);
  }
  // The app sets `tabComments.disabled = !commentsToken` — i.e. the tab is
  // disabled PRECISELY when comment extraction failed. A disabled tab on a
  // normal video IS the violation.
  const tab = await page.$('.rail-tab:has-text("Comments")');
  if (!tab) {
    report('comments-tab-exists', 'expected a Comments rail tab to exist');
  } else if (await page.evaluate((el) => el.disabled, tab)) {
    report('comments-tab-disabled', 'the Comments rail tab is disabled on a normal video with comments enabled — the app only disables it when the comments continuation token could not be extracted');
  } else {
    await tab.click();
    await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 10000 }).catch(() => {});
    const commentsAfter = await page.evaluate(() => document.querySelectorAll('.comment-row').length);
    if (!(commentsAfter > 0)) {
      report('comments-expand-on-click', `expected >0 .comment-row after activating the Comments tab, got ${commentsAfter}`);
    }
    // Switching to Comments hides the Up next panel (that's the point of the
    // tabs) — switch back so the rest of this suite, which clicks .rc related
    // cards, finds them visible again, matching the page's default state.
    const upNextTab = await page.$('.rail-tab:has-text("Up next")');
    if (upNextTab) {
      await upNextTab.click();
      await page.waitForTimeout(100);
    }
  }

  // --- actions row renders like/dislike/save/share/subscribe ---
  const actionCounts = await page.evaluate(() => ({
    like: document.querySelectorAll('.watch-like-btn').length,
    dislike: document.querySelectorAll('.watch-dislike-btn').length,
    saveOrShare: document.querySelectorAll('.watch-action-btn').length,
    subscribe: document.querySelectorAll('.watch-subscribe').length,
  }));
  if (actionCounts.like < 1) report('actions-row-render', `expected >=1 .watch-like-btn, got ${actionCounts.like}`);
  if (actionCounts.dislike < 1) report('actions-row-render', `expected >=1 .watch-dislike-btn, got ${actionCounts.dislike}`);
  if (actionCounts.saveOrShare < 2) report('actions-row-render', `expected >=2 .watch-action-btn (save+share), got ${actionCounts.saveOrShare}`);
  if (actionCounts.subscribe < 1) report('actions-row-render', `expected >=1 .watch-subscribe, got ${actionCounts.subscribe}`);

  // --- clicking like while logged out must REVERT, never lie ---
  // Same inversion as the comments toggle: the app sets `likeBtn.disabled =
  // !actionsVideoId`, so a disabled like button means the video id could not
  // be resolved from the page. Skipping the assertion in that case meant the
  // check passed on its own failure mode.
  //
  // Wait for the button to be VISIBLE first: the .watch-actions row (like/
  // dislike/save/share/tools) is one of the elements the load skeleton
  // (v4.6.0) sets display:none until the owner data arrives. Under
  // full-suite load that reveal can lag the video being ready, so a bare
  // .click() here would sit 30s on a display:none button.
  // A genuine "meta never loaded" still surfaces — the button stays hidden, the
  // wait lapses, and the existence/disabled checks below report it.
  await page.waitForSelector('.watch-like-btn', { state: 'visible', timeout: 15000 }).catch(() => {});
  const likeBtn = await page.$('.watch-like-btn');
  if (!likeBtn) {
    report('like-button-exists', 'expected .watch-like-btn to exist');
  } else if (await page.evaluate((el) => el.disabled, likeBtn)) {
    report('like-button-disabled', 'the .watch-like-btn is disabled on a normal video — the app only disables it when it could not resolve the video id (actionsVideoId), so the actions row is wired to nothing');
  } else if (!(await likeBtn.isVisible())) {
    report('like-button-hidden', 'the .watch-like-btn stayed hidden past the 15s wait — the watch meta never revealed past the load skeleton, so the actions row is unreachable');
  } else {
    await likeBtn.click();
    // Optimistic UI flips immediately, then the failed (logged-out)
    // network call should revert it. Give the revert time to land.
    await page.waitForTimeout(1500);
    const ariaPressed = await page.evaluate((el) => el.getAttribute('aria-pressed'), likeBtn);
    if (ariaPressed !== 'false') {
      report('like-reverts-logged-out', `expected aria-pressed to revert to "false" when logged out, got "${ariaPressed}"`);
    }
  }

  return violations;
}

// ytd-app (YouTube's own UI) must never be visible on any page.
// NOTE the shape: `absent` is a VIOLATION, not a pass. The old check was
// `if (info.present && !hidden)`, so if ytd-app vanished from the document
// entirely — which would mean the page never loaded YouTube's own app, i.e.
// the harness is testing nothing — the check reported green.
async function checkYtdAppHidden(page) {
  const violations = [];
  const info = await page.evaluate(() => {
    const app = document.querySelector('ytd-app');
    if (!app) return { present: false };
    const r = app.getBoundingClientRect();
    const cs = getComputedStyle(app);
    return { present: true, left: r.left, opacity: Number(cs.opacity) };
  });
  if (!info.present) {
    violations.push({ check: 'ytd-app-present-but-hidden', detail: 'ytd-app is absent from the document — YouTube\'s own app never mounted, so "it is hidden" is vacuous and the rest of this suite is not testing a real YouTube page' });
    return violations;
  }
  if (!(info.left <= -9999 || info.opacity === 0)) {
    violations.push({ check: 'ytd-app-hidden', detail: `expected ytd-app offscreen (left<=-9999) or opacity:0, got left=${info.left} opacity=${info.opacity}` });
  }
  return violations;
}

// Clicks a related-video card on the watch page and asserts the navigation
// happened client-side: zero main-frame *document* responses (iframes/ads
// also produce 'document' resourceType responses and would be false
// positives, so we filter to frame === page.mainFrame()).
async function checkWatchToWatchNavigation(page) {
  const violations = [];
  const titleBefore = await page.evaluate(() => document.querySelector('.watch-title')?.textContent || '');
  // Related cards on the watch page use the `.rc` class (`.row` is used by
  // other feed-style lists such as subscriptions/history). The list loads
  // asynchronously after the watch page mounts, so give it a real chance to
  // appear before declaring it missing.
  await page.waitForSelector('.rc', { timeout: 10000 }).catch(() => {});
  const related = await page.$('.rc');
  if (!related) {
    violations.push({ check: 'related-card-exists', detail: 'expected at least one .rc related-video card on watch page' });
    return violations;
  }
  const mainFrame = page.mainFrame();
  let docLoads = 0;
  const onResponse = (res) => {
    if (res.request().resourceType() === 'document' && res.frame() === mainFrame) docLoads++;
  };
  page.on('response', onResponse);
  // Click the TITLE, not the card's centre: the centre of a compact related
  // card lands on the channel-name link, which correctly opens the channel
  // rather than the video.
  const clicked = await clickCardPart(page, related, '.rc-title');
  if (!clicked) {
    violations.push({ check: 'related-card-exists', detail: 'the first .rc related card has no layout box to click' });
    page.off('response', onResponse);
    return violations;
  }
  // renderWatchFor() awaits a fresh 'next' API fetch before updating
  // .watch-title, so poll for the change rather than a fixed sleep.
  await page.waitForFunction(
    (prev) => document.querySelector('.watch-title')?.textContent !== prev,
    titleBefore,
    { timeout: 8000 }
  ).catch(() => {});
  page.off('response', onResponse);
  const titleAfter = await page.evaluate(() => document.querySelector('.watch-title')?.textContent || '');
  if (docLoads > 0) {
    violations.push({ check: 'watch-to-watch-no-reload', detail: `expected 0 main-frame document loads, got ${docLoads}` });
  }
  if (titleAfter === titleBefore) {
    violations.push({ check: 'watch-to-watch-title-changes', detail: `expected .watch-title to change after clicking a related video, stayed "${titleAfter}"` });
  }
  return violations;
}

// Counts MAIN-FRAME document requests for the duration of `fn`. Ad iframes
// also issue requests with resourceType() === 'document', so filtering to the
// main frame is not optional — without it every count is a false positive.
// Returns { docLoads, urls }.
async function countMainFrameDocLoads(page, fn) {
  const rec = recordMainFrameDocLoads(page);
  try {
    await fn();
  } finally {
    rec.stop();
  }
  return { docLoads: rec.urls.length, urls: rec.urls };
}

// The counting-window version above is only as good as the window: a listener
// that is detached 1.5s after a click cannot see a fallback `location.assign()`
// that fires at 3s, and the reloaded page then satisfies every later assertion.
// This variant keeps recording until the caller explicitly stops it, so the
// window can be held open past the app's WATCH_BOOT_TIMEOUT.
function recordMainFrameDocLoads(page) {
  const mainFrame = page.mainFrame();
  const urls = [];
  const onRequest = (req) => {
    if (req.resourceType() !== 'document') return;
    if (req.frame() !== mainFrame) return;
    urls.push(req.url());
  };
  page.on('request', onRequest);
  return { urls, stop: () => page.off('request', onRequest) };
}

// The app's own fallback timeout (WATCH_BOOT_TIMEOUT in flyt.user.js). Any
// reload-detection window has to stay open longer than this, or the reload it
// exists to catch happens after the listener is gone.
const WATCH_BOOT_TIMEOUT = 3000;
const RELOAD_WATCH_MS = WATCH_BOOT_TIMEOUT + 1500;

// Stamps a unique value on `window`. ANY main-frame document load — including
// one that happens long after a doc-load listener was detached — creates a new
// JS global object and wipes it. Timing-independent proof that the document
// the checks end on is the same document they started on.
async function stampMark(page) {
  const mark = `itube-mark-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((m) => { window.__itubeMark = m; }, mark);
  return mark;
}

async function markSurvived(page, mark) {
  const seen = await page.evaluate(() => window.__itubeMark).catch(() => null);
  return seen === mark;
}

// "The route changed and #itube-stage exists" is NOT "the video plays". A real
// bug shipped straight through this check: Forward into a watch page whose id
// the player still held left the <video> PAUSED forever (paused=true,
// readyState=4, playerState=-1) — every structural assertion passed while the
// user stared at a frozen frame.
//
// The only honest test of playback is the clock: sample currentTime, wait, and
// require that it MOVED. paused=false alone is not enough (a stalled element
// reports paused=false), and readyState alone says nothing about progress.
const PLAY_WINDOW_MS = 2500;
const PLAY_MIN_ADVANCE = 0.2;

async function playbackProbe(page, windowMs = PLAY_WINDOW_MS) {
  const read = () => page.evaluate(() => {
    const v = document.querySelector('#itube-stage video');
    const p = document.getElementById('movie_player');
    return {
      video: !!v,
      paused: v ? v.paused : null,
      readyState: v ? v.readyState : null,
      currentTime: v ? v.currentTime : null,
      playerState: p && typeof p.getPlayerState === 'function' ? p.getPlayerState() : null,
    };
  });
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && v.readyState >= 2;
  }, { timeout: 15000 }).catch(() => {});

  // Up to 3 sampling windows, mirroring the retry loop runWatchFunctional's
  // own autoplay check already uses: an ad/source swap resets currentTime to
  // ~0 mid-probe (a preroll or mid-roll swapping into the same <video>),
  // which a single before/after sample can't tell apart from a real stall —
  // the exact flake observed under full-suite load. A currentTime DECREASE
  // between windows is treated as a source swap and resampled from the new
  // baseline, not failed; a genuine stall (flat, or advancing under the
  // PLAY_MIN_ADVANCE floor) still exhausts the retries and fails below.
  let before = await read();
  let after = before;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(windowMs);
    after = await read();
    const droppedBack = before.currentTime != null && after.currentTime != null && after.currentTime < before.currentTime;
    if (droppedBack && attempt < 2) {
      before = after;
      continue;
    }
    break;
  }

  const advanced = !!before.video && !!after.video
    && after.currentTime > before.currentTime + PLAY_MIN_ADVANCE;
  return {
    before,
    after,
    advanced,
    playing: advanced && after.paused === false,
    detail: `paused=${after.paused}, readyState=${after.readyState}, playerState=${after.playerState}, currentTime ${before.currentTime} -> ${after.currentTime} over ${windowMs}ms`,
  };
}

// Clicking sidebar "Home" must be a pure client-side route change.
// The old version ran this on the HOME page — clicking "Home" while already on
// "/" and then asserting pathname === "/" is a tautology that holds even if
// the click handler does nothing at all. So: navigate somewhere else FIRST,
// then come back.
async function checkHomeNavigation(page) {
  const violations = [];
  const home = await page.$('.nav-row[href="/"]');
  if (!home) {
    violations.push({ check: 'home-link-exists', detail: 'expected .nav-row[href="/"] to exist' });
    return violations;
  }

  // If we're already on "/", route away so that clicking Home is a real
  // transition. History is a feed route that exists logged-out (it renders an
  // empty state, which is fine — we only care that the path changed).
  if (await page.evaluate(() => location.pathname === '/')) {
    const away = await page.$('.nav-row[href="/feed/history"]');
    if (!away) {
      violations.push({ check: 'home-nav-precondition', detail: 'expected .nav-row[href="/feed/history"] to exist so the Home click is a real navigation and not a no-op' });
      return violations;
    }
    await away.click();
    await page.waitForFunction(() => location.pathname !== '/', { timeout: 8000 }).catch(() => {});
    const awayPath = await page.evaluate(() => location.pathname);
    if (awayPath === '/') {
      violations.push({ check: 'home-nav-routes', detail: 'clicking a non-Home sidebar row did not change location.pathname — the sidebar is not routing at all' });
      return violations;
    }
  }

  const pathBefore = await page.evaluate(() => location.pathname);
  const { docLoads } = await countMainFrameDocLoads(page, async () => {
    await page.click('.nav-row[href="/"]');
    await page.waitForFunction(() => location.pathname === '/', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  });
  if (docLoads > 0) {
    violations.push({ check: 'home-nav-no-reload', detail: `expected 0 main-frame document loads clicking Home (from "${pathBefore}"), got ${docLoads}` });
  }
  const path = await page.evaluate(() => location.pathname);
  if (path !== '/') {
    violations.push({ check: 'home-nav-routes', detail: `expected location.pathname === "/" after clicking Home (from "${pathBefore}"), got "${path}"` });
  }
  return violations;
}

// THE hard-navigation regression check: clicking a video card in a feed
// (home/search/channel) must be a client-side route change, and so must Back
// and Forward afterwards. A full document load throws away the mounted app,
// re-downloads YouTube's entire page, and is the single biggest thing the
// userscript exists to avoid.
async function checkFeedToWatchNavigation(page, pageName) {
  const violations = [];

  // `.c` = grid card (home/channel/playlist), `.row` = list row (search). Each
  // is a CONTAINER whose video link is an overlay anchor stretched across it
  // (the channel name is a sibling link on top) — so match the card by the
  // video link it contains, and click it through the overlay by coordinates.
  //
  // NOTE: the logged-out home feed legitimately renders ZERO video cards —
  // plain YouTube serves a feedNudgeRenderer instead of a grid to a session
  // with no watch history — so there is nothing to click there and nothing to
  // assert. That is a property of YouTube, not a bug in the app.
  const card = await page.$('#itube .c:has(a[href^="/watch"]), #itube .row:has(a[href^="/watch"])');
  if (!card) {
    if (pageName !== 'home') {
      violations.push({ check: 'feed-card-exists', detail: `expected at least one video card linking to /watch on the ${pageName} page` });
    }
    return violations;
  }

  const pathBefore = await page.evaluate(() => location.pathname + location.search);

  // Two independent detectors, because either one alone can be fooled:
  //  - the doc-load counter is held open past the app's 3s boot-fallback, so a
  //    late `location.assign()` is still inside the window;
  //  - the window mark is timing-independent: whenever the reload happens, the
  //    global object is replaced and the mark is gone at the end of the check.
  const clickMark = await stampMark(page);
  const rec = recordMainFrameDocLoads(page);
  let survived;
  try {
    await clickCardPart(page, card, '.c-title, .row-title');
    await page.waitForFunction(() => location.pathname === '/watch', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#itube-stage', { timeout: 15000 }).catch(() => {});
    // Hold the window open past WATCH_BOOT_TIMEOUT: the fallback reload this
    // check exists to catch fires ~3s after the click, i.e. long after the
    // player is expected to be up.
    await page.waitForTimeout(RELOAD_WATCH_MS);
    survived = await markSurvived(page, clickMark);
  } finally {
    rec.stop();
  }
  const pathAfter = await page.evaluate(() => location.pathname);
  if (pathAfter !== '/watch') {
    violations.push({ check: 'feed-to-watch-routes', detail: `expected location.pathname === "/watch" after clicking a video card on ${pageName}, got "${pathAfter}"` });
    return violations;
  }
  if (rec.urls.length > 0) {
    violations.push({ check: 'feed-to-watch-no-reload', detail: `clicking a video card on ${pageName} caused ${rec.urls.length} main-frame document load(s) — a full page reload, not a client-side route: ${rec.urls.join(' , ')}` });
  }
  if (!survived) {
    violations.push({ check: 'feed-to-watch-no-reload', detail: `window.__itubeMark did not survive the ${pageName} -> watch navigation — the document was replaced, i.e. something did a full page load (the boot fallback firing on an already-routed page looks exactly like this)` });
  }

  // The app must survive the transition, not just the URL.
  const stage = await page.$('#itube-stage');
  if (!stage) {
    violations.push({ check: 'feed-to-watch-mounts-player', detail: `no #itube-stage after navigating from ${pageName} to a watch page` });
  }

  // …and the video must actually PLAY, not merely mount.
  const played = await playbackProbe(page);
  if (!played.playing) {
    violations.push({ check: 'feed-to-watch-plays', detail: `after clicking a video card on ${pageName} the video is not playing: ${played.detail}` });
  }

  // --- Back, then Forward ---
  const backMark = await stampMark(page);
  const backRec = recordMainFrameDocLoads(page);
  let backSurvived;
  try {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(RELOAD_WATCH_MS);
    backSurvived = await markSurvived(page, backMark);
  } finally {
    backRec.stop();
  }
  const backPath = await page.evaluate(() => location.pathname + location.search);
  if (backRec.urls.length > 0) {
    violations.push({ check: 'back-no-reload', detail: `going Back from watch to ${pageName} caused ${backRec.urls.length} main-frame document load(s) — popstate is doing a full reload: ${backRec.urls.join(' , ')}` });
  }
  if (!backSurvived) {
    violations.push({ check: 'back-no-reload', detail: `window.__itubeMark did not survive going Back to ${pageName} — the document was replaced` });
  }
  if (backPath !== pathBefore) {
    violations.push({ check: 'back-restores-route', detail: `expected Back to restore "${pathBefore}", got "${backPath}"` });
  }

  // Back lands on the FEED, which has no player — the watch teardown hands the
  // <video> back to #movie_player and pauses it. So the playback assertion here
  // is the mirror image of the one on /watch: nothing may still be playing
  // inside a stage. (The paused element this leaves behind is exactly what
  // Forward then has to resume — see below.)
  const backPlayback = await page.evaluate(() => {
    const v = document.querySelector('#itube-stage video');
    return { inStage: !!v, paused: v ? v.paused : null };
  });
  if (backPlayback.inStage && backPlayback.paused === false) {
    violations.push({ check: 'back-stops-playback', detail: `after going Back to ${pageName} a <video> is still playing inside #itube-stage — the watch view was not torn down` });
  }

  const fwdMark = await stampMark(page);
  const fwdRec = recordMainFrameDocLoads(page);
  let fwdSurvived;
  try {
    await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(RELOAD_WATCH_MS);
    fwdSurvived = await markSurvived(page, fwdMark);
  } finally {
    fwdRec.stop();
  }
  const fwdPath = await page.evaluate(() => location.pathname);
  if (fwdRec.urls.length > 0) {
    violations.push({ check: 'forward-no-reload', detail: `going Forward back to the watch page caused ${fwdRec.urls.length} main-frame document load(s): ${fwdRec.urls.join(' , ')}` });
  }
  if (!fwdSurvived) {
    violations.push({ check: 'forward-no-reload', detail: 'window.__itubeMark did not survive going Forward to the watch page — the document was replaced' });
  }
  if (fwdPath !== '/watch') {
    violations.push({ check: 'forward-restores-route', detail: `expected Forward to restore "/watch", got "${fwdPath}"` });
  }

  // THE regression this check exists for: the player still holds this video id,
  // so nothing reloads it — and the teardown on the way out paused it. Unless
  // the navigation resumes it, the user gets a frozen frame that only a manual
  // click recovers.
  const fwdPlayed = await playbackProbe(page);
  if (!fwdPlayed.playing) {
    violations.push({ check: 'forward-resumes-playback', detail: `after going Forward from ${pageName} back to the watch page the video is not playing: ${fwdPlayed.detail}` });
  }

  return violations;
}

// F8: a route Flyt does not implement must still be a client-side route — the
// destination is the SAME "isn't available in Flyt yet" card either way, so a
// native navigation buys a whole document load for an identical result. But
// `/redirect?q=` (YouTube's outbound-link bouncer, used by description and
// sponsor links) MUST stay a native navigation.
async function checkUnhandledLinkRouting(page) {
  const violations = [];

  const unhandledHref = '/premium';
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'itube-test-unhandled-link';
    a.href = href;
    a.textContent = 'unhandled';
    a.style.position = 'fixed';
    a.style.left = '0';
    a.style.bottom = '0';
    a.style.zIndex = '99999';
    document.querySelector('#itube').appendChild(a);
  }, unhandledHref);

  const mark = await stampMark(page);
  const rec = recordMainFrameDocLoads(page);
  let survived;
  try {
    await page.click('#itube-test-unhandled-link');
    await page.waitForFunction(() => location.pathname === '/premium', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    survived = await markSurvived(page, mark);
  } finally {
    rec.stop();
  }

  const path = await page.evaluate(() => location.pathname);
  if (path !== unhandledHref) {
    violations.push({ check: 'unhandled-link-routes', detail: `expected clicking an unhandled in-app link to land on "${unhandledHref}", got "${path}"` });
  }
  if (rec.urls.length > 0) {
    violations.push({ check: 'unhandled-link-no-reload', detail: `clicking "${unhandledHref}" caused ${rec.urls.length} main-frame document load(s) — the destination is the same unhandled card either way, so the reload is pure cost: ${rec.urls.join(' , ')}` });
  }
  if (!survived) {
    violations.push({ check: 'unhandled-link-no-reload', detail: `window.__itubeMark did not survive clicking "${unhandledHref}" — the document was replaced` });
  }
  const card = await page.$('#itube .unhandled');
  if (!card) {
    violations.push({ check: 'unhandled-link-renders-card', detail: `expected the .unhandled card after SPA-routing to "${unhandledHref}"` });
  }
  await page.evaluate(() => document.getElementById('itube-test-unhandled-link')?.remove());

  // A /redirect?q= link must NOT be intercepted: preventDefault() on it would
  // break every outbound description/sponsor link on the site.
  const notIntercepted = await page.evaluate(async () => {
    const a = document.createElement('a');
    a.id = 'itube-test-redirect-link';
    a.href = '/redirect?q=' + encodeURIComponent('https://example.com/');
    a.textContent = 'redirect';
    document.querySelector('#itube').appendChild(a);
    // Dispatch the click manually. The probe runs on `document` in the bubble
    // phase — i.e. AFTER the app's own listener on #itube — so it reads the
    // app's verdict first, then swallows the default itself so the test does
    // not actually navigate away.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    let prevented = null;
    const probe = (e) => { prevented = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', probe, false);
    a.dispatchEvent(ev);
    document.removeEventListener('click', probe, false);
    a.remove();
    return prevented;
  });
  if (notIntercepted) {
    violations.push({ check: 'redirect-link-not-intercepted', detail: 'a /redirect?q= link had its click defaultPrevented by the app — YouTube\'s outbound bouncer must be allowed to navigate natively, otherwise every description/sponsor link dead-ends on the unhandled card' });
  }

  return violations;
}

// /shorts/<id> must be rewritten to the normal watch page and actually play.
// (The app does this with location.replace(), so a document load here is
// expected and deliberate — the assertion is about the destination, not the
// mechanism.)
async function checkShortsRedirect(context, videoId) {
  const { page } = await openPage(context, `https://www.youtube.com/shorts/${videoId}`);
  const violations = [];
  try {
    await page.waitForFunction(() => location.pathname === '/watch', { timeout: 15000 }).catch(() => {});
    const path = await page.evaluate(() => location.pathname);
    if (path !== '/watch') {
      violations.push({ check: 'shorts-redirect', detail: `expected /shorts/${videoId} to redirect to location.pathname === "/watch", got "${path}"` });
      return violations;
    }
    const v = await page.evaluate(() => new URLSearchParams(location.search).get('v'));
    if (v !== videoId) {
      violations.push({ check: 'shorts-redirect', detail: `expected the redirect to carry ?v=${videoId}, got "${v}"` });
    }

    await waitForApp(page, { timeout: 30000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#itube-stage video');
      return el && el.readyState >= 2;
    }, { timeout: 20000 }).catch(() => {});

    let advanced = false;
    let before = 0;
    let after = 0;
    for (let attempt = 0; attempt < 4 && !advanced; attempt++) {
      if ((await videoState(page)).paused) {
        await page.evaluate(() => document.querySelector('#itube-stage video')?.play().catch(() => {}));
        await page.waitForTimeout(400);
      }
      before = (await videoState(page)).currentTime;
      await page.waitForTimeout(1200);
      after = (await videoState(page)).currentTime;
      advanced = after > before;
    }
    if (!advanced) {
      violations.push({ check: 'shorts-redirect-plays', detail: `expected the redirected video to play, currentTime went ${before} -> ${after} over 4 attempts` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// /live/<id> is YouTube's live-stream permalink (often with a ?si= tracking
// param). Flyt must rewrite it to the normal watch page and drop ?si=.
async function checkLiveRedirect(context, videoId) {
  const { page } = await openPage(context, `https://www.youtube.com/live/${videoId}?si=FlYtTestToken`);
  const violations = [];
  try {
    await page.waitForFunction(() => location.pathname === '/watch', { timeout: 15000 }).catch(() => {});
    const dest = await page.evaluate(() => ({ path: location.pathname, v: new URLSearchParams(location.search).get('v') }));
    if (dest.path !== '/watch') {
      violations.push({ check: 'live-redirect', detail: `expected /live/${videoId}?si=… to redirect to location.pathname === "/watch", got "${dest.path}"` });
    } else if (dest.v !== videoId) {
      violations.push({ check: 'live-redirect', detail: `expected the redirect to carry ?v=${videoId} (with ?si= dropped), got "${dest.v}"` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// Privacy: tracking params (?si=, ?utm_*=, ?feature=, ?pp=) must be scrubbed
// from the address bar on navigation, while functional params (v, t, list) are
// preserved.
async function checkTrackingParamsStripped(context, videoId) {
  const { page } = await openPage(context, `https://www.youtube.com/watch?v=${videoId}&si=TrackMe123&utm_source=newsletter&feature=share&t=30`);
  const violations = [];
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('si'), { timeout: 8000 }).catch(() => {});
    const q = await page.evaluate(() => {
      const p = new URLSearchParams(location.search);
      return { v: p.get('v'), t: p.get('t'), si: p.has('si'), utm: p.has('utm_source'), feature: p.has('feature') };
    });
    if (q.si || q.utm || q.feature) {
      violations.push({ check: 'tracking-params-stripped', detail: `expected si/utm_source/feature removed from URL, got si=${q.si} utm=${q.utm} feature=${q.feature}` });
    }
    if (q.v !== videoId) {
      violations.push({ check: 'tracking-params-stripped', detail: `expected functional ?v=${videoId} preserved, got "${q.v}"` });
    }
    if (q.t !== '30') {
      violations.push({ check: 'tracking-params-stripped', detail: `expected functional ?t=30 (start time) preserved, got "${q.t}"` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// Card titles must RESERVE two lines (not just clamp to a max of two), so
// one-line and two-line titles produce equal-height cards and the grid rows
// don't go ragged (uneven vertical gaps between rows).
async function checkCardTitleHeight(context) {
  const { page } = await openPage(context, 'https://www.youtube.com/@mkbhd/videos');
  const violations = [];
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube .c-title', { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('#itube .c-title'));
      if (!els.length) return { count: 0 };
      const cs = getComputedStyle(els[0]);
      const heights = els.slice(0, 15).map((e) => Math.round(e.getBoundingClientRect().height));
      return { count: els.length, minHeight: parseFloat(cs.minHeight) || 0, lineClamp: cs.webkitLineClamp, heights };
    });
    if (!r.count) {
      violations.push({ check: 'card-title-height', detail: 'no .c-title cards rendered to verify' });
      return violations;
    }
    if (!(r.minHeight >= 34)) {
      violations.push({ check: 'card-title-height', detail: `expected .c-title to reserve ~2 lines (computed min-height >= 34px) so cards stay uniform; got ${r.minHeight}px` });
    }
    if (r.lineClamp !== '2') {
      violations.push({ check: 'card-title-height', detail: `expected .c-title to still clamp at 2 lines, got line-clamp "${r.lineClamp}"` });
    }
    const spread = Math.max(...r.heights) - Math.min(...r.heights);
    if (spread > 4) {
      violations.push({ check: 'card-title-height', detail: `expected uniform card-title heights (reserved 2 lines), got a ${spread}px spread across ${r.heights.length} cards: ${r.heights.join(',')}` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// Infinite scroll: the sentinel at the bottom of a list must load more items.
// `.content` is the scroll container (the document itself doesn't scroll), so
// scrolling the window would silently do nothing and the check would pass on
// a broken IntersectionObserver.
async function checkInfiniteScroll(page, pageName) {
  const violations = [];
  const itemSel = pageName === 'search' ? '.row' : '.c';

  const countItems = () => page.evaluate((sel) => document.querySelectorAll('#itube ' + sel).length, itemSel);
  const before = await countItems();
  if (before === 0) {
    violations.push({ check: 'infinite-scroll', detail: `expected the ${pageName} page to render at least one "${itemSel}" before scrolling, got 0` });
    return violations;
  }

  let after = before;
  for (let i = 0; i < 4 && after <= before; i++) {
    await page.evaluate(() => {
      const content = document.querySelector('#itube .content');
      if (content) content.scrollTop = content.scrollHeight;
    });
    await page.waitForFunction(
      ({ sel, prev }) => document.querySelectorAll('#itube ' + sel).length > prev,
      { sel: itemSel, prev: before },
      { timeout: 6000 }
    ).catch(() => {});
    after = await countItems();
  }

  if (!(after > before)) {
    violations.push({ check: 'infinite-scroll', detail: `expected the ${pageName} "${itemSel}" count to grow after scrolling to the bottom 4 times, stayed at ${before}` });
  }
  return violations;
}

// A route the app doesn't implement must render the explicit "not available"
// card — and must NOT fall back to letting YouTube's own UI through.
async function checkUnhandledPage(page) {
  const violations = [];
  const info = await page.evaluate(() => {
    const wrap = document.querySelector('#itube .unhandled');
    if (!wrap) return { present: false };
    const r = wrap.getBoundingClientRect();
    return {
      present: true,
      text: wrap.textContent || '',
      visible: r.width > 0 && r.height > 0,
      hasHomeLink: !!wrap.querySelector('a[href="/"]'),
    };
  });
  if (!info.present) {
    violations.push({ check: 'unhandled-card', detail: 'expected an .unhandled card on a route Flyt does not implement, found none' });
    return violations;
  }
  if (!info.visible) {
    violations.push({ check: 'unhandled-card', detail: 'the .unhandled card exists but has zero area' });
  }
  if (!/isn't available in Flyt yet/i.test(info.text)) {
    violations.push({ check: 'unhandled-card', detail: `expected the .unhandled card to say "isn't available in Flyt yet", got "${info.text.trim()}"` });
  }
  if (!info.hasHomeLink) {
    violations.push({ check: 'unhandled-card', detail: 'expected the .unhandled card to offer a link back to Home' });
  }
  return violations;
}

// The layout must hold at a narrow laptop width and on a very wide monitor.
// The `.body { max-width: 1720px; margin: 0 auto }` bug that shipped was
// invisible at the default 1440px test viewport and only appeared on a wide
// screen, so width is a dimension this suite has to actually exercise.
//
// 400/560 exercise the narrow-phone breakpoints added for Wave 2 Chunk B:
// below 1000px the sidebar must collapse to a narrow icon rail (not sit at a
// rigid 232px forcing everything else to be squeezed or clipped), and below
// 600px it must stop being a left column entirely — it becomes a full-width
// top bar (logo + search) with the content stacked beneath it, so the content
// starts at the left edge instead of being pushed right. The watch page's two-column
// `minmax(0, 1fr) clamp(340px, 24vw, 460px)` grid used to leave the LEFT
// (video) column with none of the room — at a narrow width the right column's
// 340px floor ate the whole viewport and `#itube-stage`/`.watch-left`
// shrank toward zero. That is the exact defect this check pins down: the
// stage must keep a sane width instead of collapsing. Feed grids
// (`.grid .c` / `.list .row`) must reflow to fewer columns rather than being
// clipped by `.content`'s `overflow-x: hidden`.
async function checkResponsive(page, widths = [400, 560, 900, 2560]) {
  const violations = [];
  const original = page.viewportSize();
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: original ? original.height : 900 });
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => {
        const itube = document.querySelector('#itube');
        const sidebar = itube && itube.querySelector('.sidebar');
        const content = itube && itube.querySelector('.content');
        const stage = document.querySelector('#itube-stage');
        const watchLeft = itube && itube.querySelector('.watch-left');
        const firstCard = itube && itube.querySelector('.grid .c, .list .row');
        const overflow = [];
        for (const sel of ['#itube', '.sidebar', '.content']) {
          const el = sel.startsWith('#') ? document.querySelector(sel) : itube && itube.querySelector(sel);
          if (!el) continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            overflow.push(`${sel} scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`);
          }
        }
        const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
        const contentRect = content ? content.getBoundingClientRect() : null;
        return {
          vw: window.innerWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          sidebarLeft: sidebarRect ? sidebarRect.left : null,
          sidebarWidth: sidebarRect ? sidebarRect.width : null,
          sidebarHeight: sidebarRect ? sidebarRect.height : null,
          contentLeft: contentRect ? contentRect.left : null,
          contentRight: contentRect ? contentRect.right : null,
          stageWidth: stage ? stage.getBoundingClientRect().width : null,
          watchLeftWidth: watchLeft ? watchLeft.getBoundingClientRect().width : null,
          cardRight: firstCard ? firstCard.getBoundingClientRect().right : null,
          cardWidth: firstCard ? firstCard.getBoundingClientRect().width : null,
          overflow,
        };
      });

      if (info.sidebarLeft === null) {
        violations.push({ check: 'responsive-sidebar-pinned', detail: `no .sidebar at width=${width}` });
      } else if (Math.abs(info.sidebarLeft) > 1) {
        violations.push({ check: 'responsive-sidebar-pinned', detail: `at width=${width} expected .sidebar.left === 0, got ${info.sidebarLeft.toFixed(1)}` });
      }
      for (const o of info.overflow) {
        violations.push({ check: 'responsive-no-overflow', detail: `at width=${width}: ${o}` });
      }
      if (info.docScrollWidth > info.vw + 1) {
        violations.push({ check: 'responsive-no-overflow', detail: `at width=${width} the document scrolls horizontally: scrollWidth=${info.docScrollWidth} > innerWidth=${info.vw}` });
      }
      if (info.contentRight !== null && info.contentRight > info.vw + 1) {
        violations.push({ check: 'responsive-no-overflow', detail: `at width=${width} .content.right=${info.contentRight.toFixed(1)} exceeds the viewport (${info.vw})` });
      }

      if (width <= 600) {
        // Below 600px the sidebar is no longer a left column: it becomes a
        // full-width top bar (logo + search) and the content stacks beneath it.
        // The defect this pins is the sidebar eating horizontal space at phone
        // widths — so the content must start at the left edge (left ~= 0) and
        // the sidebar must be a short bar, not a tall column swallowing the row.
        if (info.contentLeft !== null && info.contentLeft > 4) {
          violations.push({ check: 'responsive-sidebar-collapse', detail: `at width=${width} expected the sidebar to become a top bar (content full-width, left~=0), got content.left=${info.contentLeft.toFixed(1)}` });
        }
        if (info.sidebarHeight !== null && info.sidebarHeight > 220) {
          violations.push({ check: 'responsive-sidebar-collapse', detail: `at width=${width} expected the sidebar to be a short top bar (height<=220), got height=${info.sidebarHeight.toFixed(1)}` });
        }
      } else if (width < 1000) {
        if (info.sidebarWidth !== null && info.sidebarWidth > 120) {
          violations.push({ check: 'responsive-sidebar-collapse', detail: `at width=${width} expected .sidebar to collapse below 1000px, got width=${info.sidebarWidth.toFixed(1)}` });
        }
      }

      if (width <= 600 && info.stageWidth !== null) {
        const minSane = Math.min(240, info.vw * 0.5);
        if (info.stageWidth < minSane) {
          violations.push({ check: 'responsive-watch-stage-width', detail: `at width=${width} #itube-stage width=${info.stageWidth.toFixed(1)} collapsed below the sane minimum ${minSane.toFixed(1)}` });
        }
        if (info.watchLeftWidth !== null && info.watchLeftWidth < minSane) {
          violations.push({ check: 'responsive-watch-stage-width', detail: `at width=${width} .watch-left width=${info.watchLeftWidth.toFixed(1)} collapsed below the sane minimum ${minSane.toFixed(1)}` });
        }
      }

      if (width <= 600 && info.cardRight !== null && info.contentRight !== null) {
        if (info.cardRight > info.contentRight + 1) {
          violations.push({ check: 'responsive-grid-reflow', detail: `at width=${width} a feed card extends to ${info.cardRight.toFixed(1)}, past .content's right edge ${info.contentRight.toFixed(1)} (clipped instead of reflowed)` });
        }
        if (info.cardWidth !== null && info.cardWidth <= 0) {
          violations.push({ check: 'responsive-grid-reflow', detail: `at width=${width} the first feed card rendered with zero width` });
        }
      }
    }
  } finally {
    if (original) await page.setViewportSize(original);
    await page.waitForTimeout(300);
  }
  return violations;
}

// A description "1:23" link that points at the SAME video used to be a dead
// click: it rendered as /watch?v=<sameId>&t=83s, the router saw an unchanged
// video id and no-opped, and the timestamp did nothing. The fix intercepts the
// click and calls player.seekTo() directly, while leaving the href intact so
// middle-click/Cmd-click still open a real timestamped URL. This asserts the
// left-click path: the clock actually jumps, and it does so WITHOUT a
// navigation (reusing the doc-load counting pattern from
// checkWatchToWatchNavigation).
async function checkDescriptionTimestampSeek(page) {
  const violations = [];
  const currentVideoId = await page.evaluate(() => new URLSearchParams(location.search).get('v'));

  // Watch v2: the description (and its timestamp links) only exists inside
  // the Description popup now — open it before looking for the link.
  const descBtn = await page.$('.watch-action-btn[aria-label="Description"]');
  if (descBtn) {
    await descBtn.click();
    await page.waitForTimeout(200);
  }

  const handle = await page.evaluateHandle((vid) => {
    const links = [...document.querySelectorAll('.watch-desc-link')];
    return links.find((a) => {
      const href = a.getAttribute('href') || '';
      if (!/[?&]t=\d/.test(href)) return false;
      try {
        const url = new URL(href, location.origin);
        const linkVid = url.searchParams.get('v');
        return !linkVid || linkVid === vid;
      } catch (e) {
        return false;
      }
    }) || null;
  }, currentVideoId);
  const el = handle.asElement();
  if (!el) {
    console.log("  timestamp-seek: SKIP — this video's description has no same-video timestamp link (.watch-desc-link with t=)");
    if (descBtn) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    return violations;
  }

  const targetSeconds = await page.evaluate((a) => {
    const m = (a.getAttribute('href') || '').match(/[?&]t=(\d+)/);
    return m ? Number(m[1]) : null;
  }, el);
  const before = await page.evaluate(() => document.querySelector('#itube-stage video')?.currentTime ?? null);

  const rec = recordMainFrameDocLoads(page);
  await el.click();
  await page.waitForTimeout(700);
  rec.stop();

  const after = await page.evaluate(() => ({
    currentTime: document.querySelector('#itube-stage video')?.currentTime ?? null,
    pathname: location.pathname,
    v: new URLSearchParams(location.search).get('v'),
  }));

  if (rec.urls.length > 0) {
    violations.push({ check: 'timestamp-seek-no-reload', detail: `expected 0 main-frame document loads clicking a description timestamp link, got ${rec.urls.length}: ${rec.urls.join(' , ')}` });
  }
  if (after.pathname !== '/watch' || after.v !== currentVideoId) {
    violations.push({ check: 'timestamp-seek-same-video', detail: `expected to stay on /watch?v=${currentVideoId}, got pathname=${after.pathname} v=${after.v}` });
  }
  if (targetSeconds == null || after.currentTime == null || Math.abs(after.currentTime - targetSeconds) > 2) {
    violations.push({ check: 'timestamp-seek-jumps', detail: `expected currentTime to land within ~2s of target ${targetSeconds}, before=${before} after=${after.currentTime}` });
  }
  // The popup must stay open after a timestamp click (seek, don't close) —
  // but leave it closed for whatever check runs next on this shared page.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return violations;
}

// The v4.41 watch-page redesign rebuilt the two-column layout as CSS grid
// specifically to fix a reported bug: at ~1000px viewport the action row
// overflowed and the Subscribe button floated over the related rail. This
// pins the fix at the exact breakpoints the redesign introduces (spacious
// >=1512, compact two-column 1240-1512, single-column <1240, sidebar icon
// rail <1100) and must FAIL on the pre-redesign code at width~1000 (verified
// via `git stash` before this check was written): the old `.watch-actions`
// had `flex: none` with no wrap, so Subscribe sat in the same unwrapping row
// as Save/Share/Tools/likes and got pushed outside the narrowed main column,
// on top of the rail.
async function checkWatchResponsive(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  const original = page.viewportSize();
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-subscribe', { state: 'visible', timeout: 15000 }).catch(() => {});
    const widths = [1512, 1280, 1240, 1100, 900, 768];
    for (const width of widths) {
      await page.setViewportSize({ width, height: original ? original.height : 900 });
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const doc = document.documentElement;
        const content = document.querySelector('#itube .content');
        const rail = document.querySelector('#itube .watch-right');
        const railVisible = !!rail && getComputedStyle(rail).display !== 'none' && rail.getBoundingClientRect().width > 0;
        const meta = document.querySelector('#itube .watch-meta');
        const relatedWrap = document.querySelector('.related-wrap');
        const railTabs = document.querySelector('.rail-tabs');
        return {
          vw: window.innerWidth,
          docOverflow: doc.scrollWidth > doc.clientWidth + 1,
          contentOverflow: content ? content.scrollWidth > content.clientWidth + 1 : false,
          railVisible,
          railRect: rect(rail),
          subscribeRect: rect(document.querySelector('.watch-subscribe')),
          metaRect: rect(meta),
          relatedTop: relatedWrap ? relatedWrap.getBoundingClientRect().top : null,
          metaBottom: meta ? meta.getBoundingClientRect().bottom : null,
          railTabsOverflow: railTabs ? railTabs.scrollWidth > (rail ? rail.getBoundingClientRect().width : railTabs.clientWidth) + 1 : false,
        };
      });
      if (info.railTabsOverflow) {
        violations.push({ check: 'watch-responsive-rail-tabs-overflow', detail: `at width=${width} .rail-tabs overflows the rail column` });
      }
      if (info.docOverflow) {
        violations.push({ check: 'watch-responsive-no-overflow', detail: `at width=${width} the document scrolls horizontally` });
      }
      if (info.contentOverflow) {
        violations.push({ check: 'watch-responsive-no-overflow', detail: `at width=${width} .content scrolls horizontally` });
      }
      // >=1240 is the two-column range (>=1512 spacious, 1240-1512 compact):
      // the rail sits BESIDE the main column, so an X-only edge comparison is
      // meaningful there — this is what pins the reported bug (Subscribe
      // floating over the rail at ~1000px).
      if (width >= 1240 && info.railVisible && info.subscribeRect && info.railRect) {
        const intersects = info.subscribeRect.right > info.railRect.left && info.subscribeRect.left < info.railRect.right
          && info.subscribeRect.bottom > info.railRect.top && info.subscribeRect.top < info.railRect.bottom;
        if (intersects) {
          violations.push({ check: 'watch-responsive-subscribe-overlap', detail: `at width=${width} .watch-subscribe (${JSON.stringify(info.subscribeRect)}) overlaps .watch-right (${JSON.stringify(info.railRect)})` });
        }
        if (info.metaRect && info.metaRect.right > info.railRect.left + 1) {
          violations.push({ check: 'watch-responsive-meta-overflow', detail: `at width=${width} .watch-meta right edge (${info.metaRect.right.toFixed(1)}) crosses into the rail column starting at ${info.railRect.left.toFixed(1)}` });
        }
      }
      // Below 1240 the rail column goes away and .watch-right's contents
      // (queue/related) reflow to a full-width section BELOW the meta/
      // comments column — they are not hidden, just no longer a side rail.
      // That is pinned two ways: .watch-right must start at the same left
      // edge as .watch-meta (not offset right, as a side column would be),
      // and it must sit below .watch-meta's bottom, not beside it.
      if (width < 1240) {
        if (info.railRect && info.metaRect && Math.abs(info.railRect.left - info.metaRect.left) > 4) {
          violations.push({ check: 'watch-responsive-single-column', detail: `at width=${width} expected .watch-right to share .watch-meta's left edge (stacked full-width below), got rail.left=${info.railRect.left.toFixed(1)} vs meta.left=${info.metaRect.left.toFixed(1)}` });
        }
        if (info.relatedTop !== null && info.metaBottom !== null && info.relatedTop < info.metaBottom - 1) {
          violations.push({ check: 'watch-responsive-related-below', detail: `at width=${width} expected related items to render below the meta/comments column, got related.top=${info.relatedTop.toFixed(1)} < meta.bottom=${info.metaBottom.toFixed(1)}` });
        }
      }
    }
  } finally {
    if (original) await page.setViewportSize(original);
    await page.close();
    await context.close();
  }
  return violations;
}

// Watch v2's whole point: description, transcript and comments moved out from
// under the meta block (into popups + a rail tab), so the watch page itself
// should fit without scrolling at standard viewports with the tools tray
// collapsed and both popups closed. This pins that directly rather than
// inferring it from individual element positions.
async function checkNoScrollWatch(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  const original = page.viewportSize();
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-subscribe', { state: 'visible', timeout: 15000 }).catch(() => {});
    const sizes = [{ width: 1512, height: 900 }, { width: 1280, height: 800 }];
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const content = document.querySelector('#itube .content');
        const toolsOpen = document.querySelector('.watch-tools')?.classList.contains('open');
        const popupsOpen = [...document.querySelectorAll('.itube-popup-overlay')].some((o) => o.classList.contains('show'));
        const titleLines = (() => {
          const t = document.querySelector('.watch-title');
          if (!t) return 0;
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 1;
          return Math.round(t.getBoundingClientRect().height / lh);
        })();
        return {
          scrollHeight: content ? content.scrollHeight : 0,
          clientHeight: content ? content.clientHeight : 0,
          toolsOpen: !!toolsOpen,
          popupsOpen,
          titleLines,
        };
      });
      if (info.toolsOpen || info.popupsOpen) {
        violations.push({ check: 'no-scroll-watch-precondition', detail: `at ${size.width}x${size.height} expected tools collapsed and no popup open before measuring, got toolsOpen=${info.toolsOpen} popupsOpen=${info.popupsOpen}` });
        continue;
      }
      if (info.titleLines >= 3) {
        console.log(`  no-scroll-watch: SKIP at ${size.width}x${size.height} — title wraps ${info.titleLines} lines on this video, which is an explicitly tolerated overflow case`);
        continue;
      }
      if (info.scrollHeight > info.clientHeight + 24) {
        violations.push({ check: 'no-scroll-watch', detail: `at ${size.width}x${size.height} .content scrollHeight=${info.scrollHeight} exceeds clientHeight=${info.clientHeight} by more than the 24px tolerance — the watch page should fit without scrolling with tools collapsed and popups closed` });
      }
    }
  } finally {
    if (original) await page.setViewportSize(original);
    await page.close();
    await context.close();
  }
  return violations;
}

// Description/Transcript popups: a fast glass panel (native `popover` when
// supported, wireOverlay fallback otherwise) opened from an action pill,
// mutually exclusive with each other, closed by Escape/backdrop. The
// Transcript pill only renders once caption-track availability is known —
// never before, and never by fetching the transcript body itself. Comments
// stay lazy: no continuation POST until the rail's Comments tab is first
// activated, and the Top/Newest sort control only ever renders inside that
// tab panel.
async function checkWatchPopups(browser) {
  const violations = [];
  const context = await newContext(browser, { prefs: { 'itube-transcript': '1' } });
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  const commentContinuations = [];
  page.on('request', (req) => {
    if (/\/youtubei\/v1\/next/.test(req.url()) && req.method() === 'POST') {
      const body = req.postData() || '';
      if (body.includes('continuation')) commentContinuations.push(req.url());
    }
  });
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-action-btn[aria-label="Description"]', { timeout: 15000 }).catch(() => {});

    const descBtn = await page.$('.watch-action-btn[aria-label="Description"]');
    if (!descBtn) {
      violations.push({ check: 'description-popup-button-exists', detail: 'expected a Description pill in the action row' });
    } else {
      await descBtn.click();
      await page.waitForTimeout(200);
      const afterOpen = await page.evaluate(() => {
        const overlay = document.querySelector('.desc-popup');
        const text = document.querySelector('.desc-popup .watch-description')?.textContent || '';
        return { visible: !!overlay && overlay.classList.contains('show'), textLength: text.trim().length };
      });
      if (!afterOpen.visible) {
        violations.push({ check: 'description-popup-opens', detail: 'expected the Description pill to open .desc-popup' });
      }
      if (afterOpen.textLength === 0) {
        violations.push({ check: 'description-popup-full-text', detail: 'expected the Description popup body to contain the full description text' });
      }
      // Regression guard: .popup-title used to inherit `color` through a
      // [popover] element, whose UA stylesheet sets `color: CanvasText`
      // (near-black) on the popover host itself — that beat the light
      // --text token inherited from #itube, rendering the title unreadable
      // on the dark panel. Assert the computed color is actually light.
      const descTitleColor = await page.evaluate(() => getComputedStyle(document.querySelector('.desc-popup .popup-title')).color);
      const descLum = luminanceOf(descTitleColor);
      if (descLum == null || descLum < 0.4) {
        violations.push({ check: 'description-popup-title-readable', detail: `expected .desc-popup .popup-title color to be light on the dark panel, got ${descTitleColor} (luminance=${descLum})` });
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const afterEscape = await page.evaluate(() => document.querySelector('.desc-popup')?.classList.contains('show'));
      if (afterEscape) {
        violations.push({ check: 'description-popup-escape-closes', detail: 'expected Escape to close the Description popup' });
      }
    }

    const transcriptBtn = await page.$('.watch-action-btn[aria-label="Transcript"]');
    if (!transcriptBtn) {
      console.log('  watch-popups: note — no Transcript pill on this video (no caption tracks), skipping the transcript/mutual-exclusion assertions');
    } else {
      if (descBtn) await descBtn.click();
      await page.waitForTimeout(200);
      // Both popups are full-viewport overlays, so once one is open it
      // physically covers the other action pill — a real mouse click on
      // Transcript would land on the Description backdrop first (dismissing
      // it) rather than reach the button underneath in the same gesture.
      // Dispatch the click directly on the element to exercise the mutual-
      // exclusion handler itself, the same defensive path a focus+Enter
      // activation (or the backdrop's own light-dismiss racing a click)
      // would take.
      await page.evaluate((el) => el.click(), transcriptBtn);
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({
        descOpen: document.querySelector('.desc-popup')?.classList.contains('show'),
        transcriptOpen: document.querySelector('.transcript-popup')?.classList.contains('show'),
      }));
      if (state.descOpen) {
        violations.push({ check: 'popups-mutually-exclusive', detail: 'expected opening the Transcript popup to close an already-open Description popup' });
      }
      // v4.45 added a real recovery path: if the actual caption fetch proves
      // the pill's metadata wrong (empty/failed body on a live, flaky
      // caption endpoint), loadTranscript() hides the pill AND closes the
      // popup it just opened — same as checkTranscriptProvedUnavailable
      // exercises deterministically. That is an intentional, correct outcome
      // here too, not a bug, so distinguish it from a real "pill did nothing"
      // failure by also checking whether the pill itself got hidden.
      if (!state.transcriptOpen) {
        const pillNowHidden = await page.evaluate(() => {
          const btn = document.querySelector('.watch-action-btn[aria-label="Transcript"]');
          return !!btn && getComputedStyle(btn).display === 'none';
        });
        if (pillNowHidden) {
          console.log('  watch-popups: note — the Transcript popup opened then self-closed because the caption fetch proved unavailable (recovery path, see checkTranscriptProvedUnavailable); skipping the remaining transcript-popup assertions');
        } else {
          violations.push({ check: 'transcript-popup-opens', detail: 'expected the Transcript pill to open .transcript-popup' });
        }
      } else {
        const transcriptTitleColor = await page.evaluate(() => getComputedStyle(document.querySelector('.transcript-popup .popup-title')).color);
        const transcriptLum = luminanceOf(transcriptTitleColor);
        if (transcriptLum == null || transcriptLum < 0.4) {
          violations.push({ check: 'transcript-popup-title-readable', detail: `expected .transcript-popup .popup-title color to be light on the dark panel, got ${transcriptTitleColor} (luminance=${transcriptLum})` });
        }
        const backdropDismiss = await page.evaluate(() => {
          const overlay = document.querySelector('.transcript-popup');
          if (!overlay) return null;
          overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        });
        if (backdropDismiss) {
          await page.waitForTimeout(250);
          const stillOpen = await page.evaluate(() => document.querySelector('.transcript-popup')?.classList.contains('show'));
          if (stillOpen && !(await page.evaluate(() => 'showPopover' in HTMLElement.prototype))) {
            violations.push({ check: 'transcript-popup-backdrop-closes', detail: 'expected clicking the overlay backdrop to close the Transcript popup' });
          }
        }
      }
      // The transcript popup is a full-viewport overlay too — close it via
      // Escape (works for both the native-popover and fallback paths) before
      // interacting with anything else underneath.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    const tab = await page.$('.rail-tab:has-text("Comments")');
    const disabled = tab ? await page.evaluate((el) => el.disabled, tab) : true;
    if (!disabled) {
      if (commentContinuations.length > 0) {
        violations.push({ check: 'comments-lazy-no-early-fetch', detail: `expected 0 comments continuation POSTs before the Comments tab is first activated, got ${commentContinuations.length}` });
      }
      // .comments-sort's OWN inline display is 'flex' whenever sort options
      // exist — visibility while a tab is inactive comes from the ancestor
      // .comments panel being display:none, so check actual rendered
      // visibility (offsetParent), not the element's own display property.
      const sortVisibleBefore = await page.evaluate(() => document.querySelector('.comments-sort')?.offsetParent !== null);
      if (sortVisibleBefore) {
        violations.push({ check: 'comments-sort-only-in-tab', detail: 'expected .comments-sort to be hidden while the Up next tab is active' });
      }
      await tab.click();
      await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(200);
      if (commentContinuations.length === 0) {
        violations.push({ check: 'comments-fetch-on-activation', detail: 'expected activating the Comments tab to trigger a comments continuation POST' });
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Watch v2: comments moved off the page entirely into a tabbed right rail
// ("Up next" | "Comments · N"), fetched lazily on first tab activation. The
// Top/Newest sort segmented control must only be reachable inside the
// Comments tab panel, never in Up next — this is the tab-based descendant of
// the old bug where the sort control could render above a collapsed
// .comments-body regardless of expand state.
async function checkCommentsSortVisibility(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.rail-tab', { timeout: 15000 }).catch(() => {});
    const disabled = await page.evaluate(() => [...document.querySelectorAll('.rail-tab')].find((b) => /Comments/.test(b.textContent))?.disabled);
    if (disabled) {
      console.log('  comments-sort-visibility: SKIP — the Comments rail tab is disabled (no comments continuation on this fixture right now)');
      return violations;
    }
    const upNextVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.up-next-panel')).display !== 'none');
    if (!upNextVisible) {
      violations.push({ check: 'rail-defaults-to-upnext', detail: 'expected the rail to default to the Up next tab on mount' });
    }
    const collapsedVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.comments-sort')).display !== 'none' && getComputedStyle(document.querySelector('.comments')).display !== 'none');
    if (collapsedVisible) {
      violations.push({ check: 'comments-sort-hidden-collapsed', detail: 'expected the Comments panel (and its sort control) to be hidden while the Up next tab is active' });
    }
    await page.click('.rail-tab:has-text("Comments")');
    await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
    const sortOptionCount = await page.evaluate(() => document.querySelectorAll('.comments-sort-btn').length);
    if (sortOptionCount > 0) {
      const expandedVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.comments-sort')).display !== 'none');
      if (!expandedVisible) {
        violations.push({ check: 'comments-sort-visible-expanded', detail: 'expected .comments-sort to become visible once the Comments tab is active and sort options exist' });
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Watch v2: the inline description preview + "More" expander were removed
// from under the meta block entirely — description text now only renders
// inside the Description popup (opened via the .watch-action-btn pill), kept
// instant/zero-network because renderMeta() builds it once per video. The
// link-chips row stays in the meta (compact, loved) AND is repeated at the
// top of the popup. This is best-effort against a real video: if the live
// description no longer contains a URL, that's a content change on YouTube's
// end, not a regression, so it SKIPs rather than fails.
const DESC_LINKS_VIDEO_ID = 'aircAruvnKk';
async function checkDescriptionChips(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, `https://www.youtube.com/watch?v=${DESC_LINKS_VIDEO_ID}`);
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    // Link chips live only inside the Description popup now (the inline meta
    // copy was removed as a duplicate) — open the popup before reading them.
    await page.waitForSelector('.watch-action-btn[aria-label="Description"]', { timeout: 15000 }).catch(() => {});
    const descChipBtn = await page.$('.watch-action-btn[aria-label="Description"]');
    if (descChipBtn) { await descChipBtn.click(); await page.waitForTimeout(300); }
    const chips = await page.evaluate(() => Array.from(document.querySelectorAll('.desc-popup .watch-desc-chip')).map((a) => a.href));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (!chips.length) {
      console.log(`  description-chips: SKIP — ${DESC_LINKS_VIDEO_ID}'s description has no extractable URL right now (a content change, not a regression) — nothing to assert`);
      return violations;
    }
    // The chip's DISPLAYED text is deliberately not the check here: YouTube
    // often shows a shortened/custom label for a description link run (e.g.
    // link text "/3blue1brown" pointing at a full patreon.com URL), so a
    // domain-in-rendered-text comparison is a false invariant — that
    // shortening is exactly why the chips exist (a link icon + real domain
    // instead of whatever label the creator wrote). Instead check the raw
    // page DATA (ytInitialData / ytInitialPlayerResponse, which the app's own
    // extractor reads from) for the domain, allowing for the fact that a
    // YouTube /redirect?q=<url> wrapper still contains the literal domain
    // substring even URL-encoded (encodeURIComponent leaves letters/dots
    // alone).
    const rawData = await page.evaluate(() => JSON.stringify(window.ytInitialData || null) + JSON.stringify(window.ytInitialPlayerResponse || null));
    for (const href of chips) {
      const domain = (() => { try { return new URL(href).hostname; } catch (e) { return null; } })();
      if (!domain || !rawData.includes(domain)) {
        violations.push({ check: 'description-chip-matches-text', detail: `chip href ${href} — domain "${domain}" was not found anywhere in ytInitialData/ytInitialPlayerResponse, so it may not correspond to a real URL from the description` });
      }
    }
    const descBtn = await page.$('.watch-action-btn[aria-label="Description"]');
    if (!descBtn) {
      violations.push({ check: 'description-popup-button-exists', detail: 'expected a Description pill in the action row alongside the link chips' });
    } else {
      await descBtn.click();
      await page.waitForTimeout(200);
      const opened = await page.evaluate(() => {
        const overlay = document.querySelector('.desc-popup');
        const body = document.querySelector('.desc-popup .watch-description');
        return {
          visible: !!overlay && getComputedStyle(overlay).display !== 'none',
          hasText: !!body && (body.textContent || '').trim().length > 0,
          chipCount: document.querySelectorAll('.desc-popup .watch-desc-chip').length,
        };
      });
      if (!opened.visible) {
        violations.push({ check: 'description-popup-opens', detail: 'expected clicking the Description pill to reveal .desc-popup' });
      }
      if (!opened.hasText) {
        violations.push({ check: 'description-popup-text', detail: 'expected the Description popup to render the full description text' });
      }
      if (opened.chipCount !== chips.length) {
        violations.push({ check: 'description-popup-chips-repeated', detail: `expected the popup to repeat the ${chips.length} link chip(s) at its top, found ${opened.chipCount}` });
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Best-effort: comment bodies now render clickable segments (timestamps seek,
// URLs/mentions are real links) instead of one plain-text blob. Not every
// video's top comments contain a link, so this skips cleanly rather than
// asserting on content the live site may not have served this run.
async function checkCommentBodyLinks(page) {
  const violations = [];
  const links = await page.evaluate(() => [...document.querySelectorAll('.comment-text a')].map((a) => ({
    href: a.getAttribute('href'),
    nested: !!a.querySelector('a'),
  })));
  if (!links.length) {
    console.log('  comment-body-links: SKIP — no <a> found inside any .comment-text on this run');
    return violations;
  }
  const bad = links.filter((l) => !l.href || !/^(\/|https?:\/\/)/.test(l.href) || l.nested);
  if (bad.length) {
    violations.push({
      check: 'comment-body-link-shape',
      detail: `${bad.length}/${links.length} .comment-text links are malformed (want a real channel/watch/http href, no nested <a>): ${bad.slice(0, 3).map((l) => JSON.stringify(l)).join(' ; ')}`,
    });
  }
  return violations;
}

// Best-effort/optional: a deterministic comments-disabled video is hard to
// pin to a live id, so this only asserts something when the CURRENT video
// happens to have comments disabled (commentsToggle.disabled reflects that
// directly — see resetComments in flyt.user.js). Otherwise it skips cleanly.
async function checkCommentsOffCopy(page) {
  const violations = [];
  const info = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.rail-tab')].find((b) => /Comments/.test(b.textContent));
    const label = tab ? tab.querySelector('span') : null;
    return { disabled: tab ? tab.disabled : null, text: label ? label.textContent : null };
  });
  if (!info.disabled) {
    console.log('  comments-off-copy: SKIP — this video has comments enabled, nothing to assert');
    return violations;
  }
  if (info.text !== 'Comments are turned off.') {
    violations.push({ check: 'comments-off-copy', detail: `expected the Comments rail tab label to read "Comments are turned off." on a video with comments disabled, got "${info.text}"` });
  }
  return violations;
}

// A legacy /user/<name> channel URL used to fall straight through
// CHANNEL_PATH_RE, land on { type: 'unhandled' }, and render the "isn't
// available" card instead of the channel — even though the click was already
// intercepted client-side. Proves both halves: no reload, AND the channel
// mount (not the unhandled one) is what actually renders.
async function checkUserRouteClientSide(page) {
  const violations = [];
  const userHref = '/user/YouTube';
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'itube-test-user-link';
    a.href = href;
    a.textContent = 'legacy user link';
    a.style.position = 'fixed';
    a.style.left = '0';
    a.style.bottom = '0';
    a.style.zIndex = '99999';
    document.querySelector('#itube').appendChild(a);
  }, userHref);

  const mark = await stampMark(page);
  const rec = recordMainFrameDocLoads(page);
  let survived;
  try {
    await page.click('#itube-test-user-link');
    await page.waitForFunction(() => (
      document.querySelector('.ch-header') || document.querySelector('.empty') || document.querySelector('.unhandled')
    ), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    survived = await markSurvived(page, mark);
  } finally {
    rec.stop();
  }

  const info = await page.evaluate(() => ({
    path: location.pathname,
    mountedChannel: !!(document.querySelector('.ch-header') || document.querySelector('.empty')),
    mountedUnhandled: !!document.querySelector('.unhandled'),
  }));
  await page.evaluate(() => document.getElementById('itube-test-user-link')?.remove());

  if (info.path !== userHref) {
    violations.push({ check: 'user-route-client-side', detail: `expected clicking "${userHref}" to SPA-route to it, got pathname "${info.path}"` });
  }
  if (rec.urls.length > 0) {
    violations.push({ check: 'user-route-no-reload', detail: `clicking "${userHref}" caused ${rec.urls.length} main-frame document load(s), expected a client-side route: ${rec.urls.join(' , ')}` });
  }
  if (!survived) {
    violations.push({ check: 'user-route-no-reload', detail: `window.__itubeMark did not survive clicking "${userHref}" — the document was replaced` });
  }
  if (info.mountedUnhandled || !info.mountedChannel) {
    violations.push({ check: 'user-route-mounts-channel', detail: `expected "${userHref}" to mount the channel view (CHANNEL_PATH_RE must match legacy /user/ paths), got mountedUnhandled=${info.mountedUnhandled} mountedChannel=${info.mountedChannel}` });
  }
  return violations;
}

// The applied search filter used to live in memory only: reload or Back lost
// it silently. Asserts the filter round-trips through the URL's own `sp`
// param (YouTube's real param name) both ways — select change -> URL, and
// URL -> restored select on reload — without asserting on result CONTENT,
// which the live site can legitimately vary.
async function checkFiltersInUrl(page) {
  const violations = [];
  const selects = await page.$$('.search-filter-select');
  if (!selects.length) {
    violations.push({ check: 'filters-in-url-select-exists', detail: 'expected .search-filter-select elements on the search page' });
    return violations;
  }
  const sortSelect = selects[0];
  const options = await page.evaluate((el) => [...el.options].map((o) => o.value).filter(Boolean), sortSelect);
  if (!options.length) {
    violations.push({ check: 'filters-in-url-select-exists', detail: 'expected the sort filter select to have at least one non-empty option' });
    return violations;
  }
  const chosen = options[0];
  await sortSelect.selectOption(chosen);
  await page.waitForFunction((val) => new URLSearchParams(location.search).get('sp') === val, chosen, { timeout: 5000 }).catch(() => {});
  const spAfterChange = await page.evaluate(() => new URLSearchParams(location.search).get('sp'));
  if (spAfterChange !== chosen) {
    violations.push({ check: 'filters-in-url-sp-set', detail: `expected location.search to gain sp=${chosen} after changing the sort filter, got sp=${spAfterChange}` });
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page, { timeout: 30000 });
  await page.waitForSelector('.search-filter-select', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => {
    const sel = document.querySelector('.search-filter-select');
    return { spInUrl: new URLSearchParams(location.search).get('sp'), selectValue: sel ? sel.value : null };
  });
  if (restored.spInUrl !== chosen) {
    violations.push({ check: 'filters-in-url-survives-reload', detail: `expected sp=${chosen} to survive reload, got sp=${restored.spInUrl}` });
  }
  if (restored.selectValue !== chosen) {
    violations.push({ check: 'filters-in-url-select-restored', detail: `expected the sort <select> value to be restored to "${chosen}" after reload, got "${restored.selectValue}"` });
  }
  return violations;
}

// The suggestions dropdown is fetched from a third-party endpoint
// (suggestqueries-clients6.youtube.com) that can be flaky or briefly
// throttled in CI, so a missing dropdown is a SKIP, not a FAIL — but once it
// shows up, its keyboard behavior and submit behavior are asserted for real:
// ArrowDown/ArrowUp must move the highlighted row, and Enter must submit the
// HIGHLIGHTED suggestion (not just whatever was typed), landing on
// /results?search_query=<that suggestion> without leaving the dropdown open.
async function checkSearchSuggestions(page) {
  const violations = [];
  const input = await page.$('.search');
  if (!input) {
    violations.push({ check: 'search-suggestions-input', detail: 'expected a .search input in the header' });
    return violations;
  }

  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await input.type('liquid glass', { delay: 30 });
  await page.waitForSelector('.search-suggest.show .search-suggest-row', { timeout: 5000 }).catch(() => {});
  let rows = await page.$$('.search-suggest-row');
  if (!rows.length) {
    console.log('  search-suggestions: SKIP — no suggestions arrived (third-party endpoint variance), nothing to assert');
    return violations;
  }

  const texts = await page.evaluate(() => [...document.querySelectorAll('.search-suggest-row')].map((r) => r.textContent));

  await page.keyboard.press('ArrowDown');
  let active = await page.evaluate(() => document.querySelector('.search-suggest-row.active')?.textContent || null);
  if (active !== texts[0]) {
    violations.push({ check: 'search-suggestions-keyboard', detail: `ArrowDown expected to highlight "${texts[0]}", got "${active}"` });
  }
  if (texts.length > 1) {
    await page.keyboard.press('ArrowDown');
    active = await page.evaluate(() => document.querySelector('.search-suggest-row.active')?.textContent || null);
    if (active !== texts[1]) {
      violations.push({ check: 'search-suggestions-keyboard', detail: `second ArrowDown expected to highlight "${texts[1]}", got "${active}"` });
    }
    await page.keyboard.press('ArrowUp');
    active = await page.evaluate(() => document.querySelector('.search-suggest-row.active')?.textContent || null);
    if (active !== texts[0]) {
      violations.push({ check: 'search-suggestions-keyboard', detail: `ArrowUp expected to move back to "${texts[0]}", got "${active}"` });
    }
  }

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.pathname === '/results', { timeout: 5000 }).catch(() => {});
  const afterEnter = await page.evaluate(() => ({
    path: location.pathname,
    q: new URLSearchParams(location.search).get('search_query'),
    suggestVisible: !!document.querySelector('.search-suggest.show'),
  }));
  if (afterEnter.path !== '/results' || afterEnter.q !== texts[0]) {
    violations.push({ check: 'search-suggestions-submit', detail: `expected Enter on the highlighted suggestion to navigate to /results?search_query=${encodeURIComponent(texts[0])}, got path=${afterEnter.path} q=${afterEnter.q}` });
  }
  if (afterEnter.suggestVisible) {
    violations.push({ check: 'search-suggestions-submit', detail: 'the suggestions dropdown is still visible after submitting' });
  }

  const input2 = await page.$('.search');
  await input2.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await input2.type('never gonna', { delay: 30 });
  await page.waitForSelector('.search-suggest.show .search-suggest-row', { timeout: 5000 }).catch(() => {});
  rows = await page.$$('.search-suggest-row');
  if (!rows.length) {
    console.log('  search-suggestions: SKIP (click phase) — no suggestions arrived for the second query');
    return violations;
  }
  const clickText = await page.evaluate((el) => el.textContent, rows[0]);
  await rows[0].click();
  await page.waitForFunction((q) => new URLSearchParams(location.search).get('search_query') === q, clickText, { timeout: 5000 }).catch(() => {});
  const afterClick = await page.evaluate(() => ({
    path: location.pathname,
    q: new URLSearchParams(location.search).get('search_query'),
  }));
  if (afterClick.path !== '/results' || afterClick.q !== clickText) {
    violations.push({ check: 'search-suggestions-click', detail: `expected clicking a suggestion row to navigate to /results?search_query=${encodeURIComponent(clickText)}, got path=${afterClick.path} q=${afterClick.q}` });
  }

  return violations;
}

// Regression: hideSuggestions() used to clear only the dropdown DOM, not the
// pending debounce timer or the in-flight fetch generation. So a suggestion
// request that was still in flight when the user SUBMITTED (Enter within the
// 150ms debounce, or clicking a video) resolved AFTER navigation and re-opened
// the dropdown on the results/watch page over an unfocused input — the app
// popping open a menu on a page the user had already left.
//
// checkSearchSuggestions can't catch this: it waits for the dropdown to appear
// BEFORE pressing Enter, so by submit time there is no pending timer/fetch.
// This reproduces the real condition — submit while a request is still pending
// — deterministically by MOCKING the suggest endpoint (the live one is
// third-party and its timing can't be relied on to land post-navigation).
async function checkSuggestionsDontResurrectAfterSubmit(page) {
  const violations = [];
  const suggestRe = /suggestqueries.*\/complete\/search/;
  // Canned reply keyed off the query, so the resurrected dropdown (if the bug
  // is present) has real rows to render and `search.value === q` still holds
  // after mountSearch re-sets the input value post-navigation.
  await page.route(suggestRe, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || 'x';
    const body = JSON.stringify([q, [[q + ' one'], [q + ' two'], [q + ' three']]]);
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  try {
    const input = await page.$('.search');
    if (!input) {
      violations.push({ check: 'suggestions-resurrect-input', detail: 'expected a .search input in the header' });
      return violations;
    }
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    // Type then submit immediately — the debounce timer scheduled by the last
    // keystroke is still pending when Enter fires, which is the exact bug
    // condition. (A short per-key delay keeps the whole type well under 150ms.)
    await input.type('resurrect probe', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname === '/results', { timeout: 5000 }).catch(() => {});
    // Well past the 150ms debounce plus the (instant, mocked) fetch: a
    // resurrected dropdown would have rendered by now.
    await page.waitForTimeout(700);
    const visible = await page.evaluate(() => !!document.querySelector('.search-suggest.show'));
    if (visible) {
      violations.push({ check: 'suggestions-no-resurrect-after-submit', detail: 'the suggestions dropdown reappeared after the search was submitted — a debounce timer or in-flight suggestion request outlived hideSuggestions() and re-opened the dropdown post-navigation, over an unfocused input on a page the user already left' });
    }
  } finally {
    await page.unroute(suggestRe).catch(() => {});
  }
  return violations;
}

// The About tab has to behave like Videos/Playlists: a real tab button that
// mounts content client-side. Reuses the doc-load counting pattern from
// checkUserRouteClientSide — the failure mode this guards against is the tab
// silently falling back to a full navigation (or not existing at all).
async function checkAboutTab(page) {
  const violations = [];
  const aboutHandle = await page.evaluateHandle(() => (
    [...document.querySelectorAll('.ch-tab')].find((b) => b.textContent.trim() === 'About') || null
  ));
  const aboutBtn = aboutHandle.asElement();
  if (!aboutBtn) {
    violations.push({ check: 'about-tab-exists', detail: 'expected a "About" .ch-tab button beside Videos/Playlists' });
    return violations;
  }

  const mark = await stampMark(page);
  const rec = recordMainFrameDocLoads(page);
  try {
    await aboutBtn.click();
    await page.waitForFunction(() => location.pathname.endsWith('/about'), { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.ch-about-desc, .ch-about-stats, .ch-about .empty', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
  } finally {
    rec.stop();
  }
  const survived = await markSurvived(page, mark);

  const info = await page.evaluate(() => ({
    path: location.pathname,
    hasAbout: !!document.querySelector('.ch-about'),
    hasDescOrStats: !!(document.querySelector('.ch-about-desc') || document.querySelector('.ch-about-stats')),
  }));

  if (!info.path.endsWith('/about')) {
    violations.push({ check: 'about-tab-url', detail: `expected the URL to end in /about after clicking the About tab, got "${info.path}"` });
  }
  if (!survived) {
    violations.push({ check: 'about-tab-client-side', detail: 'clicking the About tab wiped window state — the page reloaded' });
  }
  if (rec.urls.length > 0) {
    violations.push({ check: 'about-tab-client-side', detail: `clicking the About tab caused ${rec.urls.length} main-frame document load(s), expected a client-side mount: ${rec.urls.join(' , ')}` });
  }
  if (!info.hasAbout || !info.hasDescOrStats) {
    violations.push({ check: 'about-tab-content', detail: 'expected the About tab to mount a description/stats block (.ch-about-desc or .ch-about-stats)' });
  }
  return violations;
}

// Clicking a related video used to swap the <video> source with nothing
// covering the gap: the decoder drops the old frame before the new one is
// ready, so the stage goes black or freezes for a beat. The fix snapshots the
// stage into a <canvas> the instant the switch starts and fades it out once
// the new video has actually painted. This asserts the whole contract: the
// overlay shows up, it goes away again within its ~1.5s hard timeout, the
// underlying <video> is never hidden while it's covering for it (the actual
// failure mode this exists to prevent), the stage box never moves, there is
// no main-frame reload, and playback is still advancing afterward.
async function checkVideoCrossfade(page) {
  const violations = [];
  await page.waitForSelector('.rc', { timeout: 10000 }).catch(() => {});
  const related = await page.$('.rc');
  if (!related) {
    violations.push({ check: 'crossfade-related-exists', detail: 'expected at least one .rc related card to trigger a watch-to-watch switch' });
    return violations;
  }
  // The crossfade only has something worth snapshotting once the CURRENT
  // video has actually reached a decodable frame (readyState >= 2) — YouTube's
  // own player cycles readyState down to 0 and back a few times while it
  // resolves formats after any switch, so clicking again mid-cycle (e.g. right
  // after checkWatchToWatchNavigation's own switch) is a real, correct skip
  // condition, not a bug. Wait for that settle first so this check exercises
  // the overlay path instead of the guarded no-op path.
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && v.readyState >= 2;
  }, { timeout: 8000 }).catch(() => {});
  const stageBefore = await page.evaluate(() => {
    const r = document.querySelector('#itube-stage')?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  const titleBefore = await page.evaluate(() => document.querySelector('.watch-title')?.textContent || '');
  const rec = recordMainFrameDocLoads(page);
  const clicked = await clickCardPart(page, related, '.rc-title');
  if (!clicked) {
    rec.stop();
    violations.push({ check: 'crossfade-related-exists', detail: 'the first .rc related card has no layout box to click' });
    return violations;
  }

  const result = await page.evaluate(() => new Promise((resolve) => {
    const stage = document.getElementById('itube-stage');
    const start = performance.now();
    let sawOverlay = false;
    let sawVideoHidden = false;
    const poll = () => {
      const canvas = stage && stage.querySelector('canvas.itube-crossfade');
      const video = stage && stage.querySelector('video');
      if (canvas && Number(getComputedStyle(canvas).opacity) > 0) sawOverlay = true;
      if (video && getComputedStyle(video).display === 'none') sawVideoHidden = true;
      if (performance.now() - start < 3000) {
        requestAnimationFrame(poll);
      } else {
        resolve({
          sawOverlay,
          sawVideoHidden,
          overlayGoneAtEnd: !(stage && stage.querySelector('canvas.itube-crossfade')),
        });
      }
    };
    requestAnimationFrame(poll);
  }));
  rec.stop();

  await page.waitForFunction(
    (prev) => document.querySelector('.watch-title')?.textContent !== prev,
    titleBefore,
    { timeout: 8000 }
  ).catch(() => {});

  const stageAfter = await page.evaluate(() => {
    const r = document.querySelector('#itube-stage')?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  // YouTube's own player cycles readyState/currentTime a few times while it
  // resolves formats after a switch (see the crossfade-overlay-appears
  // comment above), so a single fixed-delay sample can land mid-cycle. Poll
  // instead of sleeping once: this only cares that playback eventually
  // resumes, not how many buffering cycles it took to get there.
  const playbackOk = await page.evaluate(() => new Promise((resolve) => {
    const video = document.querySelector('#itube-stage video');
    if (!video) { resolve(false); return; }
    const t0 = video.currentTime;
    const deadline = performance.now() + 6000;
    const poll = () => {
      if (video.currentTime > t0 || !video.paused) { resolve(true); return; }
      if (performance.now() > deadline) { resolve(false); return; }
      setTimeout(poll, 250);
    };
    poll();
  }));

  if (!result.sawOverlay) {
    violations.push({ check: 'crossfade-overlay-appears', detail: 'expected a canvas.itube-crossfade snapshot overlay to appear with opacity > 0 during a watch-to-watch switch' });
  }
  if (!result.overlayGoneAtEnd) {
    violations.push({ check: 'crossfade-overlay-removed', detail: 'expected the crossfade snapshot overlay to be gone within ~1.5s (its hard timeout), it was still present after 2.2s' });
  }
  if (result.sawVideoHidden) {
    violations.push({ check: 'crossfade-no-black-flash', detail: 'the <video> element was display:none at some point during the switch — that is the black-flash failure mode the crossfade overlay exists to cover for' });
  }
  if (rec.urls.length > 0) {
    violations.push({ check: 'crossfade-no-reload', detail: `expected 0 main-frame document loads during the crossfade switch, got ${rec.urls.length}: ${rec.urls.join(' , ')}` });
  }
  if (stageBefore && stageAfter) {
    // A tolerance wider than 1px is deliberate: the related/queue list can
    // grow or shrink enough between videos to toggle the page's own vertical
    // scrollbar, which shifts the viewport width by a scrollbar's worth of
    // pixels — a real but unrelated effect, not a regression in the
    // crossfade. What this guards against is the stage collapsing or
    // resizing by anything bigger than that.
    const moved = Math.abs(stageBefore.x - stageAfter.x) > 24 || Math.abs(stageBefore.y - stageAfter.y) > 24
      || Math.abs(stageBefore.width - stageAfter.width) > 24 || Math.abs(stageBefore.height - stageAfter.height) > 24;
    if (moved) {
      violations.push({ check: 'crossfade-no-layout-jump', detail: `#itube-stage box moved during the switch: before=${JSON.stringify(stageBefore)} after=${JSON.stringify(stageAfter)}` });
    }
  }
  if (!playbackOk) {
    violations.push({ check: 'crossfade-playback-resumes', detail: 'expected playback to resume (currentTime advancing, or not paused) after the switch completed' });
  }
  return violations;
}

// The crossfade is explicitly skipped when Picture-in-Picture is active (the
// video has left the stage, so there is nothing on the stage to snapshot).
// Headless Chromium generally refuses to actually enter PiP with no window
// manager behind it, so this is best-effort: it only asserts the guard when
// it can actually get the browser into PiP, and skips cleanly (with a reason)
// otherwise rather than passing vacuously or failing on an environment limit.
async function checkCrossfadeSkipsWithPiP(page) {
  const violations = [];
  await page.waitForSelector('.rc', { timeout: 10000 }).catch(() => {});
  const related = await page.$('.rc');
  if (!related) return violations;
  const enteredPiP = await page.evaluate(() => {
    const video = document.querySelector('#itube-stage video');
    if (!video || typeof video.requestPictureInPicture !== 'function') return Promise.resolve(false);
    return video.requestPictureInPicture().then(() => true).catch(() => false);
  });
  if (!enteredPiP) {
    console.log('  crossfade-pip-skip: SKIP — headless Chromium would not enter real Picture-in-Picture here, cannot exercise the PiP guard');
    return violations;
  }
  const clicked = await clickCardPart(page, related, '.rc-title');
  if (clicked) {
    await page.waitForTimeout(400);
    const hasOverlay = await page.evaluate(() => !!document.querySelector('#itube-stage canvas.itube-crossfade'));
    if (hasOverlay) {
      violations.push({ check: 'crossfade-pip-skip', detail: 'expected no crossfade overlay while Picture-in-Picture is active' });
    }
  }
  await page.evaluate(() => (document.exitPictureInPicture ? document.exitPictureInPicture().catch(() => {}) : null));
  return violations;
}

// Before renderMeta() applies a video's data, the meta card used to render as
// visibly broken: an empty avatar circle, an empty channel name, and a
// metaDivider line sitting above nothing (channelRow hidden/empty while the
// divider it sits under stayed visible). The skeleton exists to occupy that
// gap deliberately instead. This drives a real watch-to-watch switch (the
// only path with an observable async gap — the initial hard load renders
// synchronously from ytInitialData) and asserts: the skeleton actually shows
// up, the divider is never shown while its own channelRow is hidden (the
// structural version of the orphaned-divider bug — a stale channel NAME
// lingering hidden behind it isn't the bug; a divider floating over nothing
// visible is), the skeleton is gone by the time real data lands, and the
// real name text is there afterward.
async function checkWatchLoadSkeleton(page) {
  const violations = [];
  await page.waitForSelector('.rc', { timeout: 10000 }).catch(() => {});
  const related = await page.$('.rc');
  if (!related) {
    violations.push({ check: 'skeleton-related-exists', detail: 'expected at least one .rc related card to trigger a watch-to-watch switch' });
    return violations;
  }
  // Arm the observer BEFORE clicking, not after — renderWatchFor's async gap
  // can be short enough on a fast connection that a probe installed only
  // after the click misses the whole loading window and asserts nothing.
  await page.evaluate(() => {
    window.__skeletonProbe = new Promise((resolve) => {
      const sk = document.querySelector('.watch-skeleton');
      const channelRow = document.querySelector('.watch-channel');
      const nameEl = document.querySelector('.watch-channel-name');
      let sawSkeleton = false;
      let orphanedContent = false;
      const check = () => {
        let skVisible = false;
        if (sk) {
          skVisible = getComputedStyle(sk).display !== 'none' && Number(getComputedStyle(sk).opacity) > 0;
          if (skVisible) sawSkeleton = true;
        }
        const channelRowVisible = channelRow && getComputedStyle(channelRow).display !== 'none';
        const nameEmpty = !((nameEl && nameEl.textContent || '').trim());
        if (channelRowVisible && nameEmpty && !skVisible) orphanedContent = true;
      };
      check();
      const mo = new MutationObserver(check);
      mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
      setTimeout(() => {
        mo.disconnect();
        check();
        resolve({
          sawSkeleton,
          orphanedContent,
          skeletonGoneAtEnd: !sk || getComputedStyle(sk).display === 'none',
          nameAtEnd: (nameEl && nameEl.textContent || '').trim(),
        });
      }, 6000);
    });
  });

  const clicked = await clickCardPart(page, related, '.rc-title');
  if (!clicked) {
    violations.push({ check: 'skeleton-related-exists', detail: 'the first .rc related card has no layout box to click' });
    return violations;
  }

  const result = await page.evaluate(() => window.__skeletonProbe);

  if (!result.sawSkeleton) {
    violations.push({ check: 'watch-skeleton-appears', detail: 'expected .watch-skeleton to become visible while the next video\'s meta was loading, it never did' });
  }
  if (result.orphanedContent) {
    violations.push({ check: 'watch-skeleton-no-orphan-content', detail: 'the .watch-channel row was visible with an empty channel name and no skeleton covering it — the broken pre-load state (real meta chrome over empty data) the skeleton exists to replace' });
  }
  if (!result.skeletonGoneAtEnd) {
    violations.push({ check: 'watch-skeleton-hides', detail: 'expected .watch-skeleton to be hidden once the new video\'s meta had loaded' });
  }
  if (!result.nameAtEnd) {
    violations.push({ check: 'watch-skeleton-real-content', detail: 'expected .watch-channel-name to have real text after the switch completed' });
  }
  return violations;
}

// prefers-reduced-motion must turn the shimmer off rather than merely making
// it subtle — getComputedStyle resolves a display:none element's pseudo
// element fine, so this does not need to catch the skeleton mid-load.
async function checkSkeletonReducedMotion(page) {
  const violations = [];
  const normal = await page.evaluate(() => {
    const el = document.querySelector('.watch-skeleton-avatar');
    return el ? getComputedStyle(el, '::after').animationName : null;
  });
  if (normal == null) {
    violations.push({ check: 'skeleton-reduced-motion-baseline', detail: 'expected a .watch-skeleton-avatar element to exist to test the shimmer animation' });
    return violations;
  }
  if (normal === 'none') {
    violations.push({ check: 'skeleton-shimmer-present', detail: 'expected the shimmer keyframe to be applied by default, got animation-name: none' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    const el = document.querySelector('.watch-skeleton-avatar');
    return el ? getComputedStyle(el, '::after').animationName : null;
  });
  await page.emulateMedia({ reducedMotion: null });
  if (reduced !== 'none') {
    violations.push({ check: 'skeleton-reduced-motion-disables', detail: `expected the shimmer keyframe to be disabled under prefers-reduced-motion, got animation-name: ${reduced}` });
  }
  return violations;
}

// The skeleton must cover the COLD page-load window, not only SPA switches.
// This is the state the user actually screenshotted: a fresh /watch load shows
// a ~2s gap before the ytInitialData-derived meta renders, and before this was
// guarded that gap displayed the broken pre-load state — an empty
// .watch-channel row under a visible .watch-meta-divider, a divider drawn over
// nothing — with no skeleton at all. checkWatchLoadSkeleton exercises ONLY the
// SPA related-click path (renderWatchFor), so it could not catch the cold-load
// regression; renderMeta()'s no-data branch is a separate code path. This opens
// a genuinely cold page with the sampler installed BEFORE any page script runs,
// so it sees the earliest frames.
async function checkColdLoadSkeleton(context) {
  const violations = [];
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__cold = { sawSkeleton: false, sawOrphanContent: false, nameAt: null, t0: Date.now() };
    const tick = () => {
      const st = window.__cold;
      const sk = document.querySelector('.watch-skeleton');
      const channelRow = document.querySelector('.watch-channel');
      const nameEl = document.querySelector('.watch-channel-name');
      let skVisible = false;
      if (sk) {
        const cs = getComputedStyle(sk);
        skVisible = cs.display !== 'none' && Number(cs.opacity) > 0;
        if (skVisible) st.sawSkeleton = true;
      }
      const nameText = (nameEl && nameEl.textContent || '').trim();
      const channelRowVisible = channelRow && getComputedStyle(channelRow).display !== 'none';
      if (channelRowVisible && !nameText && !skVisible) st.sawOrphanContent = true;
      if (nameText && st.nameAt === null) st.nameAt = Date.now() - st.t0;
      if (Date.now() - st.t0 < 8000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try {
    await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__cold && (window.__cold.nameAt !== null || Date.now() - window.__cold.t0 > 7000),
      { timeout: 12000 }
    ).catch(() => {});
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => window.__cold);
    if (res.sawOrphanContent) {
      violations.push({ check: 'cold-load-skeleton-no-orphan', detail: `on a COLD /watch load the broken pre-load state appeared: the .watch-channel row was visible over an empty .watch-channel-name with no skeleton covering it (name filled at ${res.nameAt}ms) — real meta chrome over empty data. The skeleton must cover the cold-load window, not only SPA switches.` });
    }
    // Only demand the skeleton when there was actually a gap to cover: if the
    // meta rendered near-instantly (ytInitialData already present at
    // document-start) there is legitimately nothing to skeleton over.
    if (!res.sawSkeleton && (res.nameAt === null || res.nameAt > 400)) {
      violations.push({ check: 'cold-load-skeleton-appears', detail: `expected .watch-skeleton to cover the cold-load window (real content filled at ${res.nameAt}ms), but the skeleton never became visible` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// The cold-start boot loader (#itube-boot) is the very first thing painted at
// document-start, before ytInitialData/the app shell exist. It must (1) be on
// screen before any real content, (2) report a real current step rather than
// sitting stuck on "Starting…", and (3) vanish exactly once the watch stage
// has an actual playable frame — never leaving a stuck overlay, and never
// revealing a black stage (video readyState<2) underneath it. This samples a
// genuinely cold /watch load with the sampler installed BEFORE any page
// script runs, the same way checkColdLoadSkeleton does.
async function checkBootLoaderColdLoad(context) {
  const violations = [];
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__boot = { sawAtStart: false, labels: [], removedAt: null, videoReadyAtFade: null, overlayPosition: null, t0: Date.now() };
    const tick = () => {
      const st = window.__boot;
      const overlay = document.querySelector('#itube-boot');
      const label = document.querySelector('#itube-boot .itube-boot-label');
      if (overlay && !st.sawAtStart) st.sawAtStart = true;
      // The loader must be out of normal flow so that its presence and removal
      // can never reflow the app underneath it — that, not a runtime box diff,
      // is what "no layout shift on handoff" actually means. (Measuring
      // #itube-stage across the fade is meaningless here: it is a fixed overlay,
      // and the stage legitimately resizes its own aspect ratio as the video's
      // dimensions arrive in the same window — a shift the loader cannot cause.)
      if (overlay && st.overlayPosition === null) st.overlayPosition = getComputedStyle(overlay).position;
      if (label && label.textContent && st.labels[st.labels.length - 1] !== label.textContent) {
        st.labels.push(label.textContent);
      }
      if (!overlay && st.removedAt === null) {
        st.removedAt = Date.now() - st.t0;
        const v = document.querySelector('#itube-stage video');
        st.videoReadyAtFade = v ? v.readyState : null;
      }
      if (Date.now() - st.t0 < 10000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try {
    await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__boot && (window.__boot.removedAt !== null || Date.now() - window.__boot.t0 > 9000),
      { timeout: 12000 }
    ).catch(() => {});
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => window.__boot);

    if (!res.sawAtStart) {
      violations.push({ check: 'boot-loader-first-paint', detail: 'expected #itube-boot to exist on a cold /watch load before content settled, it was never observed' });
    }
    if (res.labels.length === 0) {
      violations.push({ check: 'boot-loader-label-advances', detail: 'expected the boot label to be non-empty at some point during a cold load, it never was' });
    } else if (!res.labels.some((l) => /player/i.test(l))) {
      violations.push({ check: 'boot-loader-label-route-specific', detail: `expected the boot label to advance past "Starting…" to a watch-specific label containing "player", saw: ${JSON.stringify(res.labels)}` });
    }
    if (res.removedAt === null) {
      violations.push({ check: 'boot-loader-removed', detail: 'expected #itube-boot to be removed from the DOM once the video had a real frame, it never was (stuck overlay)' });
    } else if (res.videoReadyAtFade != null && res.videoReadyAtFade < 2 && res.removedAt < 7500) {
      // Only a defect if the loader gave up EARLY with no frame. A readyState<2
      // fade at ~8s is the deliberate hard-fallback firing on a genuinely slow
      // load (the safety net that stops the overlay ever sticking forever) —
      // revealing the stage then is intended, not a black-stage regression.
      violations.push({ check: 'boot-loader-no-black-stage', detail: `boot loader faded early (${res.removedAt}ms) while video.readyState was ${res.videoReadyAtFade} (<2) — the stage would have shown black underneath it` });
    }
    if (res.overlayPosition !== 'fixed') {
      violations.push({ check: 'boot-loader-no-layout-shift', detail: `expected #itube-boot to be position:fixed so it is out of flow and can never reflow the app on handoff, got position:${res.overlayPosition}` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// Non-watch routes fade the boot loader on first real content (a card) or a
// settled empty/sign-in state, not a fixed timer. This exercises that path on
// a genuinely cold home load, and checks the label reads a feed-specific
// step rather than the generic fallback.
async function checkBootLoaderFeedColdLoad(context) {
  const violations = [];
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__bootFeed = { sawAtStart: false, labels: [], removedAt: null, hadContentAtFade: null, t0: Date.now() };
    const tick = () => {
      const st = window.__bootFeed;
      const overlay = document.querySelector('#itube-boot');
      const label = document.querySelector('#itube-boot .itube-boot-label');
      if (overlay && !st.sawAtStart) st.sawAtStart = true;
      if (label && label.textContent && st.labels[st.labels.length - 1] !== label.textContent) {
        st.labels.push(label.textContent);
      }
      if (!overlay && st.removedAt === null) {
        st.removedAt = Date.now() - st.t0;
        const view = document.querySelector('#itube .content');
        st.hadContentAtFade = !!(view && view.querySelector('.c, .row, .rc, .empty, .signin-state'));
      }
      if (Date.now() - st.t0 < 10000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try {
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__bootFeed && (window.__bootFeed.removedAt !== null || Date.now() - window.__bootFeed.t0 > 9000),
      { timeout: 12000 }
    ).catch(() => {});
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => window.__bootFeed);

    if (!res.sawAtStart) {
      violations.push({ check: 'boot-loader-feed-first-paint', detail: 'expected #itube-boot to exist on a cold home load before content settled' });
    }
    if (!res.labels.some((l) => /feed/i.test(l))) {
      violations.push({ check: 'boot-loader-feed-label', detail: `expected a route-specific label containing "feed" on the home route, saw: ${JSON.stringify(res.labels)}` });
    }
    if (res.removedAt === null) {
      violations.push({ check: 'boot-loader-feed-removed', detail: 'expected #itube-boot to be removed once the feed had real content, it never was' });
    } else if (!res.hadContentAtFade) {
      violations.push({ check: 'boot-loader-feed-no-early-fade', detail: 'boot loader faded before any .c/.row/.empty/.signin-state existed in the view — it would have revealed an empty view' });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// prefers-reduced-motion must disable the boot loader's own indeterminate
// progress sweep (a separate animation from the later watch-meta shimmer),
// checked at the instant the overlay is created since it fades within
// seconds of a real cold load.
async function checkBootLoaderReducedMotion(context) {
  const violations = [];
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.__bootReduced = null;
    // The userscript itself runs as one synchronous document-start script
    // (registered on the context, ahead of this page-level init script), so
    // by the time this callback even starts the overlay may already be in
    // the DOM — an edge-triggered MutationObserver would miss that insertion
    // entirely. Poll every frame instead, the same pattern the cold-load
    // skeleton sampler uses, so an already-past insertion is still caught.
    const t0 = Date.now();
    const tick = () => {
      const bar = document.querySelector('#itube-boot .itube-boot-bar');
      if (bar) {
        window.__bootReduced = getComputedStyle(bar, '::after').animationName;
        return;
      }
      if (Date.now() - t0 < 5000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try {
    await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__bootReduced !== null, { timeout: 5000 }).catch(() => {});
    const anim = await page.evaluate(() => window.__bootReduced);
    if (anim == null) {
      violations.push({ check: 'boot-loader-reduced-motion-baseline', detail: 'expected the #itube-boot progress bar to exist to test the sweep animation' });
    } else if (anim !== 'none') {
      violations.push({ check: 'boot-loader-reduced-motion-disables', detail: `expected the boot progress sweep to be disabled under prefers-reduced-motion, got animation-name: ${anim}` });
    }
  } finally {
    await page.close();
  }
  return violations;
}

// The boot loader is cold-start only: SPA navigations already have their own
// per-page skeletons/spinners, and a second overlay reappearing on every
// client-side nav would read as a regression to a double-loader. Runs on the
// already-mounted shared page fixture, which is exactly where a resurrection
// bug would show up.
async function checkBootLoaderNoSpaReappear(page) {
  const violations = [];
  const armed = await page.evaluate(() => {
    window.__bootSeenOnSpa = false;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.id === 'itube-boot') window.__bootSeenOnSpa = true;
        }
      }
    });
    mo.observe(document.documentElement, { childList: true });
    window.__bootSpaObserver = mo;
    return true;
  });
  if (!armed) {
    violations.push({ check: 'boot-loader-spa-guard-setup', detail: 'could not arm the observer watching for #itube-boot resurrecting' });
    return violations;
  }
  const away = await page.$('.nav-row[href="/feed/history"]');
  const home = await page.$('.nav-row[href="/"]');
  if (away) {
    await away.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  if (home) {
    await home.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const seen = await page.evaluate(() => window.__bootSeenOnSpa);
  await page.evaluate(() => { if (window.__bootSpaObserver) window.__bootSpaObserver.disconnect(); });
  if (seen) {
    violations.push({ check: 'boot-loader-no-spa-reappear', detail: 'expected #itube-boot to never be re-inserted on SPA navigation (it is cold-start only), but it reappeared' });
  }
  return violations;
}

// Exercises the Tools-row "Audio track" cycle button against a real
// multi-track video: the button must stay hidden while a track's data hasn't
// loaded >1 track, appear once it has, and cycling it must actually switch
// the player's audio track (not just its own label). Returns
// { violations, skipped, detail } — a SKIP (not a fail) if this specific
// video no longer has multiple tracks, since that is YouTube's data changing
// underneath a fixed id, not a regression in the app.
async function checkAudioTrackSelector(browser) {
  const context = await newContext(browser);
  try {
    const { page } = await openPage(context, `https://www.youtube.com/watch?v=${MULTI_AUDIO_VIDEO_ID}`);
    await waitForApp(page, { timeout: 30000 });
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return v && v.readyState >= 2;
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).some((b) => b.textContent.includes('Tools')), { timeout: 15000 }).catch(() => {});

    let toolsOpen = false;
    for (let attempt = 0; attempt < 3 && !toolsOpen; attempt++) {
      try {
        await page.click('.watch-action-btn[title="Tools"]', { timeout: 2000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(300);
      toolsOpen = await page.evaluate(() => document.querySelector('.watch-tools')?.classList.contains('open'));
    }
    if (!toolsOpen) {
      return { violations: [{ check: 'audio-track-tools-tray-opens', detail: 'expected .watch-tools to gain .open after clicking the Tools pill' }], skipped: false, detail: '' };
    }

    // The button only reveals once getAvailableAudioTracks() actually
    // reports >1 track, which can lag the video becoming ready — poll for it
    // rather than asserting on the very first read.
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Audio track'));
      return btn && getComputedStyle(btn).display !== 'none';
    }, { timeout: 8000 }).catch(() => {});

    const state = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Audio track'));
      if (!btn) return { visible: false };
      return { visible: getComputedStyle(btn).display !== 'none', label: btn.querySelector('.watch-tool-val')?.textContent };
    });

    if (!state.visible) {
      return {
        violations: [],
        skipped: true,
        detail: `${MULTI_AUDIO_VIDEO_ID} no longer exposes multiple audio tracks (Audio track tool stayed hidden) — nothing to assert`,
      };
    }

    const violations = [];
    const readMetaId = () => page.evaluate(() => {
      const audioMeta = (t) => t && Object.values(t).find((v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && typeof v.isDefault === 'boolean' && typeof v.id === 'string');
      const p = document.getElementById('movie_player');
      const t = p?.getAudioTrack?.();
      return audioMeta(t)?.id ?? null;
    });

    const beforeLabel = state.label;
    const beforeId = await readMetaId();

    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Audio track'))?.click();
    });
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Audio track'));
      return { label: btn?.querySelector('.watch-tool-val')?.textContent };
    });
    const afterId = await readMetaId();

    if (after.label === beforeLabel) {
      violations.push({ check: 'audio-track-label-updates', detail: `expected the Audio track tool's value text to change after clicking, stayed at "${beforeLabel}"` });
    }
    if (afterId === beforeId || afterId === null) {
      violations.push({ check: 'audio-track-switch', detail: `expected getAudioTrack()'s metadata id to change after cycling, stayed at ${beforeId} (after=${afterId})` });
    }
    if (!beforeLabel || !beforeLabel.trim()) {
      violations.push({ check: 'audio-track-label-real', detail: 'expected the Audio track tool to show a non-empty track name/label' });
    }

    return {
      violations,
      skipped: false,
      detail: `${MULTI_AUDIO_VIDEO_ID}: "${beforeLabel}" -> "${after.label}", switched from ${beforeId} to ${afterId}`,
    };
  } finally {
    await context.close();
  }
}

// The dislike count next to .watch-dislike-btn is sourced from the third-
// party Return YouTube Dislike API (fetchDislikes/refreshActions), NOT
// YouTube's own data — YouTube stopped exposing real dislike counts. Two
// things matter: the label shows a clearly-marked ESTIMATE when the API
// answers, and it shows NOTHING (never '0'/'NaN') when the API fails, so a
// broken/unreachable third party can't paint a misleading number. Both
// scenarios are mocked via context.route so this runs deterministically
// against a known response, not whatever the live API currently returns for
// this video.
const DISLIKE_TEST_VIDEO_ID = 'aircAruvnKk';
const RYD_ROUTE_PATTERN = 'https://returnyoutubedislikeapi.com/**';

async function readDislikeLabel(page) {
  await page.waitForSelector('.watch-dislike-btn', { state: 'visible', timeout: 15000 }).catch(() => {});
  const btn = await page.$('.watch-dislike-btn');
  if (!btn) return null;
  return page.evaluate((el) => el.querySelector('span')?.textContent ?? null, btn);
}

async function checkDislikeEstimate(browser) {
  const violations = [];

  // --- success: a known RYD response renders as a labeled estimate ---
  {
    const context = await newContext(browser);
    try {
      await context.route(RYD_ROUTE_PATTERN, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: DISLIKE_TEST_VIDEO_ID, dateCreated: '2020-01-01', likes: 100000, rawDislikes: 12345,
          rawLikes: 100000, dislikes: 12345, rating: 4, viewCount: 1000000, deleted: false,
        }),
      }));
      const { page } = await openPage(context, `https://www.youtube.com/watch?v=${DISLIKE_TEST_VIDEO_ID}`);
      await waitForApp(page, { timeout: 30000 });
      await page.waitForTimeout(500);
      const label = await readDislikeLabel(page);
      if (label === null) {
        violations.push({ check: 'dislike-estimate-exists', detail: 'expected .watch-dislike-btn (with a label span) to exist' });
      } else if (!label.includes('12') || !/k/i.test(label)) {
        violations.push({ check: 'dislike-estimate-renders', detail: `expected the dislike label to show a compact count for the mocked dislikes:12345 (e.g. "12K"), got "${label}"` });
      } else {
        // The estimate is now marked by the tooltip, not a "~" prefix.
        const title = await page.evaluate(() => document.querySelector('.watch-dislike-btn')?.getAttribute('title') || '');
        if (!/estimat/i.test(title)) {
          violations.push({ check: 'dislike-estimate-labeled', detail: `expected the dislike button to carry an "estimate" tooltip (Return YouTube Dislike), got title="${title}"` });
        }
      }
    } finally {
      await context.close();
    }
  }

  // --- failure: the RYD endpoint erroring must leave the label EMPTY, never 0/NaN ---
  {
    const context = await newContext(browser);
    try {
      await context.route(RYD_ROUTE_PATTERN, (route) => route.fulfill({ status: 500, body: 'error' }));
      const { page } = await openPage(context, `https://www.youtube.com/watch?v=${DISLIKE_TEST_VIDEO_ID}`);
      await waitForApp(page, { timeout: 30000 });
      await page.waitForTimeout(500);
      const label = await readDislikeLabel(page);
      if (label === null) {
        violations.push({ check: 'dislike-estimate-graceful-failure-exists', detail: 'expected .watch-dislike-btn (with a label span) to exist' });
      } else if (label !== '') {
        violations.push({ check: 'dislike-estimate-graceful-failure', detail: `expected the dislike label to stay empty when the RYD API errors (never show a stale/zero/NaN count), got "${label}"` });
      }
    } finally {
      await context.close();
    }
  }

  return violations;
}

// Return YouTube Dislike sends the exact videoId to a third party on every
// watch load with no way to disable it — itube-dislikes (default ON, to
// preserve the pre-existing behavior above) is the opt-out. With it OFF,
// fetchDislikes must short-circuit before ever hitting the network: this
// mocks the RYD endpoint (so a real request would be caught, not just
// silently fail against the live API) and asserts zero requests land, and
// that the estimate label stays empty (never a stale/partial value). It also
// proves the Settings-panel toggle actually flips + persists the same pref
// the mocked-off run seeded, so the wiring between the UI and the pref this
// check gates is exercised, not just the pref in isolation.
async function checkDislikesOptOut(browser) {
  const violations = [];
  const context = await newPrefContext(browser, { 'itube-dislikes': '0' });
  const rydRequests = [];
  try {
    const page = await context.newPage();
    page.on('request', (req) => { if (req.url().startsWith('https://returnyoutubedislikeapi.com/')) rydRequests.push(req.url()); });
    await context.route(RYD_ROUTE_PATTERN, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: DISLIKE_TEST_VIDEO_ID, dateCreated: '2020-01-01', likes: 100000, rawDislikes: 12345,
        rawLikes: 100000, dislikes: 12345, rating: 4, viewCount: 1000000, deleted: false,
      }),
    }));
    await page.goto(`https://www.youtube.com/watch?v=${DISLIKE_TEST_VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);

    if (rydRequests.length > 0) {
      violations.push({ check: 'dislikes-opt-out-no-fetch', detail: `expected 0 requests to returnyoutubedislikeapi.com with itube-dislikes=0, got ${rydRequests.length}: ${rydRequests.slice(0, 3).join(', ')}` });
    }
    const label = await readDislikeLabel(page);
    if (label !== '' && label !== null) {
      violations.push({ check: 'dislikes-opt-out-label-empty', detail: `expected the dislike label to stay empty with itube-dislikes=0, got "${label}"` });
    }

    const navBtn = await page.$('.nav-settings');
    if (navBtn) {
      await navBtn.click();
      const toggled = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.settings-row')].find((r) => r.querySelector('.settings-row-label')?.textContent === 'Show dislike estimates');
        const toggle = row?.querySelector('.settings-toggle');
        if (!toggle) return null;
        const before = toggle.classList.contains('active');
        toggle.click();
        return { before, after: toggle.classList.contains('active'), stored: (() => { try { return localStorage.getItem('itube-dislikes'); } catch (e) { return null; } })() };
      });
      if (!toggled) {
        violations.push({ check: 'dislikes-settings-toggle-exists', detail: 'expected a "Show dislike estimates" settings row with a .settings-toggle' });
      } else {
        if (toggled.before !== false) {
          violations.push({ check: 'dislikes-settings-toggle-initial', detail: `expected the toggle to read OFF given itube-dislikes=0, was active=${toggled.before}` });
        }
        if (toggled.after !== true || toggled.stored !== '1') {
          violations.push({ check: 'dislikes-settings-toggle-persists', detail: `expected clicking the toggle to flip it on and persist itube-dislikes=1, got active=${toggled.after} stored="${toggled.stored}"` });
        }
      }
    } else {
      violations.push({ check: 'dislikes-settings-nav-exists', detail: 'expected a .nav-settings sidebar button to exist' });
    }
  } finally {
    await context.close();
  }
  return violations;
}

// SponsorBlock auto-skip: segments come from a third-party API (privacy
// hash-prefix endpoint, mocked here rather than hit live) and must (1) paint
// as colored markers on the seek bar once the video's duration is known, and
// (2) actually seek the <video> past a segment once the playhead enters it,
// while the feature is enabled. A regression here would silently stop
// skipping sponsors (annoying) or, worse, spin the fetch/marker render on
// every tick (perf regression) — this only proves the user-visible behavior.
const SPONSORBLOCK_TEST_VIDEO_ID = 'aircAruvnKk';
const SPONSORBLOCK_ROUTE_PATTERN = 'https://sponsor.ajay.app/api/skipSegments/**';

async function checkSponsorBlock(browser) {
  const violations = [];
  const context = await newContext(browser);
  try {
    await context.route(SPONSORBLOCK_ROUTE_PATTERN, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        videoID: SPONSORBLOCK_TEST_VIDEO_ID,
        segments: [{ category: 'sponsor', actionType: 'skip', segment: [8, 20], UUID: 'test-uuid' }],
      }]),
    }));
    const { page } = await openPage(context, `https://www.youtube.com/watch?v=${SPONSORBLOCK_TEST_VIDEO_ID}`);
    await waitForApp(page, { timeout: 30000 });
    await page.waitForSelector('#itube-stage video', { timeout: 15000 });
    await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      v.muted = true;
      v.play();
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return v && isFinite(v.duration) && v.duration > 0;
    }, { timeout: 15000 }).catch(() => {});
    // The marker paints once the segment fetch resolves AND the duration is
    // known, which raced a flat 1s sleep under full-suite load — poll for it
    // instead of sampling once on a fixed clock; a genuinely-absent marker
    // still exhausts the timeout and fails below exactly as before.
    await page.waitForFunction(() => !!document.querySelector('.itube-sb-marker'), { timeout: 6000 }).catch(() => {});

    const hasMarker = await page.evaluate(() => !!document.querySelector('.itube-sb-marker'));
    if (!hasMarker) {
      violations.push({ check: 'sponsorblock-marker', detail: 'expected a .itube-sb-marker to appear on the seek bar for the mocked [8,20] sponsor segment, found none' });
    }

    await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      v.currentTime = 10;
    });
    await page.waitForTimeout(800);
    const afterSkip = await page.evaluate(() => document.querySelector('#itube-stage video')?.currentTime ?? 0);
    if (afterSkip < 19.5) {
      violations.push({ check: 'sponsorblock-skip', detail: `expected auto-skip to jump the playhead to >= 19.5s once inside the mocked [8,20] segment, currentTime is ${afterSkip}` });
    }
  } finally {
    await context.close();
  }
  return { violations };
}

// Companion to checkSponsorBlock: sbLoad used to fire unconditionally from
// the playback tick regardless of the Skip-sponsors pref, so turning the
// feature OFF still leaked the video id (as a hash prefix) to sponsor.ajay.app
// on every watch. With itube-skip-sponsors=0 seeded before mount, sbLoad must
// early-return before the fetch — this mocks the same endpoint checkSponsorBlock
// mocks (so a real request would be caught) and asserts zero hits land.
async function checkSponsorBlockDisabled(browser) {
  const violations = [];
  const context = await newPrefContext(browser, { 'itube-skip-sponsors': '0' });
  const sbRequests = [];
  try {
    const page = await context.newPage();
    page.on('request', (req) => { if (req.url().startsWith('https://sponsor.ajay.app/')) sbRequests.push(req.url()); });
    await context.route(SPONSORBLOCK_ROUTE_PATTERN, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        videoID: SPONSORBLOCK_TEST_VIDEO_ID,
        segments: [{ category: 'sponsor', actionType: 'skip', segment: [8, 20], UUID: 'test-uuid' }],
      }]),
    }));
    await page.goto(`https://www.youtube.com/watch?v=${SPONSORBLOCK_TEST_VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; v.play(); }
    });
    await page.waitForTimeout(1500);
    if (sbRequests.length > 0) {
      violations.push({ check: 'sponsorblock-disabled-no-fetch', detail: `expected 0 requests to sponsor.ajay.app with itube-skip-sponsors=0, got ${sbRequests.length}: ${sbRequests.slice(0, 3).join(', ')}` });
    }
    const hasMarker = await page.evaluate(() => !!document.querySelector('.itube-sb-marker'));
    if (hasMarker) {
      violations.push({ check: 'sponsorblock-disabled-no-marker', detail: 'expected no .itube-sb-marker to appear when itube-skip-sponsors=0 (no fetch means no segments to paint)' });
    }
  } finally {
    await context.close();
  }
  return violations;
}

// Regression: YouTube migrated videoOwnerRenderer to viewModels on some videos —
// the channel name moved to `attributedTitle.content`, the avatar to
// `avatarStack…image.sources`, the channel id to a nested browseEndpoint, and the
// subscriber line to a plain `content` node. The old extractors read the
// pre-migration paths, so on those videos the owner came out empty. On a cold
// load `videoDetails.author` still filled the name, but the AVATAR was an empty
// <img> (a broken-image box — the reported "weird border"); on an SPA navigation
// there is no videoDetails fallback, so the name was empty too and — because the
// load skeleton only reveals once a name resolves — the meta stayed on the
// shimmer FOREVER (video playing, title shown, channel row never revealing).
//
// This loads a video known to use the new shape and asserts the meta actually
// reveals with a real name AND a loaded avatar. It SKIPs cleanly if the fixture
// video ever stops loading (removed/geo) rather than hard-failing on YouTube.
async function checkWatchMetaReveals(browser) {
  const NEW_SHAPE_VIDEO = 'HZ9UHLTPmw0';
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=' + NEW_SHAPE_VIDEO);
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => {
      const row = document.querySelector('.watch-channel');
      const name = document.querySelector('.watch-channel-name');
      return row && getComputedStyle(row).display !== 'none' && name && (name.textContent || '').trim();
    }, { timeout: 15000 }).catch(() => {});
    // Let the skeleton's ~220ms cross-fade finish before sampling, or the sample
    // catches it mid-fade (display:flex, opacity mid-transition) and misreads a
    // clean reveal as "still shown".
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => {
      const row = document.querySelector('.watch-channel');
      const sk = document.querySelector('.watch-skeleton');
      const name = document.querySelector('.watch-channel-name');
      const av = document.querySelector('img.watch-avatar');
      const title = document.querySelector('.watch-title');
      return {
        skeletonShown: !!sk && getComputedStyle(sk).display !== 'none' && Number(getComputedStyle(sk).opacity) > 0,
        rowVisible: !!row && getComputedStyle(row).display !== 'none',
        name: (name && name.textContent || '').trim(),
        avatarW: av ? av.naturalWidth : 0,
        titleText: (title && title.textContent || '').trim(),
      };
    });
    if (!s.titleText) {
      console.log('  watch-meta-reveals: SKIP — the new-shape fixture video did not load (removed/geo/unavailable), nothing to assert');
      return violations;
    }
    if (s.skeletonShown || !s.rowVisible) {
      violations.push({ check: 'watch-meta-not-stuck-on-skeleton', detail: `the watch meta is STILL on the skeleton on a playing video ("${s.titleText}") — the channel row never revealed (skeletonShown=${s.skeletonShown} rowVisible=${s.rowVisible}). The reveal must never get stuck on the shimmer.` });
    }
    if (!s.name) {
      violations.push({ check: 'watch-meta-owner-name', detail: `channel name empty on a playing video ("${s.titleText}") — the owner extractor missed the current data shape (attributedTitle.content / videoDetails.author)` });
    }
    if (s.name && s.avatarW === 0) {
      violations.push({ check: 'watch-meta-avatar-loads', detail: `the channel avatar did not load (naturalWidth 0) on "${s.titleText}" — an empty <img src> renders as a broken-image box; extract from owner.avatarStack when owner.thumbnail is absent` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Signed-in subscribe SUCCESS used to revert the button. YouTube's successful
// subscribe response carries an openPopupAction (the post-subscribe notification
// popup); the confirmation code treated any openPopupAction / CLIENT_SIGNAL as a
// "blocked" signal (it was meant to catch a SIGN-IN prompt), so the optimistic
// flip snapped back even though the server registered the subscribe (you'd find
// yourself subscribed after a hard refresh). The suite runs logged out — where
// the click short-circuits before the network call — so this fakes LOGGED_IN and
// mocks the endpoint to exercise the signed-in path that no other check reaches.
async function checkSubscribeConfirmsOnPopup(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  const subRe = (u) => /\/youtubei\/v1\/subscription\/subscribe/.test(u.toString());
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-subscribe', { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => { if (window.ytcfg && window.ytcfg.data_) window.ytcfg.data_.LOGGED_IN = true; });
    // A successful subscribe response that carries ONLY a notification popup and
    // no signInEndpoint — the exact shape that used to be misread as blocked.
    await page.route(subRe, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ responseContext: {}, actions: [{ openPopupAction: { popupType: 'TOAST', popup: { notificationActionRenderer: { responseText: { simpleText: 'Subscribed' } } } } }] }),
    }));
    await page.waitForFunction(() => {
      const b = document.querySelector('.watch-subscribe');
      return b && !b.disabled && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0;
    }, { timeout: 15000 }).catch(() => {});
    const btn = await page.$('.watch-subscribe');
    if (!btn) {
      violations.push({ check: 'subscribe-button-exists', detail: 'expected a usable .watch-subscribe on the watch page' });
      return violations;
    }
    const before = await page.evaluate((b) => b.getAttribute('aria-pressed'), btn);
    if (before === 'true') {
      console.log('  subscribe-confirms-on-popup: SKIP — button already reads subscribed, cannot exercise a fresh subscribe');
      return violations;
    }
    await btn.click();
    await page.waitForTimeout(1500);
    const after = await page.evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), text: b.textContent.trim() }), btn);
    if (after.pressed !== 'true') {
      violations.push({ check: 'subscribe-confirms-on-popup', detail: `after a successful subscribe whose response carried only a notification openPopupAction (no signInEndpoint), the button reverted (aria-pressed=${after.pressed}, "${after.text}") — a notification/confirmation popup must not be read as a failed or blocked mutation` });
    }
  } finally {
    await page.unroute(subRe).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// The enable/disable toggle near the logo: Flyt must be a real, reversible,
// persistent escape hatch. When toggled off, Flyt must NOT mount and YouTube's
// own ytd-app must be left visible (unparked); a re-enable control must appear
// near the logo; and clicking it must bring Flyt back and clear the flag.
async function checkItubeToggle(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (!(await page.evaluate(() => !!document.querySelector('#itube .itube-power')))) {
      violations.push({ check: 'itube-toggle-present', detail: 'expected an .itube-power toggle in the Flyt header' });
    }
    await page.evaluate(() => localStorage.setItem('itube-off', '1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const off = await page.evaluate(() => {
      const app = document.querySelector('ytd-app');
      return {
        reenable: !!document.getElementById('itube-reenable'),
        itubeGone: !document.getElementById('itube'),
        ytdVisible: !!(app && getComputedStyle(app).opacity !== '0' && app.getBoundingClientRect().width > 100),
      };
    });
    if (!off.itubeGone) violations.push({ check: 'itube-toggle-disables', detail: 'after toggling off, #itube still rendered — the app must not mount when itube-off is set' });
    if (!off.reenable) violations.push({ check: 'itube-toggle-reenable-shown', detail: 'after toggling off, no #itube-reenable control was shown near the logo' });
    if (!off.ytdVisible) violations.push({ check: 'itube-toggle-shows-youtube', detail: "after toggling off, YouTube's own ytd-app is not visible — Flyt must stop parking it and leave native YouTube alone" });
    await page.evaluate(() => { const b = document.getElementById('itube-reenable'); if (b) b.click(); });
    await page.waitForTimeout(4000);
    const back = await page.evaluate(() => ({ itubeBack: !!document.getElementById('itube'), flag: localStorage.getItem('itube-off') }));
    if (!back.itubeBack) violations.push({ check: 'itube-toggle-reenables', detail: 'clicking re-enable did not bring Flyt back' });
    if (back.flag === '1') violations.push({ check: 'itube-toggle-persist', detail: 'the itube-off flag was not cleared on re-enable' });
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// The related-video card thumbnail should fly into the video stage on click,
// giving visual continuity across the hard swap between the previous video
// and the new one. Guards two regressions: the fly-in clone failing to
// appear on click at all, and — the easier one to miss — the clone still
// appearing when the user has prefers-reduced-motion: reduce set, which must
// suppress the animation entirely rather than just shortening it.
async function checkThumbFlyAnimation(page) {
  const violations = [];
  const watchUrl = 'https://www.youtube.com/watch?v=aircAruvnKk';

  await page.emulateMedia({ reducedMotion: null });
  let link = await page.$('.rc-link');
  if (!link) {
    console.log('  thumb-fly-animation: SKIP — no .rc-link found on this watch page, nothing to click');
    return { violations };
  }
  const appeared = await page.evaluate(() => {
    const el = document.querySelector('.rc-link');
    el.click();
    return !!document.querySelector('.itube-fly');
  });
  if (!appeared) {
    violations.push({ check: 'thumb-fly-appears', detail: 'clicking a .rc-link related-video card did not spawn an .itube-fly clone synchronously on click — the thumbnail fly-in animation is missing' });
  }

  await page.goto(watchUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForApp(page, { timeout: 30000 }).catch(() => {});

  await page.emulateMedia({ reducedMotion: 'reduce' });
  link = await page.$('.rc-link');
  if (link) {
    const spawned = await page.evaluate(() => {
      const el = document.querySelector('.rc-link');
      el.click();
      return !!document.querySelector('.itube-fly');
    });
    if (spawned) {
      violations.push({ check: 'thumb-fly-reduced-motion', detail: 'clicking a .rc-link related-video card spawned an .itube-fly clone even with prefers-reduced-motion: reduce set — the animation must be suppressed entirely' });
    }
  } else {
    console.log('  thumb-fly-animation: SKIP (reduced-motion pass) — no .rc-link found after reset, nothing to click');
  }

  await page.emulateMedia({ reducedMotion: null });
  return { violations };
}

// Theater mode v2 (v4.45): a bar button (and the `t` shortcut) must toggle an
// immersive cinema layout — a `.theater` class on the #itube root, a squared
// (border-radius:0) stage, an idle-hide that also hides the cursor — persist
// the choice in localStorage, and tear back down cleanly. The ambient-glow
// canvas is GONE entirely (replaced by a static CSS vignette), so this test
// asserts its ABSENCE rather than its on/off display — the inverse of what
// v4.44 checked. Enter/exit now goes through a scrim-covered cross-fade
// (~180ms in, ~220ms out) instead of an instant class swap, so assertions
// wait for it to settle and then confirm the scrim was torn down, not left
// stuck over the page. Under prefers-reduced-motion the whole scrim path
// must be skipped for an instant toggle — asserted separately at the end.
async function checkTheaterMode(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    // Start from a known-off state so a leaked preference from another run
    // can't make this test pass or fail spuriously.
    await page.evaluate(() => { try { localStorage.removeItem('itube-theater'); } catch (e) {} });
    // The button only exists once the player and its control bar are built.
    await page.waitForSelector('#itube-theater', { timeout: 30000 }).catch(() => {});
    if (!(await page.evaluate(() => !!document.getElementById('itube-theater')))) {
      violations.push({ check: 'theater-button-present', detail: 'expected an #itube-theater toggle in the player bar' });
      return violations;
    }
    const read = () => page.evaluate(() => {
      const root = document.getElementById('itube');
      const stage = document.getElementById('itube-stage');
      return {
        cls: !!(root && root.classList.contains('theater')),
        ambientPresent: !!document.querySelector('.itube-ambient'),
        scrimPresent: !!document.querySelector('.itube-theater-scrim'),
        stageRadius: stage ? getComputedStyle(stage).borderRadius : null,
        pref: (() => { try { return localStorage.getItem('itube-theater'); } catch (e) { return null; } })(),
      };
    });

    await page.evaluate(() => document.getElementById('itube-theater').click());
    // Enter transition is scrim-in(180ms) -> class swap -> scrim-out(220ms)
    // -> scrim removed; ~400ms total, give it comfortable margin.
    await page.waitForTimeout(500);
    const on = await read();
    if (!on.cls) violations.push({ check: 'theater-enters', detail: 'clicking the theater button did not add .theater to #itube' });
    if (on.ambientPresent) violations.push({ check: 'theater-ambient-removed', detail: 'expected .itube-ambient to be entirely absent (the ambient-glow canvas was removed in v4.45), found one' });
    if (on.scrimPresent) violations.push({ check: 'theater-scrim-teardown', detail: 'expected .itube-theater-scrim to be removed from the DOM once the enter transition settles' });
    if (on.stageRadius && on.stageRadius !== '0px') violations.push({ check: 'theater-square-frame', detail: `expected #itube-stage border-radius to be 0 in theater mode, got ${on.stageRadius}` });
    if (on.pref !== '1') violations.push({ check: 'theater-persists-on', detail: `expected localStorage itube-theater=1 after enabling, got ${on.pref}` });

    // --- unified idle hide: bar + cursor hide together after 3s idle while playing ---
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.hover('#itube-stage', { position: { x: 200, y: 200 } }).catch(() => {});
    await page.waitForTimeout(3300);
    const idle = await page.evaluate(() => ({
      barShown: document.getElementById('itube-stage')?.classList.contains('show'),
      cursorHidden: document.querySelector('.watch-left')?.classList.contains('itube-cursor-hide'),
    }));
    if (idle.barShown) violations.push({ check: 'theater-idle-hides-bar', detail: 'expected the player bar to lose .show after 3s idle in theater mode while playing' });
    if (!idle.cursorHidden) violations.push({ check: 'theater-idle-hides-cursor', detail: 'expected .watch-left to gain .itube-cursor-hide after 3s idle in theater mode while playing' });

    await page.hover('#itube-stage', { position: { x: 220, y: 220 } }).catch(() => {});
    await page.waitForTimeout(100);
    const restored = await page.evaluate(() => ({
      barShown: document.getElementById('itube-stage')?.classList.contains('show'),
      cursorHidden: document.querySelector('.watch-left')?.classList.contains('itube-cursor-hide'),
    }));
    if (!restored.barShown || restored.cursorHidden) {
      violations.push({ check: 'theater-mousemove-restores', detail: `expected a mousemove to instantly restore the bar and un-hide the cursor, got ${JSON.stringify(restored)}` });
    }

    await page.evaluate(() => document.getElementById('itube-theater').click());
    await page.waitForTimeout(500);
    const off = await read();
    if (off.cls) violations.push({ check: 'theater-exits', detail: 'clicking the theater button again did not remove .theater' });
    if (off.scrimPresent) violations.push({ check: 'theater-scrim-teardown-exit', detail: 'expected .itube-theater-scrim to be removed from the DOM once the exit transition settles' });
    if (off.pref !== '0') violations.push({ check: 'theater-persists-off', detail: `expected localStorage itube-theater=0 after disabling, got ${off.pref}` });

    // The `t` shortcut is YouTube's own theater key — it must toggle too
    // (also goes through the animated scrim transition now).
    await page.evaluate(() => document.body.click());
    await page.keyboard.press('t');
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => document.getElementById('itube').classList.contains('theater')))) {
      violations.push({ check: 'theater-key-toggle', detail: "pressing 't' did not toggle theater mode on" });
    }
    await page.keyboard.press('t');
    await page.waitForTimeout(500);

    // --- prefers-reduced-motion: instant toggle, scrim never appears ---
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { try { localStorage.removeItem('itube-theater'); } catch (e) {} });
    await page.evaluate(() => document.getElementById('itube-theater').click());
    await page.waitForTimeout(50);
    const reducedOn = await page.evaluate(() => ({
      cls: document.getElementById('itube').classList.contains('theater'),
      scrimPresent: !!document.querySelector('.itube-theater-scrim'),
    }));
    if (!reducedOn.cls) violations.push({ check: 'theater-reduced-motion-instant', detail: 'expected prefers-reduced-motion to toggle theater mode instantly (no scrim wait) on click' });
    if (reducedOn.scrimPresent) violations.push({ check: 'theater-reduced-motion-no-scrim', detail: 'expected prefers-reduced-motion to skip the scrim transition entirely' });
    await page.evaluate(() => document.getElementById('itube-theater').click());
    await page.emulateMedia({ reducedMotion: null });
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// A-B repeat loop: the control lives ONLY in the Tools row (the player-bar
// duplicate was removed in v4.43 after a user report). Setting two marks must
// show a highlighted region + both markers on the seek bar, flip the tools
// pill to its active state, and then actually enforce the loop by snapping
// playback back to A once it crosses B. Clicking the pill (rather than the
// `[`/`]` keys) at fixed currentTimes keeps this deterministic instead of
// racing real playback.
async function checkAbLoop(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  const clickAbPill = () => page.evaluate(() => {
    Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('A–B repeat'))?.click();
  });
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-actions', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return !!v && isFinite(v.duration) && v.duration > 10;
    }, { timeout: 30000 }).catch(() => {});
    if (await page.evaluate(() => !!document.getElementById('itube-ab'))) {
      violations.push({ check: 'ab-loop-no-bar-duplicate', detail: 'expected the #itube-ab player-bar button to be gone — A–B lives only in the Tools row now' });
    }
    await page.evaluate(() => {
      const toolsBtn = Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).find((b) => b.textContent.includes('Tools'));
      toolsBtn?.click();
    });
    await page.waitForTimeout(400);
    const pillPresent = await page.evaluate(() =>
      !!Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('A–B repeat')));
    if (!pillPresent) {
      violations.push({ check: 'ab-loop-button-present', detail: 'expected an A–B repeat pill in the Tools row' });
      return violations;
    }
    await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      v.muted = true;
      v.play();
    });
    await page.evaluate(() => { document.querySelector('#itube-stage video').currentTime = 3; });
    await clickAbPill();
    await page.evaluate(() => { document.querySelector('#itube-stage video').currentTime = 8; });
    await clickAbPill();
    const marked = await page.evaluate(() => ({
      region: !!document.querySelector('.itube-ab-region'),
      active: !!Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('A–B repeat'))?.classList.contains('active'),
    }));
    if (!marked.region) violations.push({ check: 'ab-loop-markers', detail: 'expected a .itube-ab-region after setting A and B' });
    if (!marked.active) violations.push({ check: 'ab-loop-markers', detail: 'expected the A–B tools pill to gain .active after setting A and B' });

    await page.evaluate(() => { document.querySelector('#itube-stage video').currentTime = 8.6; });
    await page.waitForTimeout(500);
    const loopedTime = await page.evaluate(() => document.querySelector('#itube-stage video').currentTime);
    if (!(loopedTime < 8)) {
      violations.push({ check: 'ab-loop-enforces', detail: `expected playback past B to snap back toward A (~3s), got currentTime=${loopedTime}` });
    }
    await clickAbPill();
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Account management: the sidebar avatar is a menu button that opens a dropdown
// with a native "Your channel" plus redirects to YouTube's own UI (Studio,
// Settings, Switch account, Sign out). This guards the menu going missing, the
// redirect targets drifting (e.g. Sign out no longer pointing at YouTube's
// logout, or Studio/Settings losing target=_blank so they hijack the SPA), and
// the open/close toggle regressing. Runs logged-out: the avatar is hidden but
// the menu DOM and its wiring still exist and are clickable, so the structure
// and toggle are fully assertable without an account.
async function checkAccountMenu(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube .hd-avatar', { state: 'attached', timeout: 30000 }).catch(() => {});
    const shape = await page.evaluate(() => {
      const av = document.querySelector('.hd-avatar');
      const items = [...document.querySelectorAll('.acct-menu .acct-item')].map((a) => ({
        text: a.textContent.trim(), href: a.getAttribute('href'), blank: a.target === '_blank',
      }));
      return {
        isButton: !!av && av.tagName === 'BUTTON' && av.getAttribute('aria-haspopup') === 'menu',
        items,
      };
    });
    if (!shape.isButton) {
      violations.push({ check: 'account-avatar-button', detail: 'expected the .hd-avatar to be a <button aria-haspopup="menu"> opening the account menu' });
    }
    const byText = (t) => shape.items.find((i) => i.text === t);
    const expect = [
      ['Your channel', (i) => i && !i.blank, 'a native (same-tab, SPA) Your channel link'],
      ['YouTube Studio', (i) => i && i.blank && /studio\.youtube\.com/.test(i.href || ''), 'Studio opening studio.youtube.com in a new tab'],
      ['Settings', (i) => i && !i.blank && !/youtube\.com\/account/.test(i.href || ''), 'Settings opening the in-app settings panel (NOT navigating to youtube.com/account)'],
      ['Switch account', (i) => i && i.blank && /accounts\.google\.com/.test(i.href || ''), 'Switch account opening the Google account chooser'],
      ['Sign out', (i) => i && /youtube\.com\/logout/.test(i.href || ''), 'Sign out pointing at YouTube logout'],
    ];
    for (const [label, ok, desc] of expect) {
      if (!ok(byText(label))) {
        violations.push({ check: 'account-menu-item', detail: `expected ${desc} (item "${label}" missing or wrong)` });
      }
    }
    // The avatar toggles the menu even while hidden (logged out): click opens
    // it, Escape closes it. v4.45 made the menu a real popover where
    // supported, whose native light-dismiss only reacts to TRUSTED key
    // events — a synthetic dispatchEvent(...) from page.evaluate is not
    // trusted and would silently no-op there, so Escape goes through
    // page.keyboard.press (a real, trusted key event) rather than JS.
    const opened = await page.evaluate(() => {
      document.querySelector('.hd-avatar').click();
      return document.querySelector('.acct-menu').classList.contains('open');
    });
    if (!opened) violations.push({ check: 'account-menu-opens', detail: 'clicking the avatar did not open the account menu (.open)' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => !document.querySelector('.acct-menu').classList.contains('open'));
    if (!closed) violations.push({ check: 'account-menu-escape', detail: 'pressing Escape did not close the account menu' });

    // Regression guard for a light-dismiss race: our popover click handler
    // doesn't declare a native invoker relationship, so a strict reading of
    // the spec allows the browser to auto-close the popover on pointerdown
    // (treating the avatar as an outside click) and then have our own click
    // handler read stale state and immediately reopen it — net effect,
    // clicking the avatar again can't close its own menu. Needs a REAL
    // trusted click (a synthetic .click() never dispatches the pointerdown
    // light-dismiss keys off of), so force the avatar visible for this.
    await page.evaluate(() => { document.querySelector('.hd-avatar').style.display = 'block'; });
    await page.click('.hd-avatar');
    await page.waitForTimeout(150);
    const reopened = await page.evaluate(() => document.querySelector('.acct-menu').classList.contains('open'));
    if (!reopened) {
      violations.push({ check: 'account-menu-click-to-close-setup', detail: 'expected a real click on the avatar to open the account menu (setup for the click-to-close check)' });
    } else {
      await page.click('.hd-avatar');
      await page.waitForTimeout(150);
      const closedByClick = await page.evaluate(() => !document.querySelector('.acct-menu').classList.contains('open'));
      if (!closedByClick) {
        violations.push({ check: 'account-menu-click-to-close', detail: 'expected clicking the avatar again while the menu is open to close it, not reopen it (light-dismiss race)' });
      }
    }

    // Account -> Settings must open Flyt's OWN settings panel, not navigate to
    // youtube.com/account (an unhandled page). Open the menu, click Settings,
    // and confirm the in-app settings overlay opened.
    await page.evaluate(() => { document.querySelector('.hd-avatar').style.display = 'block'; });
    await page.click('.hd-avatar');
    await page.waitForTimeout(120);
    const settingsOpened = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.acct-menu .acct-item')].find((a) => a.textContent.trim() === 'Settings');
      if (!item) return { ok: false, why: 'no Settings item' };
      item.click();
      const ov = document.querySelector('.settings-overlay');
      let popoverOpen = false;
      try { popoverOpen = !!ov && ov.matches(':popover-open'); } catch (e) {}
      return { ok: !!ov && (ov.classList.contains('open') || popoverOpen), navigated: location.pathname };
    });
    if (!settingsOpened.ok) {
      violations.push({ check: 'account-settings-opens-panel', detail: `clicking Account → Settings did not open the in-app settings panel (path now "${settingsOpened.navigated}")` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// The collapsed sidebar rail (<=1100px) must center the brand tile, account
// avatar and nav icons on one vertical line. `.hd-right { margin-left:auto }`
// (correct for the wide row layout) once shoved the avatar off-axis in the
// column layout — this guards that symmetry.
async function checkRailAlignment(browser) {
  const violations = [];
  const context = await newContext(browser, { viewport: { width: 1000, height: 900 } });
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube .brand-tile', { timeout: 20000 }).catch(() => {});
    const c = await page.evaluate(() => {
      const av = document.querySelector('#itube .hd-avatar');
      if (av) av.style.display = 'flex'; // avatar is hidden when logged out; force it to measure its box
      const cx = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
      return { brand: cx('#itube .brand-tile'), avatar: cx('#itube .hd-avatar'), nav: cx('#itube .nav-row svg') };
    });
    const vals = [c.brand, c.avatar, c.nav].filter((v) => v != null);
    if (vals.length < 3) {
      violations.push({ check: 'rail-alignment', detail: `expected brand/avatar/nav icons in the collapsed rail, got ${JSON.stringify(c)}` });
      return violations;
    }
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > 1.5) {
      violations.push({ check: 'rail-alignment', detail: `expected brand tile, avatar and nav icons on one center line in the collapsed rail; center-x spread ${spread.toFixed(1)}px (${JSON.stringify(c)})` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// The Settings panel is the hero feature of the accent-color refactor: this
// check exists to catch the case where the CSS variable plumbing (--accent /
// --accent-rgb) silently stops reaching the elements that are supposed to
// retint, or where the panel's open/close wiring regresses. It runs once on
// the home page, in its own context, mirroring checkAccountMenu.
async function checkSettings(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    const navBtn = await page.$('.nav-settings');
    if (!navBtn) {
      violations.push({ check: 'settings-nav-exists', detail: 'expected a .nav-settings sidebar button to exist' });
      return violations;
    }
    await navBtn.click();
    const openedAfterClick = await page.evaluate(() => document.querySelector('.settings-overlay')?.classList.contains('open'));
    if (!openedAfterClick) {
      violations.push({ check: 'settings-opens', detail: 'clicking .nav-settings did not add .open to .settings-overlay' });
    }

    const swatchCount = await page.evaluate(() => document.querySelectorAll('.settings-swatch').length);
    if (swatchCount !== 8) {
      violations.push({ check: 'settings-swatches-render', detail: `expected 8 .settings-swatch buttons (one per ACCENT_PRESETS entry), got ${swatchCount}` });
    }

    // Click the Violet swatch and confirm the CSS variables that drive the
    // whole app's accent color actually changed — this is the real signal
    // that the var(--accent-rgb) refactor is wired end-to-end, not just that
    // a click handler ran.
    const violetClicked = await page.evaluate(() => {
      const sw = [...document.querySelectorAll('.settings-swatch')].find((s) => s.title === 'Violet');
      if (!sw) return false;
      sw.click();
      return true;
    });
    if (!violetClicked) {
      violations.push({ check: 'settings-swatches-render', detail: 'expected a .settings-swatch with title "Violet" among ACCENT_PRESETS' });
    } else {
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => {
        const root = document.getElementById('itube');
        const cs = getComputedStyle(root);
        return {
          accent: cs.getPropertyValue('--accent').trim(),
          accentRgb: cs.getPropertyValue('--accent-rgb').trim(),
          stored: (() => { try { return localStorage.getItem('itube-accent'); } catch (e) { return null; } })(),
        };
      });
      if (after.accent !== '#8b5cf6') {
        violations.push({ check: 'accent-applies', detail: `expected #itube's --accent to be #8b5cf6 after picking Violet, got "${after.accent}"` });
      }
      if (after.accentRgb !== '139, 92, 246') {
        violations.push({ check: 'accent-applies', detail: `expected #itube's --accent-rgb to be "139, 92, 246" after picking Violet, got "${after.accentRgb}"` });
      }
      if (after.stored !== '#8b5cf6') {
        violations.push({ check: 'accent-applies', detail: `expected localStorage itube-accent to be "#8b5cf6" after picking Violet, got "${after.stored}"` });
      }
    }

    // Reduce motion toggle: flips the root class and persists.
    const motion = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.settings-row')].find((r) => r.querySelector('.settings-row-label')?.textContent === 'Reduce motion');
      const toggle = row?.querySelector('.settings-toggle');
      if (!toggle) return { found: false };
      toggle.click();
      return {
        found: true,
        hasClass: document.getElementById('itube').classList.contains('itube-reduce-motion'),
        stored: (() => { try { return localStorage.getItem('itube-reduce-motion'); } catch (e) { return null; } })(),
      };
    });
    if (!motion.found) {
      violations.push({ check: 'settings-reduce-motion', detail: 'expected a "Reduce motion" .settings-row with a .settings-toggle control' });
    } else {
      if (!motion.hasClass) {
        violations.push({ check: 'settings-reduce-motion', detail: 'expected #itube to gain .itube-reduce-motion after toggling Reduce motion on' });
      }
      if (motion.stored !== '1') {
        violations.push({ check: 'settings-reduce-motion', detail: `expected localStorage itube-reduce-motion === "1", got "${motion.stored}"` });
      }
    }

    await page.keyboard.press('Escape');
    const closedAfterEscape = await page.evaluate(() => document.querySelector('.settings-overlay')?.classList.contains('open'));
    if (closedAfterEscape) {
      violations.push({ check: 'settings-closes-on-escape', detail: 'expected Escape to remove .open from .settings-overlay' });
    }
  } finally {
    await page.evaluate(() => {
      try { localStorage.removeItem('itube-accent'); } catch (e) {}
      try { localStorage.removeItem('itube-reduce-motion'); } catch (e) {}
    }).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// The command palette (Ctrl/Cmd-K) is a global keyboard shortcut that must
// work anywhere in the app: this guards the document-level keydown listener
// actually opening the overlay, the fuzzy filter actually narrowing results,
// and Escape actually closing it again. Runs once on the home page, in its
// own context, mirroring checkAccountMenu.
async function checkCommandPalette(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    const overlayExists = await page.evaluate(() => {
      const overlay = document.querySelector('.cmdk-overlay');
      return { exists: !!overlay, open: !!overlay && overlay.classList.contains('open') };
    });
    if (!overlayExists.exists) {
      violations.push({ check: 'cmdk-exists', detail: 'expected a .cmdk-overlay element to exist' });
      return violations;
    }
    if (overlayExists.open) {
      violations.push({ check: 'cmdk-exists', detail: 'expected .cmdk-overlay to not have .open before any shortcut is pressed' });
    }

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(100);
    let opened = await page.evaluate(() => ({
      open: document.querySelector('.cmdk-overlay')?.classList.contains('open'),
      focused: document.activeElement?.classList?.contains('cmdk-input'),
    }));
    if (!opened.open) {
      // Fall back to a synthetic keydown in case Playwright's key chord
      // doesn't reach a bare document listener in this chromium build.
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
      await page.waitForTimeout(100);
      opened = await page.evaluate(() => ({
        open: document.querySelector('.cmdk-overlay')?.classList.contains('open'),
        focused: document.activeElement?.classList?.contains('cmdk-input'),
      }));
    }
    if (!opened.open) {
      violations.push({ check: 'cmdk-opens', detail: 'Ctrl+K did not add .open to .cmdk-overlay' });
    }
    if (!opened.focused) {
      violations.push({ check: 'cmdk-opens', detail: 'expected document.activeElement to be .cmdk-input after opening the palette' });
    }

    await page.fill('.cmdk-input', 'Subscriptions');
    await page.waitForTimeout(100);
    const filtered = await page.evaluate(() =>
      [...document.querySelectorAll('.cmdk-item')].some((el) => el.textContent.includes('Subscriptions')));
    if (!filtered) {
      violations.push({ check: 'cmdk-filters', detail: 'typing "Subscriptions" did not leave a matching .cmdk-item in the list' });
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const closed = await page.evaluate(() => !document.querySelector('.cmdk-overlay')?.classList.contains('open'));
    if (!closed) {
      violations.push({ check: 'cmdk-closes', detail: 'Escape did not remove .open from .cmdk-overlay' });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Every clickable element is supposed to give a visible hover reaction (see
// the flyt.user.js hover-polish pass) — a resting UI with no feedback reads
// as broken, and it is easy for a future edit to add a clickable element
// without giving it one. This samples a representative set of controls that
// are reliably present logged-out (sidebar rows, the brand mark, Settings
// swatches/toggles, the command palette) rather than every single selector,
// to keep the check fast and deterministic without requiring a watch page.
async function checkHoverStates(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});

    const readStyle = (el) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        color: cs.color,
        boxShadow: cs.boxShadow,
        borderColor: cs.borderColor,
        transform: cs.transform,
        filter: cs.filter,
      };
    };
    const changed = (before, after) => Object.keys(before).some((k) => before[k] !== after[k]);

    const assertHover = async (selector) => {
      const handle = await page.$(selector);
      if (!handle) return; // not present logged-out — skip rather than fail
      const before = await handle.evaluate(readStyle);
      await handle.hover();
      await page.waitForTimeout(120);
      const after = await handle.evaluate(readStyle);
      if (!changed(before, after)) {
        violations.push({ check: `hover-${selector}`, detail: `no computed-style change (background/color/boxShadow/borderColor/transform/filter) after hovering ${selector}` });
      }
      await page.mouse.move(0, 0);
    };

    // A `.nav-row.active` (the current page, Home by default) shares its
    // background with `:hover` by design — assert on an inactive row so the
    // sample actually exercises the hover transition rather than a no-op.
    await assertHover('.nav-row:not(.active)');
    await assertHover('.nav-settings');
    await assertHover('.brand');

    const navSettings = await page.$('.nav-settings');
    if (navSettings) {
      await navSettings.click();
      await page.waitForSelector('.settings-overlay.open', { timeout: 5000 }).catch(() => {});
      await assertHover('.settings-swatch');
      await assertHover('.settings-toggle');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(150);
    if (!(await page.$('.cmdk-overlay.open'))) {
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
      await page.waitForTimeout(150);
    }
    // The first .cmdk-item is auto-`.selected` on open and shares its
    // background with `:hover` by design (arrow-key highlight === hover) —
    // assert on a later, unselected item instead.
    await assertHover('.cmdk-item:not(.selected)');
    await page.keyboard.press('Escape');
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Playback speed must be able to exceed YouTube's 2x cap and the chosen speed
// must be remembered as a global default applied to the next video. The real
// signal is the underlying <video>.playbackRate (the YT player clamps its own
// setPlaybackRate to <=2, so Flyt drives the element directly and re-asserts
// it): this guards both the >2x capability regressing to a clamp and the
// remembered default not surviving a reload.
async function checkPlaybackSpeed(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).some((b) => b.textContent.includes('Tools')), { timeout: 15000 }).catch(() => {});
    const set = await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
      const toolsBtn = Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      // v4.45: the Tools Speed button opens a real menu listing every SPEEDS
      // entry (no more one-click-per-step cycle) — open it and click "3×"
      // directly, the same "set to 3" a user would do in one gesture.
      const speedBtn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Speed'));
      speedBtn.click();
      await new Promise((r) => setTimeout(r, 200));
      const items = Array.from(document.querySelectorAll('.tool-menu.open .tool-menu-item, .tool-menu:popover-open .tool-menu-item'));
      const item3x = items.find((it) => it.textContent.trim() === '3×');
      item3x?.click();
      await new Promise((r) => setTimeout(r, 1600));
      return {
        playback: v ? v.playbackRate : null,
        stored: (() => { try { return localStorage.getItem('itube-speed'); } catch (e) { return null; } })(),
        foundItem: !!item3x,
        itemCount: items.length,
      };
    });
    if (!set.foundItem) {
      violations.push({ check: 'speed-menu-has-3x', detail: `expected the Speed menu to list a "3×" item among its ${set.itemCount} entries` });
    }
    if (Math.abs((set.playback || 0) - 3) > 0.01) {
      violations.push({ check: 'speed-beyond-2x', detail: `expected video.playbackRate 3 (past YouTube's 2x cap), got ${set.playback}` });
    }
    if (set.stored !== '3') {
      violations.push({ check: 'speed-persists', detail: `expected localStorage itube-speed=3, got ${set.stored}` });
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    // A cold reload of a live video takes a variable moment to load and wire
    // before the remembered rate is re-applied, so poll for it rather than
    // guessing a fixed delay (the fixed wait was a flaky race).
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return v && Math.abs(v.playbackRate - 3) < 0.01;
    }, { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      return v ? v.playbackRate : null;
    });
    if (Math.abs((after || 0) - 3) > 0.01) {
      violations.push({ check: 'speed-default-applied', detail: `after reload the remembered 3x default was not applied, got ${after}` });
    }
  } finally {
    await page.evaluate(() => { try { localStorage.removeItem('itube-speed'); } catch (e) {} }).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// togglePlayback() (mount-scope, 300ms dedup) is the single call site both
// the #itube-play button click and the Space/K keydown handler now route
// through. Before that coalescing existed, clicking #itube-play toggled AND
// focused the button, so a following Space keypress fired TWO toggles: the
// app's own keydown handler, plus the browser's native "Space activates the
// focused button" behavior — netting a flip back to the pre-click state
// (or a visible flicker) instead of the single flip the user asked for. This
// reproduces that exact sequence (click, then a real trusted Space key) and
// samples paused state at three delays to catch either a full revert or a
// transient flicker.
async function checkSpaceToggle(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return v && !v.paused;
    }, { timeout: 8000 }).catch(() => {});

    await showBar(page);
    // Click #itube-play once: this both toggles playback AND leaves the
    // button focused, which is the exact precondition for the double-toggle.
    // The Space keypress below is fired with NO artificial delay after the
    // click — that back-to-back timing is load-bearing. With a gap (e.g. a
    // 150ms wait) the click's toggle has already fully committed before
    // Space is even dispatched, and the bug never shows up. Back-to-back,
    // pre-fix code read a still-in-flight `.paused` and fired a second,
    // canceling toggle; the coalesced togglePlayback()'s 300ms dedup is
    // exactly what makes that safe now.
    await page.click('#itube-play');
    const s1 = await page.evaluate(() => document.querySelector('#itube-stage video').paused);
    await page.keyboard.press(' ');

    const samples = [];
    for (const ms of [150, 200, 300]) {
      await page.waitForTimeout(ms);
      samples.push(await page.evaluate(() => document.querySelector('#itube-stage video').paused));
    }
    if (samples.some((p) => p === s1)) {
      violations.push({ check: 'space-toggle-flips', detail: `expected paused to flip from ${s1} to ${!s1} and stay flipped at +150/+350/+650ms samples, got s1=${s1} samples=${JSON.stringify(samples)}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// The transcript panel is pre-fetched in renderWatchFor and stays hidden
// entirely when a video has no transcript, so a missing panel here is an
// expected live-site condition, not a bug — SKIP rather than FAIL. Both SKIP
// paths return { violations: [], skipped: true } rather than a bare empty
// array: a bare empty array reads identically to a full PASS at the run.js
// call site (status = violations.length === 0 ? 'PASS' : 'FAIL'), which
// silently launders "the Transcript pill never appeared at all" into a green
// row indistinguishable from "the transcript rendered and every assertion
// held" — exactly the kind of regression (pill wiring broken) this check
// exists to catch. This proves the panel expands to real lines, that the
// search box actually filters by text (not just cosmetically), and that
// clicking a line drives the REAL player's currentTime rather than just
// highlighting itself.
async function checkTranscript(browser) {
  const violations = [];
  let renderedLineCount = 0;
  const context = await newContext(browser, { prefs: { 'itube-transcript': '1' } });
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    // The transcript now lives entirely in a popup opened from the Transcript
    // action pill, which only renders once caption-track availability is
    // known (a cheap poll of the player response, never a caption fetch), so
    // there's no unconditional pre-click selector to wait on any more (see
    // checkTranscriptLazy).
    const pill = await page.waitForSelector('.watch-action-btn[aria-label="Transcript"]', { timeout: 10000 }).catch(() => null);
    if (!pill) {
      const detail = 'no Transcript pill appeared within 10s (this video may have no caption tracks)';
      console.log(`  transcript: SKIP — ${detail}`);
      return { violations, skipped: true, detail };
    }
    await pill.click();
    await page.waitForSelector('.transcript-popup.show', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.transcript-line', { timeout: 10000 }).catch(() => {});
    const lineCount = await page.evaluate(() => document.querySelectorAll('.transcript-line').length);
    if (lineCount === 0) {
      const detail = 'no .transcript-line rows appeared after expanding (this video may have returned an empty caption body on the sandbox)';
      console.log(`  transcript: SKIP — ${detail}`);
      return { violations, skipped: true, detail };
    }
    const lines = await page.evaluate(() => [...document.querySelectorAll('.transcript-line')].map((l) => ({
      time: l.querySelector('.transcript-time')?.textContent || '',
      text: l.querySelector('.transcript-text')?.textContent || '',
    })));
    renderedLineCount = lines.length;
    if (lines.length < 3 || lines.some((l) => !l.text.trim() || !l.time.trim())) {
      violations.push({ check: 'transcript-renders', detail: `expected several .transcript-line entries with non-empty time+text, got ${JSON.stringify(lines.slice(0, 3))}` });
    }

    const word = (lines[0]?.text || '').split(/\s+/).find((w) => w.replace(/\W/g, '').length > 4) || '';
    if (word) {
      await page.fill('.transcript-search', word);
      await page.waitForTimeout(200);
      const visibleCount = await page.evaluate(() => document.querySelectorAll('.transcript-line:not(.hidden)').length);
      if (visibleCount >= lines.length) {
        violations.push({ check: 'transcript-search', detail: `expected filtering by "${word}" to reduce visible lines below ${lines.length}, got ${visibleCount}` });
      }
      await page.fill('.transcript-search', '');
      await page.waitForTimeout(200);
    }

    const midIndex = Math.floor(lines.length / 2);
    const targetTime = ((line) => {
      const parts = (line?.time || '').split(':').map(Number);
      return parts.length && !parts.some(Number.isNaN) ? parts.reduce((a, b) => a * 60 + b, 0) : null;
    })(lines[midIndex]);
    await page.evaluate((i) => {
      document.querySelectorAll('.transcript-line')[i]?.click();
    }, midIndex);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.querySelector('#itube-stage video')?.currentTime ?? null);
    if (targetTime == null || after == null || Math.abs(after - targetTime) > 2) {
      violations.push({ check: 'transcript-seek', detail: `expected currentTime to land within ~2s of clicked line's ${targetTime}, got ${after}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return { violations, skipped: false, detail: `${renderedLineCount} transcript line(s) rendered` };
}

// v4.45 regression guard: a caption track can exist in the player response's
// metadata (so the pill is shown) while the actual json3 body comes back
// empty — a region-locked ASR endpoint, a stale track entry, whatever the
// cause. Before this fix that left a dead "Transcript unavailable" popup
// reachable from a pill that should never have appeared confident in the
// first place. Reproduce the exact split deterministically (metadata says
// yes, fetch says no) by intercepting the real /api/timedtext request and
// substituting an empty body, then assert the pill hides and the popup
// closes rather than sitting there empty.
// v4.46: the button is now verified before it's shown (resetTranscript
// eagerly runs loadTranscript itself and only reveals the pill once real
// segments came back), so a caption track that proves empty at fetch time
// must mean the pill never appears at all, not "appears then hides on
// click" — the older recovery-path assertion below is no longer reachable
// because there's nothing left to click. Force the exact same metadata-yes
// / body-empty split by intercepting /api/timedtext before navigation (so
// the eager loadTranscript() sees it too) and assert the pill stays hidden
// once the app settles.
async function checkTranscriptProvedUnavailable(browser) {
  const violations = [];
  const context = await newContext(browser, { prefs: { 'itube-transcript': '1' } });
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  await page.route('**/api/timedtext**', (route) => {
    const url = route.request().url();
    if (/fmt=json3/.test(url)) route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    else route.continue();
  });
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    // Give the eager verify-load a chance to resolve (waitForPlayerResponse's
    // own poll can take up to ~3s, plus the forced-empty fetch).
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => {
      const btn = document.querySelector('.watch-action-btn[aria-label="Transcript"]');
      return {
        popupOpen: document.querySelector('.transcript-popup')?.classList.contains('show'),
        pillVisible: !!btn && getComputedStyle(btn).display !== 'none',
      };
    });
    if (after.popupOpen) {
      violations.push({ check: 'transcript-empty-fetch-no-popup', detail: 'expected an empty transcript fetch (metadata said yes, body said no) to never open the Transcript popup' });
    }
    if (after.pillVisible) {
      violations.push({ check: 'transcript-empty-fetch-hides-pill', detail: 'expected an empty transcript fetch to keep the Transcript pill hidden — its metadata-based presence was wrong for this video' });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Transcript is opt-in, OFF by default (v4.47) — a fresh install with no
// 'itube-transcript' pref set must never show the Transcript pill, even on
// a video that indisputably has caption tracks (same video checkTranscript
// uses). This is the regression that would silently re-enable a feature
// meant to stay behind a Playback settings toggle.
async function checkTranscriptOffByDefault(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const pillVisible = await page.evaluate(() => {
      const btn = document.querySelector('#itube .watch-actions .watch-action-btn[aria-label="Transcript"]');
      return !!btn && getComputedStyle(btn).display !== 'none';
    });
    if (pillVisible) {
      violations.push({ check: 'transcript-default-off', detail: 'expected the Transcript pill to stay hidden with no itube-transcript pref set, but it was visible' });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Volume boost lazily creates a WebAudio GainNode wired past a
// MediaElementSource — a MediaElementSource can only be created ONCE per
// <video>, so a wiring mistake here doesn't just fail to boost, it can
// silently break playback for the rest of the session. Headless Chromium
// can't measure actual loudness, so this proves the graph engages and
// persists AND that adopting the video into the WebAudio graph didn't stall
// playback (currentTime must keep advancing).
async function checkVolumeBoost(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).some((b) => b.textContent.includes('Tools')), { timeout: 15000 }).catch(() => {});
    const engaged = await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
      const before = v ? v.currentTime : null;
      const toolsBtn = Array.from(document.querySelectorAll('.watch-actions .watch-action-btn')).find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Volume boost'));
      btn.click();
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      return {
        text: btn.querySelector('.watch-tool-val').textContent,
        active: btn.classList.contains('active'),
        stored: (() => { try { return localStorage.getItem('itube-boost'); } catch (e) { return null; } })(),
        before,
        after: v ? v.currentTime : null,
      };
    });
    if (engaged.text !== '150%' || !engaged.active) {
      violations.push({ check: 'boost-engages', detail: `expected the Tools Volume boost button to read 150% and be .active after two clicks, got text=${engaged.text} active=${engaged.active}` });
    }
    if (engaged.stored !== '1.5') {
      violations.push({ check: 'boost-persists', detail: `expected localStorage itube-boost=1.5, got ${engaged.stored}` });
    }
    if (engaged.after == null || engaged.before == null || engaged.after - engaged.before < 0.3) {
      violations.push({ check: 'boost-playback-alive', detail: `expected video.currentTime to advance by >=0.3s after wiring the WebAudio graph, went ${engaged.before} -> ${engaged.after}` });
    }
    const off = await page.evaluate(async () => {
      const btn = Array.from(document.querySelectorAll('.watch-tools .watch-tool')).find((b) => b.textContent.includes('Volume boost'));
      btn.click();
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return { text: btn.querySelector('.watch-tool-val').textContent, active: btn.classList.contains('active') };
    });
    if (off.text !== 'Off' || off.active) {
      violations.push({ check: 'boost-off', detail: `expected the Tools Volume boost button to read Off and lose .active after cycling back, got text=${off.text} active=${off.active}` });
    }
  } finally {
    await page.evaluate(() => { try { localStorage.removeItem('itube-boost'); } catch (e) {} }).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// The Tools row is the ONLY surface for speed/quality/autoplay/sponsor-skip/
// boost since the player-bar "..." settings popup was removed in v4.41 — it
// must reveal/collapse without layout thrash and its controls must drive the
// REAL player (not just its own internal label), so this proves the
// disclosure toggles and that clicking the Tools Speed button actually
// changes video.playbackRate, not just the button's own text.
async function checkToolsRow(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .some((b) => b.textContent.includes('Tools'));
    }, { timeout: 15000 }).catch(() => {});

    const initial = await page.evaluate(() => {
      const toolsBtn = Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .find((b) => b.textContent.includes('Tools'));
      const row = document.querySelector('#itube .watch-tools');
      return {
        hasToolsBtn: !!toolsBtn,
        ariaExpanded: toolsBtn ? toolsBtn.getAttribute('aria-expanded') : null,
        hasRow: !!row,
        rowOpen: row ? row.classList.contains('open') : null,
        rowHeight: row ? row.offsetHeight : null,
      };
    });
    if (!initial.hasToolsBtn || initial.ariaExpanded !== 'false') {
      violations.push({ check: 'tools-button-collapsed', detail: `expected a Tools button with aria-expanded=false, got ${JSON.stringify(initial)}` });
    }
    if (!initial.hasRow || initial.rowOpen || initial.rowHeight > 0) {
      violations.push({ check: 'tools-row-collapsed', detail: `expected .watch-tools to exist and be collapsed, got ${JSON.stringify(initial)}` });
    }

    const opened = await page.evaluate(async () => {
      const toolsBtn = Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      const row = document.querySelector('#itube .watch-tools');
      // The reveal is a CSS max-height/opacity transition (var(--tr), .16s), so
      // give it time to run before reading offsetHeight — reading immediately
      // after the click observes the pre-transition (collapsed) frame.
      await new Promise((r) => setTimeout(r, 300));
      return { rowOpen: row.classList.contains('open'), rowHeight: row.offsetHeight, ariaExpanded: toolsBtn.getAttribute('aria-expanded') };
    });
    if (!opened.rowOpen || !(opened.rowHeight > 0) || opened.ariaExpanded !== 'true') {
      violations.push({ check: 'tools-row-opens', detail: `expected .watch-tools to gain .open, be visible, and aria-expanded=true after clicking Tools, got ${JSON.stringify(opened)}` });
    }

    const speedResult = await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
      const before = v ? v.playbackRate : null;
      const speedBtn = Array.from(document.querySelectorAll('#itube .watch-tools .watch-tool'))
        .find((b) => b.textContent.includes('Speed'));
      const beforeLabel = speedBtn ? speedBtn.querySelector('.watch-tool-val').textContent : null;
      // v4.45: clicking the pill opens a menu instead of cycling directly —
      // open it and pick a different entry to actually change the rate.
      speedBtn.click();
      await new Promise((r) => setTimeout(r, 200));
      const items = Array.from(document.querySelectorAll('.tool-menu.open .tool-menu-item, .tool-menu:popover-open .tool-menu-item'));
      const target = items.find((it) => it.textContent.trim() !== beforeLabel) || items[0];
      target?.click();
      await new Promise((r) => setTimeout(r, 300));
      const afterLabel = speedBtn.querySelector('.watch-tool-val').textContent;
      return { before, after: v ? v.playbackRate : null, beforeLabel, afterLabel, menuItemCount: items.length };
    });
    if (!speedResult.menuItemCount) {
      violations.push({ check: 'tools-speed-menu-opens', detail: 'expected clicking the Tools Speed button to open a menu listing SPEEDS entries' });
    }
    if (speedResult.before == null || speedResult.after == null || Math.abs(speedResult.after - speedResult.before) < 0.01) {
      violations.push({ check: 'tools-speed-works', detail: `expected picking a different Speed menu entry to change video.playbackRate, got ${JSON.stringify(speedResult)}` });
    }
    if (speedResult.beforeLabel === speedResult.afterLabel) {
      violations.push({ check: 'tools-speed-label-updates', detail: `expected the Tools Speed value text to change after picking a different entry, stayed at ${speedResult.afterLabel}` });
    }

    // Regression guard for a light-dismiss race (see checkAccountMenu and
    // ARCHITECTURE.md): needs a REAL trusted click, since a synthetic
    // .click() never dispatches the pointerdown light-dismiss keys off of.
    const speedPill = page.locator('.watch-tools .watch-tool', { hasText: 'Speed' });
    await speedPill.click();
    await page.waitForTimeout(200);
    const menuOpenedByRealClick = await page.evaluate(() => !!document.querySelector('.tool-menu.open, .tool-menu:popover-open'));
    if (!menuOpenedByRealClick) {
      violations.push({ check: 'tools-menu-click-to-close-setup', detail: 'expected a real click on the Speed pill to open its menu (setup for the click-to-close check)' });
    } else {
      await speedPill.click();
      await page.waitForTimeout(200);
      const menuStillOpen = await page.evaluate(() => !!document.querySelector('.tool-menu.open, .tool-menu:popover-open'));
      if (menuStillOpen) {
        violations.push({ check: 'tools-menu-click-to-close', detail: 'expected clicking the Speed pill again while its menu is open to close it, not reopen it (light-dismiss race)' });
      }
    }

    const closed = await page.evaluate(() => {
      const toolsBtn = Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      const row = document.querySelector('#itube .watch-tools');
      return { rowOpen: row.classList.contains('open') };
    });
    if (closed.rowOpen) {
      violations.push({ check: 'tools-row-closes', detail: 'expected .watch-tools to lose .open after clicking Tools a second time' });
    }
  } finally {
    await page.evaluate(() => { try { localStorage.removeItem('itube-speed'); } catch (e) {} }).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// A11y audit fix: the collapsed Tools tray used to hide via max-height:0 /
// opacity:0 / overflow:hidden while every .watch-tool button underneath
// stayed a real tab stop — 9 invisible tab stops plus AT noise for anyone
// tabbing past the Tools pill. setToolsOpen now toggles `inert` on
// .watch-tools alongside the .open class, so the collapsed tray must be
// unreachable by Tab/AT and the open tray must be reachable again.
async function checkA11yTabStops(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('#itube .watch-tools .watch-tool').length > 0, { timeout: 15000 }).catch(() => {});

    const collapsed = await page.evaluate(() => {
      const row = document.querySelector('#itube .watch-tools');
      const tools = [...document.querySelectorAll('#itube .watch-tools .watch-tool')];
      return {
        rowInert: row ? row.inert : null,
        toolCount: tools.length,
        anyFocusable: tools.some((b) => b.offsetParent !== null && !b.closest('[inert]')),
      };
    });
    if (collapsed.rowInert !== true) {
      violations.push({ check: 'tools-tray-collapsed-inert', detail: `expected .watch-tools to be inert while collapsed, got inert=${collapsed.rowInert}` });
    }
    if (!collapsed.toolCount) {
      violations.push({ check: 'tools-tray-collapsed-setup', detail: 'expected .watch-tool buttons to exist inside the tray' });
    } else if (collapsed.anyFocusable) {
      violations.push({ check: 'tools-tray-collapsed-not-focusable', detail: 'expected every .watch-tool button to be excluded from the tab order while the tray is collapsed' });
    }

    const opened = await page.evaluate(async () => {
      const toolsBtn = Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const row = document.querySelector('#itube .watch-tools');
      const tools = [...document.querySelectorAll('#itube .watch-tools .watch-tool')];
      return { rowInert: row.inert, allFocusable: tools.every((b) => !b.closest('[inert]')) };
    });
    if (opened.rowInert !== false) {
      violations.push({ check: 'tools-tray-open-not-inert', detail: `expected .watch-tools to drop inert once opened, got inert=${opened.rowInert}` });
    }
    if (!opened.allFocusable) {
      violations.push({ check: 'tools-tray-open-focusable', detail: 'expected every .watch-tool button to be reachable again once the tray is open' });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// A11y audit fix: the Description/Transcript popups now expose dialog
// semantics (role=dialog, aria-modal, aria-labelledby pointing at the
// .popup-title) and move focus into the panel on open, returning it to the
// triggering pill on close — including Escape, which used to be swallowed by
// the player's capture-phase keydown handler before it ever reached the
// popup's own bubble-phase listener (see the onKeydown centralization in
// flyt.user.js).
async function checkPopupDialogSemantics(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.watch-action-btn[aria-label="Description"]', { timeout: 15000 }).catch(() => {});

    await page.click('.watch-action-btn[aria-label="Description"]');
    await page.waitForTimeout(250);

    const shape = await page.evaluate(() => {
      const panel = document.querySelector('.desc-popup .itube-popup-panel');
      const title = document.getElementById(panel?.getAttribute('aria-labelledby'));
      const active = document.activeElement;
      return {
        role: panel?.getAttribute('role'),
        ariaModal: panel?.getAttribute('aria-modal'),
        titleText: title?.textContent || null,
        focusInsidePanel: !!panel && panel.contains(active),
      };
    });
    if (shape.role !== 'dialog' || shape.ariaModal !== 'true') {
      violations.push({ check: 'desc-popup-dialog-role', detail: `expected .desc-popup panel to have role=dialog aria-modal=true, got role=${shape.role} aria-modal=${shape.ariaModal}` });
    }
    if (shape.titleText !== 'Description') {
      violations.push({ check: 'desc-popup-labelledby', detail: `expected aria-labelledby to resolve to the "Description" title, got ${JSON.stringify(shape.titleText)}` });
    }
    if (!shape.focusInsidePanel) {
      violations.push({ check: 'desc-popup-focus-on-open', detail: 'expected focus to move inside the Description panel on open' });
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const afterEscape = await page.evaluate(() => ({
      open: document.querySelector('.desc-popup')?.classList.contains('show'),
      focusedIsDescPill: document.activeElement?.getAttribute('aria-label') === 'Description',
    }));
    if (afterEscape.open) {
      violations.push({ check: 'desc-popup-escape-closes', detail: 'expected Escape to close the Description popup even with the player keydown handler bound' });
    }
    if (!afterEscape.focusedIsDescPill) {
      violations.push({ check: 'desc-popup-escape-returns-focus', detail: 'expected Escape to return focus to the Description pill after closing the popup' });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// A11y audit fix: the Up next/Comments rail tabs now expose proper tab
// semantics (role=tablist/tab, aria-selected flipping on activation) instead
// of relying on a bare .active class the accessibility tree never saw.
async function checkRailTabAria(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.rail-tab', { timeout: 15000 }).catch(() => {});

    const initial = await page.evaluate(() => {
      const tablist = document.querySelector('.rail-tabs');
      const tabs = [...document.querySelectorAll('.rail-tab')];
      const upNext = tabs.find((t) => /Up next/.test(t.textContent));
      const comments = tabs.find((t) => /Comments/.test(t.textContent));
      return {
        tablistRole: tablist?.getAttribute('role'),
        tabRoles: tabs.map((t) => t.getAttribute('role')),
        upNextSelected: upNext?.getAttribute('aria-selected'),
        commentsSelected: comments?.getAttribute('aria-selected'),
        commentsDisabled: comments?.disabled,
      };
    });
    if (initial.tablistRole !== 'tablist') {
      violations.push({ check: 'rail-tablist-role', detail: `expected .rail-tabs to have role=tablist, got ${initial.tablistRole}` });
    }
    if (initial.tabRoles.some((r) => r !== 'tab')) {
      violations.push({ check: 'rail-tab-role', detail: `expected every .rail-tab to have role=tab, got ${JSON.stringify(initial.tabRoles)}` });
    }
    if (initial.upNextSelected !== 'true' || initial.commentsSelected !== 'false') {
      violations.push({ check: 'rail-tab-initial-selected', detail: `expected Up next selected and Comments not, got upNext=${initial.upNextSelected} comments=${initial.commentsSelected}` });
    }

    if (!initial.commentsDisabled) {
      await page.click('.rail-tab:has-text("Comments")');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.rail-tab')];
        const upNext = tabs.find((t) => /Up next/.test(t.textContent));
        const comments = tabs.find((t) => /Comments/.test(t.textContent));
        return { upNextSelected: upNext?.getAttribute('aria-selected'), commentsSelected: comments?.getAttribute('aria-selected') };
      });
      if (after.upNextSelected !== 'false' || after.commentsSelected !== 'true') {
        violations.push({ check: 'rail-tab-selected-flips', detail: `expected aria-selected to flip to Comments after activating it, got upNext=${after.upNextSelected} comments=${after.commentsSelected}` });
      }
    } else {
      console.log('  rail-tab-aria: note — Comments tab disabled (no comments token) on this video, skipping the activation assertion');
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Frame export: the player-bar camera button captures the current video frame
// as a PNG and downloads it. YouTube's MSE stream is origin-clean, so drawing
// the video to a canvas and reading it back works — this guards the button
// going dead or the canvas becoming tainted (which would make toBlob throw and
// silently produce no download).
async function checkFrameExport(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-shot', { timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('#itube-stage video');
      return v && v.videoWidth > 0;
    }, { timeout: 15000 }).catch(() => {});
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => document.getElementById('itube-shot').click());
    const download = await downloadPromise;
    if (!download) {
      violations.push({ check: 'frame-export-downloads', detail: 'clicking the frame-export (camera) button did not trigger a download — the canvas may be tainted or the button unwired' });
    } else if (!/\.png$/.test(download.suggestedFilename())) {
      violations.push({ check: 'frame-export-png', detail: `expected a .png download, got ${download.suggestedFilename()}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Feed filtering (mute channels / mute keywords / hide watched) is a pure
// client-side render-path check with no server round-trip, so a regression
// here is silent: the feed still loads, it just fails to drop the muted
// items. This guards (1) a muted keyword actually removing matching cards
// from a real search feed, (2) the filter being a no-op when the mute list
// is empty (so a broken predicate can't quietly eat the whole feed), and
// (3) the channel-page Mute button actually writing itube-mute-channels and
// flipping its own state.
async function checkFeedFilter(browser) {
  const violations = [];
  const context = await newContext(browser);
  let page;
  try {
    ({ page } = await openPage(context, 'https://www.youtube.com/results?search_query=liquid+glass+design'));
    await page.evaluate(() => {
      try { localStorage.setItem('itube-mute-keywords', JSON.stringify(['glass'])); } catch (e) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    const stillHasGlass = await page.evaluate(() => (
      [...document.querySelectorAll('.c-title, .row-title')].some((t) => /glass/i.test(t.textContent))
    ));
    if (stillHasGlass) {
      violations.push({ check: 'keyword-mute-filters', detail: 'expected no rendered card title to contain "glass" after muting the keyword "glass", but one was found' });
    }

    await page.evaluate(() => {
      try { localStorage.removeItem('itube-mute-keywords'); } catch (e) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.c-title, .row-title', { timeout: 15000 }).catch(() => {});
    const cardCountAfterClear = await page.evaluate(() => document.querySelectorAll('.c-title, .row-title').length);
    if (cardCountAfterClear === 0) {
      violations.push({ check: 'feed-not-broken-without-filter', detail: 'expected at least one card to render once itube-mute-keywords was cleared, but the feed rendered empty' });
    }

    const { page: chPage } = await openPage(context, 'https://www.youtube.com/@mkbhd/videos');
    await waitForApp(chPage, { timeout: 30000 }).catch(() => {});
    const muteBtn = await chPage.$('.ch-title-row .watch-action-btn');
    if (!muteBtn) {
      violations.push({ check: 'channel-mute-toggles', detail: 'expected a Mute .watch-action-btn next to the subscribe control on the channel page' });
    } else {
      await muteBtn.click();
      await chPage.waitForTimeout(150);
      const after = await chPage.evaluate((sel) => {
        const btn = document.querySelector(sel);
        return {
          stored: (() => { try { return localStorage.getItem('itube-mute-channels'); } catch (e) { return null; } })(),
          active: btn ? btn.classList.contains('active') : false,
          text: btn ? btn.textContent : '',
        };
      }, '.ch-title-row .watch-action-btn');
      if (!after.stored || after.stored === '[]') {
        violations.push({ check: 'channel-mute-toggles', detail: `expected itube-mute-channels to gain an entry after clicking Mute, got "${after.stored}"` });
      }
      if (!after.active && !/muted/i.test(after.text)) {
        violations.push({ check: 'channel-mute-toggles', detail: `expected the Mute button to show .active or "Muted" text after clicking, got text="${after.text}"` });
      }
    }
    await chPage.close();
  } finally {
    await page.evaluate(() => {
      try { localStorage.removeItem('itube-mute-keywords'); } catch (e) {}
      try { localStorage.removeItem('itube-mute-channels'); } catch (e) {}
      try { localStorage.removeItem('itube-hide-watched'); } catch (e) {}
    }).catch(() => {});
    await context.close();
  }
  return violations;
}

// Leaving a playing watch page must not kill playback: the video is
// re-parented into a floating mini-player rather than paused/reset, so this
// proves (a) it actually keeps decoding (currentTime advances) rather than
// silently freezing while still looking "playing", (b) clicking it returns
// to the watch view, and (c) the close button really stops it.
async function checkMiniPlayer(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      const home = document.querySelector('.nav-row[href="/"]');
      if (home) home.click();
    });
    await page.waitForTimeout(1000);

    const first = await page.evaluate(() => {
      const miniEl = document.getElementById('itube-mini');
      const v = document.querySelector('#itube-mini video');
      return {
        visible: !!miniEl && miniEl.style.display !== 'none' && miniEl.offsetWidth > 0,
        hasVideo: !!v,
        paused: v ? v.paused : null,
        currentTime: v ? v.currentTime : null,
      };
    });
    if (!first.visible) {
      violations.push({ check: 'mini-appears', detail: `expected #itube-mini to be visible after leaving watch while playing, got ${JSON.stringify(first)}` });
    }
    if (!first.hasVideo) {
      violations.push({ check: 'mini-appears', detail: 'expected #itube-mini video to exist after leaving watch while playing' });
    }
    await page.waitForTimeout(600);
    const second = await page.evaluate(() => {
      const v = document.querySelector('#itube-mini video');
      return { paused: v ? v.paused : null, currentTime: v ? v.currentTime : null };
    });
    if (first.paused || second.paused) {
      violations.push({ check: 'mini-keeps-playing', detail: `expected the mini-player video to keep playing, got paused=${first.paused}/${second.paused}` });
    }
    if (first.currentTime == null || second.currentTime == null || second.currentTime <= first.currentTime) {
      violations.push({ check: 'mini-keeps-playing', detail: `expected currentTime to advance in the mini-player, got ${first.currentTime} then ${second.currentTime}` });
    }

    await page.click('#itube-mini', { position: { x: 20, y: 150 } });
    await page.waitForTimeout(1000);
    const expanded = await page.evaluate(() => ({
      hasStageVideo: !!document.querySelector('#itube-stage video'),
      miniHidden: document.getElementById('itube-mini')?.style.display === 'none',
    }));
    if (!expanded.hasStageVideo || !expanded.miniHidden) {
      violations.push({ check: 'mini-expands', detail: `expected clicking the mini-player to return to watch and hide the mini, got ${JSON.stringify(expanded)}` });
    }

    await page.evaluate(() => {
      const home = document.querySelector('.nav-row[href="/"]');
      if (home) home.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { document.querySelector('#itube-mini .mini-close')?.click(); });
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => {
      const miniEl = document.getElementById('itube-mini');
      const v = document.querySelector('#movie_player video');
      return { hidden: !!miniEl && miniEl.style.display === 'none', paused: v ? v.paused : null };
    });
    if (!closed.hidden || closed.paused !== true) {
      violations.push({ check: 'mini-closes', detail: `expected the mini-player to hide and the video to pause after clicking .mini-close, got ${JSON.stringify(closed)}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Expanding the mini-player back to the watch page used to hand the singleton
// video to a fresh mountWatch() while the page was still building, which
// visibly jumped/blanked the frame and could even restart playback (watchNav
// unconditionally reloaded the same video id). The seamless version keeps the
// video floating in #itube-mini, untouched, while everything else mounts,
// then FLIPs the mini container onto the stage and only re-parents the video
// once the rects coincide. This samples every rAF across the whole transition
// and proves: playback never pauses, currentTime only advances, there is
// never more than one <video> in the document, the video's rect never
// collapses to zero, and it never teleports partway through (only the final,
// coincident frame may snap) — then checks the handoff actually lands in
// #itube-stage with the mini gone.
async function checkMiniExpandSeamless(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      const home = document.querySelector('.nav-row[href="/"]');
      if (home) home.click();
    });
    await page.waitForSelector('#itube-mini[style*="display: block"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    const preExpand = await page.evaluate(() => {
      const v = document.querySelector('#itube-mini video');
      return { hasMiniVideo: !!v, paused: v ? v.paused : null };
    });
    if (!preExpand.hasMiniVideo || preExpand.paused) {
      violations.push({ check: 'mini-expand-seamless-setup', detail: `expected a playing mini-player before expanding, got ${JSON.stringify(preExpand)}` });
      return violations;
    }

    const samples = await page.evaluate(() => new Promise((resolve) => {
      const out = [];
      let stop = false;
      const sample = () => {
        const stageVideo = document.querySelector('#itube-stage video');
        const miniVideo = document.querySelector('#itube-mini video');
        const v = stageVideo || miniVideo || document.querySelector('#movie_player video');
        const rect = v ? v.getBoundingClientRect() : null;
        out.push({
          t: performance.now(),
          videoCount: document.querySelectorAll('video').length,
          paused: v ? v.paused : null,
          currentTime: v ? v.currentTime : null,
          inStage: !!stageVideo,
          inMini: !!miniVideo,
          rect: rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null,
        });
        if (!stop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      document.querySelector('#itube-mini .mini-expand')?.click();
      setTimeout(() => { stop = true; setTimeout(() => resolve(out), 80); }, 900);
    }));

    if (samples.length < 2) {
      violations.push({ check: 'mini-expand-seamless-samples', detail: `expected multiple per-frame samples across the transition, got ${samples.length}` });
      return violations;
    }

    const viewportSize = page.viewportSize() || { width: 1440, height: 900 };
    const teleportThreshold = Math.max(viewportSize.width, viewportSize.height) / 2;

    let pausedSamples = 0;
    let missingVideoSamples = 0;
    let multiVideoSamples = 0;
    let zeroRectSamples = 0;
    let regressedTimeSamples = 0;
    let teleportSamples = 0;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.paused) pausedSamples++;
      if (s.currentTime == null) missingVideoSamples++;
      if (s.videoCount !== 1) multiVideoSamples++;
      if (!s.rect || s.rect.width * s.rect.height < 4) zeroRectSamples++;
      if (i > 0) {
        const prev = samples[i - 1];
        if (prev.currentTime != null && s.currentTime != null && s.currentTime < prev.currentTime - 0.1) {
          regressedTimeSamples++;
        }
        const isLast = i === samples.length - 1;
        if (!isLast && prev.rect && s.rect) {
          const dx = Math.abs(s.rect.left - prev.rect.left);
          const dy = Math.abs(s.rect.top - prev.rect.top);
          if (dx > teleportThreshold || dy > teleportThreshold) teleportSamples++;
        }
      }
    }

    if (pausedSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-paused', detail: `video.paused was true on ${pausedSamples}/${samples.length} samples during expand` });
    }
    if (missingVideoSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-missing', detail: `no <video> found (neither stage/mini/movie_player) on ${missingVideoSamples}/${samples.length} samples` });
    }
    if (multiVideoSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-clone', detail: `document had != 1 <video> element on ${multiVideoSamples}/${samples.length} samples (singleton was cloned or briefly duplicated)` });
    }
    if (zeroRectSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-blank', detail: `video bounding rect collapsed to ~0 area on ${zeroRectSamples}/${samples.length} samples` });
    }
    if (regressedTimeSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-rewind', detail: `currentTime went backwards on ${regressedTimeSamples}/${samples.length} sample transitions` });
    }
    if (teleportSamples > 0) {
      violations.push({ check: 'mini-expand-seamless-teleport', detail: `video rect jumped >viewport/2 between consecutive frames on ${teleportSamples} transitions (not the final coincident handoff)` });
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    if (last.currentTime == null || first.currentTime == null || last.currentTime <= first.currentTime) {
      violations.push({ check: 'mini-expand-seamless-advance', detail: `expected currentTime to advance across the whole transition, got ${first.currentTime} then ${last.currentTime}` });
    }

    await page.waitForTimeout(200);
    const final = await page.evaluate(() => ({
      hasStageVideo: !!document.querySelector('#itube-stage video'),
      miniHidden: document.getElementById('itube-mini')?.style.display === 'none',
      videoCount: document.querySelectorAll('video').length,
      // The fly uses fill:'forwards'; if the animation is never cancel()ed the
      // final transform keeps applying via the animation (independent of
      // style.transform), so the NEXT mini activation would appear scaled and
      // translated to wherever the stage was. Identity here proves cancel ran.
      miniTransform: getComputedStyle(document.getElementById('itube-mini')).transform,
    }));
    if (!final.hasStageVideo) {
      violations.push({ check: 'mini-expand-seamless-final', detail: `expected the video to end up parented in #itube-stage, got ${JSON.stringify(final)}` });
    }
    if (!final.miniHidden) {
      violations.push({ check: 'mini-expand-seamless-final', detail: `expected #itube-mini to be hidden after the expand completes, got ${JSON.stringify(final)}` });
    }
    if (final.videoCount !== 1) {
      violations.push({ check: 'mini-expand-seamless-final', detail: `expected exactly one <video> element after the expand completes, got ${final.videoCount}` });
    }
    if (final.miniTransform !== 'none' && final.miniTransform !== 'matrix(1, 0, 0, 1, 0, 0)') {
      violations.push({ check: 'mini-expand-seamless-stale-fill', detail: `expected #itube-mini to carry no residual transform after handoff (forwards-fill animation must be cancelled), got ${final.miniTransform}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Audio-only mode hides the video behind an art overlay and drops quality to
// save bandwidth, but the whole point is that decoding/playback must keep
// running — the <video> is never display:none'd, just covered. The critical
// guard here is proving currentTime keeps advancing (and the element stays
// unpaused) while the overlay is up, since a naive implementation could
// accidentally pause the underlying player when hiding it.
async function checkAudioOnly(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
    });
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .some((b) => b.textContent.includes('Tools'));
    }, { timeout: 15000 }).catch(() => {});

    const on = await page.evaluate(async () => {
      const toolsBtn = Array.from(document.querySelectorAll('#itube .watch-actions .watch-action-btn'))
        .find((b) => b.textContent.includes('Tools'));
      toolsBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const audioBtn = Array.from(document.querySelectorAll('#itube .watch-tools .watch-tool'))
        .find((b) => b.textContent.includes('Audio only'));
      audioBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const overlay = document.querySelector('.stage-audio');
      return {
        hasAudioClass: document.getElementById('itube-stage').classList.contains('audio-only'),
        overlayVisible: !!overlay && overlay.offsetWidth > 0,
      };
    });
    if (!on.hasAudioClass || !on.overlayVisible) {
      violations.push({ check: 'audio-only-overlay', detail: `expected #itube-stage.audio-only with a visible .stage-audio overlay, got ${JSON.stringify(on)}` });
    }

    const continuity = await page.evaluate(async () => {
      const v = document.querySelector('#itube-stage video');
      const t1 = v ? v.currentTime : null;
      const paused1 = v ? v.paused : null;
      await new Promise((r) => setTimeout(r, 700));
      const t2 = v ? v.currentTime : null;
      const paused2 = v ? v.paused : null;
      return { t1, t2, paused1, paused2 };
    });
    if (continuity.t1 == null || continuity.t2 == null || continuity.t2 <= continuity.t1 || continuity.paused1 || continuity.paused2) {
      violations.push({ check: 'audio-only-keeps-playing', detail: `expected video.currentTime to strictly advance and stay unpaused while audio-only is on, got ${JSON.stringify(continuity)}` });
    }

    const off = await page.evaluate(async () => {
      const audioBtn = Array.from(document.querySelectorAll('#itube .watch-tools .watch-tool'))
        .find((b) => b.textContent.includes('Audio only'));
      audioBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const overlay = document.querySelector('.stage-audio');
      return {
        hasAudioClass: document.getElementById('itube-stage').classList.contains('audio-only'),
        overlayVisible: !!overlay && overlay.offsetWidth > 0,
      };
    });
    if (off.hasAudioClass || off.overlayVisible) {
      violations.push({ check: 'audio-only-off', detail: `expected .audio-only class and overlay to be removed after toggling off, got ${JSON.stringify(off)}` });
    }
  } finally {
    await page.evaluate(() => { try { localStorage.removeItem('itube-audio-only'); } catch (e) {} }).catch(() => {});
    await page.close();
    await context.close();
  }
  return violations;
}

// Hard-loading /results?search_query=... used to always POST to
// /youtubei/v1/search even though the server already inlined the first page
// of results into ytInitialData — mountSearch now reads that inline data on
// non-SPA loads and only hits the network for continuations/filter changes.
// This proves the initial render is network-free; a regression here means
// someone reintroduced an unconditional innertube('search', ...) call.
async function checkSearchNoRefetch(browser) {
  const violations = [];
  const context = await newContext(browser);
  const page = await context.newPage();
  const searchPosts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/youtubei/v1/search')) searchPosts.push(req.url());
  });
  try {
    await page.goto('https://www.youtube.com/results?search_query=liquid+glass+design', { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.row', { timeout: 15000 }).catch(() => {});
    const rowCount = await page.evaluate(() => document.querySelectorAll('.row').length);
    if (rowCount === 0) {
      console.log('  search-no-refetch: SKIP — no .row results rendered within 15s');
      return violations;
    }
    if (searchPosts.length > 0) {
      violations.push({ check: 'search-no-refetch', detail: `expected 0 POSTs to /youtubei/v1/search before first results render, got ${searchPosts.length}: ${searchPosts.slice(0, 3).join(', ')}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// The transcript panel used to eagerly POST to /youtubei/v1/player and fetch
// the caption track on every watch mount/navigation, even though the panel
// starts collapsed and most sessions never open it. It's now fully lazy:
// loadTranscript() doesn't run at all until the toggle is clicked, at which
// point it reads the already-fetched player response (zero extra POST) and
// only hits /api/timedtext for the caption body itself. The parked, headless
// YouTube player independently prefetches its own auto-caption chunk
// regardless of Flyt, so a raw "0 timedtext requests" assertion would be
// flaky against the live site — this instead watches loadTranscript()'s own
// "Loading transcript…" state to prove OUR fetch didn't start early, then
// proves the click produces a real attempt (rows or the tolerated
// empty/unavailable state). Both SKIP paths below return
// { violations: [], skipped: true } rather than a bare empty array — see
// checkTranscript's comment for why a bare array here would launder a dead
// pill/fetch into an indistinguishable PASS at the run.js call site.
async function checkTranscriptLazy(browser) {
  const violations = [];
  const context = await newContext(browser, { prefs: { 'itube-transcript': '1' } });
  const timedtextRequests = [];
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  page.on('request', (req) => {
    if (req.url().includes('/api/timedtext')) timedtextRequests.push(req.url());
  });
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
    const pill = await page.waitForSelector('.watch-action-btn[aria-label="Transcript"]', { timeout: 10000 }).catch(() => null);
    if (!pill) {
      const detail = 'no Transcript pill appeared within 10s (this video may have no caption tracks)';
      console.log(`  transcript-lazy: SKIP — ${detail}`);
      return { violations, skipped: true, detail };
    }
    await page.waitForTimeout(1000);
    // YouTube's own (parked, headless) player independently prefetches an
    // auto-caption chunk for itself regardless of any Flyt UI action — that
    // shows up here as a genuine /api/timedtext request we don't control and
    // isn't the regression this check exists to catch. What IS ours to
    // control is loadTranscript(), which we can observe directly: it must
    // not have started before the popup is opened.
    const startedEarly = await page.evaluate(() => document.querySelector('.transcript-status')?.textContent === 'Loading transcript…');
    if (timedtextRequests.length > 0) {
      console.log(`  transcript-lazy: note — ${timedtextRequests.length} /api/timedtext request(s) fired before the click; this is YouTube's own player prefetching auto-captions, not Flyt (see loadTranscript's own state below)`);
    }
    if (startedEarly) {
      violations.push({ check: 'transcript-lazy-no-fetch', detail: 'expected loadTranscript() to stay idle until the Transcript pill is clicked, but the status already read "Loading transcript…" before the click' });
    }

    await pill.click();
    await page.waitForSelector('.transcript-line', { timeout: 10000 }).catch(() => {});
    const lineCount = await page.evaluate(() => document.querySelectorAll('.transcript-line').length);
    const label = await page.evaluate(() => document.querySelector('.transcript-status')?.textContent || '');
    if (lineCount === 0 && !/unavailable/i.test(label)) {
      const detail = `no rows rendered and no "unavailable" status after opening (status="${label}", possibly an empty caption body on the sandbox)`;
      console.log(`  transcript-lazy: SKIP — ${detail}`);
      return { violations, skipped: true, detail };
    }
  } finally {
    await page.close();
    await context.close();
  }
  return { violations, skipped: false, detail: '' };
}

// updateMediaSessionMetadata() is the ONLY thing wiring lock-screen/media-key
// integration (title, artist, artwork, and — via syncMediaSessionQueueActions
// — the previous/next-track handlers a headless test can't read back
// directly). A watchNav/wired refactor that stops calling it would leave the
// OS media controls silently blank or stale while everything on-screen still
// looks fine, so this asserts the metadata it actually sets: a non-empty
// title matching the rendered watch title, an artist matching the channel
// name, and at least one artwork entry — the three fields a broken wiring
// would leave empty/stale even though the action-handler wiring itself
// (setActionHandler) has no readable state to assert directly. SKIPs cleanly
// if the MediaSession API isn't available in this headless browser at all,
// rather than failing on an environment limitation.
async function checkMediaSession(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});

    const hasMediaSession = await page.evaluate(() => 'mediaSession' in navigator);
    if (!hasMediaSession) {
      const detail = 'navigator.mediaSession is unavailable in this headless browser — nothing to assert';
      console.log(`  mediasession: SKIP — ${detail}`);
      return { violations, skipped: true, detail };
    }

    // The video is muted+autoplaying already (see runWatchFunctional); give
    // updateMediaSessionMetadata() — called from renderMeta() — a moment to
    // have run rather than racing the very first render.
    await page.waitForFunction(() => !!navigator.mediaSession.metadata, { timeout: 10000 }).catch(() => {});

    const state = await page.evaluate(() => {
      const md = navigator.mediaSession.metadata;
      return {
        hasMetadata: !!md,
        title: md?.title || '',
        artist: md?.artist || '',
        artworkLength: md?.artwork?.length ?? 0,
        renderedTitle: document.querySelector('.watch-title')?.textContent?.trim() || '',
        renderedChannelName: document.querySelector('.watch-channel-name')?.textContent?.trim() || '',
      };
    });

    if (!state.hasMetadata) {
      violations.push({ check: 'mediasession-metadata-set', detail: 'expected navigator.mediaSession.metadata to be set once the watch page has rendered, got null' });
      return { violations, skipped: false, detail: '' };
    }
    if (!state.title || state.title !== state.renderedTitle) {
      violations.push({ check: 'mediasession-title', detail: `expected metadata.title ("${state.title}") to match the rendered watch title ("${state.renderedTitle}")` });
    }
    if (!state.artist || state.artist !== state.renderedChannelName) {
      violations.push({ check: 'mediasession-artist', detail: `expected metadata.artist ("${state.artist}") to match the rendered channel name ("${state.renderedChannelName}")` });
    }
    if (state.artworkLength === 0) {
      violations.push({ check: 'mediasession-artwork', detail: 'expected metadata.artwork to contain at least one entry, got 0' });
    }
    return { violations, skipped: false, detail: `title="${state.title}" artist="${state.artist}" artwork=${state.artworkLength}` };
  } finally {
    await page.close();
    await context.close();
  }
}

// itube-autoplay is read once, synchronously, at document-start
// (`let autoplayEnabled = lsGet('itube-autoplay') !== '0'`) — it can't be
// toggled after the app has already mounted, so unlike every other context
// in this file (built via the shared newContext(), which adds the userscript
// FIRST) this seeds the pref into localStorage in its own addInitScript,
// added BEFORE the userscript's, so the value already exists the instant the
// app's own init script runs and reads it.
async function newAutoplayContext(browser, autoplayOn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  await context.addInitScript((on) => {
    try { localStorage.setItem('itube-autoplay', on ? '1' : '0'); } catch (e) {}
  }, autoplayOn);
  const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await context.addInitScript({ content: scriptSource });
  return context;
}

// Shared with checkSponsorBlockDisabled and checkDislikesOptOut: both prefs
// (itube-skip-sponsors, itube-dislikes) can be read synchronously at
// document-start (sbEnabled) or on the first watch mount (fetchDislikes), so
// like newAutoplayContext above, the pref must already be in localStorage
// BEFORE the userscript's own init script runs, not set afterward.
async function newPrefContext(browser, prefs) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  await context.addInitScript((p) => {
    try { for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v); } catch (e) {}
  }, prefs);
  const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await context.addInitScript({ content: scriptSource });
  return context;
}

// The ads check (checkAdStateMachine/checkVideoAds) deliberately DISABLES
// autoplay to keep it from interfering with ad-skip assertions — which means
// nothing else in the suite actually proves the feature works. Autoplay is
// driven by a single 'ended' listener on the singleton <video> (see
// flyt.user.js's ended handler: it resolves a next id from the current
// playlist, or firstRelatedId, and calls watchNav()). Waiting for a real
// video to play to completion would make this check as long as the video
// itself, so instead the <video>'s native 'ended' event is dispatched
// directly — that drives the exact same listener a natural end-of-playback
// would, deterministically and instantly. Runs twice in two fresh contexts
// (the pref can't be flipped after mount, per above): once with autoplay ON,
// asserting the URL's v= changes to a different video; once OFF, asserting
// it does NOT. SKIPs if this fixture has no related video to resolve to —
// nothing to advance to, not a regression.
async function checkAutoplayNext(browser) {
  const violations = [];
  const url = 'https://www.youtube.com/watch?v=aircAruvnKk';

  const dispatchEndedAndRead = async (page) => {
    const before = await page.evaluate(() => location.search);
    await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video');
      if (v) v.dispatchEvent(new Event('ended'));
    });
    let changed = true;
    await page.waitForFunction((prev) => location.search !== prev, before, { timeout: 6000 }).catch(() => { changed = false; });
    const after = await page.evaluate(() => location.search);
    return { before, after, changed };
  };

  // --- autoplay ON: ending the video must advance to a next video ---
  {
    const context = await newAutoplayContext(browser, true);
    try {
      const { page } = await openPage(context, url);
      await waitForApp(page, { timeout: 30000 }).catch(() => {});
      await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
      const hasRelated = await page.waitForSelector('.rc', { timeout: 10000 }).then(() => true).catch(() => false);
      if (!hasRelated) {
        const detail = 'no .rc related video found on the fixture watch page — no next video to resolve to';
        console.log(`  autoplaynext: SKIP — ${detail}`);
        return { violations, skipped: true, detail };
      }
      const { before, after, changed } = await dispatchEndedAndRead(page);
      if (!changed || after === before) {
        violations.push({ check: 'autoplay-next-advances', detail: `expected location.search (v=) to change within 6s of the video ending with autoplay ON, stayed at "${before}"` });
      }
    } finally {
      await context.close();
    }
  }

  // --- autoplay OFF: ending the video must NOT advance ---
  {
    const context = await newAutoplayContext(browser, false);
    try {
      const { page } = await openPage(context, url);
      await waitForApp(page, { timeout: 30000 }).catch(() => {});
      await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});
      const { before, after } = await dispatchEndedAndRead(page);
      if (after !== before) {
        violations.push({ check: 'autoplay-next-off-stays', detail: `expected location.search (v=) to stay at "${before}" with autoplay OFF (ending the video must not advance), changed to "${after}"` });
      }
    } finally {
      await context.close();
    }
  }

  return { violations, skipped: false, detail: '' };
}

// getThumb used to always pick the largest thumbnail source regardless of
// how big the card actually renders, so a ~340px grid card could download a
// 1280px image. It now right-sizes to the card's CSS width × DPR. This
// proves loaded images land in a sane ratio to their rendered size — too far
// below 1 means blurry (picked too small), too far above means wasted
// bandwidth (picked too large, the original bug).
async function checkThumbSizing(browser) {
  const violations = [];
  const context = await newContext(browser);
  // The logged-out home feed legitimately renders zero cards (see
  // RECOVERY.md), so this uses a channel's videos tab, which Flyt renders
  // as the same .c-thumb grid without needing a session.
  const { page } = await openPage(context, 'https://www.youtube.com/@mkbhd/videos');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.c-thumb img', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const ratios = await page.evaluate(() => (
      [...document.querySelectorAll('.c-thumb img')]
        .filter((img) => img.naturalWidth > 0 && img.clientWidth > 0)
        .slice(0, 20)
        .map((img) => img.naturalWidth / img.clientWidth)
    ));
    if (ratios.length === 0) {
      console.log('  thumb-sizing: SKIP — no loaded grid card images found within the wait window');
      return violations;
    }
    const bad = ratios.filter((r) => r < 0.9 || r > 3.5);
    if (bad.length > 0) {
      violations.push({ check: 'thumb-sizing', detail: `expected naturalWidth/clientWidth in [0.9, 3.5] for loaded grid thumbs, got out-of-range ratios: ${bad.map((r) => r.toFixed(2)).join(', ')}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// activateMini rebinds 'play'/'pause' listeners onto the singleton <video>
// every time the mini-player activates, guarded only by identity-equality
// with the previous element — since the element is re-parented rather than
// recreated, that guard never fires past the first activation, and every
// watch -> mini round trip used to leave two more listeners attached.
// deactivateMini/closeMini now remove both listeners and null out the
// tracked element so re-activation starts clean. This proves it by wrapping
// EventTarget.add/removeEventListener to track a net 'play' listener count on
// the underlying video across two watch -> mini round trips — a leak would
// show round trip 2's count exceeding round trip 1's.
async function checkMiniListenerLeak(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube-stage video', { timeout: 30000 }).catch(() => {});

    // Wrap add/removeEventListener on the singleton video so every net 'play'
    // listener registered on it is counted regardless of native duplicate-
    // listener suppression — the bug re-registers the SAME function
    // reference, which the DOM would otherwise silently no-op, masking the
    // leak from any check that only inspects listener count via devtools.
    // Every per-mount watch listener in flyt.user.js is bound to that
    // mount's own AbortController ({signal}) and self-removes on navigation
    // without ever calling removeEventListener directly, so counting those
    // would just measure normal mount/unmount churn. Only the mini-player's
    // 'play' listener is registered without an abort signal, which is
    // exactly the one this check needs to isolate.
    await page.evaluate(() => {
      const video = document.querySelector('#itube-stage video') || document.querySelector('video');
      if (!video || video.__itubeLeakProbe) return;
      video.__itubeLeakProbe = true;
      window.__itubePlayListenerCount = 0;
      const nativeAdd = EventTarget.prototype.addEventListener;
      const nativeRemove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, opts) {
        if (this === video && type === 'play' && !(opts && opts.signal)) window.__itubePlayListenerCount++;
        return nativeAdd.call(this, type, listener, opts);
      };
      EventTarget.prototype.removeEventListener = function (type, listener, opts) {
        if (this === video && type === 'play' && !(opts && opts.signal)) window.__itubePlayListenerCount--;
        return nativeRemove.call(this, type, listener, opts);
      };
    });

    // Returning to /watch via the mini-player's expand button re-mounts the
    // watch page fresh (currentTime resets to 0, paused), so playback has to
    // be explicitly resumed before each "leave" or the app's own
    // stillPlaying guard skips mini activation entirely and the round trip
    // proves nothing.
    // The app's own stillPlaying guard (currentTime > 0 && !paused) decides
    // whether leaving watch activates the mini-player, so this polls for
    // real playback progress rather than sleeping a fixed amount — a flat
    // timeout races the video's actual play-and-advance and intermittently
    // leaves currentTime at 0, which skips mini activation and starves the
    // round trip this check depends on.
    const resumePlayback = async () => {
      await page.evaluate(async () => {
        const v = document.querySelector('#itube-stage video');
        if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
      });
      await page.waitForFunction(() => {
        const v = document.querySelector('#itube-stage video');
        return !!v && !v.paused && v.currentTime > 0.3;
      }, { timeout: 5000 }).catch(() => {});
    };
    const leaveWatch = async () => {
      await page.evaluate(() => { document.querySelector('.nav-row[href="/"]')?.click(); });
      await page.waitForSelector('#itube-mini[style*="display: block"]', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    };
    const expandBack = async () => {
      await page.click('#itube-mini', { position: { x: 20, y: 150 }, timeout: 10000 }).catch(() => {});
      await page.waitForSelector('#itube-stage video', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    };
    const listenerCount = async () => page.evaluate(() => window.__itubePlayListenerCount ?? null);
    const miniActive = async () => page.evaluate(() => document.getElementById('itube-mini')?.style.display === 'block');

    await resumePlayback();
    await leaveWatch();
    const firstActive = await miniActive();
    const afterFirst = await listenerCount();

    await expandBack();
    await resumePlayback();
    await leaveWatch();
    const secondActive = await miniActive();
    const afterSecond = await listenerCount();

    if (afterFirst == null || afterSecond == null || !firstActive || !secondActive) {
      console.log(`  mini-listener-leak: SKIP — mini-player didn't activate on both round trips (active=${firstActive}/${secondActive}), can't compare listener counts`);
      return violations;
    }
    if (afterSecond > afterFirst) {
      violations.push({ check: 'mini-listener-leak', detail: `expected the net 'play' listener count on the video to stay flat across round trips, got ${afterFirst} after trip 1, ${afterSecond} after trip 2` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// A cold InnerTube round trip (200-500ms) used to leave feed grids/lists
// showing nothing but a static "Loading…" spinner text, and the related rail
// on watch showing nothing at all until 20 cards popped in at once. Both now
// get shimmer skeleton placeholders the instant the navigation starts, before
// any data has arrived. This drives two navigations — a feed SPA switch
// (home -> history) and a feed-to-watch SPA switch (from a channel's Videos
// tab, since the logged-out home/history feeds have no cards to click) — and
// asserts the skeleton nodes exist synchronously right after the click, then
// disappear once the real content (or an empty/sign-in state) lands.
// Arms a MutationObserver-based latch BEFORE the caller clicks, so a skeleton
// that appears and clears within a window shorter than one synchronous
// page.evaluate() round trip (exactly the flake seen under full-suite load:
// the DOM sample below landed a moment after the skeleton had already been
// replaced by real content) still gets caught — mirrors the sawSkeleton latch
// checkWatchLoadSkeleton already uses for the watch-meta skeleton, applied
// here to the grid/related-rail skeleton selector instead of a one-shot
// synchronous sample right after the click.
function armSkeletonLatch(page, selector) {
  return page.evaluate((sel) => {
    window.__skeletonLatch = new Promise((resolve) => {
      let saw = document.querySelectorAll(sel).length > 0;
      const mo = new MutationObserver(() => {
        if (document.querySelectorAll(sel).length > 0) saw = true;
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      setTimeout(() => {
        mo.disconnect();
        resolve(saw);
      }, 4000);
    });
  }, selector);
}

async function checkListSkeleton(page) {
  const violations = [];

  const feedLink = await page.$('.nav-row[href="/feed/history"]');
  if (!feedLink) {
    violations.push({ check: 'list-skeleton-precondition', detail: 'expected .nav-row[href="/feed/history"] sidebar link to exist' });
    return violations;
  }
  await armSkeletonLatch(page, '.c-skel');
  await feedLink.click();
  const sawGridSkeleton = await page.evaluate(() => window.__skeletonLatch);
  if (!sawGridSkeleton) {
    violations.push({ check: 'list-skeleton-appears', detail: 'expected .c-skel skeleton cards to be present in the grid synchronously right after an SPA feed navigation, before data arrived' });
  }
  await page.waitForFunction(() => document.querySelectorAll('.c-skel').length === 0, { timeout: 15000 }).catch(() => {});
  const leftoverSkeleton = await page.evaluate(() => document.querySelectorAll('.c-skel').length);
  if (leftoverSkeleton > 0) {
    violations.push({ check: 'list-skeleton-clears', detail: `expected .c-skel skeletons to be removed once real data (or the empty/sign-in state) rendered, ${leftoverSkeleton} remained` });
  }

  // Logged-out home/history feeds render zero video cards (YouTube serves no
  // personalized recommendations to anonymous sessions), so there is nothing
  // there to click into a watch page. A channel's Videos tab is public,
  // logged-out content and always has cards, so land there first.
  await page.goto('https://www.youtube.com/@mkbhd/videos', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('.c', { timeout: 15000 }).catch(() => {});
  const card = await page.$('.c');
  if (!card) {
    violations.push({ check: 'related-skeleton-precondition', detail: 'expected at least one .c card on a channel Videos tab to click into a watch page' });
    return violations;
  }
  await armSkeletonLatch(page, '.rc-skel');
  const clicked = await clickCardPart(page, card, '.c-title');
  if (!clicked) {
    violations.push({ check: 'related-skeleton-precondition', detail: 'the first .c channel card has no layout box to click' });
    return violations;
  }
  const sawRelatedSkeleton = await page.evaluate(() => window.__skeletonLatch);
  if (!sawRelatedSkeleton) {
    violations.push({ check: 'related-skeleton-appears', detail: 'expected .rc-skel skeleton rows in the related rail synchronously right after an SPA navigation into a watch page, before data arrived' });
  }
  await page.waitForFunction(() => document.querySelectorAll('.rc-skel').length === 0, { timeout: 15000 }).catch(() => {});
  const leftoverRelated = await page.evaluate(() => document.querySelectorAll('.rc-skel').length);
  if (leftoverRelated > 0) {
    violations.push({ check: 'related-skeleton-clears', detail: `expected .rc-skel skeletons to be removed once the related rail's real cards rendered, ${leftoverRelated} remained` });
  }

  return violations;
}

// The reported glitch: on a scrolled watch page (comments expanded,
// content.scrollTop deep), clicking a related card used to fly the clicked
// thumbnail toward wherever #itube-stage happened to be measured — off the
// top of the viewport, since renderWatchFor only reset content.scrollTop
// AFTER its 'next' fetch resolved, ~1s after the fly's rAF had already
// measured the (still scrolled-away) stage. The fix hoists that reset to be
// synchronous in watchNav, before the fly animation's rAF ever runs. This
// scrolls deep, clicks a related card, and asserts scrollTop is back at 0
// immediately (not eventually) and that #itube-stage is on-screen at the
// moment the fly animation would measure it.
async function checkFlyOffscreenGuard(page) {
  const violations = [];

  // Watch v2 moved comments into the right rail's own scroll container, so
  // expanding the Comments tab no longer grows `.content` at the default
  // (>=1240px) two-column width — that's the point of the redesign. Below
  // 1240px the rail stacks back into the document's normal flow (see
  // checkWatchResponsive), so this narrows the viewport to reliably get a
  // page tall enough to scroll for the regression this check pins.
  const original = page.viewportSize();
  await page.setViewportSize({ width: 900, height: original ? original.height : 900 });
  await page.waitForTimeout(200);

  try {
    const commentsTab = await page.$('.rail-tab:has-text("Comments")');
    if (commentsTab) {
      const disabled = await page.evaluate((el) => el.disabled, commentsTab);
      if (!disabled) {
        const opened = await page.evaluate(() => document.querySelectorAll('.comment-row').length > 0);
        if (!opened) await commentsTab.click().catch(() => {});
        await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 15000 }).catch(() => {});
      }
    }

    // Scroll while the (tall) Comments panel is active to make the page
    // deep enough, THEN switch back to Up next — the related cards this
    // check needs to click live there and are display:none while Comments
    // is the active tab. Switching tabs only toggles which panel is shown;
    // it does not itself reset the shared `.content` scroll position, which
    // is exactly the state this regression guard needs.
    await page.evaluate(() => {
      const el = document.querySelector('#itube .content');
      if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
    });
    const upNextTab = await page.$('.rail-tab:has-text("Up next")');
    if (upNextTab) await upNextTab.click();
    await page.waitForTimeout(100);

    await page.waitForSelector('.rc', { timeout: 10000 }).catch(() => {});
    const related = await page.$('.rc');
    if (!related) {
      violations.push({ check: 'fly-offscreen-precondition', detail: 'expected at least one .rc related card to click' });
      return violations;
    }

    const scrolled = await page.evaluate(() => document.querySelector('#itube .content')?.scrollTop ?? null);
    if (!scrolled || scrolled < 150) {
      violations.push({ check: 'fly-offscreen-precondition', detail: `expected .content to still be scrolled past 150px after switching back to Up next (comments expanded it to make the page tall enough), got ${scrolled}` });
      return violations;
    }

    const clicked = await clickCardPart(page, related, '.rc-title');
    if (!clicked) {
      violations.push({ check: 'fly-offscreen-precondition', detail: 'the first .rc related card has no layout box to click' });
      return violations;
    }

    const scrollTopAfterClick = await page.evaluate(() => document.querySelector('#itube .content')?.scrollTop);
    if (scrollTopAfterClick !== 0) {
      violations.push({ check: 'fly-scroll-resets-synchronously', detail: `expected .content.scrollTop to be reset to 0 synchronously on a related-card click, got ${scrollTopAfterClick} — a reset that only happens after the fetch resolves means flyThumbToStage measures the stage while it is still scrolled off-screen` });
    }

    // Give the fly animation's own rAF a turn to run and measure the stage,
    // the same frame flyThumbToStage measures it on.
    await page.waitForTimeout(60);
    const stageRect = await page.evaluate(() => {
      const stage = document.getElementById('itube-stage');
      if (!stage) return null;
      const r = stage.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight };
    });
    if (!stageRect) {
      violations.push({ check: 'fly-offscreen-stage-missing', detail: 'expected #itube-stage to exist after clicking a related card' });
    } else if (stageRect.bottom < 0 || stageRect.top > stageRect.innerHeight) {
      violations.push({ check: 'fly-offscreen-stage-visible', detail: `expected #itube-stage to be on-screen at fly-measurement time, got top=${stageRect.top} bottom=${stageRect.bottom} innerHeight=${stageRect.innerHeight}` });
    }

    return violations;
  } finally {
    if (original) await page.setViewportSize(original);
  }
}

// v4.42.0 refetched a feed from scratch every time Back/Forward landed on it
// — popstate re-ran fetchInitial over the network and re-rendered from zero,
// even though the exact same items had just been scrolled through seconds
// earlier. Now leaving a cacheable list view (home/search/feed/playlist)
// stashes its extracted items + continuation token + scrollTop keyed by the
// route, and Back/Forward to that exact key restores from memory instead:
// zero network to make the restored cards appear, no skeleton flash, scroll
// position back where it was. Search is used here (rather than home) because
// the logged-out home feed legitimately renders zero cards — see
// checkFeedToWatchNavigation. Scrolls down, clicks into a video, goes Back,
// and asserts: (a) no POST to /youtubei/v1/(browse|search) fired to make the
// cards reappear — measured with a fetch wrapper installed in-page, so the
// window is exactly "before the cards became visible" and isn't polluted by
// a legitimate infinite-scroll continuation firing a beat later because the
// cached page was short; (b) results reappear fast — the same in-page clock
// avoids Playwright's own IPC latency; (c) content.scrollTop lands back near
// where it was; (d) Forward to the watch page afterwards still works.
async function checkBackForwardCache(browser) {
  const violations = [];
  const context = await newContext(browser);
  // Installed before any navigation so it is armed for the whole session —
  // it only matters what happens around Back, but re-arming later would risk
  // missing the exact tick the fetch fires on.
  await context.addInitScript(() => {
    const origFetch = window.fetch;
    window.__bfFetchLog = [];
    window.fetch = function (...args) {
      const url = String(args[0]);
      if (/\/youtubei\/v1\/(browse|search)/.test(url)) window.__bfFetchLog.push({ t: performance.now(), url });
      return origFetch.apply(this, args);
    };
  });
  const { page } = await openPage(context, 'https://www.youtube.com/results?search_query=liquid+glass+design');
  try {
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.row', { timeout: 15000 }).catch(() => {});
    const rowCount = await page.evaluate(() => document.querySelectorAll('.row').length);
    if (rowCount === 0) {
      console.log('  back-forward-cache: SKIP — no .row results rendered within 15s');
      return violations;
    }

    const scrolledTo = await page.evaluate(() => {
      const el = document.querySelector('#itube .content');
      el.scrollTop = 400;
      return el.scrollTop;
    });
    if (scrolledTo < 50) {
      violations.push({ check: 'back-forward-cache-precondition', detail: `expected to scroll .content to ~400px before clicking into a video, got ${scrolledTo}` });
      return violations;
    }

    // Pick a row that is actually ON-SCREEN at the scrolled position — the
    // first .row in DOM order is now scrolled off above the viewport, and
    // clicking its (off-screen, negative-y) bounding box hits nothing real.
    const cardHandle = await page.evaluateHandle(() => Array.from(document.querySelectorAll('#itube .row')).find((r) => {
      const rect = r.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight && r.querySelector('a[href^="/watch"]');
    }) || null);
    const card = cardHandle.asElement();
    if (!card) {
      violations.push({ check: 'back-forward-cache-precondition', detail: 'expected at least one on-screen .row card linking to /watch after scrolling' });
      return violations;
    }
    const clicked = await clickCardPart(page, card, '.row-title');
    if (!clicked) {
      violations.push({ check: 'back-forward-cache-precondition', detail: 'the first .row card has no layout box to click' });
      return violations;
    }
    await page.waitForFunction(() => location.pathname === '/watch', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#itube-stage', { timeout: 15000 }).catch(() => {});
    // Hold the window open past WATCH_BOOT_TIMEOUT, same as
    // checkFeedToWatchNavigation: a stray watchBoot fallback (native
    // location.assign) can still be armed for a moment after the player
    // mounts, and racing Back against it would reload the document for
    // reasons that have nothing to do with the list cache under test.
    await page.waitForTimeout(RELOAD_WATCH_MS);

    // Arm BEFORE Back: a rAF poll for visibility (pure in-page wall time, no
    // Playwright IPC noise) plus a reset of the fetch log so only POSTs from
    // Back onward count. The moment rows are detected, it snapshots which
    // logged fetches happened AT OR BEFORE that instant, in the same
    // synchronous tick — nothing else can run between the check and the
    // snapshot, so a continuation fetch that fires a beat later (because the
    // cached page was short and infinite-scroll's IntersectionObserver
    // legitimately wants more) can't be mistaken for "refetched to become
    // visible" just because Node read it a little late.
    await page.evaluate(() => {
      window.__bfFetchLog.length = 0;
      window.__bfResult = null;
      const start = performance.now();
      const tick = () => {
        if (document.querySelectorAll('#itube .row').length > 0) {
          const now = performance.now();
          window.__bfResult = { elapsed: now - start, postsBeforeVisible: window.__bfFetchLog.filter((e) => e.t <= now).map((e) => e.url) };
          return;
        }
        if (performance.now() - start > 3000) {
          window.__bfResult = { elapsed: -1, postsBeforeVisible: [] };
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForFunction(() => window.__bfResult !== null, { timeout: 5000 }).catch(() => {});
    const { elapsed, postsBeforeVisible } = await page.evaluate(() => window.__bfResult || { elapsed: null, postsBeforeVisible: [] });

    if (elapsed == null || elapsed < 0) {
      violations.push({ check: 'back-forward-cache-visible', detail: `expected .row cards to reappear after Back within 3s, got elapsed=${elapsed}` });
    } else if (elapsed > 250) {
      violations.push({ check: 'back-forward-cache-fast', detail: `expected the cached feed to render within 250ms of Back, took ${elapsed.toFixed(1)}ms — looks like it refetched over the network instead of restoring from memory` });
    }

    if (postsBeforeVisible.length > 0) {
      violations.push({ check: 'back-forward-cache-no-refetch', detail: `expected 0 POSTs to /youtubei/v1/(browse|search) before the cached feed became visible, got ${postsBeforeVisible.length}: ${postsBeforeVisible.slice(0, 3).join(', ')}` });
    }

    const scrollTopAfterBack = await page.evaluate(() => document.querySelector('#itube .content')?.scrollTop);
    if (scrollTopAfterBack == null || Math.abs(scrollTopAfterBack - scrolledTo) > 20) {
      violations.push({ check: 'back-forward-cache-scroll', detail: `expected .content.scrollTop restored to ~${scrolledTo} after Back, got ${scrollTopAfterBack}` });
    }

    const fwdRec = recordMainFrameDocLoads(page);
    await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForFunction(() => location.pathname === '/watch', { timeout: 15000 }).catch(() => {});
    fwdRec.stop();
    const fwdPath = await page.evaluate(() => location.pathname);
    if (fwdPath !== '/watch') {
      violations.push({ check: 'back-forward-cache-forward', detail: `expected Forward to land back on /watch, got "${fwdPath}"` });
    }
    if (fwdRec.urls.length > 0) {
      violations.push({ check: 'back-forward-cache-forward-no-reload', detail: `going Forward to the watch page caused ${fwdRec.urls.length} main-frame document load(s): ${fwdRec.urls.join(' , ')}` });
    }
  } finally {
    await page.close();
    await context.close();
  }
  return violations;
}

// Following page (/feed/channels). The sidebar only ever showed the guide's
// fast-path subscriptions (capped at MAX_GUIDE_CHANNELS=30 for the nav rail),
// so a full, sortable table needed its own route. Logged-out has no real
// subscriptions to drive this deterministically against, so — following the
// fixture-injection pattern in checks/feedorder.js — this mocks the
// FEchannels manage-subscriptions feed (fetched via the `browse` InnerTube
// endpoint, browseId 'FEchannels' — the PRIMARY source for
// fetchGuideChannels(), since the plain `guide` endpoint truncates past
// ~100 subscriptions without reliably exposing a continuation) with a
// crafted channelRenderer-shaped fixture (reusing the SAME
// collectGuideChannels()/fetchGuideChannels() path the sidebar uses), forces
// the `guide` endpoint to report an empty channel list (proving FEchannels
// is genuinely primary, not just tried-first-then-silently-ignored), and
// mocks `browse` for each channelId, leaving one channelId's browse
// unanswered (empty {} body) so its Subscribers/Videos/Last upload columns
// stay unresolved — the deterministic case for "unknown values render as —
// and sort last".
//
// Two channels exercise real accuracy bugs found in review:
//  - Ulana Channel uses the MODERN pageHeaderRenderer shape (no top-level
//    subscriberCountText/videosCountText) with German subscriber/video text
//    ("1,2 Mio. Abonnenten" / "500 Videos") — extractChannelStats() must
//    parse these structurally (by metadataRow position), not via an
//    English-only /subscriber/i /video/i regex, or the columns stay "—".
//  - Nova Channel's Home tab browse response carries an old PINNED video,
//    while its Videos-tab browse response (served only when the request's
//    `params` match the videos-tab selector) carries a genuinely recent
//    upload — "Last upload" must reflect the Videos-tab item, not whatever
//    the Home/Featured tab happens to pin.
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

const FOLLOWING_FIXTURE_CHANNELS = [
  { id: 'UCFollowTestZulu1', title: 'Zulu Channel', subs: '500K subscribers', subsNum: 500000, videos: '300 videos' },
  { id: 'UCFollowTestAlpha1', title: 'Alpha Channel', subs: '2M subscribers', subsNum: 2000000, videos: '120 videos' },
  { id: 'UCFollowTestMike01', title: 'Mike Channel', subs: null, subsNum: null, videos: null },
  {
    id: 'UCFollowTestUlana1',
    title: 'Ulana Channel',
    modernHeader: true,
    subsText: '1,2 Mio. Abonnenten',
    subsNum: 1200000,
    videosText: '500 Videos',
    videosNum: 500,
  },
  {
    id: 'UCFollowTestNovaC1',
    title: 'Nova Channel',
    subs: '10K subscribers',
    subsNum: 10000,
    videos: '50 videos',
    pinnedOld: { id: 'itubeflwpin01', title: 'Old pinned classic', published: '2 years ago' },
    recentUpload: { id: 'itubeflwnew01', title: 'Brand new upload', published: '2 hours ago' },
  },
  // Regression fixture for the handle/count-swap bug: parseCount() matches
  // the stray digit inside a handle like "@foo2bar" (real-world: "@pal2tech",
  // "@penguinz0"), so a naive "does parseCount() match" filter over the
  // modern-header metadata parts let the handle itself win the Subscribers
  // slot while the real count shifted into Videos. The fix requires the
  // matched part to also START with a digit — a handle never does.
  {
    id: 'UCFollowTestHandl1',
    title: 'Handle Digit Channel',
    modernHeader: true,
    handle: '@foo2bar',
    subsText: '77K subscribers',
    subsNum: 77000,
    videosText: '42 videos',
    videosNum: 42,
  },
  // Auto-generated "Topic" channel — no real stats, must be grouped into its
  // own section below all real channels, not interleaved by sort order.
  {
    id: 'UCFollowTestTopic1',
    title: 'Static-X - Topic',
    subs: null,
    subsNum: null,
    videos: null,
  },
];

// The guide endpoint is now only a last-resort fallback (see
// fetchGuideChannels()), so its mock must return an empty, non-paginating
// channel list — a stub that proves the fallback-proofing works: if a
// regression made the implementation silently prefer (or fall back to) the
// guide endpoint, this fixture would starve the table down to 0 rows and
// the test would fail loudly, instead of quietly passing via the old path.
function followingGuideFixture() {
  return { items: [{ guideSectionRenderer: { items: [] } }] };
}

// fetchGuideChannels() must follow FEchannels' continuation instead of
// truncating at whatever the first page holds (the real-world bug: users
// with >100 subscriptions lost everything past the first page — the guide
// endpoint doesn't reliably expose a continuation past its own cap, so
// falling back to FEchannels only when the guide reported none could itself
// be starved). To prove pagination works without needing 100+ fixture
// channels, the FEchannels fixture is split across two pages — only the
// first FECHANNELS_PAGE1_COUNT fixture channels are on page 1 (which also
// carries a continuation token), and the rest are served only when the
// continuation is followed. A truncated implementation would render exactly
// FECHANNELS_PAGE1_COUNT rows instead of the full set. Channels are served
// as channelRenderer nodes (the shape FEchannels actually uses, unlike the
// guideEntryRenderer shape the old guide-primary fixture used) inside a
// plausible browse-response wrapper — a sectionListRenderer/
// itemSectionRenderer contents array — which is enough for the generic
// walk()-based extractor to reach.
const FECHANNELS_CONTINUATION_TOKEN = 'FLYT_TEST_FECHANNELS_CONTINUATION_TOKEN';
const FECHANNELS_PAGE1_COUNT = 3;

function followingFEchannelsFixture(continuation) {
  const isPage2 = continuation === FECHANNELS_CONTINUATION_TOKEN;
  const pageChannels = isPage2
    ? FOLLOWING_FIXTURE_CHANNELS.slice(FECHANNELS_PAGE1_COUNT)
    : FOLLOWING_FIXTURE_CHANNELS.slice(0, FECHANNELS_PAGE1_COUNT);
  const items = pageChannels.map((ch) => ({
    channelRenderer: {
      channelId: ch.id,
      title: { simpleText: ch.title },
      thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${ch.id}.jpg`, width: 88, height: 88 }] },
    },
  }));
  if (!isPage2) {
    items.push({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token: FECHANNELS_CONTINUATION_TOKEN } },
      },
    });
  }
  return { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } };
}

function followingVideoItemFixture(item) {
  return {
    richItemRenderer: {
      content: {
        videoRenderer: {
          videoId: item.id,
          title: { simpleText: item.title },
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + item.id + '/hqdefault.jpg', width: 720, height: 404 }] },
          longBylineText: { runs: [{ text: 'Flyt Test Channel' }] },
          publishedTimeText: { simpleText: item.published },
          lengthText: { simpleText: '10:00' },
        },
      },
    },
  };
}

function followingBrowseFixture(ch, params) {
  if (ch.subs == null && !ch.subsText) return {};

  const header = ch.modernHeader
    ? {
      pageHeaderRenderer: {
        title: ch.title,
        content: {
          pageHeaderViewModel: {
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [
                  { metadataParts: [{ text: { content: ch.handle || ('@' + ch.title.replace(/\s+/g, '')) } }] },
                  { metadataParts: [{ text: { content: ch.subsText } }, { text: { content: ch.videosText } }] },
                ],
              },
            },
          },
        },
      },
    }
    : {
      c4TabbedHeaderRenderer: {
        title: ch.title,
        subscriberCountText: { simpleText: ch.subs },
        videosCountText: { simpleText: ch.videos },
      },
    };

  if (!ch.pinnedOld) return { header };

  const isVideosTabRequest = params === VIDEOS_TAB_PARAMS;
  const selectedContent = isVideosTabRequest
    ? { richGridRenderer: { contents: [followingVideoItemFixture(ch.recentUpload)] } }
    : { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [followingVideoItemFixture(ch.pinnedOld)] } }] } };

  return {
    header,
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              title: 'Home',
              selected: !isVideosTabRequest,
              endpoint: { browseEndpoint: { params: 'EghmZWF0dXJlZA%3D%3D' } },
              content: !isVideosTabRequest ? selectedContent : undefined,
            },
          },
          {
            tabRenderer: {
              title: 'Videos',
              selected: isVideosTabRequest,
              endpoint: { browseEndpoint: { params: VIDEOS_TAB_PARAMS } },
              content: isVideosTabRequest ? selectedContent : undefined,
            },
          },
        ],
      },
    },
  };
}

// Topic channels are always grouped into their own trailing section, so any
// expected row order below must sort the non-topic and topic channels
// separately and concatenate, rather than sorting the flat fixture list.
const nonTopicFixtureChannels = FOLLOWING_FIXTURE_CHANNELS.filter((c) => !c.title.endsWith(' - Topic'));
const topicFixtureChannels = FOLLOWING_FIXTURE_CHANNELS.filter((c) => c.title.endsWith(' - Topic'));
const localeSort = (arr) => [...arr].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
// Mirrors FOLLOWING_COLUMNS.length in flyt.user.js (Channel, Subscribers,
// Videos, Last upload, Upload frequency) — the "Topics" separator <td> must
// colspan all of them.
const FOLLOWING_TABLE_COLUMN_COUNT = 5;

const HOME_URL = 'https://www.youtube.com/';

async function checkFollowingPage(browser) {
  const violations = [];
  const context = await newContext(browser);

  // renderGuideChannels() fetches `guide` unconditionally at boot (it feeds
  // the sidebar), well before any click — so the mock has to be armed on the
  // CONTEXT before the page even loads, or the sidebar's own real (unmocked)
  // fetch wins the race and caches a real (here: empty, signed-out) result
  // that mountFollowing then reuses instead of ever re-fetching.
  const guideRe = /\/youtubei\/v1\/guide/;
  const browseRe = /\/youtubei\/v1\/browse/;
  // The guide endpoint is only a last-resort fallback now — this mock always
  // returns the empty stub (see followingGuideFixture's comment above), so
  // any call here at all is fine, but the list must come from FEchannels.
  await context.route(guideRe, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(followingGuideFixture()),
  }));
  // Counts every FEchannels fulfillment (by continuation) so the assertion
  // below can prove fetchGuideChannels() actually followed the FEchannels
  // continuation to a second page instead of returning after page 1.
  let feChannelsPage1CallCount = 0;
  let feChannelsPage2CallCount = 0;
  // Counts every fixture-channel browse fulfillment, so the persistent-cache
  // regression guard below can prove a second mount served entirely from
  // localStorage instead of re-fetching every followed channel.
  let browseCallCount = 0;
  await context.route(browseRe, (route) => {
    let browseId = null;
    let params = null;
    let continuation = null;
    try {
      const body = JSON.parse(route.request().postData() || '{}');
      browseId = body.browseId;
      params = body.params || null;
      continuation = body.continuation || null;
    } catch (e) {
      // fall through — not JSON we understand, let it hit the network
    }
    // FEchannels requests: the first page carries browseId 'FEchannels', but
    // continuation requests carry ONLY a continuation token (no browseId) —
    // matching on the token is the only way to route page-2 requests here,
    // otherwise they'd fall through to the per-channel lookup below, find no
    // match, and hit route.continue() (real network), which must not happen.
    if (browseId === 'FEchannels' || continuation === FECHANNELS_CONTINUATION_TOKEN) {
      if (continuation === FECHANNELS_CONTINUATION_TOKEN) feChannelsPage2CallCount++;
      else feChannelsPage1CallCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(followingFEchannelsFixture(continuation)),
      });
    }
    const ch = FOLLOWING_FIXTURE_CHANNELS.find((c) => c.id === browseId);
    if (ch) {
      browseCallCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(followingBrowseFixture(ch, params)),
      });
    }
    return route.continue();
  });

  const { page } = await openPage(context, HOME_URL);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  // The suite runs logged out, where mountFollowing renders the sign-in
  // prompt rather than the table — so, like checkSubscribeConfirmsOnPopup,
  // this fakes LOGGED_IN to reach the signed-in table path the mocked
  // guide/browse fixtures are built to drive.
  await page.evaluate(() => { if (window.ytcfg && window.ytcfg.data_) window.ytcfg.data_.LOGGED_IN = true; });

  try {
    const navLink = await page.$('a.nav-row[href="/feed/channels"]');
    if (!navLink) {
      violations.push({ check: 'following-nav-item-exists', detail: 'expected a.nav-row[href="/feed/channels"] ("Following") in the sidebar' });
      return violations;
    }

    const sortButtonsDisabled = async () => page.evaluate(() => (
      [...document.querySelectorAll('.following-sort-btn')].every((b) => b.disabled)
    ));

    const mark = await stampMark(page);
    const rec = recordMainFrameDocLoads(page);
    await navLink.click();
    await page.waitForFunction(() => location.pathname === '/feed/channels', { timeout: 10000 }).catch(() => {});
    await page.waitForSelector('.following-table', { timeout: 15000 }).catch(() => {});

    // Throttled-loading regression guard: enrichment is paced (concurrency 3,
    // a jittered ~300-600ms gap between each worker's successive fetches),
    // so the sort headers must read disabled right as the (unenriched) rows
    // first appear — before the settle-wait below gives enrichment time to
    // finish — rather than racing the user into reordering rows mid-load.
    if (!(await sortButtonsDisabled())) {
      violations.push({ check: 'following-sort-disabled-while-loading', detail: 'expected all .following-sort-btn to be disabled as soon as the (unenriched) rows first render' });
    }

    await page.waitForTimeout(800);
    const survived = await markSurvived(page, mark);
    rec.stop();

    const path = await page.evaluate(() => location.pathname);
    if (path !== '/feed/channels') {
      violations.push({ check: 'following-nav-client-side', detail: `expected clicking "Following" to route to /feed/channels, got pathname "${path}"` });
    }
    if (rec.urls.length > 0) {
      violations.push({ check: 'following-nav-no-reload', detail: `clicking "Following" caused ${rec.urls.length} main-frame document load(s), expected a client-side route: ${rec.urls.join(' , ')}` });
    }
    if (!survived) {
      violations.push({ check: 'following-nav-no-reload', detail: 'window.__itubeMark did not survive clicking "Following" — the document was replaced' });
    }

    const rowTitles = async () => page.evaluate(() => (
      [...document.querySelectorAll('.following-table tbody tr:not(.following-section-row)')].map((tr) => tr.querySelector('.following-chan-name')?.textContent || '')
    ));

    // FEchannels-continuation regression guard: the FEchannels fixture splits
    // its channels across two pages (page 1 + a continuation token), so a
    // truncated fetchGuideChannels() would only ever request page 1 and the
    // rendered table would be missing every channel that only page 2 holds.
    // Asserting both the page-2 request happened AND the combined row count
    // (first-page + second-page channels) proves continuations are followed
    // rather than the list silently stopping at page 1.
    if (feChannelsPage2CallCount < 1) {
      violations.push({ check: 'following-fechannels-continuation-followed', detail: `expected fetchGuideChannels() to request the FEchannels continuation (page 2) at least once, saw ${feChannelsPage2CallCount} such request(s) (page 1 requests: ${feChannelsPage1CallCount})` });
    }

    const initialTitles = await rowTitles();
    if (initialTitles.length !== FOLLOWING_FIXTURE_CHANNELS.length) {
      violations.push({ check: 'following-one-row-per-channel', detail: `expected ${FOLLOWING_FIXTURE_CHANNELS.length} rows (one per fixture channel, spanning both guide pages), got ${initialTitles.length} (${JSON.stringify(initialTitles)})` });
      return violations;
    }

    // Loading-UX regression guard: once enrichment settles, the skeleton
    // placeholders must be gone and the status must read the plain settled
    // form — with this small fixture (well under the 500-channel enrich
    // cap) there must be no "showing details for first N" truncation note.
    await page.waitForFunction(() => {
      const el = document.querySelector('.following-status');
      return el && !/Loading details/.test(el.textContent);
    }, { timeout: 10000 }).catch(() => {});
    const skeletonCount = await page.evaluate(() => document.querySelectorAll('.following-skeleton').length);
    if (skeletonCount !== 0) {
      violations.push({ check: 'following-skeletons-cleared', detail: `expected 0 .following-skeleton placeholders once enrichment settles, found ${skeletonCount}` });
    }
    const finalStatus = await page.evaluate(() => document.querySelector('.following-status')?.textContent || '');
    const topicFixtureCount = FOLLOWING_FIXTURE_CHANNELS.filter((c) => c.title.endsWith(' - Topic')).length;
    const expectedSettled = FOLLOWING_FIXTURE_CHANNELS.length + ' channels'
      + (topicFixtureCount > 0 ? ' · ' + topicFixtureCount + (topicFixtureCount === 1 ? ' topic' : ' topics') : '');
    if (finalStatus !== expectedSettled) {
      violations.push({ check: 'following-status-settled', detail: `expected settled status "${expectedSettled}" (no truncation note, no leftover progress text); got "${finalStatus}"` });
    }

    // Sort-gating regression guard: only once every row is enriched should
    // the headers become clickable.
    if (await sortButtonsDisabled()) {
      violations.push({ check: 'following-sort-enabled-after-load', detail: 'expected .following-sort-btn headers to be enabled once enrichment has fully settled' });
    }

    const readSubsColumn = async () => page.evaluate(() => (
      [...document.querySelectorAll('.following-table tbody tr:not(.following-section-row)')].map((tr) => ({
        name: tr.querySelector('.following-chan-name')?.textContent || '',
        subs: tr.querySelectorAll('td')[1]?.textContent || '',
      }))
    ));

    const beforeSort = await readSubsColumn();
    const expectedDefaultOrder = localeSort(nonTopicFixtureChannels.map((c) => c.title))
      .concat(localeSort(topicFixtureChannels.map((c) => c.title)));
    if (beforeSort.map((r) => r.name).join(',') !== expectedDefaultOrder.join(',')) {
      violations.push({ check: 'following-default-name-sort', detail: `expected the default (Channel, ascending) sort to be locale-aware alphabetical, topics trailing — expected [${expectedDefaultOrder.join(', ')}], got [${JSON.stringify(beforeSort.map((r) => r.name))}]` });
    }

    await page.click('.following-table th:nth-child(2) .following-sort-btn');
    await page.waitForTimeout(200);
    const ascSubs = await readSubsColumn();
    const ascZuluIdx = ascSubs.findIndex((r) => r.name === 'Zulu Channel');
    const ascAlphaIdx = ascSubs.findIndex((r) => r.name === 'Alpha Channel');
    const ascMikeIdx = ascSubs.findIndex((r) => r.name === 'Mike Channel');
    if (!(ascZuluIdx < ascAlphaIdx)) {
      violations.push({ check: 'following-sort-subs-asc', detail: `expected ascending Subscribers sort to place Zulu Channel (500K) before Alpha Channel (2M); got order ${JSON.stringify(ascSubs.map((r) => r.name))}` });
    }
    // Mike sorts last WITHIN the non-topic group (unknown subs) — the topic
    // channel(s) still trail the whole non-topic group regardless.
    if (ascMikeIdx !== nonTopicFixtureChannels.length - 1) {
      violations.push({ check: 'following-sort-subs-unknown-last-asc', detail: `expected Mike Channel (unknown subscriber count) to sort last within the non-topic group on ascending Subscribers sort; got order ${JSON.stringify(ascSubs.map((r) => r.name))}` });
    }
    // Topic-grouping regression guard: no matter the active sort key/dir,
    // topic channels must stay in their own trailing section.
    if (ascSubs.length !== nonTopicFixtureChannels.length + topicFixtureChannels.length
      || !topicFixtureChannels.every((c, i) => ascSubs[nonTopicFixtureChannels.length + i]?.name === c.title)) {
      violations.push({ check: 'following-topic-section-trailing-asc', detail: `expected topic channel(s) [${topicFixtureChannels.map((c) => c.title).join(', ')}] to trail every non-topic row on ascending Subscribers sort; got order ${JSON.stringify(ascSubs.map((r) => r.name))}` });
    }

    await page.click('.following-table th:nth-child(2) .following-sort-btn');
    await page.waitForTimeout(200);
    const descSubs = await readSubsColumn();
    const descZuluIdx = descSubs.findIndex((r) => r.name === 'Zulu Channel');
    const descAlphaIdx = descSubs.findIndex((r) => r.name === 'Alpha Channel');
    const descMikeIdx = descSubs.findIndex((r) => r.name === 'Mike Channel');
    if (!(descAlphaIdx < descZuluIdx)) {
      violations.push({ check: 'following-sort-subs-desc', detail: `expected descending Subscribers sort to place Alpha Channel (2M) before Zulu Channel (500K); got order ${JSON.stringify(descSubs.map((r) => r.name))}` });
    }
    if (descMikeIdx !== nonTopicFixtureChannels.length - 1) {
      violations.push({ check: 'following-sort-subs-unknown-last-desc', detail: `expected Mike Channel (unknown subscriber count) to still sort last within the non-topic group on descending Subscribers sort; got order ${JSON.stringify(descSubs.map((r) => r.name))}` });
    }
    if (!topicFixtureChannels.every((c, i) => descSubs[nonTopicFixtureChannels.length + i]?.name === c.title)) {
      violations.push({ check: 'following-topic-section-trailing-desc', detail: `expected topic channel(s) to still trail every non-topic row on descending Subscribers sort; got order ${JSON.stringify(descSubs.map((r) => r.name))}` });
    }

    await page.click('.following-table th:nth-child(1) .following-sort-btn');
    await page.waitForTimeout(200);
    const nameSorted = await rowTitles();
    const expectedNameOrder = localeSort(nonTopicFixtureChannels.map((c) => c.title))
      .concat(localeSort(topicFixtureChannels.map((c) => c.title)));
    if (nameSorted.join(',') !== expectedNameOrder.join(',')) {
      violations.push({ check: 'following-sort-name', detail: `expected clicking the Channel header to sort names locale-aware ascending (topics trailing) — expected [${expectedNameOrder.join(', ')}], got [${nameSorted.join(', ')}]` });
    }

    // Fix 2 regression guard: a "Topics" section-header row must separate
    // the topic group from real channels, and each topic row must carry the
    // dimmed class + badge.
    const topicSection = await page.evaluate(() => {
      const sepRow = document.querySelector('.following-table tbody tr.following-section-row');
      const topicRow = document.querySelector('.following-table tbody tr.following-topic-row');
      return {
        sepText: sepRow?.textContent || null,
        sepColspan: sepRow?.querySelector('td')?.getAttribute('colspan') || null,
        topicRowHasBadge: !!topicRow?.querySelector('.following-topic-badge'),
        topicBadgeText: topicRow?.querySelector('.following-topic-badge')?.textContent || null,
      };
    });
    if (topicSection.sepText !== 'Topics') {
      violations.push({ check: 'following-topic-separator', detail: `expected a "Topics" section-header row, got sepText="${topicSection.sepText}"` });
    }
    if (topicSection.sepColspan !== String(FOLLOWING_TABLE_COLUMN_COUNT)) {
      violations.push({ check: 'following-topic-separator-colspan', detail: `expected the "Topics" separator <td> to span all ${FOLLOWING_TABLE_COLUMN_COUNT} columns, got colspan="${topicSection.sepColspan}"` });
    }
    if (!topicSection.topicRowHasBadge || topicSection.topicBadgeText !== 'Topic') {
      violations.push({ check: 'following-topic-badge', detail: `expected the topic channel's row to carry a "Topic" badge, got badge text "${topicSection.topicBadgeText}"` });
    }

    // Fix 1 regression guard: modern pageHeaderRenderer + non-English
    // ("1,2 Mio. Abonnenten" / "500 Videos") must parse to numbers, not "—".
    // Pre-fix, extractChannelStats() only matched /subscriber/i and /video/i
    // against the metadata text, so this fell through to null on every
    // non-English UI.
    const readAllColumns = async () => page.evaluate(() => (
      [...document.querySelectorAll('.following-table tbody tr:not(.following-section-row)')].map((tr) => {
        const cells = tr.querySelectorAll('td');
        return {
          name: tr.querySelector('.following-chan-name')?.textContent || '',
          subs: cells[1]?.textContent || '',
          videos: cells[2]?.textContent || '',
          lastUpload: cells[3]?.textContent || '',
        };
      })
    ));

    const allCols = await readAllColumns();
    const ulanaRow = allCols.find((r) => r.name === 'Ulana Channel');
    if (!ulanaRow || !/\d/.test(ulanaRow.subs) || ulanaRow.subs === '—') {
      violations.push({ check: 'following-locale-subs-parse', detail: `expected Ulana Channel's German "1,2 Mio. Abonnenten" to parse to a Subscribers number, got "${ulanaRow?.subs}"` });
    }
    if (!ulanaRow || !/\d/.test(ulanaRow.videos) || ulanaRow.videos === '—') {
      violations.push({ check: 'following-locale-videos-parse', detail: `expected Ulana Channel's German "500 Videos" to parse to a Videos number, got "${ulanaRow?.videos}"` });
    }

    // Fix 1 regression guard (handle/count-swap): a modern-header handle
    // containing a digit ("@foo2bar") must NOT be picked up as the
    // Subscribers value — parseCount() matches the stray "2" inside it, so
    // pre-fix the handle string itself won when the numericParts filter only
    // checked "does parseCount() match", shoving the real 77K count into the
    // Videos column instead.
    const handleRow = allCols.find((r) => r.name === 'Handle Digit Channel');
    if (!handleRow || handleRow.subs.includes('@foo2bar') || !/77K/.test(handleRow.subs)) {
      violations.push({ check: 'following-handle-digit-subs-not-swapped', detail: `expected Handle Digit Channel's Subscribers cell to read "77K subscribers", not the "@foo2bar" handle; got "${handleRow?.subs}"` });
    }
    if (!handleRow || !/42/.test(handleRow.videos)) {
      violations.push({ check: 'following-handle-digit-videos-not-swapped', detail: `expected Handle Digit Channel's Videos cell to read "42 videos", got "${handleRow?.videos}"` });
    }

    await page.click('.following-table th:nth-child(2) .following-sort-btn');
    await page.waitForTimeout(200);
    const localeSubsSorted = await readSubsColumn();
    const ulanaIdx = localeSubsSorted.findIndex((r) => r.name === 'Ulana Channel');
    const zuluIdxAfterLocale = localeSubsSorted.findIndex((r) => r.name === 'Zulu Channel');
    const alphaIdxAfterLocale = localeSubsSorted.findIndex((r) => r.name === 'Alpha Channel');
    if (ulanaIdx === -1 || !(zuluIdxAfterLocale < ulanaIdx && ulanaIdx < alphaIdxAfterLocale)) {
      violations.push({ check: 'following-locale-subs-sort', detail: `expected ascending Subscribers sort to place Zulu (500K) < Ulana (1.2M, parsed from German) < Alpha (2M); got order ${JSON.stringify(localeSubsSorted.map((r) => r.name))}` });
    }

    // Fix 2 regression guard: "Last upload" must come from the channel's
    // VIDEOS tab (chronological), not whatever the Home/Featured tab pins.
    // Nova Channel's Home tab browse response pins a 2-year-old video; only
    // its Videos-tab response (fetched via the resolved videos-tab params)
    // carries the genuinely recent upload.
    const novaRow = allCols.find((r) => r.name === 'Nova Channel');
    if (!novaRow || !/2 hours ago/.test(novaRow.lastUpload)) {
      violations.push({ check: 'following-last-upload-videos-tab', detail: `expected Nova Channel's "Last upload" to reflect the Videos-tab upload ("2 hours ago"), not the Home-tab pinned video; got "${novaRow?.lastUpload}"` });
    }

    // Persistent-cache regression guard: the whole point of caching
    // per-channel enrichment in localStorage is that a second visit is a
    // one-time cost, not a repeated one. Navigate away and back to
    // /feed/channels (same page, same origin — the localStorage entries
    // written during the first mount are still there) and confirm the
    // second mount (a) renders fully enriched immediately, with no loading
    // skeletons and sort headers enabled from the start, and (b) makes zero
    // additional browse requests.
    const browseCallCountAfterFirstLoad = browseCallCount;
    await page.click('.nav-row[href="/"]');
    await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 }).catch(() => {});
    const navLinkAgain = await page.$('a.nav-row[href="/feed/channels"]');
    if (!navLinkAgain) {
      violations.push({ check: 'following-nav-item-exists-second-visit', detail: 'expected a.nav-row[href="/feed/channels"] ("Following") in the sidebar on the second visit' });
      return violations;
    }
    await navLinkAgain.click();
    await page.waitForFunction(() => location.pathname === '/feed/channels', { timeout: 10000 }).catch(() => {});
    await page.waitForSelector('.following-table', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);

    const secondSkeletonCount = await page.evaluate(() => document.querySelectorAll('.following-skeleton').length);
    if (secondSkeletonCount !== 0) {
      violations.push({ check: 'following-cache-second-visit-no-skeletons', detail: `expected the cache-hydrated second visit to render fully enriched with no loading skeletons, found ${secondSkeletonCount}` });
    }
    if (await sortButtonsDisabled()) {
      violations.push({ check: 'following-cache-second-visit-sort-enabled', detail: 'expected sort headers to be enabled immediately on a fully cache-hydrated second visit' });
    }
    const secondStatus = await page.evaluate(() => document.querySelector('.following-status')?.textContent || '');
    if (secondStatus !== expectedSettled) {
      violations.push({ check: 'following-cache-second-visit-status', detail: `expected settled status "${expectedSettled}" on the cache-hydrated second visit, got "${secondStatus}"` });
    }
    if (browseCallCount !== browseCallCountAfterFirstLoad) {
      violations.push({ check: 'following-cache-second-visit-no-refetch', detail: `expected 0 additional browse requests on the cache-hydrated second visit, saw ${browseCallCount - browseCallCountAfterFirstLoad}` });
    }
  } finally {
    await context.close();
  }
  return violations;
}

// Root cause of the "Subscribe button doesn't reflect real state" bug: both
// the channel page and the watch page derived subscribe state from
// readSubscribedState(), which only understands the legacy
// subscribeButtonRenderer / subscribeButtonViewModel payload shapes and
// misses YouTube's modern subscribe-button shape — so a channel you ARE
// subscribed to still rendered "Subscribe". The fix derives state from the
// guide (sidebar "SUBSCRIPTIONS") cache instead, since that's the one signal
// that's actually correct, falling back to readSubscribedState() only while
// the guide hasn't loaded yet. This mocks the guide (same signed-in +
// context.route mechanism as checkFollowingPage, armed before the page loads
// since the guide fetch fires unconditionally at boot) to include one fixed
// channel, and asserts /channel/<that id> renders "Subscribed" while a
// channel absent from the guide still renders plain "Subscribe".
const CHANNEL_SUB_STATE_IN_GUIDE_ID = 'UCFlytSubStateInGd1';
const CHANNEL_SUB_STATE_NOT_GUIDE_ID = 'UCFlytSubStateNotGd1';

function channelSubStateGuideFixture() {
  return {
    items: [{
      guideSectionRenderer: {
        items: [{
          guideEntryRenderer: {
            navigationEndpoint: { browseEndpoint: { browseId: CHANNEL_SUB_STATE_IN_GUIDE_ID } },
            formattedTitle: { simpleText: 'Guide Sub Channel' },
            thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${CHANNEL_SUB_STATE_IN_GUIDE_ID}.jpg`, width: 88, height: 88 }] },
          },
        }],
      },
    }],
  };
}

function channelSubStateBrowseFixture(title) {
  return {
    header: {
      c4TabbedHeaderRenderer: {
        title,
        subscriberCountText: { simpleText: '1K subscribers' },
        videosCountText: { simpleText: '10 videos' },
      },
    },
  };
}

async function checkChannelSubscribeState(browser) {
  const violations = [];
  const context = await newContext(browser);

  const guideRe = /\/youtubei\/v1\/guide/;
  const browseRe = /\/youtubei\/v1\/browse/;
  await context.route(guideRe, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(channelSubStateGuideFixture()),
  }));
  await context.route(browseRe, (route) => {
    let browseId = null;
    try {
      const body = JSON.parse(route.request().postData() || '{}');
      browseId = body.browseId;
    } catch (e) {
      // fall through — not JSON we understand, let it hit the network
    }
    if (browseId === CHANNEL_SUB_STATE_IN_GUIDE_ID) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(channelSubStateBrowseFixture('Guide Sub Channel')) });
    }
    if (browseId === CHANNEL_SUB_STATE_NOT_GUIDE_ID) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(channelSubStateBrowseFixture('Not In Guide Channel')) });
    }
    return route.continue();
  });

  const { page } = await openPage(context, HOME_URL);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => { if (window.ytcfg && window.ytcfg.data_) window.ytcfg.data_.LOGGED_IN = true; });

  try {
    const navTo = async (browseId) => {
      const href = '/channel/' + browseId;
      await page.evaluate((h) => {
        let a = document.getElementById('itube-test-channel-sub-link');
        if (!a) {
          a = document.createElement('a');
          a.id = 'itube-test-channel-sub-link';
          a.style.position = 'fixed';
          a.style.left = '0';
          a.style.bottom = '0';
          a.style.zIndex = '99999';
          document.querySelector('#itube').appendChild(a);
        }
        a.href = h;
        a.textContent = 'test channel link';
      }, href);
      await page.click('#itube-test-channel-sub-link');
      await page.waitForFunction((want) => location.pathname === want, href, { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('.ch-header .watch-subscribe', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
    };

    const readSubBtn = () => page.evaluate(() => {
      const btn = document.querySelector('.ch-header .watch-subscribe');
      return btn ? { subscribedClass: btn.classList.contains('subscribed'), text: btn.textContent.trim() } : null;
    });

    await navTo(CHANNEL_SUB_STATE_IN_GUIDE_ID);
    const inGuide = await readSubBtn();
    if (!inGuide) {
      violations.push({ check: 'channel-subscribe-button-exists', detail: 'expected a .ch-header .watch-subscribe button on the channel page' });
    } else if (!inGuide.subscribedClass || inGuide.text !== 'Subscribed') {
      violations.push({ check: 'channel-subscribe-state-in-guide', detail: `expected a channel present in the guide (subscriptions) cache to render "Subscribed", got subscribedClass=${inGuide.subscribedClass} text="${inGuide.text}" — readSubscribedState() alone misses YouTube's modern subscribe-button shape and must fall back to the guide cache` });
    }

    await navTo(CHANNEL_SUB_STATE_NOT_GUIDE_ID);
    const notInGuide = await readSubBtn();
    if (!notInGuide) {
      violations.push({ check: 'channel-subscribe-button-exists-2', detail: 'expected a .ch-header .watch-subscribe button on the second channel page' });
    } else if (notInGuide.subscribedClass || notInGuide.text !== 'Subscribe') {
      violations.push({ check: 'channel-subscribe-state-not-in-guide', detail: `expected a channel absent from the guide cache to render plain "Subscribe", got subscribedClass=${notInGuide.subscribedClass} text="${notInGuide.text}"` });
    }
  } finally {
    await page.evaluate(() => document.getElementById('itube-test-channel-sub-link')?.remove()).catch(() => {});
    await context.close();
  }
  return violations;
}

// Same bug, watch-page half: the "next" response for a real live video embeds
// the real owner channel; this mocks ONLY the guide (armed before the hard
// navigation, since the guide fetch fires unconditionally at boot) to include
// that video's real owner channel ID, so the sole variable is whether the
// subscribe button reads state off the guide cache instead of the
// (here, deliberately absent-shape) subscribeButtonRenderer/ViewModel.
const WATCH_SUB_STATE_VIDEO_ID = 'aircAruvnKk';

async function checkWatchSubscribeState(browser) {
  const violations = [];
  const context = await newContext(browser);
  const watchUrl = 'https://www.youtube.com/watch?v=' + WATCH_SUB_STATE_VIDEO_ID;

  try {
    // First, an unmocked load to discover the video's real owner channel ID
    // out of window.ytInitialData — the "next" data is embedded in the
    // initial page HTML, not fetched, so it can't be intercepted directly.
    const { page: discoverPage } = await openPage(context, watchUrl);
    await waitForApp(discoverPage, { timeout: 30000 }).catch(() => {});
    await discoverPage.waitForSelector('.watch-subscribe', { timeout: 20000 }).catch(() => {});
    const ownerChannelId = await discoverPage.evaluate(() => {
      const walk = (node, visit) => {
        if (!node || typeof node !== 'object') return;
        visit(node);
        if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
        for (const key in node) { if (Object.prototype.hasOwnProperty.call(node, key)) walk(node[key], visit); }
      };
      let found = null;
      walk(window.ytInitialData, (n) => {
        if (found) return;
        const owner = n?.videoOwnerRenderer;
        const id = owner?.navigationEndpoint?.browseEndpoint?.browseId;
        if (typeof id === 'string' && id.startsWith('UC')) found = id;
      });
      return found || window.ytInitialPlayerResponse?.videoDetails?.channelId || null;
    });
    await discoverPage.close();
    if (!ownerChannelId) {
      console.log('  watch-subscribe-state: SKIP — could not discover the fixture video\'s owner channel ID from ytInitialData');
      return violations;
    }

    const guideRe = /\/youtubei\/v1\/guide/;
    await context.route(guideRe, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          guideSectionRenderer: {
            items: [{
              guideEntryRenderer: {
                navigationEndpoint: { browseEndpoint: { browseId: ownerChannelId } },
                formattedTitle: { simpleText: 'Watch Owner Channel' },
                thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${ownerChannelId}.jpg`, width: 88, height: 88 }] },
              },
            }],
          },
        }],
      }),
    }));

    const { page } = await openPage(context, watchUrl);
    try {
      await waitForApp(page, { timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => {
        const b = document.querySelector('.watch-subscribe');
        return b && !b.disabled;
      }, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => {
        const btn = document.querySelector('.watch-subscribe');
        return btn ? { subscribedClass: btn.classList.contains('subscribed'), text: btn.textContent.trim() } : null;
      });
      if (!state) {
        violations.push({ check: 'watch-subscribe-button-exists', detail: 'expected a usable .watch-subscribe on the watch page' });
      } else if (!state.subscribedClass || state.text !== 'Subscribed') {
        violations.push({ check: 'watch-subscribe-state', detail: `expected the watch page's subscribe button to read "Subscribed" when its owner channel is present in the guide (subscriptions) cache, got subscribedClass=${state.subscribedClass} text="${state.text}" — readSubscribedState() alone misses YouTube's modern subscribe-button shape and must fall back to the guide cache` });
      }
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
  return violations;
}

module.exports = {
  runWatchFunctional,
  checkThumbFlyAnimation,
  checkAbLoop,
  checkFrameExport,
  checkTheaterMode,
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
  checkSettings,
  checkCommandPalette,
  checkHoverStates,
  checkItubeToggle,
  checkSubscribeConfirmsOnPopup,
  checkWatchMetaReveals,
  checkDislikeEstimate,
  checkDislikesOptOut,
  checkSponsorBlock,
  checkSponsorBlockDisabled,
  checkColdLoadSkeleton,
  checkBootLoaderColdLoad,
  checkBootLoaderFeedColdLoad,
  checkBootLoaderReducedMotion,
  checkBootLoaderNoSpaReappear,
  checkYtdAppHidden,
  checkWatchToWatchNavigation,
  checkHomeNavigation,
  checkMiniPlayer,
  checkMiniExpandSeamless,
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
  checkWatchResponsive,
  checkNoScrollWatch,
  checkWatchPopups,
  checkCommentsSortVisibility,
  checkDescriptionChips,
  checkAudioTrackSelector,
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
  checkFeedFilter,
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
  checkChannelSubscribeState,
  checkWatchSubscribeState,
};
