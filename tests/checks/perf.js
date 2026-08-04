// DOM-weight guard.
//
// Performance IS the product here: Flyt exists because YouTube's own DOM is
// too heavy. The channel-link feature restructured every card (the video link
// became an overlay anchor, the channel name became its own link), which adds a
// node per card — exactly the kind of change that, repeated over a few
// features, quietly turns this app into the thing it replaced.
//
// So the budget is asserted PER CARD, not per page: a page-wide count moves
// with how many videos YouTube served this hour, but a card's skeleton is a
// property of the code and nothing else. `tests/bench.js` measures the absolute
// numbers (see PERF.md); this check is the ratchet that stops them drifting.
//
// The budgets below have ZERO slack — they are the exact measured skeleton, so
// ONE extra wrapper per card goes red. Parts a card only sometimes carries are
// declared as explicit allowances rather than padding, so an optional part
// cannot silently pay for a structural regression. Adding a node on purpose
// means editing this file on purpose.
'use strict';

const CARD_SPECS = [
  {
    // card, overlay video link, thumb, img, duration, title, channel, meta
    sel: '.c',
    budget: 8,
    optional: [{ sel: '.c-progress', nodes: 2, why: 'resume-progress bar (bar + fill)' }],
  },
  {
    // card, overlay video link, thumb, img, duration, body, title, channel, meta
    sel: '.row',
    budget: 9,
    optional: [{ sel: '.row-desc', nodes: 1, why: 'search-result snippet' }],
  },
  {
    // card, overlay video link, thumb, img, duration, body, title, channel, meta
    sel: '.rc',
    budget: 9,
    optional: [],
  },
  {
    // row, avatar link, img, body, head, author, time, text, show-more, likes
    sel: '.comment-row',
    budget: 10,
    optional: [
      { sel: '.comment-replies-btn', nodes: 1, why: 'view-replies button' },
      // Clickable timestamps/URLs/mentions inside a comment body render as
      // <a> per segment instead of one textContent blob (see A5): the
      // count is per-match, not a flat allowance, because a comment can
      // carry any number of links.
      { sel: '.comment-text a', nodes: 1, why: 'clickable comment link/timestamp/mention' },
    ],
    // Expanded replies nest whole comment rows inside this one; they are their
    // own rows and are budgeted as such, not as part of the parent.
    exclude: '.comment-replies',
  },
];

// Total nodes Flyt's whole UI may use on a page. Deliberately loose (it scales
// with however many cards YouTube served): it exists to catch a structural
// blow-up, not to police normal variation. The per-card budget above is the
// tight one.
const PAGE_NODE_CEILING = {
  home: 400,
  search: 700,
  channel: 900,
  playlist: 700,
  watch: 900,
  unhandled: 200,
};

async function checkNodeBudget(page, pageName) {
  const violations = [];
  const stats = await page.evaluate((specs) => {
    const size = (el) => el.querySelectorAll('*').length + 1;
    const out = { cards: {}, itubeNodes: 0 };
    const itube = document.querySelector('#itube');
    out.itubeNodes = itube ? itube.querySelectorAll('*').length : 0;

    for (const spec of specs) {
      const els = [...document.querySelectorAll('#itube ' + spec.sel)];
      if (!els.length) continue;
      let worst = null;
      for (const el of els) {
        let count = size(el);
        if (spec.exclude) {
          for (const ex of el.querySelectorAll(spec.exclude)) count -= size(ex);
        }
        const raw = count;
        const allowed = [];
        for (const opt of spec.optional || []) {
          const matches = el.querySelectorAll(opt.sel).length;
          if (matches) {
            count -= opt.nodes * matches;
            allowed.push(matches > 1 ? `${opt.why} x${matches}` : opt.why);
          }
        }
        if (!worst || count > worst.count) {
          worst = {
            count,
            raw,
            allowed,
            title: (el.querySelector('.c-title, .row-title, .rc-title, .comment-text')?.textContent || '').trim().slice(0, 40),
          };
        }
      }
      out.cards[spec.sel] = { n: els.length, ...worst };
    }
    return out;
  }, CARD_SPECS);

  for (const spec of CARD_SPECS) {
    const s = stats.cards[spec.sel];
    if (!s) continue;
    if (s.count > spec.budget) {
      violations.push({
        check: 'card-node-budget',
        detail: `${spec.sel} on ${pageName} renders ${s.raw} DOM nodes per card (${s.count} after allowing for ${s.allowed.length ? s.allowed.join(' + ') : 'nothing optional'}), budget is ${spec.budget} — ${s.n} cards on this page, worst: "${s.title}". Per-card weight is the whole point of this app; if the extra node is deliberate, raise the budget in tests/checks/perf.js on purpose.`,
      });
    }
  }

  const ceiling = PAGE_NODE_CEILING[pageName];
  if (ceiling && stats.itubeNodes > ceiling) {
    violations.push({
      check: 'page-node-ceiling',
      detail: `#itube renders ${stats.itubeNodes} DOM nodes on ${pageName}, ceiling is ${ceiling}`,
    });
  }
  return violations;
}

module.exports = { CARD_SPECS, PAGE_NODE_CEILING, checkNodeBudget };
