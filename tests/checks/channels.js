// Channel-link checks.
//
// The bug this exists to catch: for the app's entire life, the channel route
// (/@handle, /channel/ID) worked perfectly and was completely UNREACHABLE.
// Every card was one big <a href="/watch">, so clicking the author's name
// opened the video; on the watch page the author's name and avatar were inert
// <div>/<img> with `cursor: auto`. Zero channel links existed anywhere in the
// app, and no check noticed, because every check only ever asked whether the
// VIDEO link worked.
//
// So these assertions are deliberately about the AUTHOR, everywhere the author
// is rendered: feed cards, list rows, related cards, the watch page's channel
// row, and comment authors. They assert real <a href> elements (not spans with
// JS click handlers — those break Cmd-click and middle-click), that the href
// points at a channel route, that no <a> ended up nested inside another <a>
// (which the browser silently unnests, destroying the DOM), and that clicking
// one is a client-side route with ZERO main-frame document loads.
'use strict';

const { waitForApp } = require('../lib/harness');

// A channel destination is either a handle (/@mkbhd) or a canonical channel id
// (/channel/UC...). Anything else — /watch, /user/foo, an absolute URL — means
// the extractor picked up the wrong endpoint.
const CHANNEL_HREF_RE = /^\/(@|channel\/)/;

// The card kinds, and the class of the channel link each one is supposed to
// carry. `.c` = grid card, `.row` = search list row, `.rc` = related/queue card.
const CARD_KINDS = [
  { card: '.c', chan: '.c-chan' },
  { card: '.row', chan: '.row-chan' },
  { card: '.rc', chan: '.rc-chan' },
];

// Reads every card on the page and reports, per card, whether its channel
// element is a real anchor and where it points.
async function readCards(page) {
  return page.evaluate((kinds) => {
    const out = [];
    for (const { card, chan } of kinds) {
      const cards = [...document.querySelectorAll('#itube ' + card)];
      cards.forEach((el, i) => {
        const chanEl = el.querySelector(chan);
        const titleEl = el.querySelector('.c-title, .row-title, .rc-title');
        out.push({
          kind: card,
          index: i,
          title: (titleEl ? titleEl.textContent : '').slice(0, 50),
          hasChanEl: !!chanEl,
          tag: chanEl ? chanEl.tagName : null,
          href: chanEl ? chanEl.getAttribute('href') : null,
          text: chanEl ? chanEl.textContent.trim() : '',
        });
      });
    }
    return out;
  }, CARD_KINDS);
}

// Every card/row/related item must expose a channel link. A card whose channel
// element is missing, is not an <a>, or has no href is a card whose author the
// user cannot reach — which is exactly the shipped bug.
async function checkCardChannelLinks(page, pageName) {
  const violations = [];
  const cards = await readCards(page);

  if (!cards.length) {
    // The logged-out home feed legitimately renders zero cards (YouTube serves
    // a nudge, not a grid, to a session with no history) — nothing to assert.
    if (pageName !== 'home') {
      violations.push({ check: 'channel-link-cards-exist', detail: `expected at least one .c/.row/.rc card on the ${pageName} page to assert channel links against` });
    }
    return violations;
  }

  const bad = cards.filter((c) => !c.hasChanEl || c.tag !== 'A' || !c.href || !CHANNEL_HREF_RE.test(c.href));
  if (bad.length) {
    const sample = bad.slice(0, 3).map((c) => `${c.kind}[${c.index}] "${c.title}" -> ${c.hasChanEl ? `<${c.tag}> href=${JSON.stringify(c.href)} text=${JSON.stringify(c.text)}` : 'no channel element at all'}`);
    violations.push({
      check: 'channel-link-on-every-card',
      detail: `${bad.length}/${cards.length} cards on ${pageName} expose no usable channel link (want a real <a href> matching ${CHANNEL_HREF_RE}): ${sample.join(' ; ')}`,
    });
  }
  return violations;
}

