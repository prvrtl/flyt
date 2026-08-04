// One-off: re-capture the landing-page screenshots against the current Flyt
// build (the committed shots still show the old "iTube" wordmark). Uses the
// same document-start injection the test harness uses, logged out, default
// prefs (green accent), 1440x900. Screenshots to PNG then converts to .webp
// with cwebp so the docs/shots/*.webp filenames stay identical.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchBrowser, openPage, waitForApp, SCRIPT_PATH, CONSENT_COOKIES } = require('./lib/harness');

const OUT = path.join(__dirname, '..', 'docs', 'shots');
const TMP = process.env.SCRATCH || '/tmp';
const WATCH = 'https://www.youtube.com/watch?v=aircAruvnKk&hl=en&gl=US';  // 3Blue1Brown — "But what is a neural network?"
const SEARCH = 'https://www.youtube.com/results?search_query=3blue1brown&hl=en&gl=US';

// The test harness's newContext() doesn't pin a language; the headless box's
// geo-IP made YouTube serve German. Force en-US so the landing shots read in
// English, then replicate newContext()'s consent-cookie + document-start inject.
const newEnglishContext = async (browser) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await context.addCookies(CONSENT_COOKIES);
  await context.addInitScript({ content: fs.readFileSync(SCRIPT_PATH, 'utf8') });
  return context;
};

const cwebp = (name) => {
  const png = path.join(TMP, name + '.png');
  const webp = path.join(OUT, name + '.webp');
  execFileSync('cwebp', ['-q', '82', png, '-o', webp], { stdio: 'ignore' });
  const kb = (fs.statSync(webp).size / 1024).toFixed(1);
  console.log(`  ✓ ${name}.webp (${kb} KB)`);
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(TMP, name + '.png') });
  cwebp(name);
};

// Freeze the borrowed player on a clean, decoded frame (matches the old shots'
// ~0:30). Direct video.currentTime doesn't stick — Flyt drives YouTube's
// player as the engine — so use the player API: seek just before the target,
// let it play to the target so a real frame decodes, then pause.
const freezeVideo = async (page) => {
  await page.waitForFunction(() => {
    const p = document.querySelector('#movie_player');
    const v = document.querySelector('video');
    return p && typeof p.seekTo === 'function' && v && v.duration > 0;
  }, { timeout: 20000 });
  await page.evaluate(() => {
    const p = document.querySelector('#movie_player');
    p.seekTo(28, true);
    p.playVideo();
  });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.currentTime >= 30 && v.readyState >= 2;
  }, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#movie_player').pauseVideo());
  await page.waitForTimeout(600);
};

(async () => {
  const browser = await launchBrowser();
  const context = await newEnglishContext(browser);

  // ---- watch-page shots (one page, state driven between captures) ----
  console.log('watch page:', WATCH);
  const { page } = await openPage(context, WATCH);
  await waitForApp(page);
  await freezeVideo(page);

  // 1. default watch page (Up next rail)
  await shot(page, 'watch-closed');

  // 2. Comments tab
  await page.click('#itube-rail-tab-comments');
  await page.waitForSelector('.comment-row', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, 'watch-comments');
  // back to Up next for the remaining shots
  await page.click('#itube-rail-tab-upnext');
  await page.waitForTimeout(300);

  // 3. Description popup
  await page.waitForSelector('button[aria-label="Description"]', { state: 'visible', timeout: 15000 });
  await page.click('button[aria-label="Description"]');
  await page.waitForTimeout(500);
  await shot(page, 'watch-description');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 4. Command palette (Ctrl/Cmd-K)
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  await shot(page, 'command-palette');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 5. Settings panel
  await page.click('.nav-settings');
  await page.waitForTimeout(500);
  await shot(page, 'settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 6. Theater mode (last — toggles layout + a persisted pref). The 't'
  // shortcut is ignored while a button outside #itube-bar holds focus (the
  // Settings nav row still did, after we closed the panel) — so blur first,
  // which drops the key target to <body> and lets the shortcut through.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('t');
  await page.waitForSelector('#itube.theater', { timeout: 5000 });
  await page.waitForTimeout(700);
  await shot(page, 'watch-theater');
  await page.close();

  // ---- search results ----
  console.log('search page:', SEARCH);
  const { page: sp } = await openPage(context, SEARCH);
  await waitForApp(sp);
  await sp.waitForTimeout(800);
  await shot(sp, 'search-grid');
  await sp.close();

  await browser.close();
  console.log('done.');
})().catch((e) => { console.error(e); process.exit(1); });
