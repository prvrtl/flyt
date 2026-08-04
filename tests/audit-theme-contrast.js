// Measures REAL rendered contrast in the light theme rather than trusting the
// palette arithmetic: walks every visible text-bearing element in #itube,
// resolves the effective background by climbing until a non-transparent layer
// is found, and reports anything under the WCAG AA threshold for its size.
// Elements over video/thumbnail art are excluded — their true backdrop is an
// image, which no computed style can report.
const path = require('path');
const { launchBrowser, newContext, openPage, waitForApp } = require('./lib/harness');

const AUDIT = () => {
  const parse = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || '');
    if (!m) return null;
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => {
    const l1 = L(a); const l2 = L(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

  // Anything whose backdrop is artwork: the duration badge, the hover action
  // cluster, the player chrome. Their contrast is against pixels, not CSS.
  const OVER_ART = ['#itube-bar', '#itube-preview', '#itube-mini', '#itube-cue',
    '#itube-stage', '.c-thumb', '.row-thumb', '.qa', '.wl-quick', '#itube-live'];

  // Collect the translucent layers top-down, then composite BOTTOM-up. Doing
  // it top-down and forcing alpha to 1 after the first blend (the obvious
  // version) treats two stacked 5%-accent tints as a fully opaque accent
  // slab, which invents violations that are not on screen.
  const bgOf = (el) => {
    const layers = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      node = node.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };

  const out = [];
  for (const el of document.querySelectorAll('#itube *')) {
    if (OVER_ART.some((s) => el.closest(s))) continue;
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // checkVisibility walks ANCESTORS. The collapsed watch-tools row is
    // opacity:0 on the container while every child still computes opacity:1,
    // so a self-only check reports invisible chrome as failing text.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;
    const bg = bgOf(el);
    const eff = fg[3] < 1 ? over(fg, bg) : fg.slice(0, 3);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(eff, bg);
    if (got < need) {
      out.push({
        sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
        text: (el.textContent || '').trim().slice(0, 40),
        color: cs.color, bg: `rgb(${bg.map(Math.round).join(', ')})`,
        got: +got.toFixed(2), need,
      });
    }
  }
  return out;
};

(async () => {
  const browser = await launchBrowser();
  let bad = 0;
  for (const theme of ['light', 'dark']) {
    const context = await newContext(browser, { prefs: { 'itube-theme': theme } });
    for (const [name, url] of [['home', 'https://www.youtube.com/'],
      ['watch', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
      ['search', 'https://www.youtube.com/results?search_query=blender']]) {
      const { page } = await openPage(context, url);
      await waitForApp(page);
      await page.waitForTimeout(3000);
      const found = await page.evaluate(AUDIT);
      // Dedupe by selector — a grid of 40 cards reports the same class 40×.
      const seen = new Map();
      for (const f of found) if (!seen.has(f.sel)) seen.set(f.sel, f);
      console.log(`\n=== ${theme} / ${name} — ${seen.size} distinct under AA ===`);
      for (const f of seen.values()) console.log(' ', JSON.stringify(f));
      bad += seen.size;
      await page.close();
    }
    await context.close();
  }
  await browser.close();
  console.log('\ntotal distinct violations:', bad);
})();
