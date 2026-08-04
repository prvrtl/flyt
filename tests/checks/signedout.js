// Signed-out honesty checks.
//
// The suite runs logged out, which is exactly the state these checks are about.
//
// The bug: the app had no concept of sign-in state at all (`grep LOGGED_IN` ->
// 0 hits). Every account-gated surface therefore rendered the app's generic
// empty state — "Nothing here yet." — which told a signed-out user that their
// history was EMPTY, that they had no subscriptions, that their Watch later was
// empty. None of that was true; they were simply not signed in. Worse, YouTube
// hands us the honest, localized copy in those very responses
// ("Sign in to see updates from your favorite YouTube channels") and the app
// threw it away. Watch later was the sharpest version: `browse` with VLWL
// returns HTTP 404, which the client maps to null, which the feed mount turned
// into "an empty playlist".
//
// So: no account-gated surface may say "Nothing here yet.", each must show a
// sign-in affordance, the header must expose a Sign in control, and the watch
// actions must not pretend a like/save/subscribe succeeded while logged out.
'use strict';

const { newContext, openPage, waitForApp } = require('../lib/harness');

// The string the app used to render on every one of these pages. Its presence
// on an account-gated surface IS the bug.
const EMPTY_LIE = 'Nothing here yet.';

// Account-gated surfaces. Watch later goes through the /playlist route (VLWL),
// which is the one that 404s rather than returning a sign-in message — it must
// still end up in the same signed-out state, not an "empty playlist".
const GATED_PAGES = {
  subscriptions: 'https://www.youtube.com/feed/subscriptions',
  history: 'https://www.youtube.com/feed/history',
  library: 'https://www.youtube.com/feed/library',
  watchlater: 'https://www.youtube.com/playlist?list=WL',
};

const WATCH_URL = 'https://www.youtube.com/watch?v=aircAruvnKk';
const HOME_URL = 'https://www.youtube.com/';

// Reads the signed-out state the app rendered: YouTube's own message (if any),
// the sign-in affordance, and whether the old lie is on screen.
async function readSignedOutState(page) {
  return page.evaluate((lie) => {
    const view = document.querySelector('#itube .content');
    const text = view ? view.textContent : '';
    const block = document.querySelector('.signin-state');
    const btn = document.querySelector('.signin-state .signin-btn');
    return {
      saysNothingHereYet: text.includes(lie),
      hasSignInBlock: !!block,
      title: document.querySelector('.signin-title')?.textContent || '',
      message: document.querySelector('.signin-message')?.textContent || '',
      btnTag: btn ? btn.tagName : null,
      btnHref: btn ? btn.getAttribute('href') : null,
      cards: document.querySelectorAll('#itube .c, #itube .row').length,
    };
  }, EMPTY_LIE);
}

// Every account-gated feed must (a) not claim the user's data is empty and
// (b) offer a real way to sign in.
async function checkGatedFeeds(browser) {
  const violations = [];
  const context = await newContext(browser);
  const details = [];

  for (const [name, url] of Object.entries(GATED_PAGES)) {
    const { page } = await openPage(context, url);
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    // The sign-in state is rendered from the browse response, which lands a
    // moment after the shell mounts.
    await page.waitForSelector('.signin-state, .empty, .c, .row', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const state = await readSignedOutState(page);
    details.push(`${name}: ${state.hasSignInBlock ? `signin("${(state.title || state.message).slice(0, 40)}")` : 'NO signin block'}${state.saysNothingHereYet ? ' + "Nothing here yet."' : ''}`);

    if (state.saysNothingHereYet) {
      violations.push({ check: 'signed-out-no-empty-lie', detail: `/${name} renders "${EMPTY_LIE}" while logged out — it is telling the user their data is empty when they are simply signed out` });
    }
    if (!state.hasSignInBlock) {
      violations.push({ check: 'signed-out-shows-signin', detail: `/${name} renders no .signin-state while logged out (cards=${state.cards}) — a signed-out user is given no way to sign in` });
    } else if (state.btnTag !== 'A' || state.btnHref !== '/signin') {
      violations.push({ check: 'signed-out-signin-is-link', detail: `/${name} sign-in affordance is <${state.btnTag} href=${JSON.stringify(state.btnHref)}>, expected a real <a href="/signin">` });
    } else if (!state.title && !state.message) {
      violations.push({ check: 'signed-out-has-copy', detail: `/${name} renders a sign-in button with no explanation at all — YouTube's own response carries the message, use it` });
    }
    await page.close();
  }

  await context.close();
  return { violations, detail: details.join(' | ') };
}

// The header slot where a user expects their account was a dead <div>
// (`.hd-avatar`), and next to it sat a notification bell that advertised itself
// as clickable (`cursor: pointer`) and did nothing at all.
async function checkHeaderSignIn(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, HOME_URL);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);

  const header = await page.evaluate(() => {
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    const signIn = document.querySelector('#itube .hd-signin');
    const avatar = document.querySelector('#itube .hd-avatar');
    // Any control in the header that LOOKS clickable must actually do
    // something. A <button> with no listener and cursor:pointer is worse than
    // no control: the bell was exactly that.
    const deadButtons = [...document.querySelectorAll('#itube .hd button')]
      .filter((b) => getComputedStyle(b).cursor === 'pointer')
      .map((b) => b.className || b.getAttribute('aria-label') || 'button');
    return {
      signInVisible: visible(signIn),
      signInTag: signIn ? signIn.tagName : null,
      signInHref: signIn ? signIn.getAttribute('href') : null,
      avatarVisible: visible(avatar),
      deadButtons,
    };
  });

  if (!header.signInVisible || header.signInTag !== 'A' || header.signInHref !== '/signin') {
    violations.push({ check: 'header-signin-control', detail: `expected a visible <a href="/signin"> in the header while logged out, got tag=${header.signInTag} href=${JSON.stringify(header.signInHref)} visible=${header.signInVisible}` });
  }
  if (header.avatarVisible) {
    violations.push({ check: 'header-no-fake-avatar', detail: 'the dead .hd-avatar placeholder is still shown while logged out — that slot is where a user expects their account, so it must be the Sign in control' });
  }
  if (header.deadButtons.length) {
    violations.push({ check: 'header-no-dead-controls', detail: `header still has clickable-looking button(s) with no behaviour: ${header.deadButtons.join(', ')}` });
  }

  await page.close();
  await context.close();
  return { violations, detail: `signIn=${header.signInHref} avatarVisible=${header.avatarVisible} deadButtons=[${header.deadButtons.join(',')}]` };
}

