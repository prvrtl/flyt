'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const PROFILE = path.join(__dirname, '.yt-profile');
(async () => {
  const opts = { headless: false, viewport: { width: 1440, height: 900 }, args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--enable-automation'] };
  let context;
  try { context = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'chrome' }); } catch (e) { context = await chromium.launchPersistentContext(PROFILE, opts); }
  // OLD copy first (installed earlier = usually runs earlier), then CURRENT.
  const oldSrc = fs.readFileSync('/tmp/flyt-old-0.0.14.js', 'utf8');
  const newSrc = fs.readFileSync(path.join(__dirname, '..', 'flyt.user.js'), 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${oldSrc}\n}` });
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${newSrc}\n}` });
  const page = context.pages()[0] || await context.newPage();
  page.on('console', (m) => { const t = m.text(); if (/\[(flyt|itube)\]/i.test(t)) console.log('  console:', t); });
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const v = document.querySelector('#itube-stage video'); return v && !v.paused && v.currentTime > 3; }, { timeout: 45000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  console.log('>>> SPACE');
  await page.keyboard.press(' ');
  const timeline = [];
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(100); timeline.push(await page.evaluate(() => document.querySelector('#itube-stage video')?.paused)); }
  const everPaused = timeline.some(Boolean), endsPlaying = !timeline[timeline.length - 1];
  console.log('everPaused:', everPaused, '| endsPlaying:', endsPlaying, '=>', everPaused && endsPlaying ? 'DUAL-COPY BUG REPRODUCED' : (everPaused ? 'PAUSE HELD' : 'NEVER PAUSED'));
  await context.close();
})().catch(e => { console.error(e); process.exit(1); });
