'use strict';
// Space repro on WEBKIT — the user is on Safari, everything so far verified
// Chrome only. Instrumented like space-diagnose: stacks for every play/pause.
const fs = require('fs');
const path = require('path');
const { webkit } = require('playwright');
const { CONSENT_COOKIES } = require('./lib/harness');

(async () => {
  const browser = await webkit.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  await context.addInitScript(() => {
    const log = window.__avLog = [];
    const t0 = Date.now();
    const stamp = (kind) => log.push({ t: Date.now() - t0, kind, stack: (new Error().stack || '').split('\n').slice(1, 7).join(' | ') });
    const origPlay = HTMLMediaElement.prototype.play;
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) { stamp('el.play'); return origPlay.apply(this, a); };
    HTMLMediaElement.prototype.pause = function (...a) { stamp('el.pause'); return origPause.apply(this, a); };
    window.addEventListener('keydown', (e) => { if (e.key === ' ') stamp('key.window(trusted=' + e.isTrusted + ')'); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === ' ') stamp('key.document'); }, true);
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });
  const page = await context.newPage();
  page.on('console', (m) => { const t = m.text(); if (/\[(flyt|itube)\]/i.test(t)) console.log('  console:', t); });
  page.on('pageerror', (e) => console.log('  PAGEERROR:', String(e).slice(0, 200)));
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video') || document.querySelector('video');
    return v && !v.paused && v.currentTime > 3 && v.readyState >= 3;
  }, { timeout: 60000 });
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__avLog.length = 0; });
  console.log('>>> SPACE (trusted, WebKit)');
  await page.keyboard.press(' ');
  const timeline = [];
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    timeline.push(await page.evaluate(() => { const v = document.querySelector('#itube-stage video') || document.querySelector('video'); return v.paused; }));
  }
  const everPaused = timeline.some(Boolean);
  const endsPlaying = !timeline[timeline.length - 1];
  console.log('everPaused:', everPaused, '| endsPlaying:', endsPlaying, '=>', everPaused && endsPlaying ? 'BUG REPRODUCED ON WEBKIT' : (everPaused ? 'PAUSE HELD' : 'NEVER PAUSED'));
  const transitions = [];
  for (let i = 1; i < timeline.length; i++) if (timeline[i] !== timeline[i - 1]) transitions.push(`${i * 100}ms: ${timeline[i - 1]} -> ${timeline[i]}`);
  transitions.forEach((t) => console.log('  transition', t));
  const avLog = await page.evaluate(() => window.__avLog);
  console.log('=== call log ===');
  for (const e of avLog.slice(0, 40)) {
    console.log(`  +${String(e.t).padStart(5)}ms  ${e.kind}`);
    if (/play/.test(e.kind) && e.stack) console.log('      ' + e.stack.slice(0, 400));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
