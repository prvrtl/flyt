'use strict';
// WebKit + simulated content blocker (AdGuard/1Blocker-style): abort the same
// requests the user's Safari blocks, then test whether a Space pause holds.
const fs = require('fs');
const path = require('path');
const { webkit } = require('playwright');
const { CONSENT_COOKIES } = require('./lib/harness');
(async () => {
  const browser = await webkit.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(CONSENT_COOKIES);
  // Simulate the blocker.
  await context.route(/api\/stats\/qoe|api\/stats\/atr|doubleclick\.net|googleads|\/pagead\/|ptracking|log_event/, (route) => route.abort());
  const src = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && !v.paused && v.currentTime > 3 && v.readyState >= 3;
  }, { timeout: 60000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  console.log('>>> SPACE (WebKit + blocker)');
  await page.keyboard.press(' ');
  const timeline = [];
  for (let i = 0; i < 60; i++) { await page.waitForTimeout(100); timeline.push(await page.evaluate(() => document.querySelector('#itube-stage video').paused)); }
  const everPaused = timeline.some(Boolean), endsPlaying = !timeline[timeline.length - 1];
  const transitions = [];
  for (let i = 1; i < timeline.length; i++) if (timeline[i] !== timeline[i - 1]) transitions.push(`${i * 100}ms ${timeline[i - 1]}->${timeline[i]}`);
  console.log('everPaused:', everPaused, '| endsPlaying:', endsPlaying, '=>', everPaused && endsPlaying ? 'BUG REPRODUCED (blocker interaction)' : (everPaused ? 'PAUSE HELD' : 'NEVER PAUSED'));
  transitions.forEach((t) => console.log('  ', t));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
