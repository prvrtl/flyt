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

async function newContext(browser, { viewport = { width: 1440, height: 900 }, prefs = null, colorScheme = undefined } = {}) {
  // serviceWorkers: 'block' — on WebKit, youtube.com's service worker mediates
  // fetches and page.route() never sees them (mocked-endpoint checks silently
  // hit the real network). Chromium's interception hid this; blocking SWs
  // makes route mocks deterministic on both engines.
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(colorScheme ? { colorScheme } : {}) });
  await context.addCookies(CONSENT_COOKIES);

  // Seed localStorage prefs (if requested) before the userscript's own
  // init script runs, so it sees them from the very first read.
  if (prefs) {
    await context.addInitScript((p) => {
      try { for (const k in p) localStorage.setItem(k, p[k]); } catch (e) {}
    }, prefs);
  }

  // Silence playback. The suite plays real videos on the live site and the
  // noise is unusable to sit next to, but the obvious mute is a trap: setting
  // video.muted or video.volume fires `volumechange`, which is the exact event
  // Flyt persists volume on, and an earlier attempt at it broke
  // volume-persistence (expected 42, got 95). Routing the element into a Web
  // Audio graph through a zero gain node produces no media-state change the
  // page can observe, so Flyt's own volume handling is untouched. Chromium
  // additionally gets --mute-audio at launch; WebKit has no equivalent flag,
  // which is why this exists at all. FLYT_SOUND=1 to hear the tests.
  // So `muted` is split in two: the real property is set true exactly once per
  // element, and the JS-visible one becomes a plain field that reports back
  // whatever the page last wrote. Neither Flyt nor YouTube can see the mute —
  // reads return their own value, and writes never reach the platform, so no
  // volumechange is ever generated on their behalf. Element volume, the
  // player's volume and the sliders all keep working on real values.
  if (!process.env.FLYT_SOUND) {
    await context.addInitScript(() => {
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      const real = proto && Object.getOwnPropertyDescriptor(proto, 'muted');
      if (!real || !real.set) return;
      // Once the property is redefined, getOwnPropertyDescriptor returns the
      // FAKE one, so there is no way to observe the platform flag from a test
      // without keeping a handle on the original accessor.
      window.__flytRealMuted = (el) => real.get.call(el);
      Object.defineProperty(proto, 'muted', {
        configurable: true,
        enumerable: true,
        get() { return !!this.__flytVisibleMuted; },
        set(v) { this.__flytVisibleMuted = !!v; },
      });
      // Media events do not bubble, but capture-phase listeners on document
      // still see them on the way down to the element.
      const silence = (el) => {
        try {
          if (!(el instanceof HTMLMediaElement)) return;
          if (!real.get.call(el)) real.set.call(el, true);
        } catch (e) {}
      };
      for (const type of ['loadedmetadata', 'loadeddata', 'play', 'playing', 'canplay']) {
        document.addEventListener(type, (e) => silence(e.target), true);
      }
      // A src assignment can reset the platform flag, so re-assert on the
      // events that follow one rather than trusting the first mute to stick.
      const reassert = setInterval(() => {
        for (const el of document.querySelectorAll('video, audio')) {
          try { if (!real.get.call(el)) real.set.call(el, true); } catch (e) {}
        }
      }, 500);
      window.addEventListener('pagehide', () => clearInterval(reassert));
    });
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
