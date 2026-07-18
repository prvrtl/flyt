// Subscriptions chronological ordering.
//
// The bug: /feed/subscriptions rendered cards scrambled — a real report showed
// "1 hour ago, 1 day ago, 2 days ago, 21 hours ago, 3 days ago, 46 minutes
// ago" in that visual order. extractVideos() walks the payload tree in strict
// document order (no Map/sort in the walk itself — see `walk` in
// flyt.user.js), so the extractor is not reordering anything; YouTube's own
// FEsubscriptions payload is not strictly chronological (it interleaves
// channels/relevance signals), so the scramble is real, upstream data order.
//
// The fix enforces chronology client-side, for the subscriptions feed only:
// mountFeed() sorts each extracted batch (initial + every continuation) by
// parseRelativeTime(item.published) ascending, stably, so items whose time
// can't be parsed (LIVE, Premieres-in-the-future) are not forcibly relocated.
//
// This can't be observed against the live site logged out — subscriptions
// renders a sign-in prompt, not real cards (see checks/signedout.js). Instead
// this mocks the `browse` InnerTube call for FEsubscriptions with a crafted,
// deliberately-scrambled, multi-locale (en/de/uk/ru) fixture and asserts the
// RENDERED card order is chronological — exercising the real extractor +
// mountFeed path, not a reimplementation of it.
'use strict';

const fs = require('fs');
const path = require('path');
const { newContext, openPage, waitForApp } = require('../lib/harness');

// Mirrors parseRelativeTime() in flyt.user.js. Kept here (not required from
// the userscript — it's a single IIFE, nothing is exported) purely to compute
// the EXPECTED order from the fixture's own publishedTimeText strings; the
// assertion is on what the page actually rendered, not on this function.
const RELATIVE_TIME_UNITS = [
  [/second|секунд|sekunde/, 1],
  [/minute|хвилин|минут/, 60],
  [/hour|годин|час|stunde/, 3600],
  [/week|тижд|недел|woche/, 604800],
  [/day|день|дні|днів|дня|дней|tag/, 86400],
  [/month|місяц|месяц|monat/, 2592000],
  [/year|рік|рок|год|лет|jahr/, 31536000],
];

function parseRelativeTime(text) {
  if (typeof text !== 'string' || !text) return null;
  const lower = text.toLowerCase().trim();
  if (/^premieres\b/.test(lower) || /^scheduled/.test(lower)) return null;
  let seconds = null;
  for (const [re, mult] of RELATIVE_TIME_UNITS) {
    if (re.test(lower)) { seconds = mult; break; }
  }
  if (seconds == null) return null;
  const numMatch = lower.match(/(\d+(?:[.,]\d+)?)/);
  let value;
  if (numMatch) {
    value = parseFloat(numMatch[1].replace(',', '.'));
  } else if (/\ban?\b|\beine?r?\b/.test(lower)) {
    value = 1;
  } else {
    return null;
  }
  if (!isFinite(value) || value < 0) return null;
  return value * seconds;
}

// Deliberately scrambled, cross-locale — reproduces the reported symptom
// ("1 hour ago, 1 day ago, 2 days ago, 21 hours ago, 3 days ago, 46 minutes
// ago") plus a german/ukrainian pair with the SAME value (stability check)
// and two unparseable entries (LIVE now, a future premiere).
const FIXTURE_ITEMS = [
  { id: 'itubeord0001', title: 'One hour ago', published: '1 hour ago' },
  { id: 'itubeord0002', title: 'One day ago', published: '1 day ago' },
  { id: 'itubeord0003', title: 'Two days ago', published: '2 days ago' },
  { id: 'itubeord0004', title: 'Twenty-one hours ago', published: '21 hours ago' },
  { id: 'itubeord0005', title: 'Three days ago (ru)', published: '3 дня назад' },
  { id: 'itubeord0006', title: 'Forty-six minutes ago', published: '46 minutes ago' },
  { id: 'itubeord0007', title: 'Streaming live', published: 'LIVE' },
  { id: 'itubeord0008', title: 'Two hours ago (de)', published: 'vor 2 Stunden' },
  { id: 'itubeord0009', title: 'Two hours ago (uk)', published: '2 години тому' },
  { id: 'itubeord0010', title: 'Future premiere', published: 'Premieres in 2 hours' },
];

// The chronological order the fix must produce: every PARSEABLE item must
// appear in non-decreasing seconds-ago order. Unparseable items (LIVE,
// Premieres) are excluded from this check — the spec only promises they don't
// get forcibly relocated, not a specific slot.
const EXPECTED_PARSEABLE_ORDER = FIXTURE_ITEMS
  .filter((it) => parseRelativeTime(it.published) != null)
  .map((it) => ({ id: it.id, secs: parseRelativeTime(it.published) }))
  .sort((a, b) => a.secs - b.secs)
  .map((it) => it.id);

function videoRendererFixture(item) {
  return {
    richItemRenderer: {
      content: {
        videoRenderer: {
          videoId: item.id,
          title: { simpleText: item.title },
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + item.id + '/hqdefault.jpg', width: 720, height: 404 }] },
          longBylineText: { runs: [{ text: 'Flyt Test Channel' }] },
          publishedTimeText: { simpleText: item.published },
          lengthText: { simpleText: '10:00' },
        },
      },
    },
  };
}

