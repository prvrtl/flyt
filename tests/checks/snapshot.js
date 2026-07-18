// Layout-geometry snapshot: records position/size of key structural
// elements, rounded to the nearest 4px so ordinary content churn (a
// different video title, a different number of digits in a view count)
// doesn't cause false failures. This is deliberately NOT a pixel diff —
// YouTube's content changes hourly, so pixel baselines would never hold.
// Geometry is content-independent: the sidebar is always 200px wide
// regardless of what's playing.
'use strict';

const fs = require('fs');
const path = require('path');

const BASELINE_DIR = path.join(__dirname, '..', 'baselines');
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts');

// Superset of selectors worth tracking across all page types. Selectors
// that don't exist on a given page are simply skipped.
// NOTE the thumb selectors are DESCENDANT selectors, not `:first-child` ones.
// A card's first child is now its overlay video link (the restructure that made
// the channel name a link of its own), so `.c-thumb:first-child` matches
// nothing — and "matches nothing" reads as `missing from current page`, which
// is a real failure mode, not a false alarm: it is how a collapsed or removed
// thumbnail would look too. Anchor on the card instead.
const KEY_SELECTORS = [
  '.sidebar', '.sidebar-head', '.content', '.grid',
  '.c:first-child', '.c:first-child .c-thumb',
  '#itube-stage', '#itube-bar',
  '.watch-meta', '.watch-right', '.watch-left',
  '.ch-banner', '.ch-avatar',
  '.row:first-child', '.row:first-child .row-thumb',
];

// Elements whose HEIGHT is a function of what YouTube happened to serve, not
// of the layout. Two kinds:
//
//  - containers sized by how many items loaded (`.grid`, `.list`, the watch
//    columns): one more row of results is not a regression;
//  - the FIRST CARD of a feed (`.c:first-child`, `.row:first-child`): a card's
//    height is a function of its TITLE'S LINE COUNT, and the first card is
//    whichever video YouTube ranked first this hour. A two-line title makes the
//    card exactly one line-height (16px) taller than a one-line title. This is
//    the source of the channel/playlist snapshot flake: baselines held
//    h=220/236, a re-ranked feed measured 236/252, and the suite went red on a
//    page where nothing was wrong. The card's real layout is still pinned —
//    x/y/w are asserted here, and the card's thumbnail keeps FULL geometry
//    including height, because a thumbnail's box is fixed by the design and not
//    by the content.
//
// Height is not simply ignored for any of these: liveViolations asserts every
// one of them renders with height > 0, so a collapsed card or an empty column
// still fails.
//
// `.content` is deliberately NOT in this set: it is the fixed-height scroll
// viewport (`height: calc(100vh - 52px)` via `.body`), not a content-sized
// box, and it is exactly where a collapsed region would show up. It gets an
// explicit height assertion instead (see liveViolations).
const HEIGHT_IS_CONTENT_DEPENDENT = new Set([
  '.grid', '.list', '.watch-left', '.watch-right',
  '.c:first-child', '.row:first-child',
]);

// Structural selectors: the app's own chrome, whose geometry is a deliberate
// design decision rather than a function of whatever YouTube served. A change
// here is a regression until a human says otherwise, so `--update` refuses to
// overwrite them unless `--force` is also passed (see mergeBaseline).
const STRUCTURAL_SELECTORS = new Set(['.sidebar', '.sidebar-head', '.content', '#itube-stage']);

// Element counts per page. These must NOT be compared for equality (YouTube
// returns a different number of results every hour) but they must not be
// ignored either: an empty related rail, or a search that returned 3 results
// instead of 20, is a real regression that geometry cannot see — a container
// with no children still has a perfectly correct x/y/width.
const COUNT_SELECTORS = {
  c: '#itube .c', // grid cards (home, channel, playlist)
  row: '#itube .row', // list rows (search)
  rc: '#itube .rc', // related-video cards (watch right rail)
  commentRow: '#itube .comment-row',
};

