#!/usr/bin/env node
// Performance benchmark for Flyt v4, stock YouTube vs the userscript.
//
// This is the repro script behind every number in PERF.md. It measures only the
// two metrics that earlier benchmarking proved were tight and repeatable across
// runs (DOM node count and frame timing); JS heap and first contentful paint are
// deliberately NOT reported, because their run-to-run ranges overlap completely
// — see the "metrics deliberately NOT reported" section of PERF.md.
//
//   cd tests && node bench.js            # 3 runs, watch page
//   cd tests && node bench.js --runs=5 --page=home
//
// Headed Chromium with a focused window, so requestAnimationFrame is not
// throttled. The script is injected via addInitScript, i.e. at document-start —
// the same moment a userscript manager runs it.
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const { SCRIPT_PATH, CONSENT_COOKIES } = require('./lib/harness');

const PAGES = {
  watch: 'https://www.youtube.com/watch?v=aircAruvnKk',
  home: 'https://www.youtube.com/',
  search: 'https://www.youtube.com/results?search_query=liquid+glass+design',
  channel: 'https://www.youtube.com/@mkbhd/videos',
};

const VIEWPORT = { width: 1512, height: 900 };
const SCROLL_FRAMES = 150;
const SCROLL_STEP = 60; // px per frame
const JANK_MS = 16.7;

function parseArgs(argv) {
  const args = { runs: 3, page: 'watch' };
  for (const a of argv) {
    if (a.startsWith('--runs=')) args.runs = Number(a.slice('--runs='.length));
    else if (a.startsWith('--page=')) args.page = a.slice('--page='.length);
  }
  return args;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// One measurement of one page in one mode. `withScript` decides whether the
// userscript is injected at document-start; everything else is identical.
async function measure(browser, url, withScript) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies(CONSENT_COOKIES);

  // Long tasks must be observed from document-start or the early ones are lost.
  await context.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push(e.duration);
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });
  if (withScript) {
    await context.addInitScript({ content: fs.readFileSync(SCRIPT_PATH, 'utf8') });
  }

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for the UI under test to actually be on screen: Flyt's own root when
  // the script is injected, YouTube's when it is not.
  if (withScript) {
    await page.waitForSelector('#itube .content', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => {
      const c = document.querySelector('#itube .content');
      return c && c.querySelector('#itube-stage, .c, .row, .unhandled');
    }, { timeout: 30000 }).catch(() => {});
  } else {
    await page.waitForSelector('ytd-app', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(3000); // let comments/related/thumbnails settle

  // Scroll the element that actually scrolls in each mode: Flyt scrolls its own
  // `.content` pane; stock YouTube scrolls the document. Scrolling the window in
  // Flyt would move nothing and silently measure an idle page.
  const scroller = withScript ? '#itube .content' : null;

  // Populate lazily-rendered content the same way in both modes.
  for (let i = 0; i < 8; i++) {
    await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : null;
      if (el) el.scrollTop += 900;
      else window.scrollBy(0, 900);
    }, scroller);
    await page.waitForTimeout(400);
  }
  await page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : null;
    if (el) el.scrollTop = 0;
    else window.scrollTo(0, 0);
  }, scroller);
  await page.waitForTimeout(1000);

  const nodes = await page.evaluate(() => {
    const count = (root) => root ? root.querySelectorAll('*').length : 0;
    return {
      total: document.querySelectorAll('*').length,
      itube: count(document.querySelector('#itube')),
      ytdApp: count(document.querySelector('ytd-app')),
    };
  });

  // Record real frame intervals during a scripted scroll.
  const frames = await page.evaluate(
    ({ sel, n, step }) => new Promise((resolve) => {
      const el = sel ? document.querySelector(sel) : null;
      const intervals = [];
      let last = performance.now();
      let i = 0;
      const tick = (now) => {
        intervals.push(now - last);
        last = now;
        if (el) el.scrollTop += step;
        else window.scrollBy(0, step);
        if (++i < n) requestAnimationFrame(tick);
        else resolve(intervals.slice(1)); // drop the first, it includes setup
      };
      requestAnimationFrame(tick);
    }),
    { sel: scroller, n: SCROLL_FRAMES, step: SCROLL_STEP }
  );

  const longTasks = await page.evaluate(() => window.__longTasks || []);
  await context.close();

  return {
    nodes,
    frameMedian: median(frames),
    frameP95: percentile(frames, 95),
    frameWorst: Math.max(...frames),
    janky: frames.filter((f) => f > JANK_MS).length,
    frameCount: frames.length,
    longTaskCount: longTasks.length,
    longTaskTotal: longTasks.reduce((a, b) => a + b, 0),
  };
}

const f1 = (n) => n.toFixed(1);
const pct = (stock, itube) => {
  if (!stock) return 'n/a';
  const d = ((itube - stock) / stock) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(0)}%`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = PAGES[args.page];
  if (!url) {
    console.error(`Unknown page "${args.page}". Known: ${Object.keys(PAGES).join(', ')}`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  const runs = { stock: [], itube: [] };
  for (let i = 0; i < args.runs; i++) {
    for (const mode of ['stock', 'itube']) {
      process.stdout.write(`run ${i + 1}/${args.runs} ${mode}… `);
      const r = await measure(browser, url, mode === 'itube');
      runs[mode].push(r);
      console.log(`nodes=${r.nodes.total} p95=${f1(r.frameP95)}ms worst=${f1(r.frameWorst)}ms janky=${r.janky}`);
    }
  }
  await browser.close();

  const med = (mode, pick) => median(runs[mode].map(pick));
  const row = (label, pick, fmt = (v) => String(Math.round(v))) => {
    const s = med('stock', pick);
    const i = med('itube', pick);
    console.log(`| ${label} | ${fmt(s)} | ${fmt(i)} | ${pct(s, i)} |`);
  };

  console.log(`\n## ${args.page} page (median of ${args.runs} runs, viewport ${VIEWPORT.width}x${VIEWPORT.height}, logged out)\n`);
  console.log('| Metric | Stock | Flyt | Change |');
  console.log('|---|---|---|---|');
  row('DOM nodes, whole document', (r) => r.nodes.total);
  row('DOM nodes, ytd-app subtree', (r) => r.nodes.ytdApp);
  row('DOM nodes, Flyt UI', (r) => r.nodes.itube);
  row('Frame time, median', (r) => r.frameMedian, (v) => `${f1(v)} ms`);
  row('Frame time, p95', (r) => r.frameP95, (v) => `${f1(v)} ms`);
  row('Worst frame', (r) => r.frameWorst, (v) => `${f1(v)} ms`);
  row(`Janky frames (>${JANK_MS} ms) of ${runs.stock[0].frameCount}`, (r) => r.janky);
  row('Long tasks', (r) => r.longTaskCount);
  row('Long-task time, total', (r) => r.longTaskTotal, (v) => `${Math.round(v)} ms`);

  console.log('\nPer-run p95 (ms):');
  for (const mode of ['stock', 'itube']) {
    console.log(`  ${mode.padEnd(6)} ${runs[mode].map((r) => f1(r.frameP95)).join(' / ')}`);
  }
  console.log('Per-run total DOM nodes:');
  for (const mode of ['stock', 'itube']) {
    console.log(`  ${mode.padEnd(6)} ${runs[mode].map((r) => r.nodes.total).join(' / ')}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
