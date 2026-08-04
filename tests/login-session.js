// Opens a real, headed Chrome with a persistent profile so the user can log
// into YouTube BY HAND (no Flyt injected, nothing automated about the login —
// the script never touches or sees credentials). It just polls for the
// SAPISID session cookie and exits once the user is signed in; the profile
// under tests/.yt-profile (gitignored) is then reused by diagnosis runs.
'use strict';

const path = require('path');
const { chromium } = require('playwright');

const PROFILE = path.join(__dirname, '.yt-profile');

(async () => {
  let context;
  const opts = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  // Prefer the real installed Chrome — Google blocks logins from browsers it
  // deems "not secure", and stock Playwright Chromium often trips that.
  try {
    context = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'chrome' });
  } catch (e) {
    context = await chromium.launchPersistentContext(PROFILE, opts);
  }

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('Browser is open. Log into YouTube in that window.');
  console.log('Waiting for sign-in (checks every 3s, up to 10 minutes)…');

  const deadline = Date.now() + 10 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://www.youtube.com').catch(() => []);
    if (cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) { loggedIn = true; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (loggedIn) {
    console.log('LOGGED IN — session saved to tests/.yt-profile. Closing the browser.');
  } else {
    console.log('TIMED OUT waiting for login (10 min). Run again when ready.');
  }
  await context.close();
  process.exit(loggedIn ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