// The watch actions used to flip optimistically, fail the network call, and
// snap back with no explanation — the user could not tell whether the action
// failed or the app was broken. Logged out, they must not flip at all, and they
// must say WHY. (The "never lies" assertions stay: after a click, nothing may
// claim the action succeeded.)
async function checkWatchActions(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, WATCH_URL);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('.watch-like-btn', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // The mutation endpoints are HUNG (the request is never answered), and that
  // is what makes this check deterministic instead of a race. A UI that flips
  // optimistically and reverts when the call fails is indistinguishable, in a
  // fast network, from one that never flipped — the revert can land inside the
  // sampling window. With the response withheld, no revert can arrive: anything
  // still claiming "Liked"/"Saved"/"Subscribed" a second after the click did
  // flip, and flipping on an unconfirmed (here, unanswerable) request while
  // logged out is precisely the lie this feature removes.
  await page.route(
    (url) => /\/youtubei\/v1\/(like\/|subscription\/|browse\/edit_playlist)/.test(url.toString()),
    () => {}
  );

  const readState = () => page.evaluate(() => {
    const hint = document.querySelector('.watch-signin-hint');
    const hintVisible = !!hint && getComputedStyle(hint).display !== 'none';
    return {
      likePressed: document.querySelector('.watch-like-btn')?.getAttribute('aria-pressed'),
      dislikePressed: document.querySelector('.watch-dislike-btn')?.getAttribute('aria-pressed'),
      saveLabel: document.querySelector('.watch-action-btn')?.textContent.trim(),
      savePressed: document.querySelector('.watch-action-btn')?.getAttribute('aria-pressed'),
      subscribeLabel: document.querySelector('.watch-subscribe')?.textContent.trim(),
      subscribePressed: document.querySelector('.watch-subscribe')?.getAttribute('aria-pressed'),
      hintVisible,
      hintText: hintVisible ? hint.textContent : '',
      hintLink: hint?.querySelector('a')?.getAttribute('href') || null,
    };
  });

  const details = [];
  for (const [name, selector, lie] of [
    ['like', '.watch-like-btn', (s) => s.likePressed === 'true'],
    ['save', '.watch-action-btn', (s) => s.savePressed === 'true' || /saved/i.test(s.saveLabel || '')],
    ['subscribe', '.watch-subscribe', (s) => s.subscribePressed === 'true' || /subscribed/i.test(s.subscribeLabel || '')],
  ]) {
    const btn = await page.$(selector);
    if (!btn) {
      violations.push({ check: 'signed-out-actions-exist', detail: `expected ${selector} on the watch page` });
      continue;
    }
    await btn.click();
    await page.waitForTimeout(1200);
    const settled = await readState();
    if (lie(settled)) {
      violations.push({ check: 'signed-out-no-optimistic-lie', detail: `clicking ${name} while logged out claims it succeeded (like=${settled.likePressed} save="${settled.saveLabel}" subscribe="${settled.subscribeLabel}") — with the request unanswered, this can only be an optimistic flip, i.e. the UI telling the user something happened that did not` });
    }
    if (!settled.hintVisible) {
      violations.push({ check: 'signed-out-action-explains', detail: `clicking ${name} while logged out neither worked nor explained itself — no .watch-signin-hint is shown, so the user cannot tell whether the app is broken` });
    } else if (settled.hintLink !== '/signin') {
      violations.push({ check: 'signed-out-action-explains', detail: `the sign-in hint shown after clicking ${name} has no /signin link (href=${JSON.stringify(settled.hintLink)})` });
    }
    details.push(`${name}: hint=${settled.hintVisible ? JSON.stringify(settled.hintText.slice(0, 40)) : 'none'}`);
  }

  await page.close();
  await context.close();
  return { violations, detail: details.join(' | ') };
}

module.exports = {
  EMPTY_LIE,
  GATED_PAGES,
  checkGatedFeeds,
  checkHeaderSignIn,
  checkWatchActions,
};