// An <a> inside an <a> is not a DOM the browser will keep: the parser/DOM
// silently restructures it, and the inner link's clicks land on the outer one.
// The whole point of the card restructure is that the channel link is a SIBLING
// of the video link, never a child of it.
//
// Scoped to `#itube`, not the whole document: ytd-app is still in the page
// (parked offscreen — the player must keep laying out), and YouTube's own ad
// markup ships nested <a> elements of its own. A document-wide `a a` query is
// therefore red on every search page for reasons that have nothing to do with
// this app's DOM.
async function checkNoNestedAnchors(page, pageName) {
  const violations = [];
  const nested = await page.evaluate(() => {
    const bad = [...document.querySelectorAll('#itube a a')];
    return {
      count: bad.length,
      sample: bad.slice(0, 3).map((a) => `${a.className || a.tagName}[href=${a.getAttribute('href')}]`),
    };
  });
  if (nested.count > 0) {
    violations.push({ check: 'no-nested-anchors', detail: `found ${nested.count} <a> nested inside another <a> on ${pageName}: ${nested.sample.join(' ; ')}` });
  }
  return violations;
}

// The watch page's channel row: BOTH the name and the avatar must be links.
// Before this feature they were a <div> and a bare <img> — the two things a
// user is most likely to click to get to a channel, and neither did anything.
async function checkWatchChannelRow(page) {
  const violations = [];
  const row = await page.evaluate(() => {
    const name = document.querySelector('.watch-channel-name');
    const avatar = document.querySelector('.watch-avatar-link');
    return {
      nameTag: name ? name.tagName : null,
      nameHref: name ? name.getAttribute('href') : null,
      nameText: name ? name.textContent.trim() : '',
      avatarTag: avatar ? avatar.tagName : null,
      avatarHref: avatar ? avatar.getAttribute('href') : null,
      avatarHasImg: !!(avatar && avatar.querySelector('img.watch-avatar')),
    };
  });
  if (row.nameTag !== 'A' || !row.nameHref || !CHANNEL_HREF_RE.test(row.nameHref)) {
    violations.push({ check: 'watch-channel-name-is-link', detail: `expected .watch-channel-name to be an <a> with a channel href, got <${row.nameTag}> href=${JSON.stringify(row.nameHref)} (text "${row.nameText}")` });
  }
  if (row.avatarTag !== 'A' || !row.avatarHref || !CHANNEL_HREF_RE.test(row.avatarHref)) {
    violations.push({ check: 'watch-avatar-is-link', detail: `expected the watch avatar to be wrapped in an <a> with a channel href, got <${row.avatarTag}> href=${JSON.stringify(row.avatarHref)}` });
  }
  if (row.avatarTag === 'A' && !row.avatarHasImg) {
    violations.push({ check: 'watch-avatar-is-link', detail: 'the .watch-avatar-link anchor contains no <img.watch-avatar> — the avatar image was lost in the restructure' });
  }
  return violations;
}

// Comment authors are channels too. `commentEntityPayload.author` carries both
// a channelId and a canonical /@handle, so an unlinked comment author is thrown
// away data, not missing data.
async function checkCommentAuthorLinks(page) {
  const violations = [];
  const toggle = await page.$('.rail-tab:has-text("Comments")');
  if (!toggle) {
    violations.push({ check: 'comment-author-links', detail: 'expected a Comments rail tab on the watch page' });
    return violations;
  }
  if (await page.evaluate((el) => el.disabled, toggle)) {
    violations.push({ check: 'comment-author-links', detail: 'the Comments rail tab is disabled on a video with comments — cannot assert comment author links' });
    return violations;
  }
  const alreadyOpen = await page.evaluate(() => document.querySelectorAll('.comment-row').length > 0);
  if (!alreadyOpen) await toggle.click();
  await page.waitForFunction(() => document.querySelectorAll('.comment-row').length > 0, { timeout: 15000 }).catch(() => {});

  const comments = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.comment-row')];
    return rows.map((r) => {
      const author = r.querySelector('.comment-author');
      const avatarLink = r.querySelector('.comment-avatar-link');
      return {
        authorTag: author ? author.tagName : null,
        authorHref: author ? author.getAttribute('href') : null,
        authorText: author ? author.textContent.trim().slice(0, 30) : '',
        avatarTag: avatarLink ? avatarLink.tagName : null,
        avatarHref: avatarLink ? avatarLink.getAttribute('href') : null,
      };
    });
  });
  if (!comments.length) {
    violations.push({ check: 'comment-author-links', detail: 'expected >0 .comment-row after expanding comments' });
    return violations;
  }
  const badAuthors = comments.filter((c) => c.authorTag !== 'A' || !c.authorHref || !CHANNEL_HREF_RE.test(c.authorHref));
  if (badAuthors.length) {
    violations.push({
      check: 'comment-author-is-link',
      detail: `${badAuthors.length}/${comments.length} comment authors are not channel links: ${badAuthors.slice(0, 3).map((c) => `<${c.authorTag}> href=${JSON.stringify(c.authorHref)} "${c.authorText}"`).join(' ; ')}`,
    });
  }
  const badAvatars = comments.filter((c) => c.avatarTag !== 'A' || !c.avatarHref || !CHANNEL_HREF_RE.test(c.avatarHref));
  if (badAvatars.length) {
    violations.push({
      check: 'comment-avatar-is-link',
      detail: `${badAvatars.length}/${comments.length} comment avatars are not channel links: ${badAvatars.slice(0, 3).map((c) => `<${c.avatarTag}> href=${JSON.stringify(c.avatarHref)}`).join(' ; ')}`,
    });
  }
  return violations;
}

