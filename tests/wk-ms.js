'use strict';
const fs = require('fs');
const path = require('path');
const { webkit } = require('playwright');
const { CONSENT_COOKIES } = require('./lib/harness');
(async () => {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  await context.addInitScript(() => {
    window.__msLog = [];
    const t0 = Date.now();
    if (navigator.mediaSession && navigator.mediaSession.setActionHandler) {
      const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => {
        window.__msLog.push(`${Date.now() - t0}ms register ${action} ${handler ? 'fn' : 'null'}`);
        return orig(action, handler ? (...a) => { window.__msLog.push(`${Date.now() - t0}ms INVOKED ${action}`); return handler(...a); } : null);
      };
    }
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const v = document.querySelector('#itube-stage video'); return v && !v.paused && v.currentTime > 3; }, { timeout: 60000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  console.log('after space:', await page.evaluate(() => ({ paused: document.querySelector('#itube-stage video').paused, ...window.__flytWatchState() })));
  await page.evaluate(() => { window.__msLog.push('--- playVideo() ---'); document.getElementById('movie_player').playVideo(); });
  await page.waitForTimeout(700);
  console.log('after playVideo:', await page.evaluate(() => ({ paused: document.querySelector('#itube-stage video').paused, ...window.__flytWatchState() })));
  console.log('mediaSession log:');
  (await page.evaluate(() => window.__msLog.slice(-12))).forEach((l) => console.log('  ', l));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