function subscriptionsBrowseFixture() {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              richGridRenderer: {
                contents: FIXTURE_ITEMS.map(videoRendererFixture),
              },
            },
          },
        }],
      },
    },
  };
}

const HOME_URL = 'https://www.youtube.com/';

// Drives the SPA path deliberately: a hard load of /feed/subscriptions reads
// window.ytInitialData (the real, signed-out sign-in prompt) and never calls
// the mocked endpoint at all — mountFeed only takes the `browse` fetch path
// when spaNav is true (see the `useInitialData && !spaNav` guard). So this
// starts on Home (a real, hard load) and clicks the sidebar Subscriptions
// link, which is a genuine client-side <a> navigation (root click handler ->
// spaRoute()) — the same path a real signed-in user takes.
async function checkSubscriptionsChronological(browser) {
  const violations = [];
  const context = await newContext(browser);
  const { page } = await openPage(context, HOME_URL);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});

  const browseRe = /\/youtubei\/v1\/browse/;
  await page.route(browseRe, (route) => {
    let browseId = null;
    try {
      browseId = JSON.parse(route.request().postData() || '{}').browseId;
    } catch (e) {
      // fall through — not JSON we understand, let it hit the network
    }
    if (browseId === 'FEsubscriptions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(subscriptionsBrowseFixture()),
      });
    }
    return route.continue();
  });

  let renderedIds = [];
  try {
    const subsLink = await page.$('a.nav-row[href="/feed/subscriptions"]');
    if (!subsLink) {
      violations.push({ check: 'subs-order-sidebar-link', detail: 'expected a.nav-row[href="/feed/subscriptions"] in the sidebar' });
      return { violations, detail: '' };
    }
    await subsLink.click();
    await page.waitForFunction(() => location.pathname === '/feed/subscriptions', { timeout: 10000 }).catch(() => {});
    await page.waitForSelector('.c', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);

    renderedIds = await page.evaluate(() => (
      [...document.querySelectorAll('.c')]
        .map((c) => c.querySelector('a[href^="/watch?v="]')?.getAttribute('href') || '')
        .map((href) => new URLSearchParams(href.split('?')[1] || '').get('v'))
        .filter(Boolean)
    ));
  } finally {
    await page.unroute(browseRe).catch(() => {});
  }

  const renderedParseable = renderedIds.filter((id) => EXPECTED_PARSEABLE_ORDER.includes(id));
  if (renderedParseable.length !== EXPECTED_PARSEABLE_ORDER.length) {
    violations.push({
      check: 'subs-order-all-rendered',
      detail: `expected all ${EXPECTED_PARSEABLE_ORDER.length} parseable fixture items to render, got ${renderedParseable.length} (rendered=${JSON.stringify(renderedIds)})`,
    });
  } else if (renderedParseable.join(',') !== EXPECTED_PARSEABLE_ORDER.join(',')) {
    violations.push({
      check: 'subs-order-chronological',
      detail: `subscriptions cards are not in chronological order — expected [${EXPECTED_PARSEABLE_ORDER.join(', ')}], got [${renderedParseable.join(', ')}]`,
    });
  }

  await page.close();
  await context.close();
  return { violations, detail: `rendered=[${renderedIds.join(', ')}]` };
}

// Guard against the sort leaking into a ranked feed (home/search/channel must
// keep payload ranking). There is no live ground truth to assert this
// behaviorally against — home's real order is YouTube's own recommendation
// ranking, which this suite cannot independently verify either way. So this
// is a source-level invariant check instead: sortByRecency (the chronological
// sort) must only ever be invoked from the subscriptions-gated `extractOrdered`
// helper inside mountFeed, and mountHome/mountSearch/the channel view must
// keep calling extractVideos directly. If a future edit calls sortByRecency
// from anywhere else, this fails loudly instead of silently reordering a
// ranked feed.
function checkHomeOrderNotSorted() {
  const violations = [];
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'flyt.user.js'), 'utf8');

  const sortCallSites = [...src.matchAll(/sortByRecency\(items\)/g)].length;
  // Called exactly once: from inside mountFeed's extractOrdered.
  if (sortCallSites !== 1) {
    violations.push({
      check: 'sort-not-leaked',
      detail: `expected sortByRecency(items) to be called exactly once (from mountFeed's extractOrdered), found ${sortCallSites} occurrence(s) — a new call site would need re-auditing to confirm it isn't reordering a ranked feed`,
    });
  }

  const mountFeedMatch = src.match(/const mountFeed = \([\s\S]*?\n {2}\};\n/);
  if (!mountFeedMatch) {
    violations.push({ check: 'mountfeed-found', detail: 'could not locate `const mountFeed = (...) => { ... }` in flyt.user.js to inspect' });
  } else if (!/isSubscriptions \? sortByRecency\(items\) : items/.test(mountFeedMatch[0])) {
    violations.push({
      check: 'sort-gated-by-subscriptions',
      detail: 'expected mountFeed\'s extractOrdered to gate sortByRecency behind `isSubscriptions` so home/search/channel/other feeds keep payload order',
    });
  }

  return { violations, detail: `sortByRecency(...) occurrences=${sortCallSites}` };
}

module.exports = {
  checkSubscriptionsChronological,
  checkHomeOrderNotSorted,
  parseRelativeTime,
  EXPECTED_PARSEABLE_ORDER,
};
