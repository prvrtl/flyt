// Diagnoses the logged-in "space pauses then resumes" bug on a REAL signed-in
// session (profile from login-session.js). Instruments every path that can
// start/stop playback with timestamped call stacks, presses Space with
// trusted input, and reports exactly what resumed the video and from where.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = path.join(__dirname, '.yt-profile');
const SCRIPT_PATH = path.join(__dirname, '..', 'flyt.user.js');
const WATCH = process.env.WATCH_URL || 'https://www.youtube.com/watch?v=aircAruvnKk';

(async () => {
  const opts = {
    headless: false,   // headed: mirrors the user's real environment
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'chrome' });
  } catch (e) {
    context = await chromium.launchPersistentContext(PROFILE, opts);
  }

  // 1) Instrumentation FIRST (before YouTube and before Flyt): stamp every
  //    media play/pause with time + stack.
  await context.addInitScript(() => {
    const log = window.__avLog = [];
    const t0 = Date.now();
    const stamp = (kind) => log.push({ t: Date.now() - t0, kind, stack: new Error().stack.split('\n').slice(2, 8).join(' | ') });
    const origPlay = HTMLMediaElement.prototype.play;
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) { stamp('el.play'); return origPlay.apply(this, a); };
    HTMLMediaElement.prototype.pause = function (...a) { stamp('el.pause'); return origPause.apply(this, a); };
    // Patch the player API methods once #movie_player exists.
    const patchPlayer = setInterval(() => {
      const p = document.getElementById('movie_player');
      if (!p || typeof p.playVideo !== 'function' || p.__avPatched) return;
      p.__avPatched = true;
      clearInterval(patchPlayer);
      for (const m of ['playVideo', 'pauseVideo']) {
        const orig = p[m].bind(p);
        p[m] = (...a) => { stamp('api.' + m); return orig(...a); };
      }
    }, 100);
    // Record space keydowns as seen at window capture AND document capture,
    // to prove where the event travels.
    window.addEventListener('keydown', (e) => { if (e.key === ' ') stamp('key.window(trusted=' + e.isTrusted + ')'); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === ' ') stamp('key.document'); }, true);
  });

  // 2) Flyt, guarded to youtube.com like a real userscript manager would.
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });

  const page = context.pages()[0] || await context.newPage();
  page.on('console', (msg) => { const t = msg.text(); if (/\[(flyt|itube)\]/i.test(t)) console.log('  console:', t); });

  await page.goto(WATCH, { waitUntil: 'domcontentloaded' });

  // Confirm we are actually logged in.
  await page.waitForTimeout(4000);
  const loggedIn = await page.evaluate(() => document.cookie.includes('SAPISID') || !!window.ytcfg?.data_?.LOGGED_IN);
  const flytMounted = await page.evaluate(() => !!document.getElementById('itube'));
  console.log('logged in:', loggedIn, '| Flyt mounted:', flytMounted);

  // Wait for real playback.
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video') || document.querySelector('video');
    return v && !v.paused && v.currentTime > 3 && v.readyState >= 3;
  }, { timeout: 45000 });
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__avLog.length = 0; });

  console.log('\n>>> pressing SPACE (trusted) …');
  await page.keyboard.press(' ');

  // Sample the paused state for 6s at 100ms.
  const timeline = [];
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const s = await page.evaluate(() => {
      const v = document.querySelector('#itube-stage video') || document.querySelector('video');
      const p = document.getElementById('movie_player');
      return { paused: v ? v.paused : null, t: v ? +v.currentTime.toFixed(2) : null, ps: p && p.getPlayerState ? p.getPlayerState() : null };
    });
    timeline.push(s);
  }

  const everPaused = timeline.some((s) => s.paused);
  const endsPlaying = !timeline[timeline.length - 1].paused;
  const resumed = everPaused && endsPlaying;
  console.log('paused at any point:', everPaused, '| still playing at end:', endsPlaying, '=>', resumed ? 'BUG REPRODUCED' : (everPaused ? 'PAUSE HELD' : 'NEVER PAUSED'));
  const transitions = [];
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].paused !== timeline[i - 1].paused) transitions.push(`${i * 100}ms: paused ${timeline[i - 1].paused} -> ${timeline[i].paused} (ps=${timeline[i].ps})`);
  }
  console.log('state transitions:', transitions.length ? '' : '(none)');
  transitions.forEach((t) => console.log('  ' + t));

  console.log('\n=== play/pause call log (with stacks) ===');
  const avLog = await page.evaluate(() => window.__avLog);
  for (const e of avLog.slice(0, 60)) {
    console.log(`  +${String(e.t).padStart(5)}ms  ${e.kind}`);
    if (e.stack && /play/i.test(e.kind)) console.log('      ' + e.stack);
  }

  await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
