'use strict';
// Verify: with the in-script telemetry stub, (a) NO qoe/log_event/ads request
// leaves the browser, (b) watchtime still allowed, (c) playback + space fine.
const fs = require('fs');
const path = require('path');
const { webkit } = require('playwright');
const { CONSENT_COOKIES } = require('./lib/harness');
(async () => {
  const browser = await webkit.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  const seen = { blockedClass: 0, watchtime: 0 };
  context.on('request', (req) => {
    const u = req.url();
    if (/\/api\/stats\/(qoe|atr|ads)|youtubei\/v1\/log_event|doubleclick\.net\/|\/pagead\//.test(u)) { seen.blockedClass++; console.log('  LEAKED:', u.slice(0, 90)); }
    if (/\/api\/stats\/watchtime/.test(u)) seen.watchtime++;
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const v = document.querySelector('#itube-stage video'); return v && !v.paused && v.currentTime > 5; }, { timeout: 60000 });
  await page.waitForTimeout(8000); // let beacons fire
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(' ');
  await page.waitForTimeout(2500);
  const paused = await page.evaluate(() => document.querySelector('#itube-stage video').paused);
  console.log('telemetry-class requests that left the browser:', seen.blockedClass);
  console.log('watchtime requests (must still flow):', seen.watchtime);
  console.log('space pause held:', paused);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
