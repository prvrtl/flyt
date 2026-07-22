// Shared Playwright harness: launches a real Chromium session with the Flyt
// userscript injected exactly the way a userscript manager would run it
// (document-start, before any YouTube JS executes), and logged-out consent
// cookies pre-set so YouTube doesn't show a consent interstitial.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium, webkit } = require('playwright');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'flyt.user.js');

// Consent cookies copied from a working logged-out YouTube session. Without
// these, youtube.com redirects to a consent.youtube.com interstitial and the
// page under test is never youtube.com at all.
const CONSENT_COOKIES = [
  {
    name: 'SOCS',
    value: 'CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNjExLjA2X3AwGgJlbiADGgYIgO7ItgY',
    domain: '.youtube.com',
    path: '/',
  },
  {
    name: 'CONSENT',
    value: 'YES+cb',
    domain: '.youtube.com',
    path: '/',
  },
];

// WebKit is the DEFAULT engine: the app's primary user runs Safari, and a
// string of bugs reproduced only there while every Chromium run stayed green.
// Set FLYT_BROWSER=chromium for the old engine (e.g. to bisect an engine
// difference), HEADED=1 to watch either one.
async function launchBrowser() {
  if ((process.env.FLYT_BROWSER || 'webkit') === 'chromium') {
    return chromium.launch({
      headless: !process.env.HEADED,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
  }
  return webkit.launch({ headless: !process.env.HEADED });
}

async function newContext(browser, { viewport = { width: 1440, height: 900 }, prefs = null } = {}) {
  // serviceWorkers: 'block' — on WebKit, youtube.com's service worker mediates
  // fetches and page.route() never sees them (mocked-endpoint checks silently
  // hit the real network). Chromium's interception hid this; blocking SWs
  // makes route mocks deterministic on both engines.
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addCookies(CONSENT_COOKIES);

  // Seed localStorage prefs (if requested) before the userscript's own
  // init script runs, so it sees them from the very first read.
  if (prefs) {
    await context.addInitScript((p) => {
      try { for (const k in p) localStorage.setItem(k, p[k]); } catch (e) {}
    }, prefs);
  }

  // Inject the userscript at document-start, i.e. before any page script
  // runs — this is the one thing that must match how a real userscript
  // manager (Tampermonkey/Violentmonkey) executes @run-at document-start.
  const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await context.addInitScript({ content: scriptSource });

  return context;
}

// Open `url` in a fresh page inside `context`. Error collectors are wired up
// BEFORE navigation so nothing that happens during document-start script
// execution is missed. Returns { page, errors }. Does NOT wait for the app
// to mount — callers should follow up with waitForApp().
//
// The live site occasionally stalls a `domcontentloaded` navigation past
// Playwright's default 30s (network hiccup, not a regression in the app), so
// the goto itself gets up to 2 retries. This is narrowly scoped to the
// navigation only — waitForApp() is deliberately NOT retried here, since a
// timeout there means the app failed to mount on a page that DID load, which
// must keep failing loudly rather than being papered over by a retry loop.
async function openPage(context, url) {
  const page = await context.newPage();
  const errors = collectErrors(page);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!/Timeout/i.test(String(err && err.message))) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return { page, errors };
}

// Wait until #itube has actually been populated with content, i.e. the
// route() function has mounted a page body (grid/watch/feed/etc), not just
// the empty shell. Distinct pages settle on different children, so we just
// wait for #itube .content to contain at least one element OR #itube-stage
// to exist (watch pages).
async function waitForApp(page, { timeout = 20000 } = {}) {
  await page.waitForSelector('#itube', { timeout });
  await page.waitForFunction(
    () => {
      const itube = document.querySelector('#itube');
      if (!itube) return false;
      const content = itube.querySelector('.content');
      if (!content) return false;
      if (content.querySelector('#itube-stage')) return true;
      return content.querySelector('.view') ? content.querySelector('.view').children.length > 0 : content.children.length > 0;
    },
    { timeout }
  );
  // Let thumbnails/lazy content settle a moment.
  await page.waitForTimeout(300);
}

// Attach error/console collectors BEFORE navigation so nothing is missed.
// Returns an object with .pageErrors, .consoleErrors (both arrays, live) and
// a .dispose() no-op for symmetry (Playwright listeners are cleaned up when
// the page closes).
function collectErrors(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(String(err && err.stack ? err.stack : err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

module.exports = {
  SCRIPT_PATH,
  CONSENT_COOKIES,
  launchBrowser,
  newContext,
  openPage,
  waitForApp,
  collectErrors,
};
