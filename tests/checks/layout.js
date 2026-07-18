// Generic layout invariants, asserted on GEOMETRY and RELATIONSHIPS between
// elements — not CSS properties. This is the direct response to a real bug
// that shipped: `.body { max-width: 1720px; margin: 0 auto; }` passed every
// property-based check ("sidebar has overflow:auto") while the sidebar was
// visibly floating in the middle of the screen. Every check here reads
// getBoundingClientRect() (or an equivalent computed value) so a bug like
// that fails loudly.
'use strict';

// Runs entirely inside the page. Returns an array of violation strings.
// Kept as one big in-page function so it can be sent to the browser with a
// single page.evaluate() call, and so the whole layout snapshot is read from
// one consistent frame (no back-and-forth serialization mid-measurement).
function layoutInPage() {
  const violations = [];
  const report = (check, detail) => violations.push({ check, detail });

  const ALLOWED_SPACING = new Set([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 32, 40, 48]);

  const itube = document.querySelector('#itube');
  if (!itube) {
    report('itube-present', 'expected #itube to exist, got null');
    return violations;
  }

  const vw = window.innerWidth;

  // Collect every visible element inside #itube. "Visible" = not
  // display:none, not visibility:hidden, non-zero area. This deliberately
  // walks ALL descendants, not a curated list, so unexpected regressions in
  // elements nobody thought to check still get caught.
  const all = Array.from(itube.querySelectorAll('*'));
  const visible = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    visible.push({ el, rect: r, cs });
  }

  const describe = (el) => {
    if (el.id) return '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      return el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).join('.');
    }
    // An anonymous <span> is useless in a violation message. Qualify it with
    // the nearest identifiable ancestor so the report says which one.
    const tag = el.tagName.toLowerCase();
    let anc = el.parentElement;
    while (anc && anc !== itube) {
      if (anc.id) return '#' + anc.id + ' > ' + tag;
      if (anc.className && typeof anc.className === 'string' && anc.className.trim()) {
        return anc.tagName.toLowerCase() + '.' + anc.className.trim().split(/\s+/).join('.') + ' > ' + tag;
      }
      anc = anc.parentElement;
    }
    return tag;
  };

  const q = (sel) => itube.querySelector(sel);
  const rectOf = (sel) => {
    const el = q(sel);
    return el ? el.getBoundingClientRect() : null;
  };

  // --- (a) NO HORIZONTAL OVERFLOW on the major scroll containers ---
  for (const sel of ['#itube', '.sidebar', '.content', '.watch-right']) {
    const el = q(sel);
    if (!el) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      report('no-horizontal-overflow', `${sel} scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`);
    }
  }

  // --- (b) NOTHING OUT OF BOUNDS ---
  for (const { el, rect } of visible) {
    if (rect.left < -1 || rect.right > vw + 1) {
      report('within-viewport', `${describe(el)} left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)} viewportWidth=${vw}`);
    }
  }

  // --- (c) SIDEBAR PINNED — the exact bug that shipped ---
  const sidebarRect = rectOf('.sidebar');
  const contentRect = rectOf('.content');
  if (sidebarRect) {
    if (Math.abs(sidebarRect.left - 0) > 1) {
      report('sidebar-pinned', `expected left=0 got left=${sidebarRect.left.toFixed(1)}`);
    }
    if (Math.abs(sidebarRect.width - 232) > 1) {
      report('sidebar-pinned', `expected width=232 got width=${sidebarRect.width.toFixed(1)}`);
    }
  }
  if (sidebarRect && contentRect) {
    if (Math.abs(contentRect.left - sidebarRect.right) > 1) {
      report('sidebar-pinned', `expected content.left=${sidebarRect.right.toFixed(1)} (sidebar.right) got content.left=${contentRect.left.toFixed(1)}`);
    }
  }

  // --- SIGNED-IN SIDEBAR: rows must not compress when the list overflows ---
  // The test session is LOGGED OUT, so the subscriptions list is empty and the
  // sidebar never overflows. A real signed-in user has 20+ channels, which
  // overflowed the flex column and shrank every nav row from 40px to 17px —
  // a bug invisible to a logged-out run. Simulate the signed-in state.
  const sidebarEl = q('.sidebar');
  if (sidebarEl) {
    const heightsBefore = [...document.querySelectorAll('.nav-row')]
      .map((r) => Math.round(r.getBoundingClientRect().height));

    const injected = [];
    for (let i = 0; i < 30; i++) {
      const a = document.createElement('a');
      a.className = 'nav-chan';
      a.href = '/';
      const img = document.createElement('img');
      img.className = 'nav-chan-avatar';
      const span = document.createElement('span');
      span.textContent = 'Simulated Subscription Channel ' + i;
      a.append(img, span);
      sidebarEl.appendChild(a);
      injected.push(a);
    }

    const overflows = sidebarEl.scrollHeight > sidebarEl.clientHeight;
    const heightsAfter = [...document.querySelectorAll('.nav-row')]
      .map((r) => Math.round(r.getBoundingClientRect().height));
    const chanWraps = [...document.querySelectorAll('.nav-chan span')]
      .some((s) => s.getBoundingClientRect().height > 24);

    for (const el of injected) el.remove();

    if (overflows) {
      const squashed = heightsAfter.some((h, i) => h < (heightsBefore[i] || 40) - 1);
      if (squashed) {
        report('sidebar-overflow-signed-in',
          `nav rows compressed when the sidebar overflows: ${heightsBefore[0]}px -> ${heightsAfter[0]}px (flex children must not shrink)`);
      }
      if (chanWraps) {
        report('sidebar-overflow-signed-in', 'subscription names wrap to multiple lines (must truncate with ellipsis)');
      }
    }
  }

  // --- (d) NO OVERLAP of major regions ---
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  if (sidebarRect && contentRect && intersects(sidebarRect, contentRect)) {
    report('no-region-overlap', `.sidebar (${JSON.stringify(rectStr(sidebarRect))}) overlaps .content (${JSON.stringify(rectStr(contentRect))})`);
  }
  // The top header was removed; the sidebar (with the logo + search) and the
  // content must now both fill from the very top of the viewport — a gap here
  // would mean a stray header offset crept back in.
  if (contentRect && contentRect.top > 2) {
    report('content-fills-top', `with the header removed, .content should start at the top of the viewport, got .content.top=${contentRect.top.toFixed(1)}`);
  }
  if (sidebarRect && sidebarRect.top > 2) {
    report('sidebar-fills-top', `expected .sidebar to start at the top of the viewport, got .sidebar.top=${sidebarRect.top.toFixed(1)}`);
  }

  function rectStr(r) {
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // --- (e) NO COLLAPSED CONTENT ---
  const MIN_SIZE = {
    '.c-thumb': 80,
    '.rc-thumb': 40,
    '.row-thumb': 60,
    '#itube-stage': 200,
    '.watch-meta': 60,
    '.sidebar': 200,
  };
  for (const [sel, minHeight] of Object.entries(MIN_SIZE)) {
    for (const el of itube.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.height <= minHeight) {
        report('no-collapsed-content', `${sel} expected height>${minHeight} got height=${r.height.toFixed(1)}`);
      }
    }
  }

  // --- (f) THUMBNAIL ASPECT ratio ~16:9 ---
  const TARGET_RATIO = 16 / 9;
  for (const sel of ['.c-thumb', '.row-thumb']) {
    for (const el of itube.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const ratio = r.width / r.height;
      if (Math.abs(ratio - TARGET_RATIO) > 0.15) {
        report('thumbnail-aspect', `${sel} expected ratio~${TARGET_RATIO.toFixed(2)} got ratio=${ratio.toFixed(2)} (w=${r.width.toFixed(1)} h=${r.height.toFixed(1)})`);
      }
    }
  }

  // --- (g) GRID ALIGNMENT within the first row of .grid ---
  const grid = q('.grid');
  if (grid) {
    const cards = Array.from(grid.children).filter((c) => c.classList.contains('c'));
    if (cards.length > 1) {
      const rects = cards.map((c) => c.getBoundingClientRect());
      const firstTop = rects[0].top;
      const firstRowRects = rects.filter((r) => Math.abs(r.top - firstTop) <= 2);
      if (firstRowRects.length > 1) {
        const tops = firstRowRects.map((r) => r.top);
        const widths = firstRowRects.map((r) => r.width);
        const minTop = Math.min(...tops), maxTop = Math.max(...tops);
        if (maxTop - minTop > 2) {
          report('grid-alignment', `first-row card tops not aligned: min=${minTop.toFixed(1)} max=${maxTop.toFixed(1)}`);
        }
        const minW = Math.min(...widths), maxW = Math.max(...widths);
        if (maxW - minW > 2) {
          report('grid-alignment', `first-row card widths not aligned: min=${minW.toFixed(1)} max=${maxW.toFixed(1)}`);
        }
        const sorted = [...firstRowRects].sort((a, b) => a.left - b.left);
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].left - sorted[i - 1].right);
        if (gaps.length > 1) {
          const minGap = Math.min(...gaps), maxGap = Math.max(...gaps);
          if (maxGap - minGap > 2) {
            report('grid-alignment', `first-row card gaps not equal: min=${minGap.toFixed(1)} max=${maxGap.toFixed(1)} gaps=[${gaps.map((g) => g.toFixed(1)).join(',')}]`);
          }
        }
      }
    }
  }

  // --- (h) SPACING SCALE ("healthy paddings") ---
  // Negative margins are a deliberate, common pattern here (e.g. `.c { padding:
  // 8px; margin: -8px }` expands the hit-area and offsets it back) — the sign
  // encodes direction, not a different spacing decision, so we compare
  // magnitude.
  const SPACING_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap'];
  // `margin: 0 auto` centering resolves to a content-dependent pixel value in
  // getComputedStyle — that's a geometric relationship (centered in its
  // container), not a spacing-scale decision. Rather than guess from
  // geometry, read the actually-authored rules: any selector that declares
  // marginLeft/marginRight/margin as `auto` is centering, not spacing, so
  // elements matching it are exempt on that axis.
  const autoMarginSelectors = { left: [], right: [] };
  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.style) continue;
        const ml = rule.style.marginLeft;
        const mr = rule.style.marginRight;
        const shorthand = rule.style.margin;
        if (ml === 'auto' || (shorthand && /(^|\s)auto(\s|$)/.test(shorthand))) autoMarginSelectors.left.push(rule.selectorText);
        if (mr === 'auto' || (shorthand && /(^|\s)auto(\s|$)/.test(shorthand))) autoMarginSelectors.right.push(rule.selectorText);
      }
    }
  } catch (e) {}
  const matchesAny = (el, selectors) => {
    for (const sel of selectors) {
      try { if (sel && el.matches(sel)) return true; } catch (e) {}
    }
    return false;
  };
  const isAutoCentered = (el, prop) => {
    if (prop === 'marginLeft') return matchesAny(el, autoMarginSelectors.left);
    if (prop === 'marginRight') return matchesAny(el, autoMarginSelectors.right);
    return false;
  };
  for (const { el, cs } of visible) {
    for (const prop of SPACING_PROPS) {
      const raw = cs[prop];
      if (!raw || raw === 'normal') continue;
      const px = parseFloat(raw);
      if (!isFinite(px) || px === 0) continue;
      if (isAutoCentered(el, prop)) continue;
      const rounded = Math.round(Math.abs(px));
      if (!ALLOWED_SPACING.has(rounded)) {
        report('spacing-scale', `${describe(el)} ${prop}=${raw} not in allowed spacing scale`);
      }
    }
  }

  // --- (i) LEGIBILITY: real WCAG contrast, not string equality ---
  // The previous version compared computed colour STRINGS for equality, which
  // can never fire: `rgb(235, 235, 245)` is not the string `rgba(255, 255,
  // 255, 0.05)`, so grey-on-grey at 1.2:1 sailed through. Composite the text
  // colour (and every translucent background between it and an opaque one)
  // and compute the actual ratio.
  const parseColor = (str) => {
    if (!str) return null;
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !isFinite(n))) return null;
    const a = parts.length > 3 && isFinite(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a };
  };
  // `over` = the colour underneath. Standard source-over compositing.
  const composite = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  // Walk up compositing every translucent background until an opaque one is
  // reached. The page ground is the document background (the app is dark), so
  // fall back to that rather than assuming white.
  const rootBg = parseColor(getComputedStyle(document.documentElement).backgroundColor)
    || { r: 0, g: 0, b: 0, a: 1 };
  const effectiveBg = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        stack.push(bg);
        if (bg.a >= 1) break;
      }
      node = node.parentElement;
    }
    let acc = rootBg.a >= 1 ? rootBg : { r: 0, g: 0, b: 0, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) acc = composite(stack[i], acc);
    return acc;
  };
  const luminance = ({ r, g, b }) => {
    const chan = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const contrastRatio = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };
  let lowContrast = 0;
  for (const { el, cs } of visible) {
    if (lowContrast >= 5) break;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) continue;
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    // Text is itself painted over its background, so alpha-composite it too:
    // `color: rgba(255,255,255,.5)` on black is mid-grey, not white.
    const text = composite(fg, bg);
    const ratio = contrastRatio(text, bg);
    // WCAG AA: large text (>=24px, or >=18.66px bold) needs 3:1, everything
    // else needs 4.5:1.
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = isLarge ? 3 : 4.5;
    if (ratio < required) {
      report('legibility', `${describe(el)} contrast ${ratio.toFixed(2)}:1 is below the required ${required}:1 (color=${cs.color} over effective background rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}), fontSize=${cs.fontSize} weight=${cs.fontWeight})`);
      lowContrast++;
    }
  }

  // --- (j) TEXT NOT CLIPPED ---
  // Every one of these selectors HAS a line-clamp, so the old `if (hasClamp)
  // continue;` skipped essentially everything it claimed to cover. A clamp is
  // not a licence to render badly: the box must be tall enough for the lines
  // it actually shows (no half-line sheared off at the bottom), and if the
  // text overflows it must be showing the FULL clamp allowance — a 2-line
  // clamp that only has room for 1.4 lines is a bug.
  // `.rc-title` (the related rail) belongs here too: it is clamped exactly like
  // the others, and on a watch page it is the ONLY one of these that renders in
  // bulk — without it this check inspects almost nothing on the app's main page.
  for (const sel of ['.c-title', '.row-title', '.rc-title', '.watch-title', '.comment-text']) {
    for (const el of Array.from(itube.querySelectorAll(sel)).slice(0, 8)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const clampRaw = cs.webkitLineClamp;
      const clamp = clampRaw && clampRaw !== 'none' ? parseInt(clampRaw, 10) : 0;
      const overflows = el.scrollHeight > el.clientHeight + 2;

      if (!clamp) {
        if (overflows) {
          report('text-not-clipped', `${sel} scrollHeight=${el.scrollHeight} > clientHeight=${el.clientHeight} and no line-clamp set`);
        }
        continue;
      }

      // Height available for text = content box (clientHeight already excludes
      // borders/scrollbars, so subtract padding).
      const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const contentH = el.clientHeight - padding;
      const lh = parseFloat(cs.lineHeight);
      if (!isFinite(lh) || lh <= 0) continue; // `line-height: normal` — no reliable line metric to assert on
      const lines = contentH / lh;

      if (lines < 0.9) {
        report('text-not-clipped', `${sel} has line-clamp:${clamp} but only ${lines.toFixed(2)} line(s) of height (contentHeight=${contentH.toFixed(1)} lineHeight=${lh}) — the text is clipped to nothing`);
        continue;
      }
      // A partial line means the bottom row of glyphs is sheared in half.
      const fractional = Math.abs(lines - Math.round(lines));
      if (fractional > 0.15) {
        report('text-not-clipped', `${sel} renders ${lines.toFixed(2)} lines — not a whole number, so the last line is cut mid-glyph (contentHeight=${contentH.toFixed(1)} lineHeight=${lh} clamp=${clamp})`);
        continue;
      }
      // If the text is long enough to be truncated, the box must be giving it
      // every line the clamp promised.
      if (overflows && Math.round(lines) < clamp) {
        report('text-not-clipped', `${sel} is truncated at ${Math.round(lines)} line(s) but line-clamp is ${clamp} — the box is shorter than the clamp it declares (contentHeight=${contentH.toFixed(1)} lineHeight=${lh})`);
      }
    }
  }

  // --- (k) SURFACE CLIPPED BY AN OVERFLOW ANCESTOR (inline axis) ---
  // The bug this catches: `.rc { padding: 6px; margin: -6px }` bleeds the
  // hover pill outward, but `.watch-right` is a scroll container with no
  // horizontal padding and overflow clips at the PADDING box — so the left
  // 6px of the pill was shaved off while top/bottom kept their inset, and the
  // thumbnail sat flush against the pill's left edge. Any element that paints
  // a surface worth preserving (background, rounded corners, or an outward
  // negative inline margin) must fit inside the padding box of its nearest
  // horizontal clipper. Vertical overflow is NOT checked: scrolling down a
  // scroll container is the whole point of one.
  //
  // The exemption here is deliberately NARROW: only the things that genuinely
  // OVERLAY the video (the bar itself, the OSD cue, the overflow menu, the
  // <video>) are out-of-flow surfaces that legitimately sit on the stage's
  // clip boundary. Everything laid out INSIDE the bar — buttons, the seek bar,
  // the volume slider, the quality select — is in normal flow and must obey
  // the same rule as any other card surface. (The old version exempted every
  // descendant of #itube-bar and #itube-stage, i.e. the entire player.)
  const stage = document.querySelector('#itube-stage');
  const isPlayerOverlay = (el, cs) => {
    if (!stage || !stage.contains(el)) return false;
    if (el.tagName === 'VIDEO') return true;
    return cs.position === 'absolute' || cs.position === 'fixed';
  };

  const paintsSurface = (cs) => {
    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
    if (parseFloat(cs.borderRadius) > 0) return true;
    if (parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0) return true;
    return false;
  };

  // Nearest ancestor that clips horizontally, searching up to (and including)
  // #itube. `overflow-x: visible` is the only non-clipping value.
  const clipperOf = (el) => {
    let node = el.parentElement;
    while (node) {
      if (getComputedStyle(node).overflowX !== 'visible') return node;
      if (node === itube) return null;
      node = node.parentElement;
    }
    return null;
  };

  let clipped = 0;
  for (const { el, rect, cs } of visible) {
    if (clipped >= 3) break;
    if (cs.position === 'fixed') continue;
    if (isPlayerOverlay(el, cs)) continue;
    if (!paintsSurface(cs)) continue;
    const clipper = clipperOf(el);
    if (!clipper) continue;
    const cr = clipper.getBoundingClientRect();
    const ccs = getComputedStyle(clipper);
    const boxLeft = cr.left + parseFloat(ccs.borderLeftWidth || 0);
    const boxRight = cr.right - parseFloat(ccs.borderRightWidth || 0);
    if (rect.left < boxLeft - 1) {
      report('surface-clipped', `${describe(el)} is clipped by ${describe(clipper)} on the left: element left=${rect.left.toFixed(1)} clip box left=${boxLeft.toFixed(1)} (a padded surface whose bleed is cut off renders with asymmetric insets)`);
      clipped++;
      continue;
    }
    if (rect.right > boxRight + 1) {
      report('surface-clipped', `${describe(el)} is clipped by ${describe(clipper)} on the right: element right=${rect.right.toFixed(1)} clip box right=${boxRight.toFixed(1)} (a padded surface whose bleed is cut off renders with asymmetric insets)`);
      clipped++;
    }
  }

  // --- (l) INSET SYMMETRY on card surfaces ---
  // Independent of cause: whatever the reason (clipping, a stray one-sided
  // margin, an asymmetric padding shorthand), the rendered gap between a card
  // and its content must look the same on all four sides. Measured from the
  // union box of the card's laid-out children, so it reflects what a human
  // actually sees rather than what the CSS claims. Only the first 8 of each
  // selector are inspected — a 40-card grid is homogeneous and would just
  // repeat the same violation 40 times.
  let asym = 0;
  for (const sel of ['.c', '.rc', '.row']) {
    for (const el of Array.from(itube.querySelectorAll(sel)).slice(0, 8)) {
      if (asym >= 3) break;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const kids = Array.from(el.children).filter((k) => {
        const kcs = getComputedStyle(k);
        if (kcs.display === 'none') return false;
        if (kcs.position === 'absolute' || kcs.position === 'fixed') return false;
        const kr = k.getBoundingClientRect();
        return kr.width > 0 && kr.height > 0;
      });
      if (!kids.length) continue;

      const rects = kids.map((k) => k.getBoundingClientRect());
      const union = {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
      const l = union.left - rect.left;
      const r = rect.right - union.right;
      const t = union.top - rect.top;
      const b = rect.bottom - union.bottom;

      const gaps = [l, r, t, b];
      const spread = Math.max(...gaps) - Math.min(...gaps);
      // 3px tolerance: CSS-grid column math rounds a card's box by a sub-pixel or
      // two depending on the exact container width (e.g. whether a 16px scrollbar
      // is present), which is not the clipped-bleed / stretched-card asymmetry
      // (tens of px) this check exists to catch.
      if (spread > 3) {
        report('inset-symmetry', `${describe(el)} has asymmetric insets: left=${l.toFixed(1)} right=${r.toFixed(1)} top=${t.toFixed(1)} bottom=${b.toFixed(1)} (all four should match the padding)`);
        asym++;
      }
    }
    if (asym >= 3) break;
  }

  // --- (m) PLAYER BAR CONTROLS ARE REAL ---
  // Every invariant above skips elements that are display:none,
  // visibility:hidden or zero-area. #itube-bar is `visibility: hidden` until
  // #itube-stage gets `.show`, and visibility INHERITS — so for as long as the
  // bar was hidden, every control inside it was skipped by within-viewport,
  // spacing-scale, legibility, text-not-clipped and inset-symmetry. The
  // project's signature feature had zero layout coverage.
  //
  // runLayoutChecks() forces `.show` on before calling this, so the controls
  // are now in `visible` and covered by everything above. This check asserts
  // that they really are there and really are non-zero — otherwise a bar that
  // failed to mount would once again make every invariant pass vacuously.
  const bar = document.querySelector('#itube-bar');
  if (stage) {
    if (!bar) {
      report('player-bar-controls', 'expected #itube-bar to exist on a watch page, got null');
    } else {
      const barCs = getComputedStyle(bar);
      if (barCs.visibility === 'hidden' || barCs.display === 'none') {
        report('player-bar-controls', `#itube-bar is still ${barCs.display === 'none' ? 'display:none' : 'visibility:hidden'} after #itube-stage.show was applied — the layout invariants above cannot see any control`);
      }
      const barRect = bar.getBoundingClientRect();
      for (const id of ['itube-play', 'itube-seek', 'itube-vol', 'itube-theater']) {
        const ctl = document.getElementById(id);
        if (!ctl) {
          report('player-bar-controls', `expected #${id} to exist inside the player bar, got null`);
          continue;
        }
        const ccs = getComputedStyle(ctl);
        if (ccs.display === 'none' || ccs.visibility === 'hidden') {
          report('player-bar-controls', `#${id} is not visible with the bar shown (display=${ccs.display} visibility=${ccs.visibility})`);
          continue;
        }
        const cr = ctl.getBoundingClientRect();
        if (cr.width <= 0 || cr.height <= 0) {
          report('player-bar-controls', `#${id} has zero area (w=${cr.width.toFixed(1)} h=${cr.height.toFixed(1)}) — it cannot be clicked`);
          continue;
        }
        if (cr.left < barRect.left - 1 || cr.right > barRect.right + 1 || cr.top < barRect.top - 1 || cr.bottom > barRect.bottom + 1) {
          report('player-bar-controls', `#${id} escapes the player bar box: control=${JSON.stringify(rectStr(cr))} bar=${JSON.stringify(rectStr(barRect))}`);
        }
      }
    }
  }

  // --- (n) VERTICAL CENTERING IN CENTERED FLEX ROWS ---
  // `align-items: center` centers the child's MARGIN box, not its border box.
  // So a stray margin (typically left over from a previous layout, e.g. a
  // sidebar logo that kept `margin-bottom: 12px` after moving into the header)
  // silently pushes the visible element off-centre by half the margin, while
  // every property-based check still reports a perfectly centered row.
  // That bug shipped. This asserts the RESULT: in a single-line centered flex
  // row, each child's visual centre must coincide with the row's content-box
  // centre.
  const centered = [];
  for (const { el, cs } of visible) {
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
    if (cs.alignItems !== 'center') continue;
    if (cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse') continue;
    if (cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse') continue;
    centered.push(el);
  }

  let offCentre = 0;
  for (const row of centered) {
    if (offCentre >= 3) break;
    const rowRect = row.getBoundingClientRect();
    const rcs = getComputedStyle(row);
    // Centre of the CONTENT box, so the row's own padding/border don't skew it.
    const top = rowRect.top + parseFloat(rcs.borderTopWidth) + parseFloat(rcs.paddingTop);
    const bottom = rowRect.bottom - parseFloat(rcs.borderBottomWidth) - parseFloat(rcs.paddingBottom);
    const rowMid = (top + bottom) / 2;
    const rowInner = bottom - top;
    if (!(rowInner > 0)) continue;

    for (const child of row.children) {
      const ccs = getComputedStyle(child);
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      if (ccs.position === 'absolute' || ccs.position === 'fixed') continue;
      // Only children that are free to be centred: one that fills (or
      // overflows) the row has no slack, and `align-self` opts out by design.
      if (ccs.alignSelf !== 'auto' && ccs.alignSelf !== 'center') continue;
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) continue;
      if (cr.height >= rowInner - 1) continue;

      const childMid = (cr.top + cr.bottom) / 2;
      const delta = childMid - rowMid;
      if (Math.abs(delta) > 1.5) {
        offCentre++;
        report('vertical-centering',
          `${describe(child)} is ${delta > 0 ? 'below' : 'above'} the centre of ${describe(row)} by ${Math.abs(delta).toFixed(1)}px `
          + `(marginTop=${ccs.marginTop} marginBottom=${ccs.marginBottom} — align-items:center centres the MARGIN box, so a stray margin offsets the visible element)`);
        if (offCentre >= 3) break;
      }
    }
  }

  return violations;
}

// The player bar and every control inside it are `visibility: hidden` until
// #itube-stage carries the `show` class (it appears on mousemove and
// auto-hides ~2.8s later). Since layoutInPage() — correctly — ignores hidden
// elements, running it as-is means the play button, seek bar, volume slider
// and overflow menu are never measured at all. Force the bar visible for the
// duration of the measurement, then put the class back the way we found it.
async function runLayoutChecks(page) {
  const forced = await page.evaluate(() => {
    const stage = document.getElementById('itube-stage');
    if (!stage || stage.classList.contains('show')) return false;
    stage.classList.add('show');
    return true;
  });
  try {
    return await page.evaluate(layoutInPage);
  } finally {
    if (forced) {
      await page.evaluate(() => {
        const stage = document.getElementById('itube-stage');
        if (stage) stage.classList.remove('show');
      });
    }
  }
}

module.exports = { runLayoutChecks };