// Clicking a channel link must be a CLIENT-SIDE route: the router already
// handles /@handle and /channel/ID, so a document load here would mean the app
// threw itself away and let YouTube reload the world — the one thing the
// userscript exists to prevent.
//
// Document loads are counted on the MAIN FRAME only: ad iframes issue requests
// whose resourceType() is also 'document', so an unfiltered count is a
// guaranteed false positive.
async function checkChannelLinkNavigation(page, pageName) {
  const violations = [];
  const link = await page.$('#itube a.c-chan[href], #itube a.row-chan[href], #itube a.rc-chan[href]');
  if (!link) {
    if (pageName !== 'home') {
      violations.push({ check: 'channel-link-navigates', detail: `no channel link to click on the ${pageName} page` });
    }
    return violations;
  }
  const href = await page.evaluate((el) => el.getAttribute('href'), link);

  const mainFrame = page.mainFrame();
  let docLoads = 0;
  const onRequest = (req) => {
    if (req.resourceType() === 'document' && req.frame() === mainFrame) docLoads++;
  };
  page.on('request', onRequest);
  await link.click();
  await page.waitForFunction(() => /^\/(@|channel\/)/.test(location.pathname), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
  page.off('request', onRequest);

  const after = await page.evaluate(() => ({
    path: location.pathname,
    hasHeader: !!document.querySelector('.ch-header'),
    name: document.querySelector('.ch-name')?.textContent || '',
  }));
  if (!CHANNEL_HREF_RE.test(after.path)) {
    violations.push({ check: 'channel-link-navigates', detail: `clicking a channel link (${href}) on ${pageName} did not land on a channel route, location.pathname is "${after.path}"` });
    return violations;
  }
  if (docLoads > 0) {
    violations.push({ check: 'channel-link-no-reload', detail: `clicking a channel link (${href}) on ${pageName} caused ${docLoads} main-frame document load(s) — a full page reload, not a client-side route` });
  }
  if (!after.hasHeader) {
    violations.push({ check: 'channel-link-mounts-channel', detail: `after clicking ${href} on ${pageName} the channel page did not mount (no .ch-header)` });
  }
  return violations;
}

// The whole-card affordance must survive the restructure: clicking anywhere on
// a card that is NOT the channel name still opens the video. The video link is
// an overlay anchor covering the card, so this is a real hit-test, not a
// synthetic dispatch — a covered or pointer-events:none overlay fails here.
async function checkCardStillOpensVideo(page, pageName) {
  const violations = [];
  const meta = await page.$('#itube .c .c-meta, #itube .row .row-meta');
  if (!meta) {
    if (pageName !== 'home') {
      violations.push({ check: 'card-body-opens-video', detail: `no card metadata line to click on the ${pageName} page` });
    }
    return violations;
  }
  // Clicked by COORDINATES, not by element: the video link is an overlay
  // anchor sitting on top of the card, so Playwright's actionability check
  // rightly reports that the overlay "intercepts pointer events" on the meta
  // line. That interception IS the feature — a real mouse click at that point
  // must land on the overlay and open the video. So aim the mouse where a human
  // would and let the browser hit-test.
  const box = await meta.boundingBox();
  if (!box) {
    violations.push({ check: 'card-body-opens-video', detail: `the card metadata line on ${pageName} has no layout box` });
    return violations;
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => location.pathname === '/watch', { timeout: 10000 }).catch(() => {});
  const path = await page.evaluate(() => location.pathname);
  if (path !== '/watch') {
    violations.push({ check: 'card-body-opens-video', detail: `clicking a card's metadata line on ${pageName} should still open the video, but location.pathname is "${path}" — the overlay video link does not cover the whole card` });
  }
  return violations;
}

// Opening a video from a /playlist page used to lose the queue: only the
// watch-page queue itself appended `&list=`, so a card's own `.c-link` was a
// bare `/watch?v=<id>` with no playlist context at all. Passive half: every
// card's href must carry `list=`.
async function checkPlaylistCardsCarryList(page) {
  const violations = [];
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('#itube .c .c-link')].map((a) => a.getAttribute('href')));
  if (!hrefs.length) {
    violations.push({ check: 'playlist-cards-exist', detail: 'expected at least one .c card on the playlist page' });
    return violations;
  }
  const missing = hrefs.filter((href) => !href || !/[?&]list=/.test(href));
  if (missing.length) {
    violations.push({
      check: 'playlist-card-carries-list',
      detail: `${missing.length}/${hrefs.length} playlist cards have a .c-link href with no list= param, so opening the video from here loses the queue: ${missing.slice(0, 3).join(' ; ')}`,
    });
  }
  return violations;
}

