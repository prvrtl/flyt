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
    const log = window.__log = [];
    const t0 = Date.now();
    const stamp = (kind) => log.push(`${Date.now() - t0}ms ${kind}`);
    const oP = HTMLMediaElement.prototype.play, oQ = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) { stamp('el.play'); return oP.apply(this, a); };
    HTMLMediaElement.prototype.pause = function (...a) { stamp('el.pause'); return oQ.apply(this, a); };
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const v = document.querySelector('#itube-stage video'); return v && !v.paused && v.currentTime > 3; }, { timeout: 60000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  const s1 = await page.evaluate(() => {
    const v = document.querySelector('#itube-stage video');
    // does the video have a 'play' listener that will fire? test via one-shot dispatch check below
    window.__log.push('--- after space: paused=' + v.paused + ' ---');
    return v.paused;
  });
  await page.evaluate(() => { window.__log.push('--- calling playVideo() ---'); document.getElementById('movie_player').playVideo(); });
  await page.waitForTimeout(800);
  const out = await page.evaluate(() => ({
    paused: document.querySelector('#itube-stage video').paused,
    sameEl: document.querySelector('#itube-stage video') === (window.__el || null),
    log: window.__log.slice(-15),
  }));
  console.log('pausedAfterSpace:', s1, '| pausedAfterPlayVideo:', out.paused);
  out.log.forEach((l) => console.log('  ', l));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
