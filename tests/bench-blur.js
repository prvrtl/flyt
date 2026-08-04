// Perf gate for the player capsules' backdrop-filter.
//
// bench.js cannot answer this: it scrolls feeds, while the cost in question is
// compositing a blurred backdrop over a PLAYING video with the controls shown.
// So this measures rAF deltas in three conditions on the same page:
//   hidden  — controls idle (capsules are visibility:hidden, not composited)
//   shown   — controls up, backdrop-filter live
//   noblur  — controls up, backdrop-filter forced to none
// shown vs noblur isolates the blur; hidden is the floor.
//
// HEADED=1 is worth using — headless WebKit pins the frame clock near vsync
// (see bench.js) and can flatten real differences.
'use strict';
const { launchBrowser, newContext, openPage, waitForApp } = require('./lib/harness');

const SAMPLE_MS = 5000;

const measure = (ms) => new Promise((resolve) => {
  const deltas = [];
  let last = performance.now();
  const start = last;
  const tick = (t) => {
    deltas.push(t - last);
    last = t;
    if (t - start < ms) requestAnimationFrame(tick);
    else resolve(deltas);
  };
  requestAnimationFrame(tick);
});

const stats = (d) => {
  const s = d.slice(1).sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    frames: s.length,
    median: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    worst: +s[s.length - 1].toFixed(2),
    janky: s.filter((x) => x > 16.7).length,
  };
};

(async () => {
  const browser = await launchBrowser();
  const context = await newContext(browser);
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=aircAruvnKk');
  await waitForApp(page, { timeout: 30000 });
  await page.waitForSelector('#itube-stage video', { timeout: 30000 });
  await page.evaluate(async () => {
    const v = document.querySelector('#itube-stage video');
    if (v) { v.muted = true; try { await v.play(); } catch (e) {} }
  });
  await page.waitForTimeout(4000);
  const playing = await page.evaluate(() => !document.querySelector('#itube-stage video')?.paused);
  console.log('video playing:', playing);

  const run = async (label, setup) => {
    await page.evaluate(setup);
    await page.waitForTimeout(700);
    const d = await page.evaluate(measure, SAMPLE_MS);
    console.log(label.padEnd(8), JSON.stringify(stats(d)));
  };

  // hidden: no pointer activity, chrome idle
  await run('hidden', () => {
    document.getElementById('itube-stage')?.classList.remove('show');
    document.getElementById('flyt-noblur')?.remove();
  });
  // shown: force .show so the capsules composite with their blur
  await run('shown', () => {
    document.getElementById('flyt-noblur')?.remove();
    document.getElementById('itube-stage')?.classList.add('show');
  });
  // noblur: same, blur off
  await run('noblur', () => {
    document.getElementById('itube-stage')?.classList.add('show');
    const s = document.createElement('style');
    s.id = 'flyt-noblur';
    s.textContent = '#itube-tools,#itube-sound,#itube-viewer,#itube-transport button{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}';
    document.head.appendChild(s);
  });

  // Stress case: theater enlarges the composited stage a lot, so if the blur
  // is going to cost anything it should show here rather than in a small
  // inline player.
  await page.evaluate(() => document.getElementById('itube-theater')?.click());
  await page.waitForFunction(() => document.getElementById('itube')?.classList.contains('theater'), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await run('th-blur', () => {
    document.getElementById('flyt-noblur')?.remove();
    document.getElementById('itube-stage')?.classList.add('show');
  });
  await run('th-none', () => {
    document.getElementById('itube-stage')?.classList.add('show');
    const s = document.createElement('style');
    s.id = 'flyt-noblur';
    s.textContent = '#itube-tools,#itube-sound,#itube-viewer,#itube-transport button{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}';
    document.head.appendChild(s);
  });

  await browser.close();
})();