// Active half: actually click a card and confirm the queue survives the
// navigation — location.search keeps list=, and the watch page's own
// .queue-item rail populates from it.
async function checkPlaylistClickPreservesQueue(page) {
  const violations = [];
  const link = await page.$('#itube .c .c-link[href]');
  if (!link) {
    violations.push({ check: 'playlist-click-preserves-list', detail: 'no .c-link to click on the playlist page' });
    return violations;
  }
  await link.click();
  await page.waitForFunction(() => location.pathname === '/watch', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length > 0, { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(() => ({ search: location.search, queueItems: document.querySelectorAll('.queue-item').length }));
  if (!/[?&]list=/.test(after.search)) {
    violations.push({ check: 'playlist-click-preserves-list', detail: `after clicking a playlist card, location.search is "${after.search}" — expected a list= param so the queue survives the click` });
  }
  if (after.queueItems === 0) {
    violations.push({ check: 'playlist-click-populates-queue', detail: 'expected >0 .queue-item after opening a video from the playlist page' });
  }
  return violations;
}

// Runs the channel-link suite for one page. Navigation-y checks come last and
// re-open the page under test, so each one starts from the same state.
async function runChannelChecks(page, pageName, url) {
  let violations = [];
  violations = violations.concat(await checkCardChannelLinks(page, pageName));
  violations = violations.concat(await checkNoNestedAnchors(page, pageName));

  if (pageName === 'watch') {
    violations = violations.concat(await checkWatchChannelRow(page));
    violations = violations.concat(await checkCommentAuthorLinks(page));
    // Comments render another ~20 author links; re-assert after they exist.
    violations = violations.concat(await checkNoNestedAnchors(page, 'watch (comments expanded)'));
  }

  if (pageName === 'playlist') {
    violations = violations.concat(await checkPlaylistCardsCarryList(page));
  }

  violations = violations.concat(await checkChannelLinkNavigation(page, pageName));

  // The watch page has no grid card to click, and its related rail is already
  // covered by the watch-to-watch navigation check in functional.js.
  if (pageName !== 'watch') {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 });
    await page.waitForSelector('.c, .rc, .row', { timeout: 10000 }).catch(() => {});
    violations = violations.concat(await checkCardStillOpensVideo(page, pageName));
  }

  // Own fresh reload: the checks above already navigated this page away
  // (channel-link-navigation, card-still-opens-video), so the click here
  // needs a clean slate to be sure it lands on the FIRST card in list order.
  if (pageName === 'playlist') {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 });
    await page.waitForSelector('.c', { timeout: 10000 }).catch(() => {});
    violations = violations.concat(await checkPlaylistClickPreservesQueue(page));
  }

  return violations;
}

module.exports = {
  CHANNEL_HREF_RE,
  runChannelChecks,
  checkCardChannelLinks,
  checkNoNestedAnchors,
  checkWatchChannelRow,
  checkCommentAuthorLinks,
  checkChannelLinkNavigation,
  checkPlaylistCardsCarryList,
  checkPlaylistClickPreservesQueue,
};
