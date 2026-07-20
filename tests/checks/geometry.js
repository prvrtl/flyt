// Geometry invariants. These are RELATIONAL assertions (edges that must
// coincide, elements that must sit on one shared line) plus the few
// deliberate design constants of the sidebar column system (boxes on 12,
// icons on 24, labels on 52). Relational checks are stable against live-site
// content churn — which videos load never changes whether two boxes share an
// edge — unlike raw-pixel snapshot baselines, which drifted stale silently:
// the search box sat 12px narrower than the nav pills THROUGH several full
// audits because nothing asserted the relationship (fixed in 0.0.20, caught
// by a user screenshot, not by the suite).
'use strict';

const { waitForApp, openPage, newContext } = require('../lib/harness');

const TOL = 1;        // px — float/rounding slack for box-edge comparisons
const LINE_TOL = 0.6; // px — "on one vertical line" assertions

// Spread of a list of coordinates; violation text lists the offenders.
const spreadOf = (entries) => {
  const vals = entries.map((e) => e.v);
  return { spread: Math.max(...vals) - Math.min(...vals), entries };
};

async function checkGeometry(browser) {
  const violations = [];
  const report = (check, detail) => violations.push({ check, detail });
  const context = await newContext(browser);

  // ---------- HOME: sidebar column system + grid rhythm ----------
  const { page } = await openPage(context, 'https://www.youtube.com/');
  try {
    await waitForApp(page, { timeout: 30000 });
    await page.waitForSelector('#itube .c .c-thumb', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);

    const side = await page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, rgt: r.right, t: r.top, w: r.width, h: r.height }; };
      const all = (sel) => [...document.querySelectorAll(sel)];
      const sidebar = document.querySelector('#itube .sidebar');
      const boxes = [];
      for (const [name, sel] of [
        ['search-wrap', '#itube .search-wrap'],
        ['search', '#itube .search'],
        ['signin-row', '#itube .sidebar-signin-row'],
        ['logo-row', '#itube .sidebar-logo-row'],
        ['settings-row', '#itube .nav-settings'],
      ]) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) boxes.push({ name, ...rect(el) });
      }
      all('#itube .nav-row').forEach((el, i) => {
        if (el.getBoundingClientRect().width > 0) boxes.push({ name: 'nav-row#' + i, ...rect(el) });
      });
      const icons = [];
      const si = document.querySelector('#itube .search-icon');
      if (si) icons.push({ name: 'search-icon', v: si.getBoundingClientRect().left });
      all('#itube .nav-row svg').forEach((el, i) => icons.push({ name: 'nav-icon#' + i, v: el.getBoundingClientRect().left }));
      all('#itube .nav-chan img').slice(0, 5).forEach((el, i) => icons.push({ name: 'chan-avatar#' + i, v: el.getBoundingClientRect().left }));
      const labels = [];
      const search = document.querySelector('#itube .search');
      if (search) labels.push({ name: 'search-text', v: search.getBoundingClientRect().left + parseFloat(getComputedStyle(search).paddingLeft) });
      all('#itube .nav-row span').forEach((el, i) => labels.push({ name: 'nav-label#' + i, v: el.getBoundingClientRect().left }));
      // Only the icon-line icons — the brand-tile glyph and collapsed-rail
      // buttons are deliberately different sizes.
      const svgSizes = all('#itube .nav-row svg, #itube .search-icon svg, #itube .nav-settings svg').slice(0, 12).map((el, i) => ({ name: 'svg#' + i, v: el.getBoundingClientRect().width }));
      const navHeights = all('#itube .nav-row').map((el, i) => ({ name: 'nav-row#' + i, v: el.getBoundingClientRect().height }));
      return { sidebar: sidebar ? rect(sidebar) : null, boxes, icons, labels, svgSizes, navHeights };
    });

    if (!side.sidebar || side.boxes.length < 5) {
      report('geometry-sidebar-present', `expected the sidebar column with its boxes, got ${side.boxes.length} boxes`);
    } else {
      // Every head/nav box spans one shared column (the 0.0.20 bug: the
      // search box was inset 12px on both sides relative to the nav pills).
      const colL = side.sidebar.l + 12;
      const colR = side.sidebar.rgt - 12;
      for (const b of side.boxes) {
        if (Math.abs(b.l - colL) > TOL || Math.abs(b.rgt - colR) > TOL) {
          report('geometry-sidebar-column', `${b.name} spans ${b.l.toFixed(1)}..${b.rgt.toFixed(1)}, expected the shared ${colL}..${colR} column every sidebar box sits in`);
        }
      }
      // Icons (and subscription avatars) sit on ONE vertical line.
      if (side.icons.length >= 3) {
        const { spread, entries } = spreadOf(side.icons);
        if (spread > LINE_TOL) {
          report('geometry-sidebar-icon-line', `sidebar icons are not on one vertical line: spread ${spread.toFixed(2)}px (${entries.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')})`);
        }
      }
      // Text starts (search placeholder + nav labels) sit on ONE line — this
      // is what the 17px-icon off-grid drift broke by 1px before 0.0.20.
      if (side.labels.length >= 3) {
        const { spread, entries } = spreadOf(side.labels);
        if (spread > TOL) {
          report('geometry-sidebar-text-line', `sidebar text starts are not on one line: spread ${spread.toFixed(2)}px (${entries.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')})`);
        }
      }
      // Icons render at an integer 16px — 17px meant non-integer viewBox
      // scaling (blurry strokes) and pushed the label line off the grid.
      for (const s of side.svgSizes) {
        if (Math.abs(s.v - 16) > 0.2) {
          report('geometry-icon-size', `${s.name} renders at ${s.v.toFixed(2)}px, expected 16 (integer scaling of the 16-unit viewBox)`);
        }
      }
      // Uniform nav-row rhythm.
      if (side.navHeights.length >= 3) {
        const { spread } = spreadOf(side.navHeights);
        if (spread > TOL) {
          report('geometry-nav-rhythm', `nav rows are not one height: ${side.navHeights.map((e) => e.v.toFixed(1)).join('/')}`);
        }
      }
    }

    // List rhythm: measure search results — Home/Trending are sign-in pages
    // logged out, search always renders. Guards the "ragged rows" class of
    // bug (cards drifting to different widths/edges as extraction changes).
    await page.goto('https://www.youtube.com/results?search_query=lofi', { waitUntil: 'domcontentloaded' });
    await waitForApp(page, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#itube .row .row-thumb', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);

    const list = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#itube .row')].slice(0, 10);
      const content = document.querySelector('#itube .content');
      if (!rows.length || !content) return null;
      return {
        content: { l: content.getBoundingClientRect().left, rgt: content.getBoundingClientRect().right },
        rows: rows.map((r) => { const b = r.getBoundingClientRect(); return { l: b.left, rgt: b.right, t: b.top, h: b.height }; }),
        thumbs: rows.map((r) => r.querySelector('.row-thumb')).filter(Boolean).slice(0, 6).map((t) => { const b = t.getBoundingClientRect(); return { l: b.left, w: b.width, h: b.height }; }),
      };
    });
    if (list && list.rows.length >= 5) {
      const ls = list.rows.map((r, i) => ({ name: 'row#' + i, v: r.l }));
      const rs = list.rows.map((r, i) => ({ name: 'row#' + i, v: r.rgt }));
      if (spreadOf(ls).spread > TOL) report('geometry-list-left-edges', `search rows not left-aligned: ${ls.map((e) => e.v.toFixed(1)).join('/')}`);
      if (spreadOf(rs).spread > TOL) report('geometry-list-right-edges', `search rows not right-aligned: ${rs.map((e) => e.v.toFixed(1)).join('/')}`);
      // Symmetric content gutters (left inset == right inset).
      const gutL = list.rows[0].l - list.content.l;
      const gutR = list.content.rgt - list.rows[0].rgt;
      if (Math.abs(gutL - gutR) > 2) {
        report('geometry-list-gutters', `list gutters asymmetric: left ${gutL.toFixed(1)}px vs right ${gutR.toFixed(1)}px`);
      }
      // Thumbs: one size, one left edge, 16:9.
      const tw = list.thumbs.map((t, i) => ({ name: 'thumb#' + i, v: t.w }));
      const tl = list.thumbs.map((t, i) => ({ name: 'thumb#' + i, v: t.l }));
      if (spreadOf(tw).spread > TOL) report('geometry-list-thumb-widths', `row thumbs not one width: ${tw.map((e) => e.v.toFixed(1)).join('/')}`);
      if (spreadOf(tl).spread > TOL) report('geometry-list-thumb-edges', `row thumbs not on one left edge: ${tl.map((e) => e.v.toFixed(1)).join('/')}`);
      for (const t of list.thumbs.slice(0, 4)) {
        const ratio = t.w / t.h;
        if (Math.abs(ratio - 16 / 9) > 0.03) {
          report('geometry-thumb-aspect', `row thumb aspect ${ratio.toFixed(3)}, expected 16:9 (${(16 / 9).toFixed(3)})`);
        }
      }
      // Uniform vertical rhythm between consecutive rows.
      const gaps = list.rows.slice(1).map((r, i) => r.t - (list.rows[i].t + list.rows[i].h));
      if (gaps.length >= 3 && Math.max(...gaps) - Math.min(...gaps) > TOL) {
        report('geometry-list-row-gaps', `uneven vertical gaps between rows: ${gaps.map((g) => g.toFixed(1)).join('/')}`);
      }
    } else {
      report('geometry-list-present', `expected >=5 search rows to measure, got ${list ? list.rows.length : 'none'}`);
    }
  } finally {
    await page.close();
  }

  // ---------- WATCH: the two columns and the actions row ----------
  const { page: wp } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  try {
    await waitForApp(wp, { timeout: 30000 });
    await wp.waitForSelector('#itube-stage', { timeout: 20000 });
    await wp.waitForSelector('#itube .rc', { timeout: 20000 }).catch(() => {});
    await wp.waitForSelector('.watch-like-btn', { state: 'visible', timeout: 15000 }).catch(() => {});
    await wp.waitForTimeout(400);

    const w = await wp.evaluate(() => {
      const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, rgt: r.right, t: r.top, h: r.height, w: r.width }; };
      return {
        stage: rect('#itube-stage'),
        title: rect('#itube .watch h1'),
        channel: rect('#itube .watch-channel'),
        actions: rect('#itube .watch-actions'),
        railTabs: rect('#itube .rail-tabs'),
        watchRight: rect('#itube .watch-right'),
        firstRc: rect('#itube .rc'),
        rcCards: [...document.querySelectorAll('#itube .rc')].slice(0, 8).map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, w: r.width }; }),
        actionBtns: [...document.querySelectorAll('#itube .watch-actions > *')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.className.split(' ')[0] || el.tagName, t: r.top, h: r.height };
        }),
      };
    });

    // Left column: stage, title, channel row and actions share both edges.
    const leftCol = [['stage', w.stage], ['title', w.title], ['channel', w.channel], ['actions', w.actions]].filter(([, r]) => r);
    if (leftCol.length >= 3) {
      const ls = leftCol.map(([n, r]) => ({ name: n, v: r.l }));
      const rs = leftCol.map(([n, r]) => ({ name: n, v: r.rgt }));
      if (spreadOf(ls).spread > TOL) report('geometry-watch-left-edges', `watch column left edges differ: ${ls.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')}`);
      if (spreadOf(rs).spread > TOL) report('geometry-watch-right-edges', `watch column right edges differ: ${rs.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')}`);
    } else {
      report('geometry-watch-present', `expected stage/title/channel/actions to measure, got ${leftCol.length}`);
    }
    // Rail column: tabs and cards share a left edge; rail top == stage top.
    if (w.watchRight && w.railTabs && w.firstRc) {
      const rl = [{ name: 'watch-right', v: w.watchRight.l }, { name: 'rail-tabs', v: w.railTabs.l }, { name: 'first-rc', v: w.firstRc.l }];
      if (spreadOf(rl).spread > TOL) report('geometry-watch-rail-edges', `rail left edges differ: ${rl.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')}`);
      if (w.stage && Math.abs(w.watchRight.t - w.stage.t) > TOL) {
        report('geometry-watch-column-tops', `stage top ${w.stage.t.toFixed(1)} vs rail top ${w.watchRight.t.toFixed(1)} — the two columns must start level`);
      }
    }
    // Every related card shares the rail's left edge and width.
    if (w.rcCards && w.rcCards.length >= 4) {
      const rls = w.rcCards.map((c, i) => ({ name: 'rc#' + i, v: c.l }));
      const rws = w.rcCards.map((c, i) => ({ name: 'rc#' + i, v: c.w }));
      if (spreadOf(rls).spread > TOL) report('geometry-rc-edges', `related cards not on one left edge: ${rls.map((e) => e.v.toFixed(1)).join('/')}`);
      if (spreadOf(rws).spread > TOL) report('geometry-rc-widths', `related cards not one width: ${rws.map((e) => e.v.toFixed(1)).join('/')}`);
    }
    // Actions row: every control shares one top and one height.
    if (w.actionBtns.length >= 3) {
      const tops = w.actionBtns.map((b) => ({ name: b.name, v: b.t }));
      const heights = w.actionBtns.map((b) => ({ name: b.name, v: b.h }));
      if (spreadOf(tops).spread > TOL) report('geometry-actions-tops', `action controls not on one baseline: ${tops.map((e) => `${e.name}@${e.v.toFixed(1)}`).join(', ')}`);
      if (spreadOf(heights).spread > TOL) report('geometry-actions-heights', `action controls not one height: ${heights.map((e) => `${e.name}=${e.v.toFixed(1)}`).join(', ')}`);
    }
  } finally {
    await wp.close();
    await context.close();
  }

  return violations;
}

module.exports = { checkGeometry };