// Counts are compared as a FLOOR: a drop below 70% of the baseline fails,
// anything above passes. Only counts whose baseline is > 0 are floored — a 0
// baseline asserts nothing, which matters because the logged-out home feed
// legitimately serves ZERO videos (plain YouTube with no userscript does the
// same: it returns a feedNudgeRenderer instead of a grid) and comments are
// collapsed until clicked.
const COUNT_FLOOR_RATIO = 0.7;

async function takeSnapshot(page) {
  return page.evaluate(({ selectors, ignoreHeight, countSelectors }) => {
    const round4 = (n) => Math.round(n / 4) * 4;
    const itube = document.querySelector('#itube');
    const geometry = {};
    for (const sel of selectors) {
      const scope = sel.startsWith('#') ? document : itube;
      const el = scope ? scope.querySelector(sel) : null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const box = { x: round4(r.left), y: round4(r.top), w: round4(r.width), h: round4(r.height) };
      if (ignoreHeight.includes(sel)) delete box.h;
      geometry[sel] = box;
    }

    const counts = {};
    for (const [key, sel] of Object.entries(countSelectors)) {
      counts[key] = document.querySelectorAll(sel).length;
    }

    // `live` is asserted against the PAGE ITSELF (a value derivable from the
    // viewport), never against a stored number, so it runs on every
    // invocation — including `--update`, where it stops a collapsed column
    // from being laundered into the baseline. Stripped before writing.
    const heightOf = (sel) => {
      const el = itube ? itube.querySelector(sel) : null;
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    const live = {
      viewportHeight: window.innerHeight,
      headerHeight: 0,
      contentHeight: heightOf('.content'),
      columnHeights: {},
    };
    for (const sel of ignoreHeight) {
      const h = heightOf(sel);
      if (h !== null) live.columnHeights[sel] = h;
    }

    return { geometry, counts, live };
  }, { selectors: KEY_SELECTORS, ignoreHeight: [...HEIGHT_IS_CONTENT_DEPENDENT], countSelectors: COUNT_SELECTORS });
}

function baselinePath(pageName) {
  return path.join(BASELINE_DIR, `${pageName}.json`);
}

async function saveScreenshot(page, pageName) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${pageName}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// Copies, rather than aliases, the snapshot's maps: mergeBaseline writes
// refused values back into the object it returns, and if that object shared
// `geometry`/`counts` with the caller's snapshot it would silently rewrite the
// caller's measurements too.
function stripLive(snapshot) {
  return {
    geometry: { ...(snapshot.geometry || {}) },
    counts: { ...(snapshot.counts || {}) },
  };
}

// Assertions that need no baseline, because the correct value is derivable
// from the page itself.
function liveViolations(live) {
  const violations = [];
  if (!live) return violations;

  // `.content` is the scroll viewport, not a content-sized box: with the header
  // removed it must fill the FULL viewport height. If it collapses, the page
  // scrolls in the wrong element and the fold moves.
  if (live.contentHeight !== null && live.headerHeight !== null) {
    const expected = live.viewportHeight - live.headerHeight;
    if (Math.abs(live.contentHeight - expected) > 2) {
      violations.push({
        check: 'content-fills-viewport',
        detail: `.content height expected ~${expected} (viewport ${live.viewportHeight} - header ${live.headerHeight}) got ${live.contentHeight}`,
      });
    }
  }

  // The columns whose exact height is content noise still must not be zero.
  for (const [sel, h] of Object.entries(live.columnHeights || {})) {
    if (!(h > 0)) {
      violations.push({ check: 'column-not-collapsed', detail: `${sel} rendered with height=${h} (expected > 0 — the column exists but is collapsed)` });
    }
  }
  return violations;
}

// Merges a fresh snapshot into an existing baseline under `--update`.
//
// Two things are REFUSED unless `force` is set, because rewriting every number
// in every baseline is exactly how a real regression gets silently laundered
// into the "expected" values:
//
//  - structural geometry (the app's own chrome);
//  - any count that would go DOWN. A count baseline is a floor, and the whole
//    point of the floor is to catch "the related rail returned 3 cards instead
//    of 20". If `--update` happily writes 3 over 20, the floor protects
//    nothing — the next run's floor is 2. Counts are allowed to RISE freely
//    (YouTube serving more results is not a regression).
//
// Returns { merged, refused, refusedCounts }.
function mergeBaseline(existing, fresh, { force = false } = {}) {
  const next = stripLive(fresh);
  const refused = [];
  const refusedCounts = [];
  if (!existing || force) return { merged: next, refused, refusedCounts };

  for (const sel of Object.keys(next.geometry)) {
    if (!STRUCTURAL_SELECTORS.has(sel)) continue;
    const base = existing.geometry && existing.geometry[sel];
    if (!base) continue; // a selector the baseline never had — nothing to overwrite
    if (JSON.stringify(base) === JSON.stringify(next.geometry[sel])) continue;
    refused.push({ sel, from: base, to: next.geometry[sel] });
    next.geometry[sel] = base;
  }

  for (const [key, base] of Object.entries(existing.counts || {})) {
    if (!(base > 0)) continue; // a 0 baseline asserts nothing; anything is an improvement
    const cur = next.counts[key] || 0;
    if (cur >= base) continue;
    refusedCounts.push({ key, from: base, to: cur });
    next.counts[key] = base;
  }
  return { merged: next, refused, refusedCounts };
}

// Compares a fresh snapshot against the committed baseline. If `update` is
// true, writes the baseline instead of comparing — but the live assertions
// still run, and structural geometry is protected unless `force` is passed.
function diffSnapshot(pageName, snapshot, { update = false, force = false } = {}) {
  const violations = liveViolations(snapshot.live);
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const file = baselinePath(pageName);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  if (update) {
    const { merged, refused, refusedCounts } = mergeBaseline(existing, snapshot, { force });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    for (const r of refused) {
      console.log(`  REFUSED to update structural geometry ${pageName} ${r.sel}: kept baseline ${JSON.stringify(r.from)}, page measured ${JSON.stringify(r.to)} — pass --force if this change is intentional.`);
    }
    for (const r of refusedCounts) {
      console.log(`  REFUSED to LOWER count baseline ${pageName} ${r.key}: kept baseline ${r.from}, page measured ${r.to} — a count baseline is a floor, and writing a smaller number over it is how "the rail returned 3 cards instead of 20" gets laundered into "expected". Pass --force if the drop is intentional.`);
    }
    return violations;
  }

  if (!existing) {
    violations.push({ check: 'snapshot-baseline-missing', detail: `no baseline at ${file} — run "npm run test:update" first` });
    return violations;
  }

  for (const [sel, base] of Object.entries(existing.geometry || {})) {
    const cur = snapshot.geometry[sel];
    if (!cur) {
      violations.push({ check: 'snapshot-geometry', detail: `${sel} missing from current page (baseline had ${JSON.stringify(base)})` });
      continue;
    }
    for (const dim of ['x', 'y', 'w', 'h']) {
      if (!(dim in base)) continue;
      if (Math.abs(cur[dim] - base[dim]) > 4) {
        violations.push({ check: 'snapshot-geometry', detail: `${sel}.${dim} expected ${base[dim]} got ${cur[dim]} (baseline=${JSON.stringify(base)} current=${JSON.stringify(cur)})` });
      }
    }
  }
  for (const sel of Object.keys(snapshot.geometry)) {
    if (!(sel in (existing.geometry || {}))) {
      violations.push({ check: 'snapshot-geometry', detail: `${sel} present now but absent from baseline — run "npm run test:update" if this is intentional` });
    }
  }

  for (const [key, base] of Object.entries(existing.counts || {})) {
    if (!(base > 0)) continue; // a 0 baseline (logged-out home feed, collapsed comments) asserts nothing
    const cur = snapshot.counts[key] || 0;
    const floor = Math.max(1, Math.floor(base * COUNT_FLOOR_RATIO));
    if (cur < floor) {
      violations.push({ check: 'snapshot-count', detail: `${key}=${cur} is below the floor of ${floor} (baseline ${base}, allowed to drop to ${Math.round(COUNT_FLOOR_RATIO * 100)}%)` });
    }
  }

  return violations;
}

module.exports = {
  takeSnapshot,
  saveScreenshot,
  diffSnapshot,
  baselinePath,
  KEY_SELECTORS,
  STRUCTURAL_SELECTORS,
  mergeBaseline,
};
