// Logged-in verification pass: reuses the manual-login profile
// (tests/.yt-profile) and walks every page Flyt renders, asserting the
// signed-in state actually reaches the UI. STRICTLY READ-ONLY — nothing here
// clicks subscribe/like/save/post; it only loads pages and reads state.
// Screenshots land in the dir given by SHOTS (or /tmp).
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = path.join(__dirname, '.yt-profile');
const SCRIPT_PATH = path.join(__dirname, '..', 'flyt.user.js');
const SHOTS = process.env.SHOTS || '/tmp';
const WATCH = 'https://www.youtube.com/watch?v=aircAruvnKk';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const opts = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context;
  try { context = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'chrome' }); }
  catch (e) { context = await chromium.launchPersistentContext(PROFILE, opts); }

  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await context.addInitScript({ content: `if (location.hostname === 'www.youtube.com') {\n${src}\n}` });

  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err).slice(0, 200)));

  const shoot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const waitApp = async () => {
    await page.waitForSelector('#itube', { timeout: 20000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('#itube .content');
      if (!c) return false;
      if (c.querySelector('#itube-stage')) return true;
      const v = c.querySelector('.view');
      return v ? v.children.length > 0 : c.children.length > 0;
    }, { timeout: 25000 });
    await page.waitForTimeout(1200);
  };

  // ---------- HOME ----------
  console.log('\n[home]');
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await waitApp();
  const home = await page.evaluate(() => ({
    cards: document.querySelectorAll('#itube .c').length,
    resume: document.querySelectorAll('#itube .cw-row .c, #itube .resume .c').length,
    signinPrompt: !!document.querySelector('#itube .signin-state'),
    sidebarSubs: document.querySelectorAll('#itube .nav-subs .nav-chan').length,
    avatarShown: !!document.querySelector('#itube .hd-avatar img[src]'),
    signinBtnVisible: (() => { const b = document.querySelector('#itube .hd-signin'); return !!(b && b.offsetParent); })(),
  }));
  check('home renders personalized feed', home.cards > 5 && !home.signinPrompt, `${home.cards} cards`);
  check('sidebar shows subscriptions', home.sidebarSubs > 0, `${home.sidebarSubs} channels`);
  check('account avatar loaded (not Sign in)', home.avatarShown && !home.signinBtnVisible);
  await shoot('li-home');

  // account menu (open + close, read-only)
  await page.evaluate(() => document.querySelector('#itube .hd-avatar')?.click());
  await page.waitForTimeout(800);
  const acct = await page.evaluate(() => ({
    open: !!document.querySelector('#itube .acct-menu.open, #itube .acct-menu[style*="block"]') || (() => { const m = document.querySelector('#itube .acct-menu'); return !!(m && m.offsetParent); })(),
    name: document.querySelector('#itube .acct-name')?.textContent || '',
  }));
  check('account menu opens with account name', acct.open && acct.name.length > 0, JSON.stringify(acct.name));
  await shoot('li-account-menu');
  await page.keyboard.press('Escape');

  // ---------- SUBSCRIPTIONS FEED ----------
  console.log('\n[subscriptions]');
  await page.goto('https://www.youtube.com/feed/subscriptions', { waitUntil: 'domcontentloaded' });
  await waitApp();
  const subs = await page.evaluate(() => ({
    cards: document.querySelectorAll('#itube .c').length,
    signinPrompt: !!document.querySelector('#itube .signin-state'),
  }));
  check('subscriptions feed renders', subs.cards > 3 && !subs.signinPrompt, `${subs.cards} cards`);
  await shoot('li-subscriptions');

  // ---------- FOLLOWING ----------
  console.log('\n[following]');
  await page.goto('https://www.youtube.com/feed/channels', { waitUntil: 'domcontentloaded' });
  await waitApp();
  await page.waitForTimeout(4000); // let some enrichment land
  const following = await page.evaluate(() => ({
    rows: document.querySelectorAll('#itube .following-table tbody tr').length,
    status: document.querySelector('#itube .following-status')?.textContent || '',
    enrichedCells: document.querySelectorAll('#itube .following-table tbody td:nth-child(2)').length
      - document.querySelectorAll('#itube .following-table tbody td:nth-child(2) .following-skeleton').length,
  }));
  check('following table lists real subscriptions', following.rows > 0, `${following.rows} rows, status "${following.status.slice(0, 60)}"`);
  check('following enrichment progressing', following.enrichedCells > 0, `${following.enrichedCells} enriched`);
  await shoot('li-following');

  // ---------- WATCH ----------
  console.log('\n[watch]');
  await page.goto(WATCH, { waitUntil: 'domcontentloaded' });
  await waitApp();
  await page.waitForFunction(() => {
    const v = document.querySelector('#itube-stage video');
    return v && v.readyState >= 2;
  }, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const watch = await page.evaluate(() => {
    const sub = document.querySelector('#itube .watch-subscribe');
    const like = document.querySelector('#itube .watch-like-btn');
    return {
      subText: sub ? sub.textContent.trim() : null,
      subState: sub ? sub.classList.contains('subscribed') : null,
      likeDisabled: like ? like.disabled : null,
      likeCount: like ? like.textContent.trim() : '',
      signInHint: (() => { const h = document.querySelector('#itube .watch-signin-hint'); return !!(h && h.offsetParent); })(),
      related: document.querySelectorAll('#itube .rc').length,
      title: document.querySelector('#itube .watch-title, #itube .watch h1')?.textContent?.slice(0, 40) || '',
    };
  });
  check('watch page renders with meta', watch.title.length > 5 && watch.related > 3, `"${watch.title}" +${watch.related} related`);
  check('subscribe button reflects a real state', watch.subText === 'Subscribed' || watch.subText === 'Subscribe', `"${watch.subText}" (subscribed=${watch.subState})`);
  check('like button enabled logged-in, no sign-in hint', watch.likeDisabled === false && !watch.signInHint, `count="${watch.likeCount}"`);

  // comments logged-in
  await page.evaluate(() => document.getElementById('itube-rail-tab-comments')?.click());
  await page.waitForSelector('#itube .comment-row', { timeout: 20000 }).catch(() => {});
  const comments = await page.evaluate(() => document.querySelectorAll('#itube .comment-row').length);
  check('comments load logged-in', comments > 3, `${comments} rows`);
  await shoot('li-watch');

  // space pause holds (the fix, logged-in, end-to-end)
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.evaluate(() => { const v = document.querySelector('#itube-stage video'); if (v && v.paused) v.play(); });
  await page.waitForTimeout(600);
  await page.keyboard.press(' ');
  await page.waitForTimeout(2500);
  const pauseHeld = await page.evaluate(() => document.querySelector('#itube-stage video').paused);
  check('space pause holds for 2.5s (logged-in)', pauseHeld === true);

  // ---------- WATCH LATER + HISTORY ----------
  console.log('\n[watch later / history]');
  await page.goto('https://www.youtube.com/playlist?list=WL', { waitUntil: 'domcontentloaded' });
  await waitApp().catch(() => {});
  const wl = await page.evaluate(() => ({
    items: document.querySelectorAll('#itube .c, #itube .row').length,
    empty: !!document.querySelector('#itube .empty'),
    unhandled: !!document.querySelector('#itube .unhandled-home'),
  }));
  check('watch later page renders', (wl.items > 0 || wl.empty) && !wl.unhandled, `${wl.items} items, empty=${wl.empty}, unhandled=${wl.unhandled}`);
  await shoot('li-watch-later');

  await page.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
  await waitApp().catch(() => {});
  const hist = await page.evaluate(() => ({
    items: document.querySelectorAll('#itube .c, #itube .row').length,
    empty: !!document.querySelector('#itube .empty'),
  }));
  check('history renders', hist.items > 0 || hist.empty, `${hist.items} items`);
  await shoot('li-history');

  // ---------- page errors ----------
  console.log('\n[errors]');
  check('no page errors across the pass', errors.length === 0, errors.slice(0, 3).join(' ; '));

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - fails}/${results.length} pass ===`);
  await context.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
