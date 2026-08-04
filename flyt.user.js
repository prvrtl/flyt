// ==UserScript==
// @name         Flyt
// @name:en      Flyt
// @namespace    https://github.com/prvrtl/flyt
// @version      0.1.0
// @description  Flyt — a fast, lightweight YouTube. Renders its own lean UI from YouTube's data: many times faster, calmer, no ads, no clutter.
// @description:en Flyt — a fast, lightweight YouTube. Renders its own lean UI from YouTube's data: many times faster, calmer, no ads, no clutter.
// @author       prvrtl
// @license      GPL-3.0-or-later
// @homepageURL  https://prvrtl.github.io/flyt/
// @supportURL   https://github.com/prvrtl/flyt/issues
// @updateURL    https://raw.githubusercontent.com/prvrtl/flyt/main/flyt.user.js
// @downloadURL  https://raw.githubusercontent.com/prvrtl/flyt/main/flyt.user.js
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2064%2064%27%3E%3Cdefs%3E%3ClinearGradient%20id%3D%27g%27%20x1%3D%270%27%20y1%3D%270%27%20x2%3D%271%27%20y2%3D%271%27%3E%3Cstop%20offset%3D%270%27%20stop-color%3D%27%233ddb8f%27%2F%3E%3Cstop%20offset%3D%27.48%27%20stop-color%3D%27%2322c3c9%27%2F%3E%3Cstop%20offset%3D%271%27%20stop-color%3D%27%234a8fe0%27%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2764%27%20height%3D%2764%27%20rx%3D%2714%27%20fill%3D%27url%28%23g%29%27%2F%3E%3Cpath%20d%3D%27M28%2011.6v40.8l28-20.4z%27%20fill%3D%27%23fff%27%2F%3E%3Crect%20x%3D%275.6%27%20y%3D%2717.2%27%20width%3D%2715.6%27%20height%3D%277.2%27%20rx%3D%273.6%27%20fill%3D%27%23fff%27%2F%3E%3Crect%20x%3D%275.6%27%20y%3D%2739.6%27%20width%3D%2715.6%27%20height%3D%277.2%27%20rx%3D%273.6%27%20fill%3D%27%23fff%27%2F%3E%3C%2Fsvg%3E
// @match        https://www.youtube.com/*
// @exclude      https://www.youtube.com/embed/*
// @exclude      https://www.youtube.com/live_chat*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // Exactly one copy may run. Two userscript copies installed side by side
  // (an old build plus a current one) both boot, both bind keyboard handlers,
  // and their playback toggles fight — which presents as bugs that "survive"
  // every fix because the old copy is still doing the old thing. The version
  // line also ends the guessing about which build a browser actually runs.
  const FLYT_VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '0.1.0';
  if (window.__flytBooted) {
    console.warn('[flyt] v' + FLYT_VERSION + ': another copy (v' + window.__flytBooted + ') is already running on this page — this one is NOT starting. Remove duplicate userscripts.');
    return;
  }
  window.__flytBooted = FLYT_VERSION;
  console.info('[flyt] v' + FLYT_VERSION);

  // Neutralize the player's telemetry at the source: answer these with a
  // fake success instead of letting them reach the network. Quieter than a
  // content blocker (the player sees "delivered" and never retries — with a
  // blocker it fails loudly and keeps trying) and it holds for users without
  // one. Deliberately NOT blocked: /api/stats/watchtime and playback — they
  // record watch history and resume positions, which are user-facing
  // features, not telemetry.
  const TELEMETRY_URL_RE = /doubleclick\.net\/|googlesyndication\.com\/|googleadservices\.com\/|google-analytics\.com\/|\/api\/stats\/(qoe|atr|ads|delayplay)\b|\/ptracking\b|\/youtubei\/v1\/log_event|\/pagead\//;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      // fetch takes string | URL | Request. A URL object has no `.url`, only
      // `.href`, so the old `input.url` read undefined for it and every
      // fetch(new URL(...)) walked straight past this filter. `'url' in input`
      // rather than `instanceof Request` because it narrows for the checker and
      // stays duck-typed, so a Request minted in another realm still matches.
      const url = typeof input === 'string' ? input
        : input && 'url' in input ? input.url
        : input ? String(input) : '';
      if (TELEMETRY_URL_RE.test(url)) return Promise.resolve(new Response(null, { status: 204 }));
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { if (TELEMETRY_URL_RE.test(String(url))) return true; } catch (e) {}
      return origBeacon(url, data);
    };
  }

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // Theme. Declared up here with the other prefs because the boot overlay —
  // which mounts at document-start, long before #itube exists — has to pick a
  // background, and a light-mode user should not get a black flash first.
  // 'dark' is the default rather than 'system': Flyt has always been dark, and
  // silently flipping every existing install on an update is not an upgrade.
  const THEME_MODES = ['system', 'dark', 'light'];
  const themeMode = () => { const t = lsGet('itube-theme'); return THEME_MODES.includes(t) ? t : 'dark'; };
  const systemPrefersLight = () => {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
  };
  const themeIsLight = (mode) => mode === 'light' || (mode === 'system' && systemPrefersLight());

  // Action buttons confirm BEFORE they change.
  //
  // Every one of these used to flip optimistically: Follow said "Following" the
  // instant you clicked, then silently reverted if YouTube refused. On a slow
  // or failed call that is a button that lies — you look away, look back, and
  // it says the opposite of what you asked for, with nothing to indicate a
  // round trip ever happened. Now the label holds still, a ring spins around
  // the control, and the state only moves once the server has agreed.
  const runPending = async (btn, run) => {
    if (!btn || btn.classList.contains('is-pending')) return undefined;
    btn.classList.add('is-pending');
    btn.setAttribute('aria-busy', 'true');
    try {
      return await run();
    } finally {
      btn.classList.remove('is-pending');
      btn.removeAttribute('aria-busy');
    }
  };

  const itubeOff = () => lsGet('itube-off') === '1';
  const setItubeOff = (off) => { lsSet('itube-off', off ? '1' : '0'); location.reload(); };
  const theaterPref = () => lsGet('itube-theater') === '1';
  const setTheaterPref = (on) => lsSet('itube-theater', on ? '1' : '0');
  const sponsorSkipOn = () => lsGet('itube-skip-sponsors') !== '0';
  const setSponsorSkipOn = (on) => lsSet('itube-skip-sponsors', on ? '1' : '0');
  const dislikesEnabled = () => lsGet('itube-dislikes') !== '0';
  const setDislikesEnabled = (on) => lsSet('itube-dislikes', on ? '1' : '0');
  const transcriptEnabled = () => lsGet('itube-transcript') === '1';
  const setTranscriptEnabled = (on) => lsSet('itube-transcript', on ? '1' : '0');
  const savedBoost = () => { const v = parseFloat(lsGet('itube-boost')); return v >= 1 && v <= 2 ? v : 1; };
  const setSavedBoost = (b) => lsSet('itube-boost', String(b));

  if (itubeOff()) {
    const mountReenable = () => {
      if (!document.body) { requestAnimationFrame(mountReenable); return; }
      if (document.getElementById('itube-reenable')) return;
      const b = document.createElement('button');
      b.id = 'itube-reenable';
      b.type = 'button';
      b.textContent = 'Flyt';
      b.title = 'Re-enable Flyt';
      const st = b.style;
      st.position = 'fixed';
      st.top = '11px';
      st.left = '196px';
      st.zIndex = '2147483647';
      st.height = '30px';
      st.padding = '0 12px';
      st.borderRadius = '8px';
      st.border = '1px solid rgba(34, 195, 201, .5)';
      st.background = 'rgba(6, 7, 12, .92)';
      st.color = '#22c3c9';
      st.font = '600 12px -apple-system, system-ui, sans-serif';
      st.cursor = 'pointer';
      st.transition = 'background .16s ease, box-shadow .16s ease';
      const reenableStyle = document.createElement('style');
      reenableStyle.textContent = '#itube-reenable:hover { background: rgba(34, 195, 201, .16); box-shadow: 0 0 0 1px rgba(34, 195, 201, .5); }';
      document.head.appendChild(reenableStyle);
      b.addEventListener('click', () => setItubeOff(false));
      document.body.appendChild(b);
    };
    mountReenable();
    return;
  }

  const NATIVE_ROUTE_RE = /^\/(account|paid_memberships|reporthistory|purchases|signin|logout|upload|create_channel|redirect)(?:[_/]|$)/;
  if (NATIVE_ROUTE_RE.test(location.pathname)) {
    // Outside Flyt's scope: leave YouTube's native UI in place, but the moment
    // a navigation leaves that scope (e.g. opening a video), reload so Flyt
    // boots on the new route — a Flyt-scope page must never render in the
    // original UI.
    const reloadIfLeftNativeScope = () => { if (!NATIVE_ROUTE_RE.test(location.pathname)) location.reload(); };
    window.addEventListener('yt-navigate-finish', reloadIfLeftNativeScope);
    window.addEventListener('popstate', reloadIfLeftNativeScope);
    return;
  }

  const CHANNEL_PATH_RE = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/.*)?$/;
  const FEED_BROWSE = {
    '/feed/subscriptions': { browseId: 'FEsubscriptions', heading: 'Subscriptions' },
    '/feed/history': { browseId: 'FEhistory', heading: 'Watch history' },
    '/feed/library': { browseId: 'FElibrary', heading: 'Library' },
    '/feed/trending': { browseId: 'FEtrending', heading: 'Trending' },
  };

  const SVGNS = 'http://www.w3.org/2000/svg';
  const icon = (nodes) => {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    // 16, not 17: 1:1 viewBox mapping keeps strokes crisp, and even sizing
    // keeps icon+gap arithmetic on the spacing grid (24+16+12 = label x 52).
    s.setAttribute('width', '16');
    s.setAttribute('height', '16');
    for (const [tag, attrs] of nodes) {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      s.appendChild(n);
    }
    return s;
  };
  const ICONS = {
    home: () => icon([['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linejoin': 'round', d: 'M2.2 7.2 8 2.6l5.8 4.6V13a.9.9 0 0 1-.9.9H3.1a.9.9 0 0 1-.9-.9z' }]]),
    subs: () => icon([
      ['rect', { x: '1.6', y: '3.4', width: '12.8', height: '9.2', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75' }],
      ['path', { fill: 'currentColor', d: 'M6.7 5.9 10.6 8l-3.9 2.1z' }],
    ]),
    later: () => icon([
      ['circle', { cx: '8', cy: '8', r: '5.9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', 'stroke-linejoin': 'round', d: 'M8 4.6V8l2.4 1.5' }],
    ]),
    playlists: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', d: 'M2.2 4h8.6M2.2 7.2h8.6M2.2 10.4h4.6' }],
      ['path', { fill: 'currentColor', d: 'M9.6 8.6l4.6 2.7-4.6 2.7z' }],
    ]),
    history: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M2.6 6.2A5.8 5.8 0 1 1 2.2 8' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', 'stroke-linejoin': 'round', d: 'M1.2 3.6v2.8h2.8' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', 'stroke-linejoin': 'round', d: 'M8 5.1V8l2.1 1.3' }],
    ]),
    following: () => icon([
      ['circle', { cx: '5.6', cy: '5.4', r: '2.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M1.6 13.2c0-2.3 1.8-3.8 4-3.8s4 1.5 4 3.8' }],
      ['circle', { cx: '11.2', cy: '5.8', r: '1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M9.8 9.7c1.7.2 2.9 1.4 2.9 3.1' }],
    ]),
    play: () => icon([['path', { fill: 'currentColor', d: 'M4 2.5v11l9-5.5z' }]]),
    pause: () => icon([['path', { fill: 'currentColor', d: 'M4 2h3v12H4zM9 2h3v12H9z' }]]),
    vol: () => icon([
      ['path', { fill: 'currentColor', d: 'M2 6h3l4-3.5v11L5 10H2z' }],
      ['path', { stroke: 'currentColor', 'stroke-width': '1.65', fill: 'none', d: 'M11 5.5a3 3 0 010 5' }],
    ]),
    muted: () => icon([
      ['path', { fill: 'currentColor', d: 'M2 6h3l4-3.5v11L5 10H2z' }],
      ['path', { stroke: 'currentColor', 'stroke-width': '1.65', d: 'M11 6l4 4m0-4l-4 4' }],
    ]),
    pip: () => icon([
      ['rect', { x: '1.5', y: '3', width: '13', height: '10', rx: '1.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65' }],
      ['rect', { x: '8', y: '8', width: '5', height: '3.5', rx: '0.8', fill: 'currentColor' }],
    ]),
    fs: () => icon([['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', d: 'M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4' }]]),
    camera: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round', d: 'M2 5.2h2.4l1-1.6h5.2l1 1.6H14a.8.8 0 0 1 .8.8v6.4a.8.8 0 0 1-.8.8H2a.8.8 0 0 1-.8-.8V6a.8.8 0 0 1 .8-.8z' }],
      ['circle', { cx: '8', cy: '9', r: '2.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
    ]),
    theater: () => icon([
      ['rect', { x: '1.5', y: '4', width: '13', height: '8', rx: '1.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
    ]),
    loop: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M4 5.5h6a2.6 2.6 0 0 1 2.6 2.6M12 10.5H6A2.6 2.6 0 0 1 3.4 7.9' }],
      ['path', { fill: 'currentColor', d: 'M9.4 3.1 12.5 5.5 9.4 7.9z' }],
      ['path', { fill: 'currentColor', d: 'M6.6 12.9 3.5 10.5 6.6 8.1z' }],
    ]),
    seekFwd: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M3.4 8a4.6 4.6 0 1 1 1.3 3.2' }],
      ['path', { fill: 'currentColor', d: 'M5.4 12.6 3.6 10.4 2 12.3z' }],
    ]),
    seekBack: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M3.4 8a4.6 4.6 0 1 1 1.3 3.2', transform: 'translate(16,0) scale(-1,1)' }],
      ['path', { fill: 'currentColor', d: 'M5.4 12.6 3.6 10.4 2 12.3z', transform: 'translate(16,0) scale(-1,1)' }],
    ]),
    speed: () => icon([
      ['circle', { cx: '8', cy: '8', r: '5.9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M8 8 10.6 5.4' }],
    ]),
    prev: () => icon([
      ['path', { fill: 'currentColor', d: 'M4 2.5h1.6v11H4z' }],
      ['path', { fill: 'currentColor', d: 'M13.5 2.5v11L6.5 8z' }],
    ]),
    next: () => icon([
      ['path', { fill: 'currentColor', d: 'M10.4 2.5H12v11h-1.6z' }],
      ['path', { fill: 'currentColor', d: 'M2.5 2.5v11L9.5 8z' }],
    ]),
    chevron: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', 'stroke-linejoin': 'round', d: 'M4.5 6.2 8 9.7l3.5-3.5' }],
    ]),
    link: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M6.6 9.4 9.4 6.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', d: 'M7.6 4.6 8.9 3.3a2.3 2.3 0 0 1 3.3 3.3l-1.3 1.3' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', d: 'M8.4 11.4 7.1 12.7a2.3 2.3 0 0 1-3.3-3.3l1.3-1.3' }],
    ]),
    thumbsUp: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M4.5 9.75 8 6.25l3.5 3.5' }],
    ]),
    thumbsDown: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M4.5 6.25 8 9.75l3.5-3.5' }],
    ]),
    save: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linejoin': 'round', d: 'M4 2.6h8v10.8l-4-2.8-4 2.8z' }],
    ]),
    share: () => icon([
      ['circle', { cx: '12', cy: '3.6', r: '1.7', fill: 'currentColor' }],
      ['circle', { cx: '12', cy: '12.4', r: '1.7', fill: 'currentColor' }],
      ['circle', { cx: '4', cy: '8', r: '1.7', fill: 'currentColor' }],
      ['path', { stroke: 'currentColor', 'stroke-width': '1.65', fill: 'none', d: 'M5.5 7.1 10.5 4.3M5.5 8.9l5 2.8' }],
    ]),
    plus: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', d: 'M8 3.6v8.8M3.6 8h8.8' }],
    ]),
    check: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'square', 'stroke-linejoin': 'round', d: 'M3 8.3 6.3 11.6 13 4.5' }],
    ]),
    tools: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', d: 'M2 4.5h5M11 4.5h3M2 11.5h3M8 11.5h6' }],
      ['circle', { cx: '9', cy: '4.5', r: '1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['circle', { cx: '6', cy: '11.5', r: '1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
    ]),
    settings: () => icon([
      ['circle', { cx: '8', cy: '8', r: '2.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round', d: 'M8 1.4v1.7M8 12.9v1.7M14.6 8h-1.7M3.1 8H1.4M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2M12.7 12.7l-1.2-1.2M4.5 4.5 3.3 3.3' }],
    ]),
    expand: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', d: 'M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4' }],
    ]),
    close: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }],
    ]),
    // Barred circle = "don't recommend this channel". Deliberately NOT a
    // cross: the cross next to it means "not this video", and two crosses
    // would read as the same action twice.
    block: () => icon([
      ['circle', { cx: '8', cy: '8', r: '5.9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', d: 'M3.8 3.8l8.4 8.4' }],
    ]),
    unfollow: () => icon([
      ['circle', { cx: '6.2', cy: '5.4', r: '2.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', d: 'M1.7 13.3c0-2.6 2-4.3 4.5-4.3.9 0 1.7.2 2.4.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', d: 'M10.4 11.6h4' }],
    ]),
    desc: () => icon([
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', d: 'M2.4 4.4h11.2M2.4 8h11.2M2.4 11.6h7.2' }],
    ]),
    transcript: () => icon([
      ['rect', { x: '1.6', y: '3.4', width: '12.8', height: '9.2', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', d: 'M4 6.4h3.2M4 9.6h5.6' }],
    ]),
  };

  const pillButton = (iconFn, label, className) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (className) btn.className = className;
    const iconEl = iconFn ? iconFn() : null;
    if (iconEl) btn.appendChild(iconEl);
    const labelEl = label === null ? null : document.createElement('span');
    if (labelEl) {
      labelEl.textContent = label;
      btn.appendChild(labelEl);
    }
    return { btn, icon: iconEl, label: labelEl };
  };

  // Two-step open/close, same shape as wirePopup: `.open` flips `display`,
  // then `.show` (next frame) drives the scrim/panel opacity+scale, and the
  // close path holds `.open` for the length of the fade so the exit is
  // visible. Settings and the command palette used to appear and vanish with
  // no animation at all while the description/transcript popups faded.
  const OVERLAY_FADE_MS = 140;
  const POPUP_FADE_MS = 140;
  // Run `fn` once, on whichever comes FIRST: the element's real transitionend
  // for `prop`, or a fallback deadline.
  //
  // Sequences that hand off between two animations used to be gated on
  // setTimeout alone, which is wrong in both directions. Late: under
  // main-thread load the timer slips and the app sits mid-sequence (an opaque
  // theater scrim up with the layout not yet swapped). Early: the timer starts
  // counting when it is armed, but the transition only starts on the next
  // frame, so a delayed rAF meant the handoff could fire while the scrim was
  // still translucent — showing the very flash the scrim exists to hide.
  // Driving off the transition makes the common case exact; the timer stays
  // only as the guarantee that it fires at all (a transition that never runs
  // because the element is display:none, or one the compositor drops).
  const afterTransition = (el, prop, fallbackMs, fn) => {
    let done = false;
    let timer = null;
    const cleanup = () => { clearTimeout(timer); el.removeEventListener('transitionend', onEnd); };
    const finish = () => { if (done) return; done = true; cleanup(); fn(); };
    function onEnd(e) { if (e.target === el && (!prop || e.propertyName === prop)) finish(); }
    el.addEventListener('transitionend', onEnd);
    timer = setTimeout(finish, fallbackMs);
    return { cancel: () => { if (done) return; done = true; cleanup(); } };
  };

  const wireOverlay = (overlay, panel) => {
    let closeWait = null;
    const close = () => {
      if (!overlay.classList.contains('open')) return;
      overlay.classList.remove('show');
      if (closeWait) { closeWait.cancel(); closeWait = null; }
      if (prefersReducedMotion()) { overlay.classList.remove('open'); return; }
      // Wait for the fade it is actually running, not a duration that has to be
      // kept in sync with the stylesheet by hand.
      closeWait = afterTransition(panel, 'opacity', OVERLAY_FADE_MS + 500, () => {
        closeWait = null;
        if (!overlay.classList.contains('show')) overlay.classList.remove('open');
      });
    };
    const open = () => {
      if (closeWait) { closeWait.cancel(); closeWait = null; }
      overlay.classList.add('open');
      if (prefersReducedMotion()) { overlay.classList.add('show'); return; }
      requestAnimationFrame(() => { if (overlay.classList.contains('open')) overlay.classList.add('show'); });
    };
    panel.addEventListener('click', (e) => { e.stopPropagation(); });
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return { open, close };
  };

  const supportsPopover = 'showPopover' in HTMLElement.prototype;
  const supportsAnchor = typeof window.CSS !== 'undefined' && !!window.CSS.supports?.('anchor-name', '--a');

  const makePopup = (className) => {
    const overlay = document.createElement('div');
    overlay.className = 'itube-popup-overlay ' + className;
    if (supportsPopover) overlay.setAttribute('popover', 'auto');
    const panel = document.createElement('div');
    panel.className = 'itube-popup-panel';
    overlay.appendChild(panel);
    return { overlay, panel };
  };

  const focusablesIn = (el) => Array.from(el.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((n) => !n.disabled);

  const wirePopup = (overlay, panel, onClose, triggerBtn) => {
    let closeTimer = null;
    panel.tabIndex = -1;
    const returnFocus = () => {
      const wasInside = panel.contains(document.activeElement);
      if (wasInside && triggerBtn) triggerBtn.focus();
    };
    const onTabTrap = (e) => {
      if (e.key !== 'Tab') return;
      const f = focusablesIn(panel);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const showNow = () => requestAnimationFrame(() => {
      overlay.classList.add('show');
      const f = focusablesIn(panel);
      (f[0] || panel).focus();
    });
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    const open = () => {
      if (closeTimer) { closeTimer.cancel(); closeTimer = null; }
      panel.addEventListener('keydown', onTabTrap);
      if (supportsPopover) { try { overlay.showPopover(); } catch (e) {} }
      else { overlay.classList.add('open'); document.addEventListener('keydown', onEsc); }
      showNow();
    };
    const close = () => {
      overlay.classList.remove('show');
      if (closeTimer) { closeTimer.cancel(); closeTimer = null; }
      panel.removeEventListener('keydown', onTabTrap);
      returnFocus();
      const finish = () => {
        if (supportsPopover) { try { overlay.hidePopover(); } catch (e) {} }
        else { overlay.classList.remove('open'); document.removeEventListener('keydown', onEsc); if (onClose) onClose(); }
      };
      if (prefersReducedMotion()) finish();
      else closeTimer = afterTransition(panel, 'opacity', POPUP_FADE_MS + 500, finish);
    };
    if (!supportsPopover) {
      panel.addEventListener('click', (e) => { e.stopPropagation(); });
      overlay.addEventListener('click', close);
    } else {
      panel.addEventListener('click', (e) => { e.stopPropagation(); });
      overlay.addEventListener('toggle', (e) => {
        if (e.newState === 'closed') {
          overlay.classList.remove('show');
          panel.removeEventListener('keydown', onTabTrap);
          returnFocus();
          if (onClose) onClose();
        }
      });
    }
    return { open, close };
  };

  // `eager` is for images that are already on screen when the grid mounts.
  // loading="lazy" on an in-viewport image is a pessimisation: the browser
  // still fetches it, just deprioritised behind everything else, so the first
  // row of thumbnails — the thing the user is actually looking at — arrived
  // last. Attributes are set BEFORE src on purpose; the loading/priority hint
  // has to be in place before the request starts or it is ignored.
  const fadeInImg = (src, eager) => {
    const img = document.createElement('img');
    img.addEventListener('load', () => img.classList.add('in'), { once: true });
    img.addEventListener('error', () => img.classList.add('in'), { once: true });
    img.setAttribute('loading', eager ? 'eager' : 'lazy');
    if (eager) img.setAttribute('fetchpriority', 'high');
    // Stays async even when eager: decoding off the main thread is what keeps
    // a burst of first-row images from blocking the frame they land in.
    img.setAttribute('decoding', 'async');
    if (src) img.src = src;
    return img;
  };

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5];
  const KEYBOARD_SHORTCUTS = [
    { keys: [' ', 'k'], display: ['Space', 'K'], label: 'Play/pause' },
    { keys: ['j'], display: ['J'], label: 'Back 10s' },
    { keys: ['l'], display: ['L'], label: 'Forward 10s' },
    { keys: ['ArrowLeft', 'ArrowRight'], display: ['←', '→'], label: 'Back/forward 5s' },
    { keys: ['ArrowUp', 'ArrowDown'], display: ['↑', '↓'], label: 'Volume up/down' },
    { keys: ['m'], display: ['M'], label: 'Mute' },
    { keys: ['f'], display: ['F'], label: 'Fullscreen' },
    { keys: ['t'], display: ['T'], label: 'Theater' },
    { keys: ['c'], display: ['C'], label: 'Captions' },
    { keys: ['i'], display: ['I'], label: 'Picture-in-picture' },
    { keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], display: ['0–9'], label: 'Seek to 0–90%' },
    { keys: [',', '.'], display: [',', '.'], label: 'Frame step' },
    { keys: ['<', '>'], display: ['<', '>'], label: 'Speed down/up' },
    { keys: ['[', ']'], display: ['[', ']'], label: 'Set A/B loop points' },
    { keys: ['\\'], display: ['\\'], label: 'Clear A-B' },
    { keys: ['/'], display: ['/'], label: 'Focus search' },
    { keys: [], display: ['⌘K', 'Ctrl-K'], label: 'Command palette' },
    { keys: ['Escape'], display: ['Esc'], label: 'Close overlay / exit theater' },
  ];
  // Thumbnails above the fold when a list first paints: enough for the widest
  // grid's first row (4 columns at 1440-1512) and the first two rows of the
  // single-column phone layout. Everything after this stays lazy.
  const EAGER_THUMBS = 4;
  const MAX_COMMENTS = 50;
  const COMMENTS_PAGE = 20;
  const MAX_REPLIES = 10;
  const MAX_STORYBOARD_TRIES = 40;
  const WATCH_BOOT_TIMEOUT = 3000;
  const WATCH_LOAD_RETRY = 3000;
  const WATCH_RESUME_MS = 6000;
  const AD_BLANK_MAX_MS = 30000;
  const AD_RESTORE_MS = 8000;
  const SUGGEST_DEBOUNCE_MS = 150;
  const MAX_SUGGESTIONS = 10;
  const CARD_DISMISS_MS = 200;
  const FEEDBACK_UNDO_MS = 6000;
  const MAX_FOLLOWING_ENRICH = 500;
  const FOLLOWING_ENRICH_CONCURRENCY = 3;
  const FOLLOWING_ENRICH_DELAY_MIN_MS = 300;
  const FOLLOWING_ENRICH_DELAY_JITTER_MS = 300;
  const FOLLOWING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const FOLLOWING_CACHE_LS_KEY = 'itube-following-stats-v2';
  const FOLLOWING_CACHE_MAX_ENTRIES = 500;
  const QUALITY_LABELS = {
    highres: '4320p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
    hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p',
    auto: 'Auto',
  };

  const CSS = `
    #itube .itube-sr-live {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    #itube {
      position: fixed;
      inset: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--ink);
      color: var(--text);
      font-family: -apple-system, system-ui, sans-serif;
      z-index: 9999;
      --ink: #06070c;
      --raised: #0e1119;
      --text: #eef1f6;
      --muted: #8b93a6;
      --dim: #7b8296;
      /* Default theme: an aurora sweep, light green -> cyan -> light blue.
         --accent stays a SOLID (the gradient's cyan midpoint) because most of
         the accent's work is text, borders, focus rings and box-shadows, none
         of which can take a gradient. --accent-grad is the sweep, and every
         surface that uses it sets background-color: var(--accent-solid) TOO —
         partly as the fallback, partly because a bare background shorthand
         computes background-color to transparent, which would make the
         contrast checker read dark-on-accent text against the page behind it.
         The dark foreground clears 4.5:1 against all three stops (measured
         10.5:1 at the green end, 8.7:1 in the middle, 5.6:1 at the blue end —
         the deeper sweep costs contrast at the blue end and still passes). */
      --accent: #22c3c9;
      --accent-solid: #22c3c9;
      --accent-grad: linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%);
      /* The same three stops, individually — for gradients whose stop
         POSITIONS are computed at runtime (the seek bar's played region), where
         a prebuilt --accent-grad cannot be reused. Inline styles can reference
         custom properties, so this stays a pure write with no style reads. */
      --grad-1: #3ddb8f;
      --grad-2: #22c3c9;
      --grad-3: #4a8fe0;
      --on-accent: #04141c;
      --accent-rgb: 34, 195, 201;
      /* The accent as it FILLS things, never re-darkened by the theme. Light
         mode dims --accent (46 sites: colour, border, ring, shadow) down to
         4.5:1 on white, which would be invisible on the overlays that sit on
         video — those opt back in via --accent-bright. */
      --accent-bright: #22c3c9;
      --accent-rgb-bright: 34, 195, 201;
      /* Leading edge of the pending arc. "Brighter" is the wrong word for it:
         it has to move AWAY from the page, so it whitens on a dark page and
         deepens on a light one. Mixing toward white in both themes made the
         head the faintest part of the arc in light mode. */
      --pending-head: color-mix(in srgb, var(--accent) 55%, white);
      /* Identical to --accent-grad in dark mode; light mode darkens it. */
      --accent-grad-ink: linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%);
      --hairline: rgba(var(--accent-rgb), .12);
      --edge: rgba(255, 255, 255, .16);
      --surface: rgba(var(--accent-rgb), .05);
      --hover: rgba(var(--accent-rgb), .09);
      /* Neutral chrome, tokenised only so the light theme can restate it:
         a drop shadow tuned for a near-black page reads as a smudge on a
         near-white one, and a white-alpha separator vanishes entirely. */
      --shadow-strong: rgba(0, 0, 0, .7);
      --shadow-soft: rgba(0, 0, 0, .35);
      --scrim: rgba(0, 0, 0, .6);
      --sep: rgba(255, 255, 255, .14);
      --sep-strong: rgba(255, 255, 255, .18);
      --shimmer: rgba(255, 255, 255, .07);
      --menu-bg: rgba(18, 18, 24, .92);
      --menu-border: rgba(255, 255, 255, .17);
      --menu-sheen: rgba(255, 255, 255, .22);
      --danger: #ff4d55;
      --danger-bg: rgba(255, 77, 85, .16);
      color-scheme: dark;
      --r-xs: 6px;
      --r-sm: 8px;
      --r-md: 9px;
      --r-lg: 11px;
      --r-pill: 8px;
      --glow: 0 0 0 1px rgba(var(--accent-rgb), .45), 0 0 10px -5px rgba(var(--accent-rgb), .4);
      --glow-soft: 0 0 8px -5px rgba(var(--accent-rgb), .32);
      --tr: .16s ease;
    }
    /* Light theme. The aurora is unchanged wherever it FILLS — --accent-grad
       and the three stops are the same sweep, and --on-accent (#04141c) still
       clears 5.6:1 against the palest stop, so every accent-filled surface is
       pixel-identical to dark mode. What changes is the accent as INK: bright
       cyan text on white is ~1.7:1, so --accent/--accent-rgb become a darkened
       teal (#126669 — 6.2:1 on the page, 5.9:1 on the accent-tinted chrome it
       usually sits on). setAccent() recomputes that per accent, so a custom
       colour picked in the wheel gets the same treatment; these literals are
       the pre-JS default and must match accentInk('#22c3c9'). */
    #itube.light {
      --ink: #f4f5f8;
      --raised: #ffffff;
      --text: #0f1218;
      --muted: #5b6273;
      --dim: #646b7d;
      --accent: #126669;
      --accent-rgb: 18, 102, 105;
      --accent-grad-ink: linear-gradient(135deg, #1d6844 0%, #126669 48%, #305e93 100%);
      --hairline: rgba(var(--accent-rgb), .2);
      --edge: rgba(0, 0, 0, .16);
      --surface: rgba(var(--accent-rgb), .05);
      --hover: rgba(var(--accent-rgb), .1);
      --glow: 0 0 0 1px rgba(var(--accent-rgb), .5), 0 0 10px -5px rgba(var(--accent-rgb), .45);
      --glow-soft: 0 0 8px -5px rgba(var(--accent-rgb), .4);
      --shadow-strong: rgba(15, 18, 24, .22);
      --shadow-soft: rgba(15, 18, 24, .12);
      --scrim: rgba(15, 18, 24, .38);
      --sep: rgba(15, 18, 24, .13);
      --sep-strong: rgba(15, 18, 24, .2);
      --shimmer: rgba(15, 18, 24, .06);
      --menu-bg: rgba(255, 255, 255, .94);
      --menu-border: rgba(15, 18, 24, .12);
      --menu-sheen: rgba(255, 255, 255, .9);
      --danger: #c62630;
      --danger-bg: rgba(198, 38, 48, .1);
      --pending-head: color-mix(in srgb, var(--accent) 70%, black);
      color-scheme: light;
    }
    /* Overlays whose backdrop is video or a thumbnail, not the page. They stay
       dark in both themes (their own backgrounds are literal, further down),
       so they have to restate the tokens light mode just inverted — otherwise
       #0f1218 body text and a 4.5:1-on-white accent land on near-black.
       Custom properties inherit, so naming the container covers its subtree:
       #itube-bar holds the seek rail, the A/B markers and every bar button. */
    #itube.light #itube-bar,
    #itube.light #itube-tools,
    #itube.light #itube-sound,
    #itube.light #itube-viewer,
    #itube.light #itube-transport,
    #itube.light #itube-preview,
    #itube.light #itube-mini,
    #itube.light #itube-cue,
    #itube.light .stage-audio,
    #itube.light .wl-quick,
    #itube.light .itube-fly {
      --accent: var(--accent-bright);
      --accent-rgb: var(--accent-rgb-bright);
      --text: #eef1f6;
      --muted: #8b93a6;
      --dim: #7b8296;
      --hairline: rgba(255, 255, 255, .16);
      --edge: rgba(255, 255, 255, .16);
      color-scheme: dark;
    }
    #itube button,
    #itube select,
    #itube .c,
    #itube .rc,
    #itube .row,
    #itube .watch-subscribe,
    #itube .signin-btn,
    #itube .hd-signin {
      transition: box-shadow var(--tr), border-color var(--tr), background var(--tr), color var(--tr), transform var(--tr);
    }
    #itube .watch-subscribe:hover:not(:disabled),
    #itube .unhandled-home:hover {
      box-shadow: 0 0 0 1px var(--accent), 0 0 13px -6px var(--accent);
      filter: brightness(1.06);
    }
    #itube .watch-tool:hover:not(:disabled),
    #itube .settings-select:hover,
    #itube .comments-sort-btn:hover,
    #itube .search-filter-select:hover,
    #itube .signin-btn:hover,
    #itube .hd-signin:hover {
      border-color: var(--accent);
      box-shadow: var(--glow-soft);
      color: var(--text);
    }
    #itube button:active:not(:disabled),
    #itube .watch-subscribe:active:not(:disabled) {
      transform: translateY(1px);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube button,
      #itube select,
      #itube .c,
      #itube .rc,
      #itube .row,
      #itube .watch-subscribe,
      #itube .signin-btn,
      #itube .hd-signin,
      #itube .hd-avatar {
        transition: none;
      }
    }
    /* No input selector here on purpose. Every text input in the app draws
       its own focus ring (border-color + inset box-shadow), so the global
       outline stacked a SECOND ring 2px outside it — and inside a panel with
       overflow:hidden the outer ring was clipped down to a stray green line
       under the field. Inputs keep their own indicator; see .cmdk-input,
       .search, .transcript-search, .settings-keyword-input. */
    #itube a:focus-visible:not(.c):not(.row),
    #itube button:focus-visible,
    #itube select:focus-visible {
      /* 2px, not 1px: macOS draws a substantial accent ring, and a hairline
         reads as a rendering artefact next to it. Still an outline (not a
         box-shadow) so it never participates in layout. */
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    #itube .sidebar,
    #itube .content,
    #itube .watch-right,
    #itube .queue-list,
    #itube .tool-menu,
    #itube .itube-popup-panel,
    #itube .settings-panel,
    #itube .cmdk-list,
    #itube .following-table-wrap {
      scrollbar-width: thin;
      scrollbar-color: var(--sep-strong) transparent;
    }
    /* WebKit pair for the same scrollables: Safari with classic (always-on)
       scrollbars would otherwise draw the system chrome — and a fixed 8px
       gutter keeps geometry deterministic across engines. */
    #itube .sidebar::-webkit-scrollbar,
    #itube .content::-webkit-scrollbar,
    #itube .watch-right::-webkit-scrollbar,
    #itube .queue-list::-webkit-scrollbar,
    #itube .tool-menu::-webkit-scrollbar,
    #itube .itube-popup-panel::-webkit-scrollbar,
    #itube .settings-panel::-webkit-scrollbar,
    #itube .cmdk-list::-webkit-scrollbar,
    #itube .following-table-wrap::-webkit-scrollbar {
      width: 8px;
      height: 8px;
      background: transparent;
    }
    #itube .sidebar::-webkit-scrollbar-thumb,
    #itube .content::-webkit-scrollbar-thumb,
    #itube .watch-right::-webkit-scrollbar-thumb,
    #itube .queue-list::-webkit-scrollbar-thumb,
    #itube .tool-menu::-webkit-scrollbar-thumb,
    #itube .itube-popup-panel::-webkit-scrollbar-thumb,
    #itube .settings-panel::-webkit-scrollbar-thumb,
    #itube .cmdk-list::-webkit-scrollbar-thumb,
    #itube .following-table-wrap::-webkit-scrollbar-thumb {
      background-color: var(--sep);
      background-image: linear-gradient(180deg, var(--grad-1), var(--grad-2), var(--grad-3));
      border-radius: 4px;
      opacity: .5;
    }
    #itube ::selection {
      background: rgba(var(--accent-rgb), .3);
    }
    #itube .sidebar-logo-row {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 34px;
    }
    #itube .sidebar-signin-row {
      display: flex;
    }
    #itube .sidebar-signin-row .hd-signin {
      width: 100%;
      justify-content: center;
      box-sizing: border-box;
    }
    #itube .search-wrap {
      position: relative;
      width: 100%;
    }
    #itube .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted);
      pointer-events: none;
    }
    #itube .search {
      width: 100%;
      height: 34px;
      border-radius: var(--r-xs);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      /* 40 = icon(12+16) + 12 gap: placeholder text starts on the exact same
         x as the nav-row labels below. */
      padding: 0 16px 0 40px;
      font-size: 14px;
      outline: none;
      box-sizing: border-box;
    }
    #itube .search:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    #itube .rail-toggle-btn {
      display: flex;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: none;
      border: none;
      /* The UA's own 1px 6px would land off the spacing scale. */
      padding: 0;
      color: var(--dim);
      cursor: pointer;
      flex: none;
      align-items: center;
      justify-content: center;
    }
    #itube .rail-toggle-btn:hover {
      background: var(--hover);
      color: var(--text);
    }
    #itube .rail-search-btn {
      display: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: none;
      border: none;
      color: var(--muted);
      cursor: pointer;
      flex: none;
      align-items: center;
      justify-content: center;
    }
    #itube .rail-search-btn:hover {
      background: var(--hover);
      color: var(--text);
    }
    #itube .search-suggest {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 6px);
      z-index: 30;
      display: none;
      flex-direction: column;
      padding: 6px;
      border-radius: var(--r-md);
      background: var(--menu-bg);
      backdrop-filter: blur(22px) saturate(1.7);
      -webkit-backdrop-filter: blur(22px) saturate(1.7);
      border: 1px solid var(--menu-border);
      box-shadow: inset 0 1px 0 var(--menu-sheen), 0 8px 32px var(--shadow-soft);
    }
    #itube .search-suggest.show {
      display: flex;
    }
    #itube .search-suggest:popover-open {
      display: flex;
    }
    @supports (anchor-name: --a) {
      #itube .search-wrap {
        anchor-name: --search-anchor;
      }
      #itube .search-suggest[popover] {
        position-anchor: --search-anchor;
        position: fixed;
        top: calc(anchor(bottom) + 6px);
        left: anchor(left);
        right: auto;
        width: anchor-size(width);
      }
    }
    #itube .search-suggest-row {
      /* text-only rows: block + line-height, NOT flex — text-overflow never
         applies to a flex container, so long suggestions hard-clipped. */
      display: block;
      height: 32px;
      line-height: 32px;
      padding: 0 10px;
      border-radius: 8px;
      color: var(--text);
      font-size: 13.5px;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #itube .search-suggest-row.active,
    #itube .search-suggest-row:hover {
      background: var(--hover);
    }
    #itube .hd-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
    }
    #itube .hd-avatar {
      width: 28px;
      height: 28px;
      border: none;
      padding: 0;
      border-radius: 50%;
      background: var(--raised);
      flex: none;
      display: block;
      overflow: hidden;
      cursor: pointer;
      box-shadow: 0 0 0 0 rgba(var(--accent-rgb), 0);
      transition: box-shadow var(--tr);
    }
    #itube .hd-avatar:hover {
      box-shadow: 0 0 0 1.5px var(--accent);
    }
    #itube .hd-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
    }
    #itube .hd-avatar-img.in {
      opacity: 1;
      transition: opacity .18s ease-out;
    }
    #itube .acct-menu {
      position: fixed;
      z-index: 10000;
      width: 264px;
      max-width: calc(100vw - 16px);
      background: var(--raised);
      border: 1px solid var(--hairline);
      border-radius: var(--r-lg);
      box-shadow: 0 12px 40px -12px var(--shadow-strong);
      padding: 6px;
      display: none;
      flex-direction: column;
    }
    #itube .acct-menu.open {
      display: flex;
    }
    #itube .acct-menu:popover-open {
      display: flex;
    }
    @supports (anchor-name: --a) {
      #itube .hd-avatar {
        anchor-name: --acct-anchor;
      }
      #itube .acct-menu {
        position-anchor: --acct-anchor;
        position: fixed;
        top: calc(anchor(bottom) + 8px);
        left: anchor(left);
        right: auto;
      }
    }
    #itube .acct-head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 10px 12px;
      border-bottom: 1px solid var(--hairline);
      margin-bottom: 6px;
    }
    #itube .acct-head-img {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--surface);
      flex: none;
    }
    #itube .acct-head-text {
      min-width: 0;
    }
    #itube .acct-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #itube .acct-handle {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #itube .acct-list {
      display: flex;
      flex-direction: column;
    }
    #itube .acct-item {
      display: block;
      padding: 9px 12px;
      border-radius: var(--r-md);
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
    }
    #itube .acct-item:hover {
      background: var(--hover);
    }
    #itube .acct-signout {
      border-top: 1px solid var(--hairline);
      margin-top: 6px;
      padding-top: 12px;
    }
    #itube .brand {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      height: 38px;
      text-decoration: none;
      color: var(--text);
      transition: color var(--tr);
    }
    #itube .brand:hover {
      color: var(--accent);
    }
    #itube .itube-power {
      width: 36px;
      height: 20px;
      flex: none;
      margin-left: 12px;
      padding: 0;
      border: none;
      border-radius: 999px;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      position: relative;
      cursor: pointer;
      transition: background var(--tr), box-shadow var(--tr);
    }
    #itube .itube-power:hover {
      box-shadow: 0 0 12px -3px var(--accent);
    }
    #itube .itube-power-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--on-accent);
      /* On = knob to the right. transform, not left, so the travel is
         compositor-only like every other motion in the app. */
      transform: translateX(16px);
      transition: transform var(--tr);
    }
    #itube .brand-tile {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
    }
    #itube .brand-word {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -.01em;
      /* --accent-grad-ink is the sweep in dark mode and a darkened copy of it
         in light mode: this is the only place the gradient is TEXT, so it is
         the only place the raw stops are too pale to read on a light page. */
      background-image: var(--accent-grad-ink, var(--accent-grad));
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      /* Kept as the anchor colour rather than transparent: it is the honest
         fallback if background-clip:text is unsupported, and it is what the
         contrast walker measures. Tracks the ink for the same reason. */
      color: var(--accent);
    }
    #itube .brand:hover .brand-word {
      -webkit-text-fill-color: transparent;
      filter: brightness(1.12);
    }
    #itube .brand-beta {
      position: absolute;
      top: -6px;
      right: 0;
      padding: 0 4px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .06em;
      line-height: 1.4;
      color: var(--on-accent);
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      border-radius: 5px;
      pointer-events: none;
    }
    #itube .body {
      display: flex;
      width: 100%;
      height: 100vh;
      box-sizing: border-box;
    }
    #itube .sidebar {
      width: 232px;
      flex: none;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      padding: 14px 12px 16px;
    }
    #itube .sidebar-head {
      display: flex;
      flex-direction: column;
      gap: 14px;
      /* No horizontal inset: head children (logo row, search box) span the
         same column as the nav-row pills, so BOX edges align. Icon alignment
         at x=24 comes from each child's own internal padding (.search-icon
         left:12, nav-row padding:12), not from insetting the whole box —
         insetting made the search box 24px narrower than the pills below. */
      padding: 6px 0 16px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--hairline);
      position: sticky;
      top: -14px;
      z-index: 2;
      background: var(--ink);
    }
    #itube .nav-row {
      display: flex;
      align-items: center;
      gap: 12px;
      height: 40px;
      flex: none;
      padding: 0 12px;
      border-radius: var(--r-xs);
      color: var(--text);
      text-decoration: none;
      font-size: 14px;
    }
    #itube .nav-row:hover {
      background: var(--hover);
    }
    #itube .nav-row svg {
      flex: 0 0 auto;
      color: var(--muted);
    }
    #itube .nav-row.active {
      background-color: rgba(var(--accent-rgb), .13);
      background-image: linear-gradient(90deg, rgba(var(--accent-rgb), .1), transparent 70%);
    }
    #itube .nav-row.active svg,
    #itube .nav-row.active span {
      color: var(--accent);
    }
    #itube .nav-section-label {
      flex: none;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--dim);
      margin: 20px 12px 8px;
    }
    #itube .nav-chan {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 32px;
      flex: none;
      padding: 4px 12px;
      border-radius: var(--r-xs);
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
    }
    #itube .nav-chan span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #itube .nav-chan:hover {
      background: var(--hover);
    }
    #itube .nav-chan-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--raised);
      flex: none;
    }
    #itube .content {
      flex: 1;
      min-width: 0;
      height: 100%;
      box-sizing: border-box;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      padding: 24px;
    }
    #itube .content > * {
      width: 100%;
    }
    #itube .section-heading {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.01em;
      margin: 0 0 16px;
      text-wrap: balance;
    }
    #itube .page-heading {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -.02em;
      margin: 0 0 20px;
    }
    #itube .search-label {
      font-size: 13px;
      color: var(--dim);
      margin-bottom: 2px;
    }
    #itube .search-query {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -.02em;
      margin: 0 0 20px;
    }
    #itube .search-filters {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 16px;
    }
    #itube .search-filter-select {
      -webkit-appearance: none;
      appearance: none;
      height: 32px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .unhandled {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 16px;
      padding: 48px 24px;
      min-height: 60vh;
      color: var(--muted);
      font-size: 15px;
    }
    #itube .unhandled-home {
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      color: var(--on-accent);
      border-radius: 10px;
      padding: 8px 20px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    /* Uniform gap, not 24/16. Each .c paints an 8px padding box pulled out by
       margin:-8px, so it is 16px wider than its grid track — with a 16px
       column gap two neighbouring cards' hover/focus surfaces were exactly
       flush, and hovering one read as a slab spanning two cards while the
       vertical rhythm had a real 8px break. 24px both ways puts the same 8px
       between painted boxes in both directions. Column counts are unchanged
       at every breakpoint (checked 480-1512); cards give up ~6px of width. */
    #itube .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 24px;
      align-items: start;
    }
    #itube .spacer {
      grid-column: 1 / -1;
      height: 0;
    }
    #itube .sentinel {
      grid-column: 1 / -1;
      height: 1px;
    }
    #itube .spinner {
      grid-column: 1 / -1;
      display: none;
      justify-content: center;
      padding: 20px 0;
      color: var(--muted);
      font-size: 13px;
    }
    #itube .spinner.show {
      display: flex;
    }
    /* NO content-visibility here, deliberately — see the .row/.comment-row
       rules, which keep it. On a dense auto-fill GRID it is a net loss on
       WebKit: every card crossing the relevance boundary is laid out or
       skipped mid-scroll, and because a grid item's height feeds its row's
       height, each transition re-sizes the track. Measured on the channel
       grid (120 cards, 1512x900, scripted 60px/frame scroll, median of 3):
       p95 21 -> 18 ms, worst 24 -> 20 ms, janky frames 17 -> 11 of 149 with
       it removed. It stays on the single-column .row list and on
       .comment-row, where the same measurement showed no difference on
       WebKit and it remains a win on Chromium. The contain rule is kept: it isolates
       each card's layout/paint and costs nothing measurable on its own. */
    #itube .c {
      display: block;
      position: relative;
      color: var(--text);
      text-decoration: none;
      contain: layout paint style;
      padding: 8px;
      margin: -8px;
      border-radius: 14px;
    }
    #itube .c:hover {
      background: var(--hover);
    }
    #itube .c-link,
    #itube .rc-link,
    #itube .row-link {
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    #itube a.c-chan,
    #itube a.rc-chan,
    #itube a.row-chan {
      text-decoration: none;
      cursor: pointer;
    }
    #itube .c-chan,
    #itube .rc-chan,
    #itube .row-chan {
      position: relative;
      z-index: 2;
      width: fit-content;
      max-width: 100%;
    }
    #itube a.c-chan:hover,
    #itube a.rc-chan:hover,
    #itube a.row-chan:hover {
      color: var(--text);
    }
    #itube a.comment-author,
    #itube .comment-avatar-link {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    #itube .comment-avatar-link {
      display: block;
      flex: none;
      border-radius: 50%;
      transition: box-shadow var(--tr);
    }
    #itube a.comment-author:hover {
      color: var(--accent);
    }
    #itube .comment-avatar-link:hover {
      box-shadow: 0 0 0 2px var(--accent);
    }

    #itube .c-thumb {
      aspect-ratio: 16 / 9;
      border-radius: var(--r-sm);
      overflow: hidden;
      background: var(--raised);
      position: relative;
    }
    #itube .c-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
    }
    #itube .c-thumb img.in,
    #itube .rc-thumb img.in,
    #itube .row-thumb img.in,
    #itube .comment-avatar.in,
    #itube .ch-banner.in,
    #itube .ch-avatar.in {
      opacity: 1;
      transition: opacity .18s ease-out, transform .45s cubic-bezier(.22, .61, .36, 1);
    }
    #itube .c:hover .c-thumb img.in,
    #itube .row:hover .row-thumb img.in,
    #itube .related-wrap .rc:hover .rc-thumb img.in {
      transform: scale(1.045);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .c:hover .c-thumb img.in,
      #itube .row:hover .row-thumb img.in,
      #itube .related-wrap .rc:hover .rc-thumb img.in {
        transform: none;
      }
    }
    #itube .c-progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: rgba(255, 255, 255, .25);
    }
    #itube .c-progress-fill {
      height: 100%;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
    }
    #itube .c-dur,
    #itube .rc-dur,
    #itube .row-dur {
      position: absolute;
      right: 4px;
      bottom: 4px;
      background: rgba(0, 0, 0, .8);
      border-radius: 6px;
      font: 600 11px -apple-system, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      color: #fff;
      padding: 2px 4px;
    }
    #itube .wl-quick {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: none;
      border-radius: var(--r-sm);
      background: rgba(6, 7, 12, .78);
      color: #fff;
      cursor: pointer;
    }
    #itube .wl-quick:hover {
      background: rgba(6, 7, 12, .94);
      color: var(--accent);
    }
    #itube .wl-quick.active {
      color: var(--accent);
    }
    /* The three "less of this" actions cluster top-LEFT; Watch Later keeps the
       top-right corner alone. Grouping them by intent means the destructive
       ones are never adjacent to the one you press by habit. Three 30px
       buttons + gaps come to 98px, which still clears the 168px compact
       thumb's Watch Later button at 132px. */
    #itube .qa {
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 2;
      display: flex;
      gap: 4px;
    }
    #itube .qa-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: none;
      border-radius: var(--r-sm);
      background: rgba(6, 7, 12, .78);
      color: #fff;
      cursor: pointer;
    }
    #itube .qa-btn:hover {
      background: rgba(6, 7, 12, .94);
    }
    /* Escalating severity, left to right: this video, this channel's
       recommendations, the subscription itself. */
    #itube .nr-quick:hover { color: #ff8a8a; }
    #itube .dnc-quick:hover { color: #ff6b6b; }
    #itube .unf-quick:hover { color: #ffc46b; }
    /* The dismissal exit. opacity/transform only — collapsing a height or a
       margin here would relayout the whole grid on every frame of it. */
    #itube .c.nr-going,
    #itube .row.nr-going,
    #itube .rc.nr-going {
      opacity: 0;
      transform: scale(.97);
      pointer-events: none;
      transition: opacity .2s ease, transform .2s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .c.nr-going,
      #itube .row.nr-going,
      #itube .rc.nr-going {
        transition: none;
      }
    }
    #itube .c-title {
      margin: 10px 0 0;
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -.01em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-wrap: pretty;
      min-height: 2.6em;
    }
    #itube .c-chan {
      margin-top: 4px;
      font-size: 13px;
      color: var(--muted);
    }
    #itube .c-meta {
      margin-top: 2px;
      font-size: 12.5px;
      color: var(--dim);
      font-variant-numeric: tabular-nums;
    }
    #itube .sk-line {
      height: 12px;
      border-radius: 6px;
      background: var(--raised);
    }
    #itube .sk-line.short {
      width: 55%;
    }
    #itube .c-skel {
      display: block;
      padding: 8px;
      margin: -8px;
    }
    #itube .c-skel-thumb {
      aspect-ratio: 16 / 9;
      border-radius: var(--r-sm);
      background: var(--raised);
    }
    #itube .c-skel .sk-line {
      margin-top: 10px;
    }
    #itube .c-skel .sk-line.short {
      margin-top: 8px;
      height: 10px;
    }
    #itube .watch {
      display: grid;
      /* Narrower rail than it looks like it wants: the rail's job is scanning
         Up next, and every px it gives back widens the video, which is what
         the page is for. A 16:9 video in the old 26vw/400px layout was only
         449px tall on a 1512x900 screen, leaving ~260px of dead space under
         it that nothing occupies now that comments and the description live in
         the rail. */
      grid-template-columns: minmax(0, 1fr) clamp(300px, 22vw, 360px);
      gap: 24px;
      align-items: start;
    }
    #itube .watch-left {
      min-width: 0;
      --stage-chrome: 243px;
      --stage-w: min(100%, calc((100vh - var(--stage-chrome)) * 16 / 9));
    }
    #itube .watch-left.itube-cursor-hide,
    #itube .watch-left.itube-cursor-hide * {
      cursor: none;
    }
    #itube .watch-right {
      position: sticky;
      /* Sticky offset matches .content's own 24px padding, so the pinned rail
         keeps the same inset it had before any scrolling — and the height
         leaves an equal 24px below it. The old top:0 + 100vh-100px pinned the
         rail flush to the viewport edge while stopping 76px short of the
         bottom, so the rail scrolled sooner than it needed to and the gaps
         above and below it never matched. */
      top: 24px;
      max-height: calc(100vh - 48px);
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    #itube .watch-right > *,
    #itube .queue-wrap > *,
    #itube .related-wrap > * {
      max-width: 100%;
      box-sizing: border-box;
    }
    #itube .queue-wrap,
    #itube .related-wrap {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    #itube .queue-wrap:empty,
    #itube .related-wrap:empty {
      display: none;
    }
    #itube .queue-panel {
      background: var(--surface);
      border-radius: var(--r-md);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #itube .queue-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    #itube .queue-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #itube .queue-count {
      flex: none;
      font-size: 12.5px;
      color: var(--dim);
      font-variant-numeric: tabular-nums;
    }
    #itube .queue-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 360px;
      overflow-y: auto;
    }
    #itube .queue-item.current {
      box-shadow: inset 3px 0 0 var(--accent);
    }
    #itube .queue-item.current .rc-title {
      color: var(--accent);
    }
    #itube .stage-wrap {
      position: relative;
      /* Height cap, so a short/wide window doesn't push the meta off screen.
         It only binds below roughly 600px of viewport height — above that the
         column width is what limits the video. */
      width: var(--stage-w, min(100%, calc((100vh - 237px) * 16 / 9)));
      margin: 20px auto 0;
      border-radius: var(--r-lg);
      /* On the wrapper: #itube-stage clips its own shadow with clip-path. */
      box-shadow: 0 24px 60px -28px var(--shadow-strong), 0 0 0 1px var(--edge);
    }
    #itube.theater {
      background: #000;
    }
    #itube.theater .body {
      background: radial-gradient(ellipse 130% 115% at 50% 42%, #121212 0%, #050505 100%);
    }
    @media (dynamic-range: high) {
      #itube.theater .body {
        background: radial-gradient(ellipse 130% 115% at 50% 42%, #060606 0%, #000 100%);
      }
    }
    .itube-theater-scrim {
      position: fixed;
      inset: 0;
      z-index: 2147483200;
      background: #000;
      opacity: 0;
      transition: opacity 180ms ease;
      pointer-events: none;
    }
    #itube.theater .content {
      background: transparent;
      padding: 0;
      overflow: hidden;
    }
    #itube.theater .sidebar {
      display: none;
    }
    #itube.theater .watch {
      display: block;
      max-width: none;
      margin: 0;
      height: 100vh;
    }
    #itube.theater .watch-right {
      display: none;
    }
    #itube.theater .watch-left {
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #itube.theater .watch-left > *:not(.stage-wrap) {
      display: none;
    }
    #itube.theater .stage-wrap {
      width: min(93vw, 156vh);
      margin: 0;
      border-radius: 0;
      box-shadow: none;
    }
    #itube-theater.active {
      color: var(--accent);
    }
    #itube.theater #itube-stage {
      border-radius: 0;
      clip-path: none;
    }
    #itube.theater #itube-bar,
    #itube.theater #itube-tools,
    #itube.theater #itube-sound,
    #itube.theater #itube-viewer,
    #itube.theater #itube-transport {
      --accent: rgba(var(--accent-rgb), .7);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube.theater .sidebar {
        transition: none;
      }
      .itube-theater-scrim {
        transition: none;
      }
    }
    #itube-stage {
      position: relative;
      overflow: hidden;
      border-radius: var(--r-lg);
      clip-path: inset(0 round var(--r-lg));
      background: #000;
      aspect-ratio: 16 / 9;
      width: 100%;
      z-index: 1;
    }
    .itube-fly {
      position: fixed;
      z-index: 2147483000;
      margin: 0;
      padding: 0;
      object-fit: cover;
      border-radius: 11px;
      transform-origin: 0 0;
      will-change: transform, opacity;
      pointer-events: none;
      backface-visibility: hidden;
      background: #000;
    }
    #itube-stage.ad video {
      opacity: 0;
    }
    #itube-stage canvas.itube-crossfade {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      width: 100% !important;
      height: 100% !important;
      z-index: 5;
      pointer-events: none;
      opacity: 1;
      transition: opacity .22s ease;
    }
    #itube-stage video {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      width: 100% !important;
      height: 100% !important;
      display: block !important;
      object-fit: contain !important;
      max-width: none !important;
    }
    #itube-stage .ytp-caption-window-container {
      position: absolute !important;
      left: 0 !important;
      right: 0 !important;
      top: auto !important;
      bottom: 76px !important;
      width: auto !important;
      height: auto !important;
      display: flex !important;
      justify-content: center !important;
      padding: 0 24px;
      pointer-events: none !important;
      z-index: 10;
    }
    #itube-stage .caption-window {
      position: static !important;
      transform: none !important;
      width: auto !important;
      height: auto !important;
      max-width: 84% !important;
      margin: 0 !important;
      padding: 0 !important;
      background: none !important;
      text-align: center;
    }
    #itube-stage .ytp-caption-segment {
      display: inline !important;
      background: rgba(10, 10, 14, .74) !important;
      color: #fff !important;
      font: 600 clamp(14px, 1.5vw, 21px)/1.55 -apple-system, system-ui, sans-serif !important;
      text-shadow: none !important;
      padding: 3px 8px !important;
      border-radius: 7px !important;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .stage-audio {
      position: absolute;
      inset: 0;
      z-index: 4;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      background: #06070c;
      overflow: hidden;
    }
    #itube-stage.audio-only .stage-audio {
      display: flex;
    }
    .stage-audio-back {
      position: absolute;
      inset: -10%;
      background-size: cover;
      background-position: center;
      filter: blur(40px) brightness(.4);
      transform: scale(1.1);
    }
    .stage-audio-art {
      position: relative;
      width: 140px;
      height: 140px;
      border-radius: 12px;
      object-fit: cover;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
    }
    .stage-audio-title {
      position: relative;
      color: var(--text);
      font-weight: 600;
      font-size: 15px;
      max-width: 80%;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .stage-audio-tag {
      position: relative;
      color: var(--muted);
      font-size: 12px;
    }
    #itube .watch-headblock {
      /* Matches the video's edges — everything in here sits above it. */
      width: var(--stage-w, 100%);
      margin: 0 auto;
      /* flow-root: an empty title lets .watch-meta's margin collapse out. */
      display: flow-root;
    }
    #itube .watch-title {
      margin-top: 0;
      margin-bottom: 0;
      font-family: 'SF Pro Display', -apple-system, system-ui, sans-serif;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -.03em;
      text-wrap: balance;
      line-height: 1.2;
    }
    #itube .watch-meta {
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      /* Positioning context for the skeleton that overlays the head. */
      position: relative;
    }
    #itube .watch-head {
      display: flex;
      flex-direction: column;
      min-height: 40px;
    }
    #itube .watch-below {
      /* Anchor for the tools popover. */
      position: relative;
      width: var(--stage-w, 100%);
      margin-inline: auto;
      margin-top: 20px;
      min-height: 34px;
    }
    #itube .watch-channel {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    #itube .watch-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--raised);
      flex: none;
      display: block;
    }
    #itube .watch-channel-info {
      /* 0 1 auto, not none — min-width:0 is inert on a non-shrinking flex
         item, so a long unbroken channel name shoved the subscribe button. */
      flex: 0 1 auto;
      min-width: 0;
      /* Identity reads as ONE line — name, then follower count as quiet
         trailing meta — not YouTube's stacked two-liner. */
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    #itube .watch-channel-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      display: block;
      width: fit-content;
    }
    #itube a.watch-channel-name[href]:hover {
      color: var(--accent);
    }
    #itube a.watch-channel-name[href] {
      cursor: pointer;
    }
    #itube .watch-subs {
      font-size: 12px;
      color: var(--dim);
      white-space: nowrap;
      flex: none;
    }
    #itube .watch-channel-spacer {
      flex: 1;
      min-width: 12px;
    }
    #itube .watch-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    /* Ghost buttons: no chrome at rest — the strip reads as a toolbar, not a
       row of pills (the pill row is YouTube's fingerprint). Hover paints the
       quiet surface; the accent Follow button stays the row's one loud thing. */
    #itube .watch-action-btn {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 6px;
      height: 34px;
      padding: 0 10px;
      background: none;
      border: 1px solid transparent;
      border-radius: var(--r-sm);
      color: var(--muted);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
      transition: background var(--tr), color var(--tr);
    }
    #itube .watch-action-btn:hover:not(:disabled) {
      color: var(--text);
    }
    #itube .tools-chevron {
      margin-left: -2px;
      transition: transform var(--tr);
    }
    #itube .watch-action-btn.menu-up .tools-chevron,
    #itube .watch-action-btn[aria-expanded="true"] .tools-chevron {
      transform: rotate(180deg);
    }
    #itube .watch-action-btn.menu-up[aria-expanded="true"] .tools-chevron {
      transform: none;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .tools-chevron {
        transition: none;
      }
    }
    #itube .watch-action-btn:hover:not(:disabled) svg {
      color: var(--text);
    }
    #itube .watch-action-btn svg {
      color: var(--muted);
    }
    #itube .watch-action-btn:hover {
      background: var(--hover);
    }
    #itube .watch-action-btn:disabled {
      opacity: .4;
      cursor: default;
    }
    #itube .watch-action-btn:disabled:hover {
      background: none;
    }
    #itube .watch-action-btn.active {
      background: rgba(var(--accent-rgb), .16);
      border-color: transparent;
      color: var(--accent);
    }
    #itube .watch-tools {
      /* fixed + display:none when closed: an absolute one adds scroll extent. */
      position: fixed;
      z-index: 10000;
      min-width: 236px;
      max-width: calc(100vw - 16px);
      display: none;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      border-radius: var(--r-lg);
      background: var(--raised);
      border: 1px solid var(--hairline);
      box-shadow: 0 12px 40px -12px var(--shadow-strong);
      box-sizing: border-box;
      opacity: 0;
      transform: translateY(-6px) scale(.98);
      transform-origin: top right;
      pointer-events: none;
      transition: opacity .13s ease, transform .16s cubic-bezier(.22, .61, .36, 1);
    }
    #itube .watch-tools.shown {
      display: flex;
    }
    #itube .watch-tools.open {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }
    #itube .watch-tool {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 10px;
      width: 100%;
      background: none;
      border: none;
      border-radius: 8px;
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
      text-align: left;
      transition: background var(--tr), color var(--tr);
    }
    #itube .watch-tool:hover {
      background: var(--hover);
    }
    #itube .watch-tool.active {
      color: var(--text);
    }
    #itube .watch-tool-val {
      margin-left: auto;
      color: var(--muted);
      font-weight: 600;
    }
    #itube .watch-tool.active .watch-tool-val {
      color: var(--accent);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .watch-tools {
        transition: none;
      }
    }
    #itube .tool-menu {
      position: fixed;
      z-index: 10000;
      min-width: 160px;
      max-width: calc(100vw - 16px);
      max-height: 60vh;
      overflow-y: auto;
      background: var(--raised);
      border: 1px solid var(--hairline);
      border-radius: var(--r-lg);
      box-shadow: 0 12px 40px -12px var(--shadow-strong);
      padding: 6px;
      display: none;
      flex-direction: column;
    }
    #itube .tool-menu.open {
      display: flex;
    }
    #itube .tool-menu:popover-open {
      display: flex;
    }
    @supports (anchor-name: --a) {
      #itube .tool-menu[style*="position-anchor"] {
        top: calc(anchor(bottom) + 6px);
        left: anchor(left);
      }
    }
    /* The account menu and the tool menus were the only surfaces left with no
       entrance at all — they appeared instantly while every other overlay
       faded. Done natively rather than with the two-step class dance the modal
       overlays use: @starting-style supplies the state to animate FROM, which
       works even though these menus flip .open and call showPopover() in the
       same tick. No JS changes.

       ENTRY ONLY, and that is an engine limit rather than an oversight.
       Measured on Safari 26.5: transition-behavior:allow-discrete is supported
       and the declaration below parses (computed transitionBehavior reads
       "normal, normal, allow-discrete, allow-discrete"), but the overlay
       property itself is NOT implemented — CSS.supports('overlay','auto') is
       false. So hidePopover() drops the menu out of the top layer immediately
       and nothing can hold it there to fade out; sampling the exit shows
       display:none within 10ms. overlay is left in the transition list on
       purpose: it is accepted as a property name, costs nothing, and the exit
       will start working on its own once WebKit ships the property. Giving
       these menus up as popovers to buy a 130ms fade would cost light-dismiss
       and top-layer correctness, which is a bad trade. */
    #itube .acct-menu,
    #itube .tool-menu {
      opacity: 0;
      transform: translateY(-6px) scale(.98);
      transform-origin: top center;
      transition: opacity .13s ease, transform .16s cubic-bezier(.22, .61, .36, 1),
                  display .16s allow-discrete, overlay .16s allow-discrete;
    }
    #itube .acct-menu.open,
    #itube .acct-menu:popover-open,
    #itube .tool-menu.open,
    #itube .tool-menu:popover-open {
      opacity: 1;
      transform: none;
    }
    @starting-style {
      #itube .acct-menu.open,
      #itube .acct-menu:popover-open,
      #itube .tool-menu.open,
      #itube .tool-menu:popover-open {
        opacity: 0;
        transform: translateY(-6px) scale(.98);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .acct-menu,
      #itube .tool-menu {
        transition: none;
        transform: none;
        opacity: 1;
      }
    }
    /* Player context menu. Same material as .tool-menu — it IS a menu, so it
       follows the app appearance rather than the dark-locked player chrome,
       which is what macOS menus do. Positioned inside the stage by the JS so
       it survives fullscreen; revealed with a class, never by clearing an
       inline display. */
    #itube .itube-ctx {
      position: absolute;
      z-index: 30;
      min-width: 210px;
      padding: 6px;
      border-radius: var(--r-md);
      background: var(--menu-bg);
      backdrop-filter: blur(22px) saturate(1.7);
      -webkit-backdrop-filter: blur(22px) saturate(1.7);
      border: 1px solid var(--menu-border);
      box-shadow: inset 0 1px 0 var(--menu-sheen), 0 12px 40px -12px var(--shadow-strong);
      display: none;
      flex-direction: column;
      color: var(--text);
    }
    #itube .itube-ctx.open {
      display: flex;
    }
    #itube .itube-ctx-sep {
      height: 1px;
      margin: 4px 6px;
      background: var(--hairline);
    }
    #itube .tool-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 10px;
      border: none;
      border-radius: 8px;
      background: none;
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
      text-align: left;
      width: 100%;
    }
    #itube .tool-menu-item:hover {
      background: var(--hover);
    }
    /* Apple marks the current option with a checkmark alone and leaves the
       label in normal text colour — tinting the row as well reads as two
       competing selection signals. The tick keeps the accent. */
    #itube .tool-menu-item.active {
      color: var(--text);
    }
    #itube .tool-menu-item.active svg {
      color: var(--accent);
    }
    /* Pending ring. The ring itself never moves — a conic gradient rotates its
       own angle underneath a border-shaped mask, so the light travels along the
       outline instead of the outline tumbling. (Rotating the box only ever read
       correctly on circular buttons; on a pill it spun like a propeller.)
       This paints each frame rather than compositing, which is affordable only
       because the painted area is one small button for the length of one
       request. Do not reuse the pattern on anything large or persistent. */
    @property --itube-arc {
      syntax: '<angle>';
      inherits: false;
      initial-value: 0deg;
    }
    #itube .is-pending {
      position: relative;
      pointer-events: none;
    }
    #itube .is-pending::after {
      content: '';
      position: absolute;
      inset: -3px;
      padding: 2px;
      border-radius: inherit;
      --itube-arc: 0deg;
      background: conic-gradient(from var(--itube-arc),
        rgba(var(--accent-rgb), .2) 0turn,
        rgba(var(--accent-rgb), .2) .5turn,
        rgba(var(--accent-rgb), .45) .78turn,
        rgba(var(--accent-rgb), .95) .95turn,
        var(--pending-head) .985turn,
        rgba(var(--accent-rgb), .2) 1turn);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      animation: itube-pending-arc 1.15s linear infinite;
      pointer-events: none;
    }
    #itube .watch-like-btn.is-pending::after,
    #itube .watch-dislike-btn.is-pending::after {
      inset: auto;
      top: 50%;
      left: -3px;
      transform: translateY(-50%);
      border-radius: 50%;
      /* border-box, or the mask's 2px padding is added to the width. */
      box-sizing: border-box;
    }
    #itube .watch-like-btn.is-pending::after {
      width: 46px;
      height: 46px;
    }
    #itube .watch-dislike-btn.is-pending::after {
      width: 38px;
      height: 38px;
    }
    @keyframes itube-pending-arc {
      to { --itube-arc: 1turn; }
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .is-pending::after {
        animation: none;
        background: rgba(var(--accent-rgb), .5);
      }
    }
    #itube .tool-menu-heading {
      padding: 4px 10px 6px;
      color: var(--dim);
      font: 600 11px -apple-system, system-ui, sans-serif;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    #itube .tool-menu-item svg {
      width: 14px;
      height: 14px;
      flex: none;
      visibility: hidden;
    }
    #itube .tool-menu-item.active svg {
      visibility: visible;
    }
    #itube .watch-likes {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 14px;
      flex: none;
    }
    #itube .watch-actions-spacer {
      flex: 1 1 auto;
      min-width: 12px;
    }
    #itube .watch-like-divider {
      display: none;
    }
    #itube .watch-like-btn,
    #itube .watch-dislike-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      height: auto;
      padding: 0;
      background: none;
      border: none;
      color: var(--text);
      font: 600 13px -apple-system, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    #itube .watch-like-btn:disabled,
    #itube .watch-dislike-btn:disabled {
      opacity: .4;
      cursor: default;
    }
    #itube .watch-like-btn svg,
    #itube .watch-dislike-btn svg {
      box-sizing: border-box;
      border-radius: 50%;
      flex: none;
      transition: background var(--tr), color var(--tr), border-color var(--tr);
    }
    #itube .watch-like-btn svg {
      width: 40px;
      height: 40px;
      padding: 10px;
      background: rgba(var(--accent-rgb), .18);
      color: var(--accent);
    }
    #itube .watch-dislike-btn svg {
      width: 32px;
      height: 32px;
      padding: 8px;
      background: var(--surface);
      border: 1px solid var(--edge);
      color: var(--muted);
    }
    #itube .watch-like-btn:hover:not(:disabled) svg {
      background: rgba(var(--accent-rgb), .3);
    }
    #itube .watch-dislike-btn:hover:not(:disabled) svg {
      background: var(--hover);
      color: var(--text);
    }
    #itube .watch-like-btn.active svg {
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      color: var(--on-accent);
    }
    #itube .watch-like-btn.active {
      color: var(--accent);
    }
    #itube .watch-dislike-btn.active svg {
      background: var(--danger-bg);
      border-color: var(--danger);
      color: var(--danger);
    }
    #itube .watch-dislike-btn.active {
      color: var(--danger);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .watch-like-btn svg,
      #itube .watch-dislike-btn svg {
        transition: none;
      }
    }
    #itube .watch-like-divider {
      width: 1px;
      height: 18px;
      background: var(--hairline);
      flex: none;
    }
    #itube .watch-subscribe {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      padding: 0 16px;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      border: none;
      border-radius: var(--r-pill);
      color: var(--on-accent);
      font: 600 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .watch-channel .watch-subscribe {
      position: relative;
      width: 40px;
      height: 40px;
      padding: 0;
      gap: 0;
      overflow: visible;
      border-radius: 50%;
      background: none;
      background-image: none;
      flex: none;
      transition: box-shadow var(--tr);
    }
    #itube .watch-channel .watch-avatar {
      width: 40px;
      height: 40px;
      display: block;
      border-radius: 50%;
    }
    #itube .watch-follow-badge {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: var(--raised);
      background-image: none;
      color: var(--text);
      box-shadow: 0 0 0 1px var(--edge), 0 0 0 3px var(--ink);
    }
    #itube .watch-channel .watch-subscribe.subscribed .watch-follow-badge {
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      color: var(--on-accent);
      box-shadow: 0 0 0 3px var(--ink);
    }
    #itube .watch-follow-badge svg {
      width: 11px;
      height: 11px;
    }
    #itube .watch-channel .watch-subscribe:hover:not(:disabled) {
      box-shadow: 0 0 0 2px rgba(var(--accent-rgb), .45);
      filter: none;
    }
    #itube .watch-channel .watch-subscribe.subscribed {
      box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--accent);
    }
    #itube .watch-channel .watch-subscribe.subscribed:hover:not(:disabled) {
      box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--accent);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .watch-channel .watch-subscribe {
        transition: none;
      }
    }
    #itube .watch-channel .watch-subscribe-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .watch-channel .watch-subscribe {
        transition: none;
      }
    }
    #itube .watch-subscribe:disabled {
      opacity: .4;
      cursor: default;
    }
    #itube .watch-subscribe.subscribed {
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
    }
    #itube .watch-subscribe.subscribed:hover {
      background: var(--hover);
    }
    #itube .watch-channel,
    #itube .watch-stats,
    #itube .watch-description,
    #itube .watch-skeleton {
      transition: opacity .2s ease;
    }
    #itube .watch-skeleton {
      display: none;
      flex-direction: column;
      gap: 12px;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    }
    #itube .watch-skeleton-channel {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    #itube .watch-skeleton-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      flex: none;
      background: var(--raised);
    }
    #itube .watch-skeleton-lines {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #itube .watch-skeleton-bar {
      border-radius: 4px;
      background: var(--raised);
    }
    #itube .watch-skeleton-name {
      width: 140px;
      height: 13px;
    }
    #itube .watch-skeleton-subs {
      width: 90px;
      height: 11px;
    }
    #itube .watch-skeleton-actions {
      display: flex;
      gap: 8px;
    }
    #itube .watch-skeleton-action {
      height: 34px;
      border-radius: var(--r-pill);
      background: var(--raised);
      flex: none;
    }
    #itube .watch-skeleton-pill {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--raised);
      flex: none;
      margin-left: auto;
    }
    #itube .sk-shimmer {
      position: relative;
      overflow: hidden;
    }
    /* transform, not background-position: a gradient whose position moves
       repaints the whole element every frame on the main thread, and every
       skeleton on screen pays it at once. A translated pseudo-element is
       compositor-only. */
    #itube .sk-shimmer::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      background: linear-gradient(90deg, transparent, var(--shimmer), transparent);
      transform: translateX(-100%);
      animation: itube-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes itube-shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .sk-shimmer::after {
        /* animation:none is the assertion checkSkeletonReducedMotion reads;
           display:none makes the resting band unambiguously invisible rather
           than relying on it sitting parked outside the clip. */
        animation: none;
        display: none;
      }
    }
    #itube .watch-stats {
      /* The quiet meta corner of the identity line (same rule the Up-next
         posters follow: content left, meta right) — not a stats LINE. */
      display: flex;
      align-items: center;
      gap: 6px 10px;
      margin-left: auto;
      font-size: 12px;
      color: var(--dim);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    #itube .watch-stats-text {
      color: var(--muted);
    }
    #itube .watch-hashtag {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    #itube .watch-hashtag:hover {
      text-decoration: underline;
    }
    #itube .watch-description {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #itube .watch-desc-link {
      color: var(--accent);
    }
    #itube .watch-desc-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #itube .watch-desc-chips:empty {
      display: none;
    }
    #itube .watch-desc-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--muted);
      font-size: 12.5px;
      text-decoration: none;
      max-width: 220px;
    }
    #itube .watch-desc-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #itube .watch-desc-chip svg {
      flex: none;
      width: 12px;
      height: 12px;
    }
    #itube .watch-desc-chip:hover {
      border-color: rgba(var(--accent-rgb), .4);
      color: var(--accent);
    }
    #itube .rail-tabs {
      display: flex;
      gap: 6px;
      flex: none;
    }
    #itube .rail-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      background: none;
      border: none;
      border-radius: var(--r-pill);
      color: var(--muted);
      font: 600 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .rail-tab:hover:not(:disabled) {
      background: var(--hover);
      color: var(--text);
    }
    #itube .rail-tab.active {
      background: var(--surface);
      color: var(--text);
    }
    #itube .rail-tab:disabled {
      cursor: default;
      opacity: .4;
    }
    #itube .rail-panel {
      min-width: 0;
    }
    /* Switching Up next <-> Comments used to snap: the panels swap display,
       which cannot transition. The incoming one gets one frame at a small
       offset and then settles — an entrance only, so nothing has to be held
       open on a timer while the outgoing panel fades. */
    #itube .rail-panel.entering {
      opacity: 0;
      transform: translateY(4px);
    }
    #itube .rail-panel.entered {
      opacity: 1;
      transform: none;
      transition: opacity .2s ease, transform .24s cubic-bezier(.22, .61, .36, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .rail-panel.entering,
      #itube .rail-panel.entered {
        opacity: 1;
        transform: none;
        transition: none;
      }
    }
    #itube .comments-count {
      font-size: 13px;
      font-weight: 400;
      color: var(--muted);
      letter-spacing: normal;
    }
    #itube .comments-sort {
      display: none;
      align-items: center;
      gap: 6px;
      flex: none;
      margin-bottom: 4px;
    }
    #itube .comments-sort-btn {
      height: 28px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--muted);
      font: 500 12.5px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .comments-sort-btn.active {
      background: rgba(var(--accent-rgb), .16);
      border-color: rgba(var(--accent-rgb), .45);
      color: var(--accent);
    }
    #itube .comments-list {
      display: flex;
      flex-direction: column;
    }
    #itube .comment-row {
      display: flex;
      gap: 12px;
      padding: 16px 0;
      border-bottom: 1px solid var(--hairline);
      transition: background var(--tr);
      content-visibility: auto;
      contain-intrinsic-size: auto 96px;
      contain: layout paint style;
    }
    #itube .comments-list > .comment-row:last-child {
      border-bottom: none;
    }
    #itube .comment-row:hover {
      background: rgba(var(--accent-rgb), .04);
    }
    #itube .comment-replies .comment-row {
      background: none;
      border: none;
      padding: 10px 0;
    }
    #itube .comment-replies .comment-row:hover {
      background: none;
    }
    #itube .comment-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--raised);
      flex: none;
      opacity: 0;
    }
    #itube .comment-body {
      flex: 1;
      min-width: 0;
    }
    #itube .comment-composer,
    #itube .comment-signin {
      display: none;
    }
    #itube .comment-composer.show {
      display: flex;
      gap: 12px;
      padding: 12px 0 14px;
      border-bottom: 1px solid var(--hairline);
    }
    #itube .comment-composer-avatar {
      opacity: 1;
    }
    #itube .comment-composer-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #itube .comment-composer-input {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      overflow: hidden;
      background: none;
      border: 0;
      border-bottom: 1px solid var(--hairline);
      padding: 4px 0 6px;
      color: var(--text);
      font: 400 14px/1.4 -apple-system, system-ui, sans-serif;
      transition: border-color var(--tr);
    }
    #itube .comment-composer-input::placeholder {
      color: var(--dim);
    }
    #itube .comment-composer-input:focus {
      outline: none;
      border-bottom-color: var(--accent);
    }
    #itube .comment-composer-actions {
      display: none;
      align-items: center;
      gap: 8px;
    }
    #itube .comment-composer.open .comment-composer-actions {
      display: flex;
    }
    #itube .comment-composer-error {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--danger);
    }
    #itube .comment-composer-btn {
      height: 32px;
      padding: 0 14px;
      border-radius: var(--r-pill);
      border: 1px solid var(--hairline);
      background: none;
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .comment-composer-btn:hover:not(:disabled) {
      background: var(--hover);
    }
    #itube .comment-composer-btn.primary {
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      border-color: transparent;
      color: var(--on-accent);
      font-weight: 600;
    }
    #itube .comment-composer-btn:disabled {
      opacity: .4;
      cursor: default;
    }
    #itube .comment-signin.show {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 0 14px;
      border-bottom: 1px solid var(--hairline);
      font-size: 13px;
      color: var(--muted);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .comment-composer-input {
        transition: none;
      }
    }
    #itube .comment-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    #itube .comment-author {
      font-size: 13px;
      font-weight: 600;
    }
    #itube .comment-time {
      font-size: 12.5px;
      color: var(--dim);
    }
    #itube .comment-text {
      margin-top: 4px;
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    #itube .comment-text.expanded {
      display: block;
      -webkit-line-clamp: unset;
    }
    /* Hidden until the batched clamp check proves the text actually
       overflows, and revealed by adding .show — never by clearing an inline
       display, which would just fall back to the 'none' below. */
    #itube .comment-showmore {
      display: none;
      margin-top: 4px;
      background: none;
      border: none;
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    #itube .comment-showmore.show {
      display: block;
    }
    #itube .comment-showmore:hover {
      color: var(--text);
    }
    #itube .comment-likes {
      margin-top: 6px;
      font-size: 12.5px;
      color: var(--dim);
    }
    #itube .comment-replies-btn {
      display: block;
      margin-top: 8px;
      background: none;
      border: none;
      /* Muted, not accent: with one of these per thread the rail was a column
         of bright green links, which made the accent meaningless where it
         actually matters (the active tab, the live sort pill). */
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    #itube .comment-replies-btn:hover {
      color: var(--text);
      text-decoration: underline;
    }
    #itube .comment-replies {
      margin-top: 10px;
      margin-left: 24px;
      display: flex;
      flex-direction: column;
    }
    #itube .comments-more {
      display: block;
      margin-top: 4px;
      background: none;
      border: none;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 12px 0 0;
    }
    #itube .comments-more:hover {
      color: var(--text);
    }
    #itube .comments-spinner {
      display: none;
      justify-content: center;
      padding: 16px 0;
      color: var(--muted);
      font-size: 13px;
    }
    #itube .comments-spinner.show {
      display: flex;
    }
    #itube .comments-empty {
      color: var(--muted);
      text-align: center;
      padding: 24px 0;
      font-size: 14px;
    }
    #itube .transcript-search {
      position: sticky;
      top: 0;
      z-index: 1;
      width: 100%;
      height: 34px;
      margin-top: 12px;
      border-radius: var(--r-xs);
      background: var(--raised);
      border: 1px solid var(--hairline);
      color: var(--text);
      padding: 0 12px;
      font-size: 13px;
      outline: none;
      box-sizing: border-box;
    }
    #itube .transcript-search:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    #itube .transcript-body {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #itube .transcript-line {
      display: flex;
      align-items: baseline;
      gap: 12px;
      width: 100%;
      text-align: left;
      padding: 6px 10px;
      border-radius: var(--r-sm);
      background: none;
      border: none;
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
    }
    #itube .transcript-line:hover {
      background: var(--hover);
    }
    #itube .transcript-line.active {
      background: var(--hover);
      color: var(--accent);
    }
    #itube .transcript-line.hidden {
      display: none;
    }
    #itube .transcript-time {
      flex: none;
      min-width: 48px;
      color: var(--muted);
      font: 500 12.5px ui-monospace, monospace;
    }
    #itube .itube-popup-overlay {
      position: fixed;
      inset: 0;
      margin: 0;
      padding: 0;
      max-width: none;
      max-height: none;
      width: 100%;
      height: 100%;
      border: none;
      background: var(--scrim);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 14000;
    }
    #itube .itube-popup-overlay.open,
    #itube .itube-popup-overlay:popover-open {
      display: flex;
    }
    #itube .itube-popup-panel {
      width: min(640px, 90vw);
      /* border-box, or the 20/26px padding is added ON TOP of max-height and
         the panel overshoots its own cap by 46px — enough to push it against
         the viewport edge on a short window. */
      box-sizing: border-box;
      max-height: 70vh;
      overflow-y: auto;
      background: var(--menu-bg);
      backdrop-filter: blur(22px) saturate(1.7);
      -webkit-backdrop-filter: blur(22px) saturate(1.7);
      border: 1px solid var(--hairline);
      border-radius: var(--r-lg);
      box-shadow: 0 24px 60px -16px var(--shadow-strong);
      padding: 20px 22px 26px;
      display: flex;
      flex-direction: column;
      opacity: 0;
      transform: scale(.98);
      transition: opacity .14s ease, transform .14s ease;
    }
    #itube .itube-popup-overlay.show .itube-popup-panel {
      opacity: 1;
      transform: scale(1);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .itube-popup-panel {
        transition: none;
      }
    }
    #itube .popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex: none;
    }
    #itube .popup-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -.01em;
      color: var(--text);
    }
    #itube .popup-close {
      background: none;
      border: none;
      color: var(--muted);
      padding: 6px;
      border-radius: var(--r-xs);
      cursor: pointer;
      flex: none;
    }
    #itube .popup-close:hover {
      background: var(--hover);
      color: var(--text);
    }
    #itube .desc-popup .watch-desc-chips {
      margin-top: 12px;
    }
    #itube .desc-popup .watch-description {
      margin-top: 14px;
    }
    #itube .transcript-status {
      font-size: 12.5px;
      color: var(--muted);
    }
    #itube .rc {
      display: flex;
      position: relative;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
      padding: 6px;
      border-radius: var(--r-sm);
    }
    #itube .rc:hover {
      background: var(--hover);
    }
    #itube .rc-thumb {
      flex: 0 0 168px;
      width: 168px;
      height: 94px;
      border-radius: var(--r-sm);
      overflow: hidden;
      background: var(--raised);
      position: relative;
    }
    #itube .rc-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
    }
    #itube .rc-body {
      flex: 1;
      min-width: 0;
    }
    #itube .rc-title {
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-wrap: pretty;
    }
    #itube .rc-chan {
      margin-top: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    #itube .rc-meta {
      margin-top: 2px;
      font-size: 11.5px;
      color: var(--dim);
    }
    #itube .rc-skel {
      display: flex;
      gap: 10px;
      padding: 6px;
    }
    #itube .rc-skel-thumb {
      flex: 0 0 168px;
      width: 168px;
      height: 94px;
      border-radius: var(--r-sm);
      background: var(--raised);
    }
    #itube .rc-skel-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 4px;
    }
    /* ---- Up next: poster cards ------------------------------------------
       Each card IS its thumbnail, full-bleed, with the text UNDER it — not on
       it. The title used to sit on a gradient scrim over the image, which
       looked right on the mock thumbnails and fell apart on real ones:
       YouTube thumbnails routinely have huge text baked in ("Inside an LLM",
       "91 YEARS?!"), so the overlaid title landed on top of the image's own
       words and both became unreadable. No scrim fixes that — the text has to
       come off the image. Same structure as the .c grid card now (thumb, then
       title/channel/meta), which the phone layout already proved reads
       cleanly over any thumbnail. Scoped to .related-wrap: the queue panel
       keeps the compact thumb-left rows (it's a position tracker; density
       wins there). Same DOM either way — this is styling only. */
    #itube .related-wrap .rc {
      display: block;
      padding: 8px;
      border-radius: var(--r-lg);
      background: none;
    }
    #itube .related-wrap .rc:hover {
      background: var(--hover);
      box-shadow: none;
    }
    #itube .related-wrap .rc-thumb {
      flex: none;
      width: 100%;
      height: auto;
      aspect-ratio: 16 / 9;
      border-radius: var(--r-sm);
    }
    #itube .related-wrap .rc-body {
      margin-top: 10px;
    }
    /* NO min-height here, unlike .c-title. Reserving two lines put the slack
       *between* the title and the channel name: a one-line title left a 21px
       hole where a two-line title had 2.8px, which reads as a layout bug.
       It bought nothing — .related-wrap is a single column above 1239px, and
       a grid below it, where the default align-items:stretch already equalises
       row heights (measured: cards stay 256.7px tall with or without it).
       The 2-line cap is -webkit-line-clamp on .rc-title; that still applies. */
    #itube .related-wrap .rc-title {
      font-size: 13.5px;
    }
    /* The first card is what autoplay will actually play — say so. */
    #itube.autoplay-on .related-wrap .rc:first-child .rc-thumb::after {
      content: 'NEXT';
      position: absolute;
      top: 8px;
      left: 8px;
      padding: 3px 7px;
      border-radius: var(--r-xs);
      font: 700 10px -apple-system, system-ui, sans-serif;
      letter-spacing: .08em;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      color: var(--on-accent);
    }
    /* Skeleton mirrors the loaded card — thumb plus text lines — so the rail
       does not jump when the text arrives. */
    #itube .related-wrap .rc-skel {
      display: block;
      padding: 8px;
    }
    #itube .related-wrap .rc-skel-thumb {
      width: 100%;
      height: auto;
      aspect-ratio: 16 / 9;
      border-radius: var(--r-sm);
    }
    #itube .related-wrap .rc-skel-body {
      padding-top: 10px;
    }

    #itube .rc-skel-body .sk-line.short {
      height: 10px;
    }
    #itube .list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
    }
    #itube .row {
      display: flex;
      position: relative;
      gap: 16px;
      color: var(--text);
      text-decoration: none;
      content-visibility: auto;
      contain-intrinsic-size: auto 138px;
      contain: layout paint style;
      padding: 8px;
      margin: -8px;
      border-radius: 14px;
      min-width: 0;
    }
    #itube .row:hover {
      background: var(--hover);
    }

    #itube .c-link:focus-visible ~ .c-thumb,
    #itube .row-link:focus-visible ~ .row-thumb,
    #itube .rc-link:focus-visible ~ .rc-thumb {
      outline: 1px solid var(--accent);
      outline-offset: 2px;
    }
    #itube .row-thumb {
      width: 246px;
      height: 138px;
      flex: 0 0 246px;
      border-radius: var(--r-sm);
      overflow: hidden;
      background: var(--raised);
      position: relative;
    }
    #itube .row-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
    }
    #itube .row-body {
      flex: 1;
      min-width: 0;
    }
    #itube .row-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -.01em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-wrap: pretty;
    }
    #itube .row-chan {
      margin-top: 6px;
      font-size: 13px;
      color: var(--muted);
    }
    #itube .row-meta {
      margin-top: 2px;
      font-size: 12.5px;
      color: var(--dim);
      font-variant-numeric: tabular-nums;
    }
    #itube .row-desc {
      margin-top: 8px;
      font-size: 13px;
      color: var(--dim);
      /* Prose gets a reading measure. The row itself still fills the column
         (the grid/list gutter invariants depend on that), but at 1440+ the
         snippet was running ~130 characters per line — the one genuinely
         long-form text in a list row. Same reasoning as .ch-about's 640px. */
      max-width: 80ch;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    #itube .row-skel {
      display: flex;
      gap: 16px;
      padding: 8px;
      margin: -8px;
      min-width: 0;
    }
    #itube .row-skel-thumb {
      width: 246px;
      height: 138px;
      flex: 0 0 246px;
      border-radius: var(--r-sm);
      background: var(--raised);
    }
    #itube .row-skel-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-top: 4px;
    }
    #itube .row-skel-body .sk-line.short {
      height: 10px;
    }
    #itube .empty {
      grid-column: 1 / -1;
      color: var(--muted);
      text-align: center;
      padding: 48px 0;
      font-size: 14px;
    }
    /* Centred in the view, the same as .unhandled — it used to sit at the top
       with ~640px of dead space under it on a 900px screen, which read as a
       page that had failed to finish loading rather than a deliberate state. */
    #itube .signin-state {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 48px 16px;
      min-height: 60vh;
      text-align: center;
    }
    #itube .signin-title {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.01em;
      color: var(--text);
    }
    #itube .signin-message {
      font-size: 14px;
      color: var(--muted);
      max-width: 420px;
    }
    #itube .signin-btn {
      display: flex;
      align-items: center;
      height: 34px;
      padding: 0 16px;
      border-radius: var(--r-pill);
      background: rgba(var(--accent-rgb), .16);
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    #itube .signin-btn:hover {
      background: rgba(var(--accent-rgb), .24);
    }
    #itube .hd-signin {
      display: flex;
      align-items: center;
      height: 28px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: rgba(var(--accent-rgb), .16);
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      flex: none;
    }
    #itube .hd-signin:hover {
      background: rgba(var(--accent-rgb), .24);
    }
    #itube .watch-signin-hint {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    /* Had no rule at all, so it rendered at the browser's default 16px in
       full-strength body text — the one state block in the app that didn't
       match .empty / .comments-empty. */
    #itube .watch-unavailable {
      padding: 20px 0 4px;
      font-size: 14px;
      color: var(--muted);
    }
    #itube .ch-header {
      margin-bottom: 24px;
    }
    #itube .ch-banner {
      display: block;
      width: 100%;
      height: 160px;
      object-fit: cover;
      border-radius: var(--r-md);
      opacity: 0;
    }
    #itube .ch-avatar {
      width: 80px;
      height: 80px;
      border-radius: var(--r-lg);
      object-fit: cover;
      background: var(--raised);
      border: 3px solid var(--ink);
      margin-top: -24px;
      opacity: 0;
      position: relative;
    }
    #itube .ch-title-row {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    #itube .ch-title-col {
      flex: 1;
      min-width: 0;
    }
    #itube .ch-name {
      margin: 12px 0 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -.02em;
    }
    #itube .ch-meta {
      margin-top: 4px;
      font-size: 13px;
      color: var(--muted);
    }
    #itube .ch-tabs {
      display: flex;
      gap: 20px;
      margin-top: 20px;
      border-bottom: 1px solid var(--hairline);
    }
    #itube .ch-tab {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 14px;
      font-weight: 500;
      padding: 0 2px 10px;
      cursor: pointer;
      position: relative;
    }
    #itube .ch-tab:hover:not(.active) {
      color: var(--text);
    }
    #itube .ch-tab.active {
      color: var(--text);
      font-weight: 600;
    }
    #itube .ch-tab.active::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 2px;
      background: var(--accent);
      border-radius: var(--r-pill);
    }
    #itube .ch-about {
      max-width: 640px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding-top: 24px;
    }
    #itube .ch-about-desc {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      white-space: pre-wrap;
    }
    #itube .ch-about-stats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #itube .ch-about-row {
      display: flex;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    #itube .ch-about-row strong {
      color: var(--text);
      font-weight: 600;
      min-width: 110px;
      flex: none;
    }
    #itube .ch-about-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 20px;
    }
    #itube .ch-about-link {
      font-size: 13px;
      color: var(--accent);
      text-decoration: none;
    }
    #itube .ch-about-link:hover {
      text-decoration: underline;
    }
    #itube-bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      box-sizing: border-box;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px 18px 14px;
      border-radius: 0 0 var(--r-lg) var(--r-lg);
      /* Much lighter than the old full-height scrim: the controls now carry
         their own material, so this only has to keep the timecodes and the
         rail legible over a bright frame. */
      background: linear-gradient(to top, rgba(6, 7, 12, .88) 15%, rgba(6, 7, 12, .55) 55%, rgba(6, 7, 12, 0));
      border: none;
      color: #fff;
      font: 500 13px -apple-system, system-ui, sans-serif;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 200ms ease, visibility 0s linear 200ms;
    }
    #itube-stage.show #itube-bar,
    #itube-bar:focus-within {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: opacity 120ms ease;
    }
    /* Floating control capsules — Apple's transport grammar. They share
       #itube-bar's visibility so the whole chrome fades as one unit, and they
       sit ON video, which is why the light theme leaves them dark (see the
       dark-locked block near the top of this stylesheet).
       pointer-events stay off until shown so an idle player passes clicks
       straight through to the video for play/pause. */
    #itube-tools,
    #itube-sound,
    #itube-viewer,
    #itube-transport {
      position: absolute;
      z-index: 21;
      display: flex;
      align-items: center;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 200ms ease, visibility 0s linear 200ms;
    }
    #itube-stage.show #itube-tools,
    #itube-stage.show #itube-sound,
    #itube-stage.show #itube-viewer,
    #itube-stage.show #itube-transport,
    #itube-tools:focus-within,
    #itube-sound:focus-within,
    #itube-viewer:focus-within,
    #itube-transport:focus-within {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: opacity 120ms ease;
    }
    /* The material. backdrop-filter over PLAYING video makes the compositor
       re-sample and blur the frame every tick, so this is deliberately on
       three small capsules rather than the whole bar — and the capsules are
       hidden (and therefore not composited) whenever the controls are idle. */
    #itube-tools,
    #itube-sound,
    #itube-viewer {
      gap: 2px;
      padding: 4px;
      border-radius: 999px;
      background: rgba(22, 23, 28, .5);
      backdrop-filter: blur(24px) saturate(1.7);
      -webkit-backdrop-filter: blur(24px) saturate(1.7);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .13), 0 6px 22px rgba(0, 0, 0, .3);
    }
    /* Corner controls get a bigger hit target than the bar's own buttons —
       they are small floating pills on video, not a dense toolbar row. */
    /* #itube-stage prefix is load-bearing: the shared "#itube-bar button" rule
       further down has the same specificity and would otherwise win on order,
       which silently pinned these back to 28px. */
    #itube-stage #itube-tools button,
    #itube-stage #itube-sound button,
    #itube-stage #itube-viewer button {
      width: 34px;
      height: 34px;
    }
    #itube-stage #itube-tools button svg,
    #itube-stage #itube-sound button svg,
    #itube-stage #itube-viewer button svg {
      width: 18px;
      height: 18px;
    }
    /* The theater button is meaningless while the stage is fullscreen — see
       applyTheater. Kept as two rules on purpose: an engine that does not know
       one of these pseudo-classes would throw away the entire selector list. */
    #itube-stage:fullscreen #itube-theater { display: none; }
    #itube-stage:-webkit-full-screen #itube-theater { display: none; }
    /* Hidden in the inline layout (the page already shows the title), revealed
       in theater and fullscreen. Shares the chrome's fade so it comes and goes
       with the controls. */
    #itube .itube-stage-meta {
      position: absolute;
      left: 20px;
      bottom: 74px;
      z-index: 21;
      max-width: 52%;
      display: none;
      color: #fff;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .55);
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
    }
    #itube.theater .itube-stage-meta,
    #itube-stage:fullscreen .itube-stage-meta { display: block; }
    #itube-stage:-webkit-full-screen .itube-stage-meta { display: block; }
    #itube-stage.show .itube-stage-meta { opacity: 1; }
    #itube .itube-stage-meta-channel {
      font: 500 13px -apple-system, system-ui, sans-serif;
      color: rgba(255, 255, 255, .78);
      margin-bottom: 2px;
    }
    #itube .itube-stage-meta-title {
      font: 700 22px -apple-system, system-ui, sans-serif;
      letter-spacing: -.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .itube-stage-meta { transition: none; }
    }
    #itube-tools { top: 14px; left: 14px; }
    /* Slider first, speaker last — Apple's order. The extra left padding is
       load-bearing: at full volume the thumb's centre sits at the track's end,
       so without it half the thumb overhangs the pill's rounded cap and the
       capsule reads as two mismatched radii fighting each other. */
    #itube-sound { top: 14px; right: 14px; padding: 4px 6px 4px 14px; gap: 10px; }
    #itube-viewer { right: 14px; bottom: 64px; }
    /* Explicit three-track grid, not a flex row: prev/next are display:none
       on anything that isn't a playlist, and a flex cluster then centres
       "play + next" as a unit, which puts the play button off-centre on every
       ordinary video. Fixed tracks plus explicit column placement keep the
       play button on the stage's centre line whatever is hidden. */
    #itube-transport {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: grid;
      grid-template-columns: 56px 84px 56px;
      gap: 40px;
      align-items: center;
      justify-items: center;
    }
    #itube-transport #itube-prev { grid-column: 1; }
    #itube-transport #itube-play { grid-column: 2; }
    #itube-transport #itube-next { grid-column: 3; }
    /* The transport is a layout box with no surface of its own, so it must not
       swallow clicks in the gaps between its buttons. It sits dead centre —
       exactly where people click the video to pause — and counting as player
       chrome there killed click-to-pause on the middle of the frame. The
       capsules keep pointer-events because they ARE painted surfaces. */
    #itube-stage.show #itube-transport { pointer-events: none; }
    #itube-transport button { pointer-events: auto; }
    #itube-stage #itube-transport button {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(22, 23, 28, .5);
      backdrop-filter: blur(24px) saturate(1.7);
      -webkit-backdrop-filter: blur(24px) saturate(1.7);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .13), 0 6px 22px rgba(0, 0, 0, .3);
    }
    /* Three ids: the sibling "#itube-stage #itube-transport button" rule is
       (2,0,1) and would otherwise size the play button like the skips. */
    #itube-stage #itube-transport #itube-play {
      width: 84px;
      height: 84px;
    }
    #itube-stage #itube-transport button svg { width: 24px; height: 24px; }
    #itube-stage #itube-transport #itube-play svg { width: 30px; height: 30px; }
    @media (prefers-reduced-motion: reduce) {
      #itube-bar,
      #itube-tools,
      #itube-sound,
      #itube-viewer,
      #itube-transport {
        transition: none;
      }
    }
    /* macOS System Settings > Accessibility > Display > Reduce Transparency.
       Vibrancy is a system-level preference on this platform, so honouring it
       is the native behaviour rather than a nicety — and it is the one
       accessibility switch that also makes the app cheaper, since every
       backdrop-filter below stops compositing a blurred backdrop. Surfaces go
       opaque instead of losing their blur and turning into murk. */
    @media (prefers-reduced-transparency: reduce) {
      #itube {
        --menu-bg: #12131a;
        --scrim: rgba(0, 0, 0, .82);
      }
      #itube.light {
        --menu-bg: #ffffff;
        --scrim: rgba(15, 18, 24, .55);
      }
      #itube .search-suggest,
      #itube .settings-panel,
      #itube .cmdk-panel,
      #itube .itube-popup-panel,
      #itube .settings-overlay,
      #itube .cmdk-overlay,
      #itube-tools,
      #itube-sound,
      #itube-viewer,
      #itube-transport button {
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      #itube-tools,
      #itube-sound,
      #itube-viewer,
      #itube-transport button {
        background: rgba(16, 17, 21, .94);
      }
    }
    /* Top-centre, not middle: the transport cluster owns the centre of the
       frame now, and an OSD slab there covered the very button you pressed. */
    #itube-cue {
      position: absolute;
      top: 18px;
      left: 50%;
      transform: translate(-50%, -6px);
      border-radius: 999px;
      background: rgba(12, 13, 18, .5);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 12px;
      color: rgba(255, 255, 255, .92);
      font: 500 12px -apple-system, system-ui, sans-serif;
      letter-spacing: .01em;
      white-space: nowrap;
      z-index: 25;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      /* The OSD used to pop in and out with no transition at all — the one
         piece of feedback the user sees on every seek/volume keystroke. It
         rises quickly and settles out slowly; visibility is delayed by the
         fade so it stays hittable-by-nothing but paints while leaving. */
      transition: opacity 160ms ease, transform 200ms cubic-bezier(.22, .61, .36, 1), visibility 0s linear 160ms;
    }
    #itube-cue.show {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, 0);
      transition: opacity 90ms ease, transform 200ms cubic-bezier(.22, .61, .36, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube-cue,
      #itube-cue.show {
        transition: none;
        transform: translate(-50%, -50%);
      }
    }
    #itube-cue svg {
      width: 22px;
      height: 22px;
    }
    #itube-bar-left,
    #itube-bar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: none;
      /* Timecodes jitter on every tick with proportional digits — the one
         typographic detail that reads as "not a native player". */
      font-variant-numeric: tabular-nums;
    }
    #itube-seekwrap {
      flex: 1;
      min-width: 0;
    }
    #itube-tools button,
    #itube-sound button,
    #itube-viewer button,
    #itube-transport button,
    #itube-bar button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #fff;
      cursor: pointer;
      flex: none;
    }
    #itube-tools button:hover,
    #itube-sound button:hover,
    #itube-viewer button:hover,
    #itube-bar button:hover { background: rgba(255, 255, 255, .14); }
    #itube-tools button:active,
    #itube-sound button:active,
    #itube-viewer button:active,
    #itube-transport button:active,
    #itube-bar button:active { background: rgba(255, 255, 255, .22); }
    #itube-bar .itube-time {
      flex: none;
      opacity: .85;
      font-variant-numeric: tabular-nums;
    }
    #itube-sound input[type="range"],
    #itube-bar input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, .18);
      cursor: pointer;
      margin: 0;
    }
    #itube-sound input[type="range"]::-webkit-slider-thumb,
    #itube-bar input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      border: none;
      box-shadow: 0 0 0 1px rgba(6, 7, 12, .55);
    }
    /* The seek rail is the one control you aim at mid-video, and Apple's is
       visibly chunkier than the volume slider it shares a base rule with here.
       Two ids so this outranks #itube-bar input[type="range"]. */
    #itube-bar #itube-seek {
      height: 6px;
      border-radius: 3px;
    }
    #itube-bar #itube-seek::-webkit-slider-thumb {
      width: 16px;
      height: 16px;
    }
    /* The rail is 6px but the grab target is the full row: a thin bar you have
       to hit exactly is the difference between scrubbing and missing. */
    #itube-bar #itube-seek {
      padding: 10px 0;
      background-clip: content-box;
    }
    #itube-seekwrap {
      position: relative;
      flex: 1;
      display: flex;
      align-items: center;
      min-width: 60px;
    }
    #itube-seek { width: 100%; }
    .itube-tick {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 8px;
      border-radius: 1px;
      background: rgba(10, 10, 14, .55);
      pointer-events: none;
    }
    #itube .itube-sb-marker {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      height: 5px;
      min-width: 2px;
      border-radius: 2px;
      pointer-events: none;
      z-index: 3;
      opacity: .9;
    }
    #itube .itube-ab-region {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      height: 5px;
      border-radius: 2px;
      background: rgba(var(--accent-rgb), .28);
      pointer-events: none;
      z-index: 2;
    }
    #itube .itube-ab-marker {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 12px;
      border-radius: 1px;
      background: var(--accent);
      pointer-events: none;
      z-index: 4;
    }
    #itube-vol { width: 84px; flex: none; }
    #itube-preview {
      position: absolute;
      bottom: 24px;
      transform: translateX(-50%);
      display: none;
      pointer-events: none;
      z-index: 21;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, .25);
      overflow: hidden;
      background-color: #000;
      background-repeat: no-repeat;
    }
    /* Chapter name over the scrub preview. The seek bar already drew tick marks
       dividing the video into sections; this is what tells you what a section
       is. Its own element rather than a child of #itube-preview, which is
       sprite-width (~160px) and clips its overflow. */
    #itube .itube-pchapter {
      position: absolute;
      transform: translateX(-50%);
      z-index: 21;
      display: none;
      max-width: min(300px, 80%);
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(10, 10, 14, .88);
      color: #fff;
      font: 600 11.5px -apple-system, system-ui, sans-serif;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    #itube .itube-pchapter.show {
      display: block;
    }
    #itube-preview .itube-ptime {
      position: absolute;
      bottom: 4px;
      left: 50%;
      transform: translateX(-50%);
      font: 600 11px -apple-system, system-ui, sans-serif;
      color: #fff;
      background: rgba(0, 0, 0, .6);
      padding: 1px 6px;
      border-radius: 6px;
    }
    #itube-live {
      width: auto !important;
      border-radius: 999px !important;
      padding: 0 10px !important;
      font-weight: 600;
    }
    #itube-live::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f33;
      margin-right: 5px;
    }
    #itube-live.behind { opacity: .55; }
    #itube-live.behind::before { background: #999; }
    ytd-app {
      position: fixed !important;
      left: -99999px !important;
      top: 0 !important;
      width: 1280px !important;
      height: 720px !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    /* Parked AND not rendered. The offscreen ytd-app was the single biggest
       remaining scroll cost — not Flyt's own grid: lifting the identical 120
       cards into a standalone page scrolled at 1 janky frame of 149, while the
       same cards inside the live page managed 6-8. Skipping YouTube's render
       work halves that (6 -> 3 on the channel grid).
       NOT display:none, which throws away layout state; content-visibility
       keeps the box and its explicit 1280x720 while skipping its contents.
       Route-scoped ON PURPOSE — it skips DESCENDANT layout, and #movie_player
       has to keep laying out to decode, so this may only apply where Flyt is
       not driving the player: never on watch, and never while the mini-player
       is alive. route() and the mini-player handoff own the class. */
    body.flyt-yt-dormant ytd-app {
      content-visibility: hidden !important;
    }
    @media (max-width: 1239px) {
      #itube .watch {
        grid-template-columns: 1fr;
      }
      #itube .watch-right {
        position: static;
        max-height: none;
      }
      #itube .related-wrap {
        display: grid;
        /* .rc-thumb is a fixed 168px — a 220px column floor left ~30px for
           the card body (titles clamped to ~2 chars/line). 300px keeps the
           horizontal card readable at every auto-fill width. */
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
      }
      #itube .queue-wrap,
      #itube .related-wrap {
        gap: 16px;
      }
    }
    #itube.rail-collapsed .sidebar {
      width: 72px;
      padding: 12px 4px 16px;
    }
    #itube.rail-collapsed .sidebar-head {
      gap: 10px;
      padding: 0 0 10px;
    }
    #itube.rail-collapsed .sidebar-logo-row {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: auto;
    }
    #itube.rail-collapsed .hd-right {
      margin-left: 0;
    }
    #itube.rail-collapsed .search-wrap {
      display: none;
    }
    #itube.rail-collapsed .search-wrap.expanded {
      display: flex;
      position: absolute;
      left: calc(100% + 8px);
      top: 0;
      width: 260px;
      z-index: 30;
    }
    #itube.rail-collapsed .rail-search-btn {
      display: flex;
    }
    #itube.rail-collapsed .brand-word,
    #itube.rail-collapsed .brand-beta,
    #itube.rail-collapsed .itube-power {
      display: none;
    }
    #itube.rail-collapsed .sidebar-signin-row {
      display: none;
    }
    #itube.rail-collapsed .nav-row {
      justify-content: center;
      padding: 0;
    }
    #itube.rail-collapsed .nav-row span,
    #itube.rail-collapsed .nav-section-label,
    #itube.rail-collapsed .nav-chan span {
      display: none;
    }
    #itube.rail-collapsed .nav-chan {
      justify-content: center;
      padding: 4px 0;
    }
    #itube.rail-collapsed .nav-subs {
      display: none;
    }
    @media (max-width: 1100px) {
      #itube .rail-toggle-btn {
        display: none;
      }
    }
    @media (max-width: 600px) {
      #itube .rail-search-btn,
      #itube .search-wrap.expanded {
        display: none;
      }
      #itube .body {
        flex-direction: column;
      }
      #itube .sidebar {
        width: 100%;
        height: auto;
        flex-direction: row;
        align-items: center;
        gap: 10px;
        overflow: visible;
        padding: 8px 12px;
        border-bottom: 1px solid var(--hairline);
      }
      #itube .sidebar-head {
        position: static;
        flex-direction: row;
        align-items: center;
        gap: 10px;
        flex: 1;
        min-width: 0;
        margin: 0;
        padding: 0;
        border-bottom: none;
      }
      #itube .sidebar-logo-row {
        flex: none;
        flex-direction: row;
        align-items: center;
      }
      #itube .search-wrap {
        display: block;
        flex: 1;
        min-width: 0;
      }
      #itube .brand-word,
      #itube .brand-beta,
      #itube .nav-row,
      #itube .nav-subs {
        display: none;
      }
      #itube .content {
        padding: 12px;
      }
      #itube .watch {
        grid-template-columns: 1fr;
      }
      #itube .watch-right {
        position: static;
        max-height: none;
      }
      #itube .watch-channel {
        flex-wrap: wrap;
        row-gap: 10px;
      }
      #itube .watch-channel-spacer {
        flex: 1 1 100%;
        min-width: 100%;
        height: 0;
      }
      #itube .search-filters {
        flex-wrap: wrap;
        row-gap: 8px;
      }
      /* Own line, left-aligned. On a phone these wrapped onto the end of the
         row they share and got shoved to the right edge by margin-left:auto,
         so the strip read as unrelated fragments. */
      #itube .watch-stats {
        flex: 1 1 100%;
        margin-left: 0;
      }
      /* The rail breakpoint (1100px) hides the sign-in row because the text
         button can't fit a 72px rail — in the top-bar layout there's room
         again, and a signed-out user needs SOME sign-in affordance. */
      #itube .sidebar-signin-row {
        display: block;
        flex: none;
      }
      /* 246px thumbs don't leave a readable row body on phone-ish widths. */
      #itube .row-thumb,
      #itube .row-skel-thumb {
        width: 160px;
        flex: 0 0 160px;
        height: 90px;
      }
    }
    #itube-boot {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #06070c;
      color: #a2a7b3;
      font-family: -apple-system, system-ui, sans-serif;
      opacity: 1;
      transition: opacity .3s cubic-bezier(.4, 0, .2, 1);
    }
    /* The backdrop never fades IN — it is opaque from the first frame or
       YouTube's page shows through. The contents are what arrive and leave:
       up on the way in, up and slightly larger on the way out, so the splash
       hands over to the app rather than blinking off. */
    #itube-boot .itube-boot-inner {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      opacity: 0;
      transform: translateY(8px) scale(.97);
      transition: opacity .32s cubic-bezier(.2, .7, .3, 1), transform .32s cubic-bezier(.2, .7, .3, 1);
    }
    #itube-boot.itube-boot-in .itube-boot-inner {
      opacity: 1;
      transform: none;
    }
    /* After the .itube-boot-in rules: equal specificity, so source order is
       what makes leaving win over arriving when a boot finishes mid-fade. */
    #itube-boot.itube-boot-hide {
      opacity: 0;
      pointer-events: none;
    }
    #itube-boot.itube-boot-hide .itube-boot-inner {
      opacity: 0;
      transform: translateY(-6px) scale(1.04);
    }
    #itube-boot .itube-boot-text {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    #itube-boot .itube-boot-word {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -.01em;
      background-image: var(--itube-boot-sweep, linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    /* The bright sweep is a fill, not ink — on a near-white splash it needs
       the darkened copy, exactly as .brand-word does inside the app. */
    #itube-boot.light .itube-boot-word {
      background-image: linear-gradient(135deg, #1d6844 0%, #126669 48%, #305e93 100%);
    }
    /* Boot mirrors the theme so a light-mode user doesn't get a black flash
       before #itube paints. The mark and the progress pip keep the aurora —
       they are fills, and the sweep reads on either background. */
    #itube-boot.light {
      background: #f4f5f8;
      color: #5b6273;
      color-scheme: light;
    }
    #itube-boot.light .itube-boot-bar {
      background: rgba(15, 18, 24, .1);
    }
    #itube-boot .itube-boot-mark {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 16px;
      /* Literal: #itube-boot is outside #itube and cannot see the tokens. */
      background-color: var(--itube-boot-accent, #22c3c9);
      background-image: var(--itube-boot-sweep, linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%));
      box-shadow: 0 12px 32px -14px color-mix(in srgb, var(--itube-boot-accent, #22c3c9) 70%, transparent);
    }
    #itube-boot .itube-boot-mark svg {
      display: block;
      /* The glyph is optically centred, not geometrically: a play triangle
         with its flat edge on the left reads left-heavy when centred by box. */
      margin-left: 2px;
    }
    #itube-boot .itube-boot-label {
      font-size: 12px;
      opacity: .8;
    }
    #itube-boot .itube-boot-bar {
      position: relative;
      width: 160px;
      height: 3px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .12);
      overflow: hidden;
    }
    /* transform, not left: this is the very first motion a user sees, and an
       animated left relayouts the bar every frame for the whole boot. The
       track is 160px and the pip 40% of it (64px), so -100% .. 250% of the
       pip's own width is the same travel the old -40% .. 100% of left was. */
    #itube-boot .itube-boot-bar::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 40%;
      border-radius: 999px;
      background-color: var(--itube-boot-accent, #22c3c9);
      background-image: var(--itube-boot-sweep, linear-gradient(90deg, #3ddb8f, #22c3c9, #4a8fe0));
      transform: translateX(-100%);
      animation: itube-boot-progress 1.1s ease-in-out infinite;
    }
    @keyframes itube-boot-progress {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(250%); }
    }
    @media (prefers-reduced-motion: reduce) {
      #itube-boot {
        transition: none;
      }
      #itube-boot .itube-boot-inner {
        opacity: 1;
        transform: none;
        transition: none;
      }
      #itube-boot.itube-boot-hide .itube-boot-inner {
        transform: none;
      }
      #itube-boot .itube-boot-bar::after {
        animation: none;
        transform: none;
        width: 100%;
      }
    }
    /* Flyt's own reduce-motion setting. #itube-boot is outside #itube, so the
       .itube-reduce-motion class on the app root cannot select it and the
       overlay carries its own flag instead. */
    #itube-boot.no-motion,
    #itube-boot.no-motion .itube-boot-inner {
      transition: none;
    }
    #itube-boot.no-motion .itube-boot-inner {
      opacity: 1;
      transform: none;
    }
    #itube-boot.no-motion.itube-boot-hide .itube-boot-inner {
      opacity: 0;
      transform: none;
    }
    #itube-boot.no-motion .itube-boot-bar::after {
      animation: none;
      transform: none;
      width: 100%;
    }
    /* Pseudo-elements are not matched by a bare universal selector, so they
       used to keep animating with the in-app setting on. The pending ring is
       the first thing that animates from an ::after, and it is what surfaced
       the gap. */
    #itube.itube-reduce-motion *,
    #itube.itube-reduce-motion *::before,
    #itube.itube-reduce-motion *::after {
      transition: none !important;
      animation: none !important;
    }
    #itube.itube-reduce-motion .is-pending::after {
      background: rgba(var(--accent-rgb), .5);
    }
    #itube .nav-settings {
      width: 100%;
      background: none;
      border: none;
      cursor: pointer;
      margin-top: 8px;
    }
    #itube .settings-overlay {
      position: fixed;
      inset: 0;
      background: var(--scrim);
      backdrop-filter: blur(6px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 12000;
    }
    #itube .settings-overlay.open {
      display: flex;
    }
    /* Scrim + panel fade/scale, driven by .show one frame after .open (see
       wireOverlay) — matches .itube-popup-panel so every modal surface in the
       app enters and leaves the same way. */
    #itube .settings-overlay,
    #itube .cmdk-overlay {
      opacity: 0;
      transition: opacity .14s ease;
    }
    #itube .settings-overlay.show,
    #itube .cmdk-overlay.show {
      opacity: 1;
    }
    #itube .settings-panel,
    #itube .cmdk-panel {
      opacity: 0;
      transform: scale(.98);
      transition: opacity .14s ease, transform .14s ease;
    }
    #itube .settings-overlay.show .settings-panel,
    #itube .cmdk-overlay.show .cmdk-panel {
      opacity: 1;
      transform: scale(1);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .settings-overlay,
      #itube .cmdk-overlay,
      #itube .settings-panel,
      #itube .cmdk-panel {
        transition: none;
      }
    }
    #itube .settings-panel {
      width: min(520px, 92vw);
      max-width: 520px;
      /* See .itube-popup-panel: without this the panel rendered 822px against
         an 86vh (774px) cap, leaving only 39px of breathing room top and
         bottom on a 900px screen. */
      box-sizing: border-box;
      max-height: 86vh;
      overflow-y: auto;
      background: var(--menu-bg);
      backdrop-filter: blur(22px) saturate(1.7);
      -webkit-backdrop-filter: blur(22px) saturate(1.7);
      border: 1px solid var(--hairline);
      border-radius: var(--r-lg);
      box-shadow: 0 24px 60px -16px var(--shadow-strong);
      padding: 20px 22px 26px;
    }
    #itube .settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    #itube .settings-title {
      font-weight: 700;
      font-size: 18px;
    }
    #itube .settings-close {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 15px;
      line-height: 1;
      padding: 6px;
      border-radius: var(--r-xs);
      cursor: pointer;
    }
    #itube .settings-close:hover {
      background: var(--hover);
      color: var(--text);
    }
    #itube .settings-section-heading {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--dim);
      margin: 22px 0 8px;
    }
    #itube .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 0;
    }
    #itube .settings-row-label {
      color: var(--text);
      font-size: 14px;
    }
    #itube .settings-swatches {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    #itube .settings-swatch {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 2px solid transparent;
      padding: 0;
      cursor: pointer;
    }
    #itube .settings-swatch.selected {
      border-color: var(--text);
      box-shadow: 0 0 0 2px var(--raised);
    }
    #itube .settings-swatch:hover {
      box-shadow: 0 0 0 2px var(--accent);
    }
    /* Hovering the selected swatch must not discard its selection ring. */
    #itube .settings-swatch.selected:hover {
      box-shadow: 0 0 0 2px var(--raised), 0 0 0 3px var(--accent);
    }
    #itube .settings-color {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--hairline);
      border-radius: 50%;
      background: none;
      cursor: pointer;
      transition: border-color var(--tr);
    }
    #itube .settings-color:hover {
      border-color: var(--accent);
    }
    /* WebKit draws its own swatch inside the control, so border-radius on the
       input alone left a square chip sitting in a row of circles. */
    #itube .settings-color::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    #itube .settings-color::-webkit-color-swatch {
      border: none;
      border-radius: 50%;
    }
    #itube .settings-select {
      -webkit-appearance: none;
      appearance: none;
      height: 32px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .settings-toggle {
      width: 52px;
      height: 28px;
      padding: 0;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--muted);
      font: 600 12px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .settings-toggle:hover:not(.active) {
      background: var(--hover);
    }
    #itube .settings-toggle.active {
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      border-color: var(--accent-solid);
      color: var(--on-accent);
    }
    #itube .settings-toggle.active:hover {
      filter: brightness(1.08);
    }
    #itube .settings-keyword-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #itube .settings-keyword-input {
      flex: 1;
      height: 32px;
      padding: 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font: 500 13px -apple-system, system-ui, sans-serif;
      outline: none;
    }
    #itube .settings-keyword-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    #itube .settings-keyword-add {
      height: 32px;
      padding: 0 14px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font: 600 12px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .settings-keyword-add:hover {
      border-color: var(--accent);
    }
    #itube .settings-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    #itube .settings-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 6px 0 12px;
      border-radius: var(--r-pill);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font-size: 12.5px;
    }
    #itube .settings-chip-remove {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 13px;
      line-height: 1;
      padding: 4px;
      cursor: pointer;
    }
    #itube .settings-chip-remove:hover {
      color: var(--text);
    }
    #itube .settings-shortcuts {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #itube .settings-shortcut-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 7px 0;
    }
    #itube .settings-shortcut-keys {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      min-width: 92px;
    }
    #itube .settings-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      border-radius: var(--r-xs);
      background: var(--surface);
      border: 1px solid var(--hairline);
      color: var(--text);
      font: 600 11.5px -apple-system, system-ui, sans-serif;
    }
    #itube .settings-shortcut-sep {
      color: var(--dim);
      font-size: 11px;
    }
    #itube .settings-shortcut-label {
      color: var(--muted);
      font-size: 13px;
    }
    #itube .cmdk-overlay {
      position: fixed;
      inset: 0;
      background: var(--scrim);
      backdrop-filter: blur(6px);
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding-top: 12vh;
      /* Above the popup overlay (14000): opening the palette over a
         description/transcript popup must not bury it under the dim scrim. */
      z-index: 15000;
    }
    #itube .cmdk-overlay.open {
      display: flex;
    }
    #itube .cmdk-panel {
      width: min(560px, 92vw);
      background: var(--menu-bg);
      backdrop-filter: blur(22px) saturate(1.7);
      -webkit-backdrop-filter: blur(22px) saturate(1.7);
      border: 1px solid var(--hairline);
      border-radius: var(--r-lg);
      overflow: hidden;
      box-shadow: 0 24px 60px -16px var(--shadow-strong);
    }
    #itube .cmdk-input {
      width: 100%;
      padding: 14px 16px;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--hairline);
      color: var(--text);
      font-size: 15px;
      outline: none;
    }
    /* Its own indicator, since the global outline no longer applies to inputs:
       the divider it already has becomes the accent. Nothing to clip. */
    #itube .cmdk-input:focus {
      border-bottom-color: var(--accent);
    }
    #itube .cmdk-list {
      max-height: 50vh;
      overflow-y: auto;
      padding: 6px;
    }
    #itube .cmdk-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 9px 12px;
      border-radius: var(--r-md);
      background: none;
      border: none;
      color: var(--text);
      cursor: pointer;
      font-size: 14px;
    }
    #itube .cmdk-item.selected, #itube .cmdk-item:hover {
      background: var(--hover);
    }
    #itube .cmdk-item img {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      object-fit: cover;
      flex: none;
    }
    #itube .cmdk-item-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #itube .cmdk-item-kind {
      flex: none;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    #itube-mini {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 340px;
      aspect-ratio: 16 / 9;
      background: #000;
      border-radius: var(--r-lg);
      overflow: hidden;
      box-shadow: 0 16px 50px -12px var(--shadow-strong);
      z-index: 11000;
      cursor: pointer;
      display: none;
    }
    #itube-mini video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    #itube-mini .mini-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      padding: 6px;
      background: linear-gradient(rgba(0, 0, 0, .6), transparent);
      opacity: 0;
      transition: opacity var(--tr);
    }
    #itube-mini:hover .mini-bar {
      opacity: 1;
    }
    #itube-mini .mini-bar button {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 50%;
      color: #fff;
      cursor: pointer;
      transition: background var(--tr);
    }
    #itube-mini .mini-bar button:hover {
      background: rgba(255, 255, 255, .18);
    }
    @media (prefers-reduced-motion: reduce) {
      #itube-mini .mini-bar {
        transition: none;
      }
    }
    /* Undo strip for the card dismiss cross. Bottom-LEFT: the mini-player owns
       the bottom-right corner and the two can be on screen together. */
    #itube .fb-toast {
      position: fixed;
      left: 20px;
      bottom: 20px;
      z-index: 11500;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: min(360px, calc(100vw - 40px));
      padding: 10px 12px;
      border-radius: var(--r-lg);
      border: 1px solid var(--hairline);
      background: var(--raised);
      color: var(--text);
      font-size: 13px;
      box-shadow: 0 16px 50px -12px var(--shadow-strong);
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      transition: opacity .16s ease, transform .18s cubic-bezier(.22, .61, .36, 1);
    }
    #itube .fb-toast.show {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }
    #itube .fb-toast-text {
      flex: 1;
      min-width: 0;
    }
    #itube .fb-toast-undo {
      flex: none;
      padding: 4px 10px;
      border: 1px solid var(--hairline);
      border-radius: var(--r-sm);
      background: transparent;
      color: var(--accent);
      font: 600 13px -apple-system, system-ui, sans-serif;
      cursor: pointer;
    }
    #itube .fb-toast-undo:hover {
      border-color: var(--accent);
      box-shadow: var(--glow-soft);
    }
    #itube .fb-toast-undo.hidden {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .fb-toast {
        transition: none;
        transform: none;
      }
    }
    #itube .following-status {
      color: var(--dim);
      font-size: 13px;
      margin: 0 0 14px;
    }
    #itube .following-table-wrap {
      overflow-x: auto;
    }
    #itube .following-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    #itube .following-table th,
    #itube .following-table td {
      text-align: left;
      padding: 10px 14px;
      border-bottom: 1px solid var(--hairline);
      white-space: nowrap;
      /* Subscriber/video counts sit in columns; proportional digits make them
         ragged even when right-aligned. */
      font-variant-numeric: tabular-nums;
    }
    #itube .following-table th {
      color: var(--dim);
      font-weight: 600;
      font-size: 11px;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    #itube .following-sort-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
      cursor: pointer;
      padding: 0;
    }
    #itube .following-sort-arrow {
      font-size: 9px;
      color: var(--accent);
      visibility: hidden;
    }
    #itube .following-sort-btn.active .following-sort-arrow {
      visibility: visible;
    }
    #itube .following-sort-btn:disabled {
      cursor: default;
      opacity: .4;
    }
    #itube .following-chan-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
      white-space: nowrap;
    }
    #itube .following-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--raised);
      flex: none;
    }
    #itube .following-chan-name {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 260px;
    }
    #itube .following-dim {
      color: var(--dim);
    }
    #itube .following-section-row td {
      padding: 8px 14px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      background: var(--surface);
      border-bottom: 1px solid var(--hairline);
    }
    #itube .following-topic-row {
      opacity: .6;
    }
    #itube .following-topic-badge {
      flex: none;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--hairline);
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .03em;
    }
    #itube .following-skeleton {
      display: inline-block;
      width: 60%;
      height: 12px;
      border-radius: 4px;
      background: var(--surface);
      border: 1px solid var(--hairline);
    }
    #itube .following-progress {
      height: 3px;
      border-radius: 999px;
      background: var(--surface);
      overflow: hidden;
      margin: 0 0 10px;
    }
    #itube .following-progress-fill {
      height: 100%;
      border-radius: 999px;
      background-color: var(--accent-solid);
      background-image: var(--accent-grad);
      width: 0;
      /* The enrich loop bumps this in coarse steps (one per completed batch);
         without a transition the bar visibly jumps. */
      transition: width 240ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .following-progress-fill {
        transition: none;
      }
    }
    #itube .following-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 6px;
      border-radius: 50%;
      border: 2px solid var(--hairline);
      border-top-color: var(--accent);
      vertical-align: -1px;
      animation: itube-following-spin .8s linear infinite;
    }
    @keyframes itube-following-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      #itube .following-spinner {
        animation: none;
      }
    }
  `;

  const style = document.createElement('style');
  style.id = 'itube-style';
  style.textContent = CSS;
  const mountStyle = () => {
    const root = document.documentElement;
    if (!root) { setTimeout(mountStyle, 0); return; }
    if (style.parentNode !== root) root.appendChild(style);
  };
  mountStyle();

  const BOOT_TYPE = (() => {
    const path = location.pathname;
    if (path === '/watch' || /^\/(?:shorts|live)\//.test(path)) return 'watch';
    if (path === '/results') return 'search';
    if (CHANNEL_PATH_RE.test(path)) return 'channel';
    if (path === '/playlist') return 'playlist';
    if (path === '/' || path === '/feed/explore' || FEED_BROWSE[path]) return 'feed';
    return 'other';
  })();

  const BOOT_LABELS = {
    watch: 'Loading player…',
    search: 'Searching…',
    channel: 'Loading channel…',
    playlist: 'Loading playlist…',
    feed: 'Loading your feed…',
    other: 'Loading…',
  };

  const bootOverlay = document.createElement('div');
  bootOverlay.id = 'itube-boot';
  // The boot mark is the header's brand tile at splash scale — same squircle,
  // same sweep, same play glyph. It used to be a bare gradient swatch, which
  // read as a missing image rather than a logo.
  const brandGlyph = (px) => {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    const tri = document.createElementNS(SVGNS, 'path');
    tri.setAttribute('fill', '#fff');
    tri.setAttribute('d', 'M7 2.9v10.2l7-5.1z');
    svg.appendChild(tri);
    for (const y of ['4.3', '9.9']) {
      const bar = document.createElementNS(SVGNS, 'rect');
      bar.setAttribute('x', '1.4');
      bar.setAttribute('y', y);
      bar.setAttribute('width', '3.9');
      bar.setAttribute('height', '1.8');
      bar.setAttribute('rx', '.9');
      bar.setAttribute('fill', '#fff');
      svg.appendChild(bar);
    }
    return svg;
  };

  const bootInner = document.createElement('div');
  bootInner.className = 'itube-boot-inner';
  const bootMark = document.createElement('div');
  bootMark.className = 'itube-boot-mark';
  bootMark.appendChild(brandGlyph(24));
  const bootText = document.createElement('div');
  bootText.className = 'itube-boot-text';
  const bootWord = document.createElement('div');
  bootWord.className = 'itube-boot-word';
  bootWord.textContent = 'Flyt';
  const bootLabel = document.createElement('div');
  bootLabel.className = 'itube-boot-label';
  bootLabel.textContent = 'Starting…';
  bootText.append(bootWord, bootLabel);
  const bootBar = document.createElement('div');
  bootBar.className = 'itube-boot-bar';
  bootInner.append(bootMark, bootText, bootBar);
  bootOverlay.appendChild(bootInner);
  // #itube-boot sits outside #itube so it can't read the accent vars — but a
  // Violet/Amber user shouldn't get a green boot screen. Inject the persisted
  // accent inline (falls back to the stylesheet's green when unset/invalid).
  // NOTE: savedAccent()/hexToRgb() are declared much later — using them here
  // would hit their temporal dead zone at document-start.
  {
    const bootAccent = lsGet('itube-accent');
    if (bootAccent && /^#[0-9a-f]{6}$/i.test(bootAccent.trim())) {
      // A custom accent replaces the sweep with its own flat colour — deriving
      // a matching gradient would need the colour helpers, which are declared
      // far below and would be in their temporal dead zone here. Both values
      // go on the overlay so the tile, its glow, the wordmark and the progress
      // pip all turn together; setting them per-element left a violet tile
      // wearing a cyan halo above a cyan pip.
      bootOverlay.style.setProperty('--itube-boot-accent', bootAccent);
      bootOverlay.style.setProperty('--itube-boot-sweep', 'none');
      bootWord.style.color = bootAccent;
    }
    if (themeIsLight(themeMode())) bootOverlay.classList.add('light');
    // The overlay is outside #itube, so the in-app reduce-motion class cannot
    // reach it — the setting is read directly, the same way the fly clone and
    // the theater scrim do it.
    if (lsGet('itube-reduce-motion') === '1') bootOverlay.classList.add('no-motion');
  }

  const mountBoot = () => {
    const root = document.documentElement;
    if (!root) { setTimeout(mountBoot, 0); return; }
    if (bootOverlay.parentNode !== root) root.appendChild(bootOverlay);
  };
  mountBoot();
  // The backdrop is opaque from the first frame — it has to be, or YouTube's
  // own page flashes through. Only the contents fade in, and only after a beat:
  // a boot that finishes inside it (a warm load) then shows a calm empty field
  // rather than a logo appearing and vanishing again.
  setTimeout(() => {
    if (!bootOverlay.classList.contains('itube-boot-hide')) bootOverlay.classList.add('itube-boot-in');
  }, 160);

  const cfg = () => window.ytcfg?.data_;

  const loggedOut = () => cfg()?.LOGGED_IN === false;

  const sapisidHash = async () => {
    const m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const origin = 'https://www.youtube.com';
    const data = ts + ' ' + m[1] + ' ' + origin;
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'SAPISIDHASH ' + ts + '_' + hex;
  };

  const sha256Hex = async (str) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const innertube = async (endpoint, body) => {
    const c = cfg();
    if (!c?.INNERTUBE_API_KEY) {
      console.warn('[itube] no INNERTUBE_API_KEY for', endpoint);
      return null;
    }
    try {
      const headers = {
        'content-type': 'application/json',
        'x-origin': 'https://www.youtube.com',
        'x-goog-authuser': '0',
      };
      const auth = await sapisidHash();
      if (auth) headers.authorization = auth;
      const res = await fetch('/youtubei/v1/' + endpoint + '?key=' + c.INNERTUBE_API_KEY + '&prettyPrint=false', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ context: c.INNERTUBE_CONTEXT, ...body }),
      });
      if (!res.ok) {
        console.warn('[itube] innertube ' + endpoint + ' failed: HTTP ' + res.status);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn('[itube] innertube ' + endpoint + ' threw', e);
      return null;
    }
  };

  const RYD_FETCH_TIMEOUT = 4000;

  const formatCompact = (n) => {
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    if (abs < 1000) return String(n);
    /** @type {[number, string]} */
    const scale = abs < 1e6 ? [1e3, 'K'] : abs < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
    const val = n / scale[0];
    const rounded = val < 10 ? Math.round(val * 10) / 10 : Math.round(val);
    return rounded + scale[1];
  };

  // Suffixes come localized like everything else: "1,2 тыс." must parse as
  // 1200, not fall to the no-suffix branch and become 12. Same locale set as
  // parseRelativeTime (en/de/uk/ru).
  /** @type {[RegExp, number][]} */
  const COUNT_SUFFIXES = [
    [/^(тыс|тис)/i, 1e3], [/^k/i, 1e3],
    [/^(млн|mio)/i, 1e6], [/^m(?!rd)/i, 1e6],
    [/^(млрд|mrd)/i, 1e9], [/^b/i, 1e9],
  ];
  const parseCount = (text) => {
    if (typeof text !== 'string') return null;
    const m = text.replace(/\s/g, '').match(/([\d.,]+)(тыс|тис|млн|млрд|Mio|Mrd|[KMB])?\.?/i);
    if (!m) return null;
    if (m[2]) {
      const n = parseFloat(m[1].replace(',', '.'));
      if (!Number.isFinite(n)) return null;
      const mult = COUNT_SUFFIXES.find(([re]) => re.test(m[2]))?.[1] || 1;
      return Math.round(n * mult);
    }
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };

  const isHttpUrl = (raw) => typeof raw === 'string' && /^https?:\/\//i.test(raw);

  const fetchDislikes = async (videoId) => {
    if (!dislikesEnabled()) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RYD_FETCH_TIMEOUT);
      const res = await fetch('https://returnyoutubedislikeapi.com/votes?videoId=' + encodeURIComponent(videoId), {
        credentials: 'omit',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.deleted === true) return null;
      const dislikes = json?.dislikes;
      return Number.isFinite(dislikes) ? dislikes : null;
    } catch (e) {
      return null;
    }
  };

  const AD_KEYS = new Set([
    'searchPyvRenderer',
    'promotedSparklesWebRenderer',
    'promotedSparklesTextSearchRenderer',
    'promotedVideoRenderer',
    'compactPromotedVideoRenderer',
    'compactPromotedItemRenderer',
    'displayAdRenderer',
    'statementBannerRenderer',
    'bannerPromoRenderer',
    'bannerPromoRendererWithContext',
    'carouselAdRenderer',
    'brandVideoShelfRenderer',
    'brandVideoSingletonRenderer',
    'mastheadAdRenderer',
    'mastheadAdV3Renderer',
    'videoMastheadAdV3Renderer',
    'primetimePromoRenderer',
    'playerLegacyDesktopWatchAdsRenderer',
    'featuredProductsCarouselViewModel',
  ]);

  const AD_KEY_RE = /^(ads?|promoted)[A-Z]|Ad(Slot|Layout|Break|Placement)|AdRenderer$|PyvRenderer$/;

  const isAdKey = (key) => AD_KEYS.has(key) || AD_KEY_RE.test(key);

  const WALK_STOP = Symbol('flyt-walk-stop');
  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return false;
    if (visit(node) === WALK_STOP) return true;
    if (Array.isArray(node)) {
      for (const item of node) if (walk(item, visit) === true) return true;
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (isAdKey(key)) continue;
        if (walk(node[key], visit) === true) return true;
      }
    }
    return false;
  };

  const findNode = (root, pred) => {
    let found = null;
    walk(root, (node) => { if (pred(node)) { found = node; return WALK_STOP; } });
    return found;
  };

  const decodeParams = (p) => {
    try {
      return atob(String(p).replace(/-/g, '+').replace(/_/g, '/'));
    } catch (e) {
      console.warn('[itube] tab params decode failed', e);
      return '';
    }
  };

  const findTabParams = (root, want) => {
    let match = null;
    walk(root, (n) => {
      const p = n?.browseEndpoint?.params;
      if (typeof p === 'string' && decodeParams(p).includes(want)) { match = p; return WALK_STOP; }
    });
    return match;
  };

  const getTitle = (node) => (
    node?.title?.runs?.[0]?.text
    || node?.title?.simpleText
    || node?.title?.accessibility?.accessibilityData?.label
    || node?.metadata?.lockupMetadataViewModel?.title?.content
    || node?.headline?.simpleText
    || null
  );

  const getChannel = (node) => (
    node?.longBylineText?.runs?.[0]?.text
    || node?.longBylineText?.simpleText
    || node?.shortBylineText?.runs?.[0]?.text
    || node?.shortBylineText?.simpleText
    || node?.metadata?.lockupMetadataViewModel?.metadata?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content
    || node?.ownerText?.runs?.[0]?.text
    || null
  );

  const channelHrefFrom = (endpoint) => {
    const cmd = endpoint?.innertubeCommand || endpoint;
    const browse = cmd?.browseEndpoint;
    if (!browse) return null;
    const base = browse.canonicalBaseUrl;
    if (typeof base === 'string' && base.startsWith('/')) return base;
    const url = cmd?.commandMetadata?.webCommandMetadata?.url;
    if (typeof url === 'string' && url.startsWith('/')) return url;
    const id = browse.browseId;
    return typeof id === 'string' && id.startsWith('UC') ? '/channel/' + id : null;
  };

  const getChannelHref = (node) => channelHrefFrom(
    node?.longBylineText?.runs?.[0]?.navigationEndpoint
    || node?.shortBylineText?.runs?.[0]?.navigationEndpoint
    || node?.ownerText?.runs?.[0]?.navigationEndpoint
    || node?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.navigationEndpoint
  );

  // The UC id off the SAME endpoint the href comes from. channelHref is often
  // a /@handle, and subscription/unsubscribe only takes channelIds — resolving
  // a handle would cost a navigation/resolve_url round trip per card, when the
  // id was sitting in the payload all along.
  const channelIdFrom = (endpoint) => {
    const cmd = endpoint?.innertubeCommand || endpoint;
    const id = cmd?.browseEndpoint?.browseId;
    return typeof id === 'string' && id.startsWith('UC') ? id : null;
  };

  const getChannelId = (node) => channelIdFrom(
    node?.longBylineText?.runs?.[0]?.navigationEndpoint
    || node?.shortBylineText?.runs?.[0]?.navigationEndpoint
    || node?.ownerText?.runs?.[0]?.navigationEndpoint
    || node?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.navigationEndpoint
  );

  const handleFromHref = (href) => (typeof href === 'string' && href.startsWith('/@') ? href.slice(1) : '');

  const pickThumbUrl = (sources, targetWidth) => {
    if (!Array.isArray(sources) || !sources.length) return null;
    if (targetWidth) {
      let best = null;
      for (const s of sources) {
        const w = s?.width;
        if (typeof w !== 'number' || w < targetWidth) continue;
        if (!best || w < best.width) best = s;
      }
      if (best?.url) return best.url;
    }
    return sources[sources.length - 1]?.url || null;
  };

  const thumbTarget = (cssWidth) => cssWidth * Math.min(window.devicePixelRatio || 1, 2);
  const GRID_THUMB_W = 340;
  const COMPACT_THUMB_W = 168;
  const ROW_THUMB_W = 246;

  const getThumb = (node, targetWidth) => {
    const list = node?.thumbnail?.thumbnails;
    if (Array.isArray(list) && list.length) return pickThumbUrl(list, targetWidth);
    const sources = node?.thumbnail?.sources;
    if (Array.isArray(sources) && sources.length) return pickThumbUrl(sources, targetWidth);
    return null;
  };

  const resolveVideoId = () => (
    new URLSearchParams(location.search).get('v')
    || player()?.getVideoData?.()?.video_id
    || null
  );

  const seekPlayerTo = (seconds) => {
    const p = player();
    if (p?.seekTo) {
      p.seekTo(seconds, true);
      return true;
    }
    const video = /** @type {HTMLVideoElement} */ (document.querySelector('#movie_player video'));
    if (video) {
      video.currentTime = seconds;
      return true;
    }
    return false;
  };

  const resolveOwnerChannelId = (data, details) => {
    const owner = findNode(data, (n) => n?.videoOwnerRenderer)?.videoOwnerRenderer;
    const fromOwner = owner?.navigationEndpoint?.browseEndpoint?.browseId
      || findNode(owner, (n) => typeof n?.browseEndpoint?.browseId === 'string' && n.browseEndpoint.browseId.startsWith('UC'))?.browseEndpoint?.browseId;
    if (fromOwner) return fromOwner;
    return details?.channelId || null;
  };

  const readLikeState = (data) => {
    const seg = findNode(data, (n) => n?.segmentedLikeDislikeButtonViewModel)?.segmentedLikeDislikeButtonViewModel;
    if (seg) {
      const likeVM = seg.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel;
      const dislikeVM = seg.dislikeButtonViewModel?.dislikeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel;
      const liked = !!likeVM?.isToggled;
      const disliked = !!dislikeVM?.isToggled;
      const likeCountText = likeVM?.defaultButtonViewModel?.buttonViewModel?.title || null;
      return { liked, disliked, likeCountText };
    }
    const buttons = findNode(data, (n) => Array.isArray(n?.topLevelButtons))?.topLevelButtons;
    let liked = false;
    let disliked = false;
    let likeCountText = null;
    if (Array.isArray(buttons)) {
      for (const b of buttons) {
        const t = b?.toggleButtonRenderer;
        if (!t) continue;
        const iconType = t?.icon?.iconType || '';
        const label = t?.defaultText?.accessibility?.accessibilityData?.label || t?.defaultText?.simpleText || '';
        const isDislike = iconType === 'DISLIKE' || /dislike/i.test(label);
        const isLike = !isDislike && (iconType === 'LIKE' || /like/i.test(label));
        if (isDislike) {
          disliked = !!t.isToggled;
        } else if (isLike) {
          liked = !!t.isToggled;
          likeCountText = t?.defaultText?.simpleText || null;
        }
      }
    }
    return { liked, disliked, likeCountText };
  };

  const runsText = (node) => (
    node?.simpleText
    || (Array.isArray(node?.runs) ? node.runs.map((r) => r?.text || '').join('') : '')
    || node?.content
    || ''
  );

  const needsSignIn = (node) => !!findNode(node, (n) => n.signInEndpoint || n.openPopupAction);

  const feedSignInPrompt = (res) => {
    if (!res) return null;
    const promo = findNode(res, (n) => n?.backgroundPromoRenderer)?.backgroundPromoRenderer;
    if (promo && needsSignIn(promo)) {
      return { title: runsText(promo.title), message: runsText(promo.bodyText) };
    }
    const message = findNode(res, (n) => n?.messageRenderer)?.messageRenderer;
    if (message && needsSignIn(message)) {
      return { title: runsText(message.text), message: '' };
    }
    return null;
  };

  const feedNudgePrompt = (res) => {
    const nudge = findNode(res, (n) => n?.feedNudgeRenderer)?.feedNudgeRenderer;
    if (!nudge) return null;
    return { title: runsText(nudge.title), message: runsText(nudge.subtitle) };
  };

  const mutationConfirmed = (res, check) => {
    if (!res || res.error) return false;
    let blocked = false;
    let ok = false;
    walk(res, (n) => {
      if (n.signInEndpoint) blocked = true;
      if (check(n)) ok = true;
    });
    return ok && !blocked;
  };

  const likeConfirmed = (res) => mutationConfirmed(res, () => true);

  const subscribeConfirmed = (res, want) => {
    if (!res || res.error) return false;
    let blocked = false;
    let contradicted = false;
    walk(res, (n) => {
      if (n.signInEndpoint) blocked = true;
      const u = n.updateSubscribeButtonAction;
      if (u && typeof u.subscribed === 'boolean' && u.subscribed !== want) contradicted = true;
    });
    return !blocked && !contradicted;
  };

  const playlistEditConfirmed = (res) => !!res && !res.error && res.status === 'STATUS_SUCCEEDED';

  const readSubscribedState = (data) => {
    const legacy = findNode(data, (n) => n?.subscribeButtonRenderer)?.subscribeButtonRenderer;
    if (legacy) return !!legacy.subscribed;
    const vm = findNode(data, (n) => n?.subscribeButtonViewModel)?.subscribeButtonViewModel;
    if (vm) return !!vm.subscribed;
    return false;
  };

  const getDuration = (node) => {
    const simple = node?.lengthText?.simpleText;
    if (simple) return simple;
    const label = node?.lengthText?.accessibility?.accessibilityData?.label;
    if (label) return label;
    const overlays = node?.thumbnailOverlays;
    if (Array.isArray(overlays)) {
      for (const o of overlays) {
        const t = o?.thumbnailOverlayTimeStatusRenderer?.text;
        const text = t?.simpleText || t?.runs?.[0]?.text;
        if (text) return text;
      }
    }
    return null;
  };

  const getViews = (node) => (
    node?.viewCountText?.simpleText
    || (Array.isArray(node?.viewCountText?.runs) ? node.viewCountText.runs.map((r) => r?.text || '').join('') : null)
    || node?.shortViewCountText?.simpleText
    || node?.shortViewCountText?.accessibility?.accessibilityData?.label
    || null
  );

  const getPublished = (node) => node?.publishedTimeText?.simpleText || null;

  // Lockup metadata rows come pre-localized; match the same locales
  // parseRelativeTime handles (en/de/uk/ru) or the rows misfile — the view
  // count would land in the channel slot on any non-English UI.
  const LOCKUP_VIEWS_RE = /views?|watching|aufrufe|zuschauer|перегляд|просмотр|глядач|зрител/i;

  /** @type {[RegExp, number][]} */
  const RELATIVE_TIME_UNITS = [
    [/second|секунд|sekunde/, 1],
    [/minute|хвилин|минут/, 60],
    [/hour|годин|час|stunde/, 3600],
    [/week|тижд|недел|woche/, 604800],
    [/day|день|дні|днів|дня|дней|tag/, 86400],
    [/month|місяц|месяц|monat/, 2592000],
    [/year|рік|рок|год|лет|jahr/, 31536000],
  ];

  const parseRelativeTime = (text) => {
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
    } else if (/\ban?\b|\bein(?:e[mrs]?)?\b/.test(lower)) {
      value = 1;
    } else {
      return null;
    }
    if (!isFinite(value) || value < 0) return null;
    return value * seconds;
  };

  // Inverse of parseRelativeTime: turns an elapsed-seconds count back into
  // "N units ago" text. Needed because cache-hydrated "Last upload" values
  // only store the absolute timestamp — the relative text YouTube supplied
  // at fetch time goes stale ("4 days ago" is wrong two days later), so it
  // has to be recomputed on every hydration rather than replayed verbatim.
  /** @type {[number, string][]} */
  const RELATIVE_AGO_UNITS = [
    [31536000, 'year'], [2592000, 'month'], [604800, 'week'],
    [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second'],
  ];

  const formatRelativeAgo = (secs) => {
    if (secs == null || !isFinite(secs) || secs < 0) return null;
    for (const [unitSecs, name] of RELATIVE_AGO_UNITS) {
      if (secs >= unitSecs || unitSecs === 1) {
        const v = Math.max(1, Math.round(secs / unitSecs));
        return v + ' ' + name + (v === 1 ? '' : 's') + ' ago';
      }
    }
    return null;
  };

  const sortByRecency = (items) => {
    const keyed = items.map((item, i) => ({ item, i, secs: parseRelativeTime(item.published) }));
    const sorted = keyed.filter((x) => x.secs != null).sort((a, b) => (a.secs - b.secs) || (a.i - b.i));
    let s = 0;
    return keyed.map((k) => (k.secs == null ? k.item : sorted[s++].item));
  };

  // ---- Home feed re-ranking ------------------------------------------------
  //
  // A PERTURBATION of YouTube's order, never a sort from scratch. YouTube has
  // corpus-wide signals this app cannot see — freshness, upload velocity,
  // cross-user quality — so the payload's own position is the prior and the
  // only thing done to it is pushing items DOWN. Demotion-only is what makes
  // this safe: the transform is trivially a permutation, movement is bounded,
  // every move is explainable, and the worst case is slightly-shuffled YouTube
  // rather than a wrecked feed.
  //
  // Ranking is per BATCH, like sortByRecency — you cannot pull item #200 above
  // item #3 without prefetching pages first, which would trade the app's whole
  // promise (instant paint) for ranking quality. Already-painted cards are
  // never reshuffled.
  //
  // Nothing here reads `views` or `duration`. Both are localized display
  // strings with no parser in this file ("8.9M views" / "8,9 Mio. Aufrufe"),
  // and misparsing them is exactly how the view count once landed in the
  // channel slot on a non-English UI.
  const RANK_MAX_SHIFT = 8;
  const RANK_MAX_DEMOTED = 0.5;
  const RANK_DOMINANCE_FREE = 2;
  const RANK_DOMINANCE_STEP = 3;
  const RANK_SHOUTY_SHIFT = 4;
  // Bounds the per-mount channel tally. It only ever holds distinct channel
  // ids from one feed mount, but "only ever" is how unbounded growth starts —
  // and the cap is enforced on INSERT, not on read.
  const RANK_STATE_MAX = 400;
  const RANK_WHY_DOMINANCE = 1;
  const RANK_WHY_SHOUTY = 2;

  const rankBalanceOn = () => lsGet('itube-rank-balance') !== '0';
  const setRankBalanceOn = (on) => lsSet('itube-rank-balance', on ? '1' : '0');
  const rankShoutyOn = () => lsGet('itube-rank-shouty') === '1';
  const setRankShoutyOn = (on) => lsSet('itube-rank-shouty', on ? '1' : '0');
  const rankExplainOn = () => lsGet('itube-rank-explain') === '1';

  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  // Deliberately conservative: a demoted title is one the user still sees,
  // but a false positive on every ALL-CAPS acronym title would be noise.
  const isShoutyTitle = (title) => {
    if (typeof title !== 'string' || title.length < 12) return false;
    const letters = title.match(/\p{L}/gu);
    if (letters && letters.length >= 8) {
      const upper = title.match(/\p{Lu}/gu);
      if (upper && upper.length / letters.length > 0.7) return true;
    }
    if (/!{2,}|\?{2,}/.test(title)) return true;
    const emoji = title.match(EMOJI_RE);
    return !!emoji && emoji.length >= 3;
  };

  const newRankState = () => ({ channelCounts: new Map() });

  const rankBumpChannel = (state, channelId) => {
    const counts = state.channelCounts;
    const n = counts.get(channelId) || 0;
    if (n === 0 && counts.size >= RANK_STATE_MAX) {
      // LRU-ish: drop the oldest key rather than letting a long scroll grow
      // this without limit. Same shape as sbCache's eviction.
      counts.delete(counts.keys().next().value);
    }
    counts.set(channelId, n + 1);
    return n;
  };

  // items -> items. ALWAYS a permutation of the input: the same array is
  // sorted by (originalIndex + demotion), so nothing can be dropped or
  // duplicated no matter what the scoring does.
  const rankBatch = (items, state) => {
    if (!Array.isArray(items) || items.length < 2 || !state) return items;
    const balance = rankBalanceOn();
    const shouty = rankShoutyOn();
    if (!balance && !shouty) return items;

    const maxDemoted = Math.floor(items.length * RANK_MAX_DEMOTED);
    let demoted = 0;
    const keyed = items.map((item, i) => {
      let shift = 0;
      let why = 0;
      if (balance && item && item.channelId) {
        const seenBefore = rankBumpChannel(state, item.channelId);
        if (seenBefore >= RANK_DOMINANCE_FREE) {
          shift += (seenBefore - RANK_DOMINANCE_FREE + 1) * RANK_DOMINANCE_STEP;
          why |= RANK_WHY_DOMINANCE;
        }
      }
      if (shouty && item && isShoutyTitle(item.title)) {
        shift += RANK_SHOUTY_SHIFT;
        why |= RANK_WHY_SHOUTY;
      }
      // A rule that fires on everything is a broken rule, not a re-rank: past
      // the cap, later items keep their original position.
      if (shift > 0) {
        if (demoted >= maxDemoted) { shift = 0; why = 0; } else demoted++;
      }
      return { item, i, shift: Math.min(shift, RANK_MAX_SHIFT), why };
    });

    keyed.sort((a, b) => ((a.i + a.shift) - (b.i + b.shift)) || (a.i - b.i));
    if (!rankExplainOn()) return keyed.map((k) => k.item);
    // Explanation carries two integers on a shallow copy — no retained
    // strings, no id-keyed Map that outlives the cards. Text is built on
    // demand in createCard.
    return keyed.map((k, pos) => (k.shift ? { ...k.item, rankFrom: k.i, rankTo: pos, rankWhy: k.why } : k.item));
  };

  const rankExplainText = (item) => {
    const why = [];
    if (item.rankWhy & RANK_WHY_DOMINANCE) why.push('repeat channel');
    if (item.rankWhy & RANK_WHY_SHOUTY) why.push('shouty title');
    return 'Flyt: #' + (item.rankFrom + 1) + ' → #' + (item.rankTo + 1) + ' (' + why.join(', ') + ')';
  };

  const getSnippet = (node) => (
    node?.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r) => r?.text || '').join('')
    || node?.descriptionSnippet?.runs?.map((r) => r?.text || '').join('')
    || null
  );

  // The two dismissal tokens behind the cross on every card. YouTube ships them
  // on two unrelated shapes — legacy menuServiceItemRenderer rows (search,
  // channel, related) and the lockup's inline sheet rows (home feed) — and the
  // row LABELS come localized, so the rows are told apart by their stable icon
  // name instead: HIDE is "Not interested" (this video), REMOVE is "Don't
  // recommend channel". Paths are read directly rather than walked: this runs
  // once per card and a menu subtree is several KB of JSON.
  const feedbackRowIcon = (row) => (
    row?.icon?.iconType
    || row?.leadingImage?.sources?.[0]?.clientResource?.imageName
    || null
  );

  const feedbackRowEndpoint = (row) => (
    row?.serviceEndpoint?.feedbackEndpoint
    || row?.rendererContext?.commandContext?.onTap?.innertubeCommand?.feedbackEndpoint
    || null
  );

  // The Undo token is pre-minted inside the feedback endpoint's own
  // replace-enclosing action, so undoing costs no extra round trip.
  const undoTokenFrom = (ep) => {
    for (const action of ep?.actions || []) {
      const buttons = action?.replaceEnclosingAction?.item?.notificationMultiActionRenderer?.buttons;
      for (const b of buttons || []) {
        const t = b?.buttonRenderer?.serviceEndpoint?.undoFeedbackEndpoint?.undoToken;
        if (typeof t === 'string' && t) return t;
      }
    }
    return null;
  };

  const extractFeedback = (rows) => {
    if (!Array.isArray(rows)) return null;
    let video = null;
    let channel = null;
    for (const r of rows) {
      const row = r?.menuServiceItemRenderer || r?.listItemViewModel;
      const iconName = feedbackRowIcon(row);
      if (iconName !== 'HIDE' && iconName !== 'REMOVE') continue;
      const ep = feedbackRowEndpoint(row);
      if (typeof ep?.feedbackToken !== 'string' || !ep.feedbackToken) continue;
      const entry = { token: ep.feedbackToken, undo: undoTokenFrom(ep) };
      if (iconName === 'HIDE') { if (!video) video = entry; }
      else if (!channel) channel = entry;
    }
    return (video || channel) ? { video, channel } : null;
  };

  const lockupFeedback = (lk) => extractFeedback(
    lk?.metadata?.lockupMetadataViewModel?.menuButton?.buttonViewModel?.onTap?.innertubeCommand
      ?.showSheetCommand?.panelLoadingStrategy?.inlineContent?.sheetViewModel?.content
      ?.listViewModel?.listItems
  );

  const lockupItem = (node, seen, targetWidth) => {
    const lk = node.lockupViewModel;
    if (!lk || lk.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const id = lk.contentId;
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    const meta = lk.metadata?.lockupMetadataViewModel;
    const title = meta?.title?.content;
    const img = lk.contentImage?.thumbnailViewModel;
    const thumb = pickThumbUrl(img?.image?.sources, targetWidth);
    if (!title || !thumb) return null;
    const texts = [];
    walk(img?.overlays, (n) => {
      if (typeof n.text === 'string') texts.push(n.text);
    });
    const rows = [];
    walk(meta?.metadata, (n) => {
      if (typeof n.content === 'string') rows.push(n.content);
    });
    const rest = rows.filter((t) => t !== title);
    seen.add(id);
    return {
      id,
      title,
      channel: rest.find((t) => !LOCKUP_VIEWS_RE.test(t) && parseRelativeTime(t) == null && !/^\d/.test(t)) || '',
      channelHref: channelHrefFrom(meta?.image?.decoratedAvatarViewModel?.rendererContext?.commandContext?.onTap)
        || channelHrefFrom(findNode(meta?.image?.avatarStackViewModel, (n) => n?.browseEndpoint)),
      thumb,
      duration: texts.find((t) => /^\d+:\d\d/.test(t)) || '',
      views: rest.find((t) => LOCKUP_VIEWS_RE.test(t)) || '',
      published: rest.find((t) => parseRelativeTime(t) != null) || '',
      snippet: '',
      feedback: lockupFeedback(lk),
      channelId: channelIdFrom(meta?.image?.decoratedAvatarViewModel?.rendererContext?.commandContext?.onTap)
        || channelIdFrom(findNode(meta?.image?.avatarStackViewModel, (n) => n?.browseEndpoint)),
    };
  };

  const extractVideos = (root, seen, targetWidth) => {
    const out = [];
    walk(root, (node) => {
      const lk = lockupItem(node, seen, targetWidth);
      if (lk) {
        out.push(lk);
        return;
      }
      if (typeof node.videoId !== 'string' || !node.videoId || seen.has(node.videoId)) return;
      const title = getTitle(node);
      if (!title) return;
      const thumb = getThumb(node, targetWidth);
      if (!thumb) return;
      seen.add(node.videoId);
      out.push({
        id: node.videoId,
        title,
        channel: getChannel(node),
        channelHref: getChannelHref(node),
        thumb,
        duration: getDuration(node),
        views: getViews(node),
        published: getPublished(node),
        snippet: getSnippet(node),
        feedback: extractFeedback(node.menu?.menuRenderer?.items),
        channelId: getChannelId(node),
      });
    });
    return out;
  };

  const getResumePercent = (node) => {
    const overlays = node?.thumbnailOverlays;
    if (Array.isArray(overlays)) {
      for (const o of overlays) {
        const p = o?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched;
        if (typeof p === 'number') return p;
      }
    }
    return null;
  };

  const extractResumeItems = (root, seen, targetWidth) => {
    const out = [];
    walk(root, (node) => {
      if (typeof node.videoId !== 'string' || !node.videoId || seen.has(node.videoId)) return;
      const percent = getResumePercent(node);
      if (percent == null) return;
      const title = getTitle(node);
      if (!title) return;
      const thumb = getThumb(node, targetWidth);
      if (!thumb) return;
      seen.add(node.videoId);
      out.push({
        id: node.videoId,
        title,
        channel: getChannel(node),
        channelHref: getChannelHref(node),
        thumb,
        duration: getDuration(node),
        views: getViews(node),
        published: getPublished(node),
        snippet: getSnippet(node),
        percent,
      });
    });
    return out;
  };

  const extractPlaylists = (root, seen, targetWidth) => {
    const out = [];
    walk(root, (node) => {
      const lk = node.lockupViewModel;
      if (lk && lk.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
        const id = lk.contentId;
        if (typeof id !== 'string' || !id || seen.has(id)) return;
        const meta = lk.metadata?.lockupMetadataViewModel;
        const title = meta?.title?.content;
        const img = lk.contentImage?.thumbnailViewModel || lk.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
        const thumb = pickThumbUrl(img?.image?.sources, targetWidth);
        if (!title || !thumb) return;
        // Collection thumbnails carry the size as a badge ("1,246 videos").
        let count = '';
        walk(lk.contentImage, (n) => {
          if (typeof n.text === 'string' && /\d/.test(n.text)) { count = n.text; return WALK_STOP; }
        });
        seen.add(id);
        out.push({ id, type: 'playlist', title, channel: '', channelHref: null, thumb, duration: '', views: count, published: '', snippet: '' });
        return;
      }
      const legacy = node.playlistRenderer || node.gridPlaylistRenderer || node.compactPlaylistRenderer;
      if (!legacy) return;
      const id = legacy.playlistId;
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      const title = getTitle(legacy);
      if (!title) return;
      const thumb = getThumb(legacy, targetWidth) || getThumb(legacy.thumbnailRenderer?.playlistVideoThumbnailRenderer, targetWidth);
      if (!thumb) return;
      const count = legacy.videoCount
        || (Array.isArray(legacy.videoCountText?.runs) ? legacy.videoCountText.runs.map((r) => r?.text || '').join('') : null)
        || legacy.videoCountText?.simpleText
        || null;
      seen.add(id);
      out.push({ id, type: 'playlist', title, channel: '', channelHref: null, thumb, duration: '', views: count ? count + ' videos' : '', published: '', snippet: '' });
    });
    return out;
  };

  const extractPlaylistPanel = (root) => {
    const wrap = findNode(root, (n) => n?.playlist?.playlistId && Array.isArray(n?.playlist?.contents))?.playlist;
    if (!wrap) return null;
    const items = [];
    for (const c of wrap.contents) {
      const r = c?.playlistPanelVideoRenderer;
      if (!r || typeof r.videoId !== 'string') continue;
      items.push({
        id: r.videoId,
        title: getTitle(r) || '',
        channel: getChannel(r) || '',
        channelHref: getChannelHref(r),
        thumb: getThumb(r, thumbTarget(COMPACT_THUMB_W)),
        duration: r.lengthText?.simpleText
          || (Array.isArray(r.lengthText?.runs) ? r.lengthText.runs.map((x) => x?.text || '').join('') : ''),
      });
    }
    if (!items.length) return null;
    const title = typeof wrap.title === 'string' ? wrap.title
      : (wrap.titleText?.simpleText
        || (Array.isArray(wrap.titleText?.runs) ? wrap.titleText.runs.map((r) => r?.text || '').join('') : ''))
      || '';
    return { id: wrap.playlistId, title, items };
  };

  const findContinuationToken = (root) => {
    let token = null;
    walk(root, (node) => {
      const t = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (typeof t === 'string' && t) { token = t; return WALK_STOP; }
    });
    return token;
  };

  const continuationFetcher = (endpoint, extract) => async (token, seen) => {
    const res = await innertube(endpoint, { continuation: token });
    if (!res) return null;
    return { items: extract(res, seen), token: findContinuationToken(res) };
  };

  const findAnyContinuationToken = (root) => {
    let token = null;
    walk(root, (node) => {
      const t = node?.continuationCommand?.token;
      if (typeof t === 'string' && t) { token = t; return WALK_STOP; }
    });
    return token;
  };

  const findAllContinuationTokens = (root) => {
    const tokens = [];
    walk(root, (node) => {
      const t = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (typeof t === 'string' && t) tokens.push(t);
    });
    return tokens;
  };

  // The comments section, sort menu and header all live in the same `next`
  // response — one walk collects all three instead of three full-tree
  // findNodes per watch navigation.
  const collectCommentsRefs = (root) => {
    const refs = { section: null, sortMenu: null, header: null };
    walk(root, (n) => {
      if (!refs.section && n?.itemSectionRenderer?.sectionIdentifier === 'comment-item-section') refs.section = n.itemSectionRenderer;
      if (!refs.sortMenu && n?.sortFilterSubMenuRenderer) refs.sortMenu = n.sortFilterSubMenuRenderer;
      if (!refs.header && n?.commentsHeaderRenderer) refs.header = n.commentsHeaderRenderer;
      if (refs.section && refs.sortMenu && refs.header) return WALK_STOP;
    });
    return refs;
  };

  const commentsTokenFromRefs = (refs, root) => {
    if (refs.section) {
      const t = findContinuationToken(refs.section);
      if (t) return t;
    }
    const tokens = findAllContinuationTokens(root);
    return tokens.length ? tokens[tokens.length - 1] : null;
  };

  const findCommentsToken = (root) => commentsTokenFromRefs(collectCommentsRefs(root), root);

  const shortSortLabel = (title) => {
    const t = (title || '').toLowerCase();
    if (t.includes('top') || t.includes('beliebt')) return 'Top';
    if (t.includes('new') || t.includes('neu')) return 'Newest';
    return title;
  };

  const sortOptionsFromMenu = (node) => {
    const items = node?.subMenuItems;
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => ({
        label: shortSortLabel(it?.title),
        token: it?.serviceEndpoint?.continuationCommand?.token || null,
      }))
      .filter((o) => o.label && o.token);
  };

  const commentEntityMap = (root) => {
    const map = new Map();
    walk(root, (node) => {
      const muts = node?.frameworkUpdates?.entityBatchUpdate?.mutations;
      if (!Array.isArray(muts)) return;
      for (const m of muts) {
        const payload = m?.payload?.commentEntityPayload;
        const key = m?.entityKey || payload?.key;
        if (payload && key) map.set(key, payload);
      }
    });
    return map;
  };

  const buildRunsSegments = (runs) => {
    if (!Array.isArray(runs) || !runs.length) return null;
    return runs.map((r) => {
      const watch = r?.navigationEndpoint?.watchEndpoint;
      return {
        text: r?.text || '',
        url: r?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || null,
        seconds: typeof watch?.startTimeSeconds === 'number' ? watch.startTimeSeconds : null,
        videoId: watch?.videoId || null,
      };
    });
  };

  const buildAttributedSegments = (attributed) => {
    const content = attributed?.content;
    if (typeof content !== 'string' || !content) return null;
    const commandRuns = (attributed.commandRuns || [])
      .filter((r) => typeof r?.startIndex === 'number' && typeof r?.length === 'number' && r?.onTap?.innertubeCommand)
      .sort((a, b) => a.startIndex - b.startIndex);
    const segments = [];
    let cursor = 0;
    for (const run of commandRuns) {
      if (run.startIndex > cursor) segments.push({ text: content.slice(cursor, run.startIndex), url: null, seconds: null, videoId: null });
      const cmd = run.onTap.innertubeCommand;
      const watch = cmd?.watchEndpoint;
      segments.push({
        text: content.slice(run.startIndex, run.startIndex + run.length),
        url: cmd?.commandMetadata?.webCommandMetadata?.url || null,
        seconds: typeof watch?.startTimeSeconds === 'number' ? watch.startTimeSeconds : null,
        videoId: watch?.videoId || null,
      });
      cursor = run.startIndex + run.length;
    }
    if (cursor < content.length) segments.push({ text: content.slice(cursor), url: null, seconds: null, videoId: null });
    return segments;
  };

  const getCommentAvatar = (legacy, author) => (
    // Comment avatars paint at 34px — the smallest sufficient variant, not
    // the largest (×50 comments per page, the decode cost adds up).
    pickThumbUrl(legacy?.authorThumbnail?.thumbnails, 68)
    || author?.avatarThumbnailUrl
    || author?.avatar?.thumbnails?.[0]?.url
    || null
  );

  const extractComment = (thread, entityMap) => {
    const legacy = thread?.comment?.commentRenderer || thread?.commentRenderer;
    if (legacy) {
      const runs = legacy.contentText?.runs;
      const text = (runs || []).map((r) => r?.text || '').join('') || legacy.contentText?.simpleText || '';
      const replyToken = findContinuationToken(thread?.replies) || findAnyContinuationToken(thread?.replies);
      const replyCount = Number(legacy.replyCount) || (replyToken ? 1 : 0);
      return {
        id: legacy.commentId || null,
        author: legacy.authorText?.simpleText || legacy.authorText?.runs?.[0]?.text || '',
        authorHref: channelHrefFrom(legacy.authorEndpoint),
        avatar: getCommentAvatar(legacy, null),
        text,
        textSegments: buildRunsSegments(runs),
        published: legacy.publishedTimeText?.runs?.[0]?.text || legacy.publishedTimeText?.simpleText || '',
        likes: legacy.voteCount?.simpleText || legacy.voteCount?.accessibility?.accessibilityData?.label || '',
        replyCount,
        replyToken,
      };
    }
    const vm = thread?.commentViewModel?.commentViewModel || thread?.commentViewModel || thread?.comment?.commentViewModel;
    if (!vm) return null;
    const key = vm.commentKey || vm.key || vm.commentId;
    const payload = key ? entityMap.get(key) : null;
    const props = payload?.properties || vm.properties;
    if (!props) return null;
    const author = payload?.author || vm.author;
    const toolbar = payload?.toolbar || vm.toolbar;
    const replyToken = findContinuationToken(thread?.replies) || findAnyContinuationToken(thread?.replies);
    const replyCount = Number(toolbar?.replyCount) || Number(props.replyCount) || (replyToken ? 1 : 0);
    return {
      id: props.commentId || payload?.key || key || null,
      author: author?.displayName || '',
      authorHref: channelHrefFrom(author?.channelCommand)
        || (typeof author?.channelId === 'string' && author.channelId ? '/channel/' + author.channelId : null),
      avatar: getCommentAvatar(null, author),
      text: props.content?.content || '',
      textSegments: buildAttributedSegments(props.content),
      published: props.publishedTime || '',
      likes: toolbar?.likeCountA11y || toolbar?.likeCountNotliked || toolbar?.likeCountLiked || '',
      replyCount,
      replyToken,
    };
  };

  const extractComments = (root, entityMap, seen) => {
    const out = [];
    walk(root, (node) => {
      let thread = null;
      if (node.commentThreadRenderer) thread = node.commentThreadRenderer;
      else if (node.commentRenderer || node.commentViewModel) thread = node;
      else return;
      const c = extractComment(thread, entityMap);
      if (!c || !c.id || seen.has(c.id)) return;
      seen.add(c.id);
      out.push(c);
    });
    return out;
  };

  const countLabelFromHeader = (header) => {
    const t = header?.countText;
    if (!t) return null;
    const raw = t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r?.text || '').join('') : null);
    if (!raw) return null;
    const n = parseCount(raw);
    return Number.isFinite(n) ? formatCompact(n) : null;
  };

  const getCommentsCountLabel = (root) => countLabelFromHeader(findNode(root, (n) => n?.commentsHeaderRenderer)?.commentsHeaderRenderer);

  const commentComposerInfo = (header) => {
    const sb = header?.createRenderer?.commentSimpleboxRenderer;
    const params = sb?.submitButton?.buttonRenderer?.serviceEndpoint?.createCommentEndpoint?.createCommentParams;
    if (!params) return null;
    return {
      params,
      placeholder: runsText(sb.placeholderText) || 'Add a comment…',
      avatar: pickThumbUrl(sb.authorThumbnail?.thumbnails, 64),
      submitLabel: runsText(sb.submitButton?.buttonRenderer?.text) || 'Comment',
    };
  };

  const postComment = async (params, text) => {
    const res = await innertube('comment/create_comment', {
      createCommentParams: params,
      commentText: text,
    });
    if (!res) return { ok: false, item: null };
    const items = extractComments(res, commentEntityMap(res), new Set());
    return { ok: true, item: items.length ? items[0] : null };
  };

  const fmt = (s) => {
    if (!isFinite(s)) return 'LIVE';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : m;
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  };

  const itemHref = (item) => (item.type === 'playlist'
    ? '/playlist?list=' + encodeURIComponent(item.id)
    : '/watch?v=' + encodeURIComponent(item.id) + (item.listId ? '&list=' + encodeURIComponent(item.listId) : ''));

  const createItemLink = (item, cls) => {
    const link = document.createElement('a');
    link.className = cls;
    link.href = itemHref(item);
    link.setAttribute('aria-label', item.title || '');
    return link;
  };

  const createChannelLink = (item, cls) => {
    const href = item.channelHref || null;
    const el = /** @type {HTMLAnchorElement} */ (document.createElement(href ? 'a' : 'div'));
    el.className = cls;
    if (href) el.href = href;
    el.textContent = item.channel || handleFromHref(href);
    return el;
  };

  const mutedChannelsSet = () => { try { return new Set(JSON.parse(lsGet('itube-mute-channels') || '[]')); } catch (e) { return new Set(); } };
  // Array.isArray, not just a parse guard: localStorage is user-writable, and
  // a stored object/number parses fine and then throws on `.includes` /
  // `for…of` at every call site instead of degrading to "no keywords muted".
  const mutedKeywordsList = () => {
    try {
      const parsed = JSON.parse(lsGet('itube-mute-keywords') || '[]');
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
    } catch (e) { return []; }
  };
  // Videos the dismiss cross has sent feedback for this session. The card is
  // pulled from the DOM on the spot, but the ITEM is still in the list's
  // captured batch — and YouTube keeps serving it in continuations until the
  // feed is rebuilt server-side — so without this it walks straight back in on
  // the next re-render or scroll.
  const dismissedIds = new Set();
  const hideWatchedOn = () => lsGet('itube-hide-watched') === '1';
  const normChannel = (href) => (href || '').toLowerCase().replace(/\/+$/, '');
  let muteChannels = mutedChannelsSet();
  let muteKeywords = mutedKeywordsList();
  let muteHideWatched = hideWatchedOn();
  const refreshMuteState = () => { muteChannels = mutedChannelsSet(); muteKeywords = mutedKeywordsList(); muteHideWatched = hideWatchedOn(); };
  const isFeedFiltered = (item) => {
    if (!item) return false;
    if (item.id && dismissedIds.has(item.id)) return true;
    if (muteHideWatched && typeof item.percent === 'number' && item.percent >= 90) return true;
    if (item.channelHref && muteChannels.has(normChannel(item.channelHref))) return true;
    if (muteKeywords.length && item.title) {
      const t = item.title.toLowerCase();
      if (muteKeywords.some((k) => k && t.includes(k))) return true;
    }
    return false;
  };

  // Card element -> what its hover buttons need: the dismissal tokens and the
  // channel the video belongs to. A WeakMap rather than data-attributes
  // because the tokens are ~200-char blobs — putting them in the DOM would
  // bloat every card for no reason, and this way they are collected with the
  // card itself.
  const cardActions = new WeakMap();
  // Sticky "has any card ever carried tokens", so the hover handler can keep
  // its old logged-out fast path: no payload YouTube serves signed-out has a
  // feedback token in it, and pointerover fires on every boundary crossing.
  // Gated on the TOKENS, not on cardActions being populated — channelId is
  // present logged out too, and unfollow needs a session anyway.
  let anyCardFeedback = false;
  const setCardActions = (el, item) => {
    if (!item.feedback && !item.channelId) return;
    if (item.feedback) anyCardFeedback = true;
    cardActions.set(el, { feedback: item.feedback || null, channelId: item.channelId || null, channel: item.channel || '' });
  };

  const createCard = (item, eager) => {
    const a = document.createElement('div');
    a.className = 'c';
    // Only present when itube-rank-explain is on, so the ranker can be
    // inspected without putting a tooltip on every card in normal use.
    if (typeof item.rankFrom === 'number') a.title = rankExplainText(item);
    setCardActions(a, item);
    const link = createItemLink(item, 'c-link');
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'c-thumb';
    const img = fadeInImg(item.thumb, eager);
    thumbWrap.appendChild(img);
    if (item.duration) {
      const dur = document.createElement('span');
      dur.className = 'c-dur';
      dur.textContent = item.duration;
      thumbWrap.appendChild(dur);
    }
    if (typeof item.percent === 'number') {
      const bar = document.createElement('div');
      bar.className = 'c-progress';
      const fill = document.createElement('div');
      fill.className = 'c-progress-fill';
      fill.style.width = Math.max(0, Math.min(100, item.percent)) + '%';
      bar.appendChild(fill);
      thumbWrap.appendChild(bar);
    }
    const title = document.createElement('h3');
    title.className = 'c-title';
    title.textContent = item.title;
    const chan = createChannelLink(item, 'c-chan');
    const meta = document.createElement('div');
    meta.className = 'c-meta';
    meta.textContent = [item.views, item.published].filter(Boolean).join(' · ');
    a.append(link, thumbWrap, title, chan, meta);
    return a;
  };

  const createCompactCard = (item) => {
    const a = document.createElement('div');
    a.className = 'rc';
    setCardActions(a, item);
    const link = createItemLink(item, 'rc-link');
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'rc-thumb';
    const img = fadeInImg(item.thumb);
    thumbWrap.appendChild(img);
    if (item.duration) {
      const dur = document.createElement('span');
      dur.className = 'rc-dur';
      dur.textContent = item.duration;
      thumbWrap.appendChild(dur);
    }
    const body = document.createElement('div');
    body.className = 'rc-body';
    const title = document.createElement('h4');
    title.className = 'rc-title';
    title.textContent = item.title;
    const chan = createChannelLink(item, 'rc-chan');
    const meta = document.createElement('div');
    meta.className = 'rc-meta';
    meta.textContent = [item.views, item.published].filter(Boolean).join(' · ');
    body.append(title, chan, meta);
    a.append(link, thumbWrap, body);
    return a;
  };

  const createRowCard = (item, eager) => {
    const a = document.createElement('div');
    a.className = 'row';
    setCardActions(a, item);
    const link = createItemLink(item, 'row-link');
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'row-thumb';
    const img = fadeInImg(item.thumb, eager);
    thumbWrap.appendChild(img);
    if (item.duration) {
      const dur = document.createElement('span');
      dur.className = 'row-dur';
      dur.textContent = item.duration;
      thumbWrap.appendChild(dur);
    }
    const body = document.createElement('div');
    body.className = 'row-body';
    const title = document.createElement('h3');
    title.className = 'row-title';
    title.textContent = item.title;
    const chan = createChannelLink(item, 'row-chan');
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = [item.views, item.published].filter(Boolean).join(' · ');
    body.append(title, chan, meta);
    if (item.snippet) {
      const desc = document.createElement('div');
      desc.className = 'row-desc';
      desc.textContent = item.snippet;
      body.appendChild(desc);
    }
    a.append(link, thumbWrap, body);
    return a;
  };

  const skLine = (extraClass) => {
    const line = document.createElement('div');
    line.className = extraClass ? 'sk-line sk-shimmer ' + extraClass : 'sk-line sk-shimmer';
    return line;
  };

  const createCardSkeleton = () => {
    const el = document.createElement('div');
    el.className = 'c-skel';
    const thumb = document.createElement('div');
    thumb.className = 'c-skel-thumb sk-shimmer';
    el.append(thumb, skLine(), skLine('short'));
    return el;
  };

  const createRowSkeleton = () => {
    const el = document.createElement('div');
    el.className = 'row-skel';
    const thumb = document.createElement('div');
    thumb.className = 'row-skel-thumb sk-shimmer';
    const body = document.createElement('div');
    body.className = 'row-skel-body';
    body.append(skLine(), skLine('short'));
    el.append(thumb, body);
    return el;
  };

  const createRelatedSkeleton = () => {
    const el = document.createElement('div');
    el.className = 'rc-skel';
    const thumb = document.createElement('div');
    thumb.className = 'rc-skel-thumb sk-shimmer';
    const body = document.createElement('div');
    body.className = 'rc-skel-body';
    body.append(skLine(), skLine('short'));
    el.append(thumb, body);
    return el;
  };

  // "Show more" only appears when the comment text actually overflows its
  // clamp — that needs a scrollHeight read per row. One rAF per row meant up
  // to 20 read/write pairs interleaving in a single frame (each write
  // invalidating the next read's layout); batching does all reads first,
  // then all writes, in one shared rAF per append batch.
  let clampChecks = [];
  const scheduleClampCheck = (text, showMore) => {
    clampChecks.push([text, showMore]);
    if (clampChecks.length > 1) return;
    requestAnimationFrame(() => {
      const batch = clampChecks;
      clampChecks = [];
      const overflowing = batch.map(([t]) => t.isConnected && t.scrollHeight > t.clientHeight + 1);
      // A CLASS, not `btn.style.display = ''`: .comment-showmore's hidden
      // state lives in the stylesheet, so clearing the inline style just
      // fell back to `display: none` and the button stayed invisible on
      // EVERY clamped comment — long comments were truncated at 4 lines
      // with no way to expand them.
      batch.forEach(([, btn], i) => { if (overflowing[i]) btn.classList.add('show'); });
    });
  };

  const createCommentRow = (item) => {
    const row = document.createElement('div');
    row.className = 'comment-row';
    const avatar = fadeInImg(item.avatar);
    avatar.className = 'comment-avatar';
    /** @type {HTMLElement} */
    let avatarEl = avatar;
    if (item.authorHref) {
      const avatarLink = document.createElement('a');
      avatarLink.className = 'comment-avatar-link';
      avatarLink.href = item.authorHref;
      avatarLink.setAttribute('aria-label', item.author || '');
      avatarLink.appendChild(avatar);
      avatarEl = avatarLink;
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'comment-body';

    const head = document.createElement('div');
    head.className = 'comment-head';
    const author = /** @type {HTMLAnchorElement} */ (document.createElement(item.authorHref ? 'a' : 'span'));
    author.className = 'comment-author';
    if (item.authorHref) author.href = item.authorHref;
    author.textContent = item.author || '';
    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = item.published || '';
    head.append(author, time);

    const text = document.createElement('div');
    text.className = 'comment-text';
    if (item.textSegments && item.textSegments.length) {
      const currentId = resolveVideoId();
      for (const seg of item.textSegments) {
        if (!seg.text) continue;
        if (seg.url) {
          const a = document.createElement('a');
          a.className = 'comment-link';
          a.href = seg.url;
          a.textContent = seg.text;
          if (seg.seconds != null && (!seg.videoId || seg.videoId === currentId)) {
            a.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              seekPlayerTo(seg.seconds);
            });
          }
          text.appendChild(a);
        } else {
          text.appendChild(document.createTextNode(seg.text));
        }
      }
    } else {
      text.textContent = item.text || '';
    }

    const showMore = document.createElement('button');
    showMore.className = 'comment-showmore';
    showMore.textContent = 'Show more';
    showMore.addEventListener('click', () => {
      const expanded = text.classList.toggle('expanded');
      showMore.textContent = expanded ? 'Show less' : 'Show more';
    });
    scheduleClampCheck(text, showMore);

    const likes = document.createElement('div');
    likes.className = 'comment-likes';
    likes.textContent = item.likes || '';

    bodyEl.append(head, text, showMore, likes);

    if (item.replyToken) {
      const repliesBtn = document.createElement('button');
      repliesBtn.className = 'comment-replies-btn';
      const n = Number(item.replyCount);
      repliesBtn.textContent = n > 1
        ? n + ' replies'
        : (n === 1 ? '1 reply' : 'View replies');
      let loaded = false;
      repliesBtn.addEventListener('click', async () => {
        if (loaded) return;
        loaded = true;
        repliesBtn.textContent = 'Loading…';
        const res = await innertube('next', { continuation: item.replyToken });
        if (!res) { repliesBtn.remove(); return; }
        const entityMap = commentEntityMap(res);
        const replies = extractComments(res, entityMap, new Set()).slice(0, MAX_REPLIES);
        repliesBtn.remove();
        if (!replies.length) return;
        const wrap = document.createElement('div');
        wrap.className = 'comment-replies';
        for (const r of replies) wrap.appendChild(createCommentRow(r));
        bodyEl.appendChild(wrap);
      });
      bodyEl.appendChild(repliesBtn);
    }

    row.append(avatarEl, bodyEl);
    return row;
  };

  const createSignInBlock = (prompt) => {
    const wrap = document.createElement('div');
    wrap.className = 'signin-state';
    if (prompt.title) {
      const heading = document.createElement('div');
      heading.className = 'signin-title';
      heading.textContent = prompt.title;
      wrap.appendChild(heading);
    }
    if (prompt.message) {
      const message = document.createElement('div');
      message.className = 'signin-message';
      message.textContent = prompt.message;
      wrap.appendChild(message);
    }
    const btn = document.createElement('a');
    btn.className = 'signin-btn';
    btn.href = '/signin';
    btn.textContent = 'Sign in';
    wrap.appendChild(btn);
    return wrap;
  };

  const root = document.createElement('div');
  root.id = 'itube';

  const liveRegion = document.createElement('div');
  liveRegion.className = 'itube-sr-live';
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  root.appendChild(liveRegion);
  const announce = (text) => {
    liveRegion.textContent = '';
    requestAnimationFrame(() => { liveRegion.textContent = text; });
  };

  // Must stay in sync with --accent-grad / --accent in the stylesheet: the CSS
  // holds the default, this holds the value the Aurora swatch re-applies.
  const ACCENT_GRADIENT = 'linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%)';
  const DEFAULT_ACCENT = '#22c3c9';
  const ACCENT_STOPS = ['#3ddb8f', '#22c3c9', '#4a8fe0'];
  const ACCENT_PRESETS = [
    // The default theme. Picking any other swatch flattens the sweep to that
    // one colour — a gradient built from an arbitrary hue picked in a colour
    // wheel would be a guess, and usually an ugly one.
    { name: 'Aurora', hex: DEFAULT_ACCENT, grad: ACCENT_GRADIENT },
    { name: 'Cyan', hex: '#29e0ff' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Magenta', hex: '#ff4d9d' },
    { name: 'Amber', hex: '#ffb020' },
    { name: 'Coral', hex: '#ff6a4d' },
    { name: 'Sky', hex: '#38bdf8' },
    { name: 'Emerald', hex: '#10d98a' },
  ];
  const savedAccent = () => lsGet('itube-accent');
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  // WCAG relative luminance (linearized sRGB) — the old gamma-encoded luma
  // put white text on Coral/Magenta at ~3:1 contrast. Pick whichever of
  // dark/white actually contrasts more against the solid accent.
  const relLuminance = ([r, g, b]) => {
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  /** @type {[number, number, number]} */
  const ON_ACCENT_DARK = [4, 20, 28];
  const ON_ACCENT_DARK_HEX = '#04141c';
  const bestOnAccent = (rgb) => {
    const L = relLuminance(rgb);
    const contrastVsWhite = (1.0 + 0.05) / (L + 0.05);
    const contrastVsDark = (L + 0.05) / (relLuminance(ON_ACCENT_DARK) + 0.05);
    return contrastVsDark >= contrastVsWhite ? ON_ACCENT_DARK_HEX : '#ffffff';
  };
  const contrastRatio = (a, b) => {
    const l1 = relLuminance(a); const l2 = relLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const rgbToHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
  // Light mode's ink accent. The aurora stops are tuned to sit ON a near-black
  // page; as TEXT on a white one the default cyan is ~1.7:1. Scale the colour
  // toward black — hue preserved, so Violet still reads violet — and keep the
  // lightest value that still clears the target.
  //
  // The reference background is NOT the page: accent text mostly lands on
  // accent-TINTED chrome (.hd-signin, the active nav row, chips), and tinting
  // with the ink itself drags the backdrop toward the very colour being
  // measured. Targeting white scored 4.7:1 there but only 3.45:1 on a .16
  // tint. So the backdrop is derived from the candidate — the darkest tint any
  // accent-coloured text sits on — which makes the check self-consistent.
  const LIGHT_INK_TARGET = 4.6;
  const LIGHT_INK_TINT = 0.2;
  const LIGHT_INK_BASE = [244, 245, 248];
  const inkOnTint = (rgb) => rgb.map((c, i) => c * LIGHT_INK_TINT + LIGHT_INK_BASE[i] * (1 - LIGHT_INK_TINT));
  const accentInk = (rgb) => {
    const ok = (c) => contrastRatio(c, inkOnTint(c)) >= LIGHT_INK_TARGET;
    if (ok(rgb)) return rgb.slice();
    let lo = 0; let hi = 1; let best = [0, 0, 0];
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      const cand = rgb.map((c) => c * m);
      // Darker = more contrast, so feasibility is monotone in m: meeting the
      // target means m is at or below the ceiling, and we can try lighter.
      if (ok(cand)) { best = cand; lo = m; } else hi = m;
    }
    return best.map((c) => Math.round(c));
  };

  const setAccent = (hex, persist, grad) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const accentRoot = document.getElementById('itube');
    if (!accentRoot) return;
    // --accent is the INK (text, borders, focus rings, glows); --accent-solid
    // and --accent-bright are the FILL. They only diverge in light mode, where
    // the fill keeps the aurora and the ink is darkened to stay legible.
    const ink = accentRoot.classList.contains('light') ? accentInk(rgb) : rgb;
    accentRoot.style.setProperty('--accent', accentRoot.classList.contains('light') ? rgbToHex(ink) : hex);
    accentRoot.style.setProperty('--accent-rgb', ink.join(', '));
    accentRoot.style.setProperty('--accent-bright', hex);
    accentRoot.style.setProperty('--accent-rgb-bright', rgb.join(', '));
    accentRoot.style.setProperty('--accent-solid', hex);
    accentRoot.style.setProperty('--on-accent', bestOnAccent(rgb));
    // Only a hex is persisted, so the stored default has to re-derive its
    // sweep on restore; every other colour flattens the gradient to itself.
    const sweep = grad || (hex.toLowerCase() === DEFAULT_ACCENT ? ACCENT_GRADIENT : hex);
    accentRoot.style.setProperty('--accent-grad', sweep);
    // A solid pick collapses all three stops onto it, so runtime-built
    // gradients flatten with everything else.
    const stops = sweep === ACCENT_GRADIENT ? ACCENT_STOPS : [hex, hex, hex];
    accentRoot.style.setProperty('--grad-1', stops[0]);
    accentRoot.style.setProperty('--grad-2', stops[1]);
    accentRoot.style.setProperty('--grad-3', stops[2]);
    // The sweep again, darkened stop by stop, for the one place the gradient
    // is TEXT rather than a fill: the wordmark clips it with
    // background-clip:text, so on a light page the raw stops render a ~1.5:1
    // logo. Darkening each stop keeps green -> teal -> blue legible.
    const inkSweep = accentRoot.classList.contains('light')
      ? (sweep === ACCENT_GRADIENT
        ? 'linear-gradient(135deg, ' + ACCENT_STOPS.map((s, i) => {
          const srgb = hexToRgb(s);
          return rgbToHex(srgb ? accentInk(srgb) : ink) + ' ' + [0, 48, 100][i] + '%';
        }).join(', ') + ')'
        : rgbToHex(ink))
      : sweep;
    accentRoot.style.setProperty('--accent-grad-ink', inkSweep);
    if (persist) lsSet('itube-accent', hex);
  };

  // setAccent writes --accent inline, which outranks the .light block in the
  // stylesheet — so the class flip alone would leave the ink at whatever the
  // previous theme computed. Toggle first, then re-derive from the same source
  // colour. Also re-points the boot overlay, which is still on screen during
  // the very first call.
  const applyTheme = (mode, persist) => {
    if (persist) lsSet('itube-theme', mode);
    const light = themeIsLight(mode);
    root.classList.toggle('light', light);
    bootOverlay.classList.toggle('light', light);
    setAccent(savedAccent() || DEFAULT_ACCENT, false);
  };

  // Only 'system' tracks the OS; an explicit Dark/Light pick must not move when
  // the Mac crosses its sunset schedule.
  //
  // schemeQuery is deliberately module-scope, NOT a const inside the try. A
  // MediaQueryList that nothing references is collectable in WebKit, and it
  // takes its 'change' listener with it — which presents as the theme syncing
  // sometimes and not others, depending on when GC last ran. Holding the
  // reference for the life of the script is the whole fix.
  let schemeQuery = null;
  try {
    schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
    const onSchemeChange = () => { if (themeMode() === 'system') applyTheme('system', false); };
    if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', onSchemeChange);
    else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange);
  } catch (e) {}

  const hdLeft = document.createElement('div');
  hdLeft.className = 'sidebar-logo-row';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  const searchIcon = icon([
    ['circle', { cx: '6.2', cy: '6.2', r: '4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75' }],
    ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M9.6 9.6 13 13' }],
  ]);
  searchIcon.classList.add('search-icon');
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'search';
  search.placeholder = 'Search';
  search.setAttribute('autocomplete', 'off');

  const suggestEl = document.createElement('div');
  suggestEl.className = 'search-suggest';
  const suggestUsePopover = supportsPopover && supportsAnchor;
  if (suggestUsePopover) suggestEl.setAttribute('popover', 'auto');

  let suggestItems = [];
  let suggestIndex = -1;
  let suggestGeneration = 0;
  let suggestTimer = null;

  const hideSuggestions = () => {
    if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null; }
    suggestGeneration++;
    suggestEl.classList.remove('show');
    if (suggestUsePopover) { try { suggestEl.hidePopover(); } catch (e) {} }
    suggestEl.replaceChildren();
    suggestItems = [];
    suggestIndex = -1;
  };

  const submitSearch = (q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    hideSuggestions();
    search.blur();
    history.pushState({}, '', '/results?search_query=' + encodeURIComponent(trimmed));
    spaRoute();
  };

  const highlightSuggestion = (index) => {
    const rows = suggestEl.querySelectorAll('.search-suggest-row');
    rows.forEach((r, i) => r.classList.toggle('active', i === index));
    suggestIndex = index;
  };

  const renderSuggestions = (items) => {
    suggestEl.replaceChildren();
    suggestItems = items;
    suggestIndex = -1;
    if (!items.length) {
      suggestEl.classList.remove('show');
      if (suggestUsePopover) { try { suggestEl.hidePopover(); } catch (e) {} }
      return;
    }
    for (const text of items) {
      const row = document.createElement('div');
      row.className = 'search-suggest-row';
      row.textContent = text;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        submitSearch(text);
      });
      suggestEl.appendChild(row);
    }
    suggestEl.classList.add('show');
    if (suggestUsePopover) { try { suggestEl.showPopover(); } catch (e) {} }
  };

  const fetchSuggestions = async (q) => {
    const gen = ++suggestGeneration;
    try {
      const res = await fetch('https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&hl=en&ds=yt&xhr=t&q=' + encodeURIComponent(q), { credentials: 'omit' });
      if (gen !== suggestGeneration || !res.ok) return;
      const data = await res.json();
      if (gen !== suggestGeneration) return;
      const raw = Array.isArray(data?.[1]) ? data[1] : [];
      const items = raw
        .map((entry) => (Array.isArray(entry) ? entry[0] : null))
        .filter((t) => typeof t === 'string')
        .slice(0, MAX_SUGGESTIONS);
      if (search.value.trim() === q) renderSuggestions(items);
    } catch (e) {
      console.warn('[itube] search suggestions failed', e);
    }
  };

  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (!q) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(q), SUGGEST_DEBOUNCE_MS);
  });

  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!suggestItems.length) return;
      e.preventDefault();
      highlightSuggestion(suggestIndex < suggestItems.length - 1 ? suggestIndex + 1 : 0);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!suggestItems.length) return;
      e.preventDefault();
      highlightSuggestion(suggestIndex > 0 ? suggestIndex - 1 : suggestItems.length - 1);
      return;
    }
    if (e.key === 'Escape') {
      hideSuggestions();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitSearch(suggestIndex >= 0 ? suggestItems[suggestIndex] : search.value);
  });

  search.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 120);
  });

  document.addEventListener('mousedown', (e) => {
    if (!searchWrap.contains(/** @type {Node} */ (e.target))) { hideSuggestions(); searchWrap.classList.remove('expanded'); }
  });

  searchWrap.append(searchIcon, search, suggestEl);

  const railSearchBtn = document.createElement('button');
  railSearchBtn.type = 'button';
  railSearchBtn.className = 'rail-search-btn';
  railSearchBtn.title = 'Search';
  railSearchBtn.setAttribute('aria-label', 'Search');
  railSearchBtn.appendChild(icon([
    ['circle', { cx: '6.2', cy: '6.2', r: '4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75' }],
    ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'square', d: 'M9.6 9.6 13 13' }],
  ]));
  railSearchBtn.addEventListener('click', () => {
    searchWrap.classList.add('expanded');
    search.focus();
  });
  search.addEventListener('blur', () => {
    setTimeout(() => { if (!searchWrap.contains(document.activeElement)) searchWrap.classList.remove('expanded'); }, 150);
  });

  const RAIL_WIDE_QUERY = '(min-width: 1101px)';
  const railUserCollapsed = () => lsGet('itube-rail') === 'collapsed';
  const railWideQuery = window.matchMedia(RAIL_WIDE_QUERY);
  const syncRail = () => {
    const collapsed = !railWideQuery.matches || railUserCollapsed();
    root.classList.toggle('rail-collapsed', collapsed);
    railToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    railToggleBtn.title = label;
    railToggleBtn.setAttribute('aria-label', label);
  };
  const railToggleBtn = document.createElement('button');
  railToggleBtn.type = 'button';
  railToggleBtn.className = 'rail-toggle-btn';
  railToggleBtn.appendChild(icon([
    ['rect', { x: '1.6', y: '2.4', width: '12.8', height: '11.2', rx: '2.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
    ['path', { d: 'M6.2 2.9v10.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
  ]));
  railToggleBtn.addEventListener('click', () => {
    lsSet('itube-rail', railUserCollapsed() ? 'open' : 'collapsed');
    syncRail();
  });
  if (railWideQuery.addEventListener) railWideQuery.addEventListener('change', syncRail);
  else if (railWideQuery.addListener) railWideQuery.addListener(syncRail);
  syncRail();

  const hdRight = document.createElement('div');
  hdRight.className = 'hd-right';
  const hdSignIn = document.createElement('a');
  hdSignIn.className = 'hd-signin';
  hdSignIn.href = '/signin';
  hdSignIn.textContent = 'Sign in';
  const sidebarSignInRow = document.createElement('div');
  sidebarSignInRow.className = 'sidebar-signin-row';
  sidebarSignInRow.style.display = 'none';
  sidebarSignInRow.appendChild(hdSignIn);
  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'hd-avatar';
  avatar.setAttribute('aria-label', 'Account menu');
  avatar.setAttribute('aria-haspopup', 'menu');
  avatar.setAttribute('aria-expanded', 'false');
  avatar.style.display = 'none';
  const avatarImg = fadeInImg();
  avatarImg.className = 'hd-avatar-img';
  avatarImg.alt = '';
  avatar.appendChild(avatarImg);
  hdRight.append(avatar);

  const acctMenu = document.createElement('div');
  acctMenu.className = 'acct-menu';
  acctMenu.setAttribute('role', 'menu');
  const acctHead = document.createElement('div');
  acctHead.className = 'acct-head';
  const acctHeadImg = document.createElement('img');
  acctHeadImg.className = 'acct-head-img';
  acctHeadImg.alt = '';
  acctHeadImg.setAttribute('decoding', 'async');
  const acctHeadText = document.createElement('div');
  acctHeadText.className = 'acct-head-text';
  const acctName = document.createElement('div');
  acctName.className = 'acct-name';
  const acctHandle = document.createElement('div');
  acctHandle.className = 'acct-handle';
  acctHeadText.append(acctName, acctHandle);
  acctHead.append(acctHeadImg, acctHeadText);
  const acctList = document.createElement('div');
  acctList.className = 'acct-list';
  const makeItem = (label, href, blank) => {
    const a = document.createElement('a');
    a.className = 'acct-item';
    a.setAttribute('role', 'menuitem');
    a.href = href;
    a.textContent = label;
    if (blank) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  };
  const acctChannel = makeItem('Your channel', '/', false);
  const acctStudio = makeItem('YouTube Studio', 'https://studio.youtube.com', true);
  const acctSettings = makeItem('Settings', '#', false);
  acctSettings.addEventListener('click', (e) => { e.preventDefault(); closeAcctMenu(); openSettings(); });
  // acctMenu stops click propagation (so an item click can't reach the
  // outside-click closer), which also keeps it from reaching root's SPA
  // router — so "Your channel" fell through to a full document load of a
  // route Flyt renders itself. Route it here instead.
  acctChannel.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = acctChannel.getAttribute('href');
    if (!href || !href.startsWith('/') || NATIVE_ROUTE_RE.test(href)) return;
    e.preventDefault();
    closeAcctMenu();
    history.pushState({}, '', href);
    spaRoute();
  });
  const acctSwitch = makeItem('Switch account', 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fwww.youtube.com%2F', true);
  const acctSignOut = makeItem('Sign out', 'https://www.youtube.com/logout', false);
  acctSignOut.className = 'acct-item acct-signout';
  acctList.append(acctChannel, acctStudio, acctSettings, acctSwitch, acctSignOut);
  acctMenu.append(acctHead, acctList);
  root.appendChild(acctMenu);
  if (supportsPopover) acctMenu.setAttribute('popover', 'auto');

  let acctOpen = false;
  const positionAcctMenu = () => {
    const r = avatar.getBoundingClientRect();
    acctMenu.style.top = Math.round(r.bottom + 8) + 'px';
    let left = Math.round(r.left);
    const w = acctMenu.offsetWidth || 280;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (left < 8) left = 8;
    acctMenu.style.left = left + 'px';
  };
  const acctItems = () => /** @type {HTMLElement[]} */ (Array.from(acctList.querySelectorAll('.acct-item')));
  const closeAcctMenu = () => {
    if (!acctOpen) return;
    acctOpen = false;
    const wasInside = acctMenu.contains(document.activeElement);
    if (supportsPopover) { try { acctMenu.hidePopover(); } catch (e) {} }
    acctMenu.classList.remove('open');
    avatar.setAttribute('aria-expanded', 'false');
    if (wasInside) avatar.focus();
  };
  const openAcctMenu = () => {
    if (acctOpen) return;
    acctOpen = true;
    if (supportsPopover) { try { acctMenu.showPopover(); } catch (e) {} }
    acctMenu.classList.add('open');
    avatar.setAttribute('aria-expanded', 'true');
    if (!supportsAnchor) positionAcctMenu();
    const items = acctItems();
    if (items.length) items[0].focus();
  };
  avatar.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); acctOpen ? closeAcctMenu() : openAcctMenu(); });
  acctMenu.addEventListener('click', (e) => { e.stopPropagation(); });
  acctMenu.addEventListener('keydown', (e) => {
    const items = acctItems();
    if (!items.length) return;
    const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });
  acctList.addEventListener('click', () => { closeAcctMenu(); });
  if (supportsPopover) {
    acctMenu.addEventListener('toggle', (e) => {
      acctOpen = e.newState === 'open';
      acctMenu.classList.toggle('open', acctOpen);
      avatar.setAttribute('aria-expanded', acctOpen ? 'true' : 'false');
      if (acctOpen) {
        if (!supportsAnchor) positionAcctMenu();
        const items = acctItems();
        if (items.length) items[0].focus();
      }
    });
  } else {
    document.addEventListener('click', () => { closeAcctMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAcctMenu(); });
  }
  window.addEventListener('resize', () => { if (acctOpen && !supportsAnchor) positionAcctMenu(); });

  let accountLoaded = false;
  const loadAccount = async () => {
    if (accountLoaded || loggedOut()) return;
    accountLoaded = true;
    const res = await innertube('account/account_menu', {});
    if (!res) { accountLoaded = false; return; }
    const header = findNode(res, (n) => n && n.activeAccountHeaderRenderer)?.activeAccountHeaderRenderer;
    const thumbs = header?.accountPhoto?.thumbnails;
    const url = pickThumbUrl(thumbs, 96);
    if (url) { avatarImg.src = url; acctHeadImg.src = url; }
    const name = header?.accountName?.simpleText;
    if (name) acctName.textContent = name;
    const handle = header?.channelHandle?.simpleText;
    if (typeof handle === 'string' && handle.startsWith('@')) {
      acctHandle.textContent = handle;
      acctChannel.href = '/' + handle;
    } else {
      let browseId = null;
      walk(res, (n) => {
        const b = n?.browseEndpoint?.browseId;
        if (!browseId && typeof b === 'string' && b.startsWith('UC')) browseId = b;
      });
      if (browseId) acctChannel.href = '/channel/' + encodeURIComponent(browseId);
    }
  };

  const syncAccount = () => {
    const out = loggedOut();
    sidebarSignInRow.style.display = out ? '' : 'none';
    avatar.style.display = out ? 'none' : '';
    if (out) closeAcctMenu();
    if (!out) idle(loadAccount);
  };

  const nav = document.createElement('nav');
  nav.className = 'sidebar';
  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/';
  const brandTile = document.createElement('div');
  brandTile.className = 'brand-tile';
  brandTile.appendChild(brandGlyph(14));
  const brandWord = document.createElement('span');
  brandWord.className = 'brand-word';
  brandWord.textContent = 'Flyt';
  const brandBeta = document.createElement('span');
  brandBeta.className = 'brand-beta';
  brandBeta.textContent = 'BETA';
  brand.append(brandTile, brandWord, brandBeta);
  hdLeft.appendChild(brand);

  const powerToggle = document.createElement('button');
  powerToggle.className = 'itube-power on';
  powerToggle.type = 'button';
  powerToggle.title = 'Disable Flyt (reload with original YouTube)';
  powerToggle.setAttribute('aria-label', 'Disable Flyt');
  const powerKnob = document.createElement('span');
  powerKnob.className = 'itube-power-knob';
  powerToggle.appendChild(powerKnob);
  powerToggle.addEventListener('click', () => setItubeOff(true));
  hdLeft.appendChild(powerToggle);
  hdLeft.appendChild(hdRight);
  hdLeft.appendChild(railSearchBtn);
  hdLeft.appendChild(railToggleBtn);

  const sidebarHead = document.createElement('div');
  sidebarHead.className = 'sidebar-head';
  sidebarHead.append(hdLeft, sidebarSignInRow, searchWrap);
  nav.appendChild(sidebarHead);

  const NAV_ITEMS = [
    { key: 'home', label: 'Home', href: '/' },
    { key: 'subs', label: 'Subscriptions', href: '/feed/subscriptions' },
    { key: 'following', label: 'Following', href: '/feed/channels' },
    { key: 'later', label: 'Watch later', href: '/playlist?list=WL' },
    { key: 'playlists', label: 'Playlists', href: '/feed/playlists' },
    { key: 'history', label: 'History', href: '/feed/history' },
  ];
  const navRows = {};
  for (const item of NAV_ITEMS) {
    const row = document.createElement('a');
    row.className = 'nav-row';
    row.href = item.href;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(ICONS[item.key](), label);
    nav.appendChild(row);
    navRows[item.key] = row;
  }
  // `seenIds` is optional and defaults to a fresh Set for a one-off call, but
  // fetchGuideChannels() passes a Set it keeps across pages so continuation
  // pages dedupe against everything collected so far, not just themselves.
  // FEchannels (the manage-subscriptions feed, now the PRIMARY source — see
  // fetchGuideChannels()) does not list channels as guideEntryRenderer nodes;
  // it uses channelRenderer/gridChannelRenderer (and, defensively, whatever
  // other shape a catch-all can independently pull an id/title/avatar out
  // of). All three branches feed the same deduped `seenIds` Set, so the same
  // underlying object matched twice (e.g. by the catch-all AND a specific
  // branch, since `walk()` visits nested objects separately) is only added
  // once.
  // Guide avatars paint at 24–28px — request the smallest variant that covers
  // that (not the 176px original: ~25× the pixels across hundreds of rows).
  const lastThumbUrl = (thumbs) => pickThumbUrl(thumbs, 64);
  const textOf = (obj) => obj?.simpleText || obj?.runs?.[0]?.text || null;

  const collectGuideChannels = (root, seenIds = new Set()) => {
    const out = [];
    walk(root, (node) => {
      if (!node || typeof node !== 'object') return;

      const g = node.guideEntryRenderer;
      if (g) {
        const browseId = g.navigationEndpoint?.browseEndpoint?.browseId;
        if (typeof browseId === 'string' && browseId.startsWith('UC') && !seenIds.has(browseId)) {
          const title = g.formattedTitle?.simpleText || g.formattedTitle?.runs?.[0]?.text || g.title?.simpleText;
          const avatarUrl = lastThumbUrl(g.thumbnail?.thumbnails);
          if (title && avatarUrl) {
            seenIds.add(browseId);
            out.push({ browseId, title, avatar: avatarUrl });
          }
        }
        return;
      }

      const c = node.channelRenderer || node.gridChannelRenderer;
      if (c) {
        const browseId = c.channelId || c.navigationEndpoint?.browseEndpoint?.browseId;
        if (typeof browseId === 'string' && browseId.startsWith('UC') && !seenIds.has(browseId)) {
          const title = c.title?.simpleText || c.title?.runs?.[0]?.text;
          const avatarUrl = lastThumbUrl(c.thumbnail?.thumbnails);
          if (title && avatarUrl) {
            seenIds.add(browseId);
            const entry = { browseId, title, avatar: avatarUrl };
            // Bonus fields, additive only — nothing downstream depends on
            // these being present (the Following page still enriches every
            // channel via its own per-channel browse fetch regardless).
            const subs = textOf(c.subscriberCountText);
            const videos = textOf(c.videoCountText);
            if (subs) entry.subscriberCountText = subs;
            if (videos) entry.videoCountText = videos;
            out.push(entry);
          }
        }
        return;
      }

      // Catch-all: only fires for nodes not already handled above, and only
      // counts a hit if id + title + avatar ALL resolve — same guard as the
      // specific branches, just against a wider set of field-name shapes.
      const browseId = node.navigationEndpoint?.browseEndpoint?.browseId || node.channelId;
      if (typeof browseId !== 'string' || !browseId.startsWith('UC') || seenIds.has(browseId)) return;
      const title = textOf(node.title) || textOf(node.formattedTitle) || textOf(node.displayName);
      const avatarUrl = lastThumbUrl(node.thumbnail?.thumbnails)
        || lastThumbUrl(node.avatar?.thumbnails)
        || lastThumbUrl(node.avatar?.decoratedAvatarViewModel?.avatar?.avatarImageViewModel?.image?.sources);
      if (!title || !avatarUrl) return;
      seenIds.add(browseId);
      out.push({ browseId, title, avatar: avatarUrl });
    });
    return out;
  };

  // Sane ceiling so a malformed/looping continuation response can't spin
  // forever — real subscription lists (even power users) fall well under
  // this, so hitting it means something is wrong with the response shape.
  const GUIDE_CHANNELS_HARD_CAP = 2000;
  const GUIDE_CHANNELS_MAX_PAGES = 40;

  // Follows `continuation` tokens on `endpoint` (either 'guide' or the
  // FEchannels 'browse' fallback), appending deduped channels (via the
  // shared `seenIds` Set) into `out` in place until the response stops
  // offering a continuation, or a page/hard cap is hit. Returns whether ANY
  // continuation token was ever seen, so the caller can tell "list fully
  // paginated to the end" apart from "this endpoint never paginates at all".
  const paginateGuideChannels = async (endpoint, firstRes, seenIds, out) => {
    let token = findContinuationToken(firstRes);
    const hadContinuation = Boolean(token);
    let pages = 0;
    while (token && pages < GUIDE_CHANNELS_MAX_PAGES && out.length < GUIDE_CHANNELS_HARD_CAP) {
      const res = await innertube(endpoint, { continuation: token });
      if (!res) break;
      out.push(...collectGuideChannels(res, seenIds));
      token = findContinuationToken(res);
      pages++;
    }
    if (pages >= GUIDE_CHANNELS_MAX_PAGES) {
      console.warn('[itube] ' + endpoint + ' channel pagination hit the ' + GUIDE_CHANNELS_MAX_PAGES + '-page cap');
    }
    return hadContinuation;
  };

  // Subscriptions feed the sidebar, the Following page AND subscribedByGuide()
  // (so the subscribe button reads correctly too) — all three go stale past
  // ~100 subscriptions if we stop at the guide endpoint's first page, so this
  // follows continuations to the end instead of returning a partial list.
  //
  // FEchannels (the manage-subscriptions feed, /feed/channels) is the PRIMARY
  // source: unlike the guide endpoint (which the sidebar's fast-path caps to
  // MAX_GUIDE_CHANNELS server-side and doesn't reliably expose a continuation
  // past that cap), FEchannels is built to paginate through the whole list.
  // The old guide-first design silently truncated at ~100 subscriptions
  // because the guide endpoint reported no continuation for a non-empty
  // (but incomplete) page — falling back to FEchannels only in that case
  // meant the fallback itself could be starved. Trying FEchannels first
  // avoids that failure mode entirely; the guide endpoint is now only a
  // last-resort fallback for the (rare) case FEchannels returns nothing.
  const fetchGuideChannels = async () => {
    const seenIds = new Set();
    const out = [];
    // On a genuine hard-load of /feed/channels, window.ytInitialData IS the
    // FEchannels payload — reuse it as a synchronous page-1 seed (no network
    // round trip). On every OTHER page (e.g. at boot, feeding the sidebar),
    // window.ytInitialData is that page's own data, not FEchannels', so this
    // must be gated on the pathname or it would misread unrelated data.
    let feRes = (location.pathname === '/feed/channels' && !hadSpaNav) ? window.ytInitialData : null;
    if (feRes) out.push(...collectGuideChannels(feRes, seenIds));
    if (!out.length) {
      feRes = await innertube('browse', { browseId: 'FEchannels' });
      if (feRes) out.push(...collectGuideChannels(feRes, seenIds));
    }
    if (out.length) {
      await paginateGuideChannels('browse', feRes, seenIds, out);
      return out;
    }
    // FEchannels' first page yielded zero channels — fall back to the guide
    // endpoint exactly as the old primary path worked, so a genuinely
    // subscription-less (or logged-out) account still resolves to `[]`
    // rather than throwing or hanging, and a real fetch failure still
    // returns `null` so loadChannels()'s error message fires.
    const seed = window.ytInitialGuideData;
    const guideOut = collectGuideChannels(seed, seenIds);
    let firstRes = seed;
    if (!guideOut.length) {
      firstRes = await innertube('guide', {});
      if (!firstRes) return null;
      guideOut.push(...collectGuideChannels(firstRes, seenIds));
    }
    await paginateGuideChannels('guide', firstRes, seenIds, guideOut);
    return guideOut;
  };
  const subsSection = document.createElement('div');
  subsSection.className = 'nav-subs';
  nav.appendChild(subsSection);

  const settingsRow = document.createElement('button');
  settingsRow.type = 'button';
  settingsRow.className = 'nav-row nav-settings';
  const settingsLabel = document.createElement('span');
  settingsLabel.textContent = 'Settings';
  settingsRow.append(ICONS.settings(), settingsLabel);
  nav.appendChild(settingsRow);

  const settingsRowEl = (labelText, control) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('div');
    label.className = 'settings-row-label';
    label.textContent = labelText;
    row.append(label, control);
    return row;
  };

  const settingsSectionHeading = (text) => {
    const h = document.createElement('div');
    h.className = 'settings-section-heading';
    h.textContent = text;
    return h;
  };

  const settingsToggle = (getOn, setOn) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-toggle';
    const sync = () => {
      const on = getOn();
      btn.classList.toggle('active', on);
      btn.textContent = on ? 'On' : 'Off';
    };
    btn.addEventListener('click', () => { setOn(!getOn()); sync(); });
    sync();
    return { el: btn, sync };
  };

  const settingsOverlay = document.createElement('div');
  settingsOverlay.className = 'settings-overlay';
  root.appendChild(settingsOverlay);

  let settingsBuilt = false;
  let settingsPanel;
  let settingsWire;
  let speedSelect;
  let qualitySelect;
  let autoplayToggle;
  let skipSponsorsToggle;
  let reduceMotionToggle;
  let hideWatchedToggle;
  let renderKeywordChips;
  let renderChannelChips;
  let syncSettingsAccent;

  function buildSettingsPanel() {
    if (settingsBuilt) return;
    settingsBuilt = true;

  settingsPanel = document.createElement('div');
  settingsPanel.className = 'settings-panel';

  const settingsHeader = document.createElement('div');
  settingsHeader.className = 'settings-header';
  const settingsTitle = document.createElement('div');
  settingsTitle.className = 'settings-title';
  settingsTitle.textContent = 'Settings';
  const settingsClose = document.createElement('button');
  settingsClose.type = 'button';
  settingsClose.className = 'settings-close';
  settingsClose.setAttribute('aria-label', 'Close settings');
  settingsClose.textContent = '✕';
  settingsHeader.append(settingsTitle, settingsClose);
  settingsPanel.appendChild(settingsHeader);

  settingsPanel.appendChild(settingsSectionHeading('Appearance'));

  const themeSelect = document.createElement('select');
  themeSelect.className = 'settings-select';
  for (const [value, label] of [['system', 'Match system'], ['dark', 'Dark'], ['light', 'Light']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = themeMode();
  themeSelect.addEventListener('change', () => { applyTheme(themeSelect.value, true); });
  settingsPanel.appendChild(settingsRowEl('Theme', themeSelect));

  const swatchesWrap = document.createElement('div');
  swatchesWrap.className = 'settings-swatches';
  const swatchEls = ACCENT_PRESETS.map((preset) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'settings-swatch';
    sw.style.background = preset.grad || preset.hex;
    sw.title = preset.name;
    sw.addEventListener('click', () => {
      setAccent(preset.hex, true, preset.grad);
      syncSettingsAccent();
    });
    swatchesWrap.appendChild(sw);
    return { hex: preset.hex, el: sw };
  });
  const accentColorInput = document.createElement('input');
  accentColorInput.type = 'color';
  accentColorInput.className = 'settings-color';
  accentColorInput.addEventListener('input', () => {
    setAccent(accentColorInput.value, true);
    syncSettingsAccent();
  });
  swatchesWrap.appendChild(accentColorInput);
  syncSettingsAccent = () => {
    const current = savedAccent() || DEFAULT_ACCENT;
    for (const { hex, el } of swatchEls) el.classList.toggle('selected', hex.toLowerCase() === current.toLowerCase());
    accentColorInput.value = current;
  };
  settingsPanel.appendChild(settingsRowEl('Accent color', swatchesWrap));

  settingsPanel.appendChild(settingsSectionHeading('Playback'));

  speedSelect = document.createElement('select');
  speedSelect.className = 'settings-select';
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = s + '×';
    speedSelect.appendChild(opt);
  }
  speedSelect.addEventListener('change', () => {
    lsSet('itube-speed', speedSelect.value);
  });
  settingsPanel.appendChild(settingsRowEl('Default playback speed', speedSelect));

  autoplayToggle = settingsToggle(
    () => lsGet('itube-autoplay') !== '0',
    (on) => lsSet('itube-autoplay', on ? '1' : '0'),
  );
  settingsPanel.appendChild(settingsRowEl('Autoplay', autoplayToggle.el));

  qualitySelect = document.createElement('select');
  qualitySelect.className = 'settings-select';
  const QUALITY_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'hd2160', label: '2160p' },
    { value: 'hd1440', label: '1440p' },
    { value: 'hd1080', label: '1080p' },
    { value: 'hd720', label: '720p' },
    { value: 'large', label: '480p' },
    { value: 'medium', label: '360p' },
  ];
  for (const { value, label } of QUALITY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    qualitySelect.appendChild(opt);
  }
  qualitySelect.addEventListener('change', () => {
    lsSet('itube-quality', qualitySelect.value);
  });
  settingsPanel.appendChild(settingsRowEl('Preferred quality', qualitySelect));

  reduceMotionToggle = settingsToggle(
    () => lsGet('itube-reduce-motion') === '1',
    (on) => {
      lsSet('itube-reduce-motion', on ? '1' : '0');
      root.classList.toggle('itube-reduce-motion', on);
    },
  );
  settingsPanel.appendChild(settingsRowEl('Reduce motion', reduceMotionToggle.el));

  settingsPanel.appendChild(settingsSectionHeading('Privacy'));

  skipSponsorsToggle = settingsToggle(
    () => sponsorSkipOn(),
    (on) => setSponsorSkipOn(on),
  );
  settingsPanel.appendChild(settingsRowEl('Skip sponsors', skipSponsorsToggle.el));

  const dislikesToggle = settingsToggle(
    () => dislikesEnabled(),
    (on) => setDislikesEnabled(on),
  );
  settingsPanel.appendChild(settingsRowEl('Show dislike estimates', dislikesToggle.el));

  const transcriptToggle = settingsToggle(
    () => transcriptEnabled(),
    (on) => setTranscriptEnabled(on),
  );
  settingsPanel.appendChild(settingsRowEl('Transcript button', transcriptToggle.el));

  // Feed ranking. Both controls only affect the home feed — see rankBatch.
  // They demote, never hide; hiding is what the Filters section below does.
  settingsPanel.appendChild(settingsSectionHeading('Feed'));

  const balanceToggle = settingsToggle(rankBalanceOn, setRankBalanceOn);
  settingsPanel.appendChild(settingsRowEl('Balance channels', balanceToggle.el));

  const shoutyToggle = settingsToggle(rankShoutyOn, setRankShoutyOn);
  settingsPanel.appendChild(settingsRowEl('Demote shouty titles', shoutyToggle.el));

  settingsPanel.appendChild(settingsSectionHeading('Filters'));

  const keywordRow = document.createElement('div');
  keywordRow.className = 'settings-keyword-row';
  const keywordInput = document.createElement('input');
  keywordInput.type = 'text';
  keywordInput.className = 'settings-keyword-input';
  keywordInput.placeholder = 'Mute keyword';
  const keywordAdd = document.createElement('button');
  keywordAdd.type = 'button';
  keywordAdd.className = 'settings-keyword-add';
  keywordAdd.textContent = 'Add';
  keywordRow.append(keywordInput, keywordAdd);
  settingsPanel.appendChild(settingsRowEl('Mute keywords', keywordRow));

  const keywordChips = document.createElement('div');
  keywordChips.className = 'settings-chips';
  settingsPanel.appendChild(keywordChips);

  renderKeywordChips = () => {
    keywordChips.replaceChildren();
    for (const kw of mutedKeywordsList()) {
      const chip = document.createElement('div');
      chip.className = 'settings-chip';
      const text = document.createElement('span');
      text.textContent = kw;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-chip-remove';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        const list = mutedKeywordsList().filter((k) => k !== kw);
        lsSet('itube-mute-keywords', JSON.stringify(list));
        refreshMuteState();
        renderKeywordChips();
      });
      chip.append(text, remove);
      keywordChips.appendChild(chip);
    }
  };

  const addKeyword = () => {
    const kw = keywordInput.value.trim().toLowerCase();
    if (!kw) return;
    const list = mutedKeywordsList();
    if (!list.includes(kw)) {
      list.push(kw);
      lsSet('itube-mute-keywords', JSON.stringify(list));
      refreshMuteState();
    }
    keywordInput.value = '';
    renderKeywordChips();
  };
  keywordAdd.addEventListener('click', addKeyword);
  keywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });

  const channelChips = document.createElement('div');
  channelChips.className = 'settings-chips';
  // Hidden entirely when there are none: an empty row left a label sitting
  // alone with blank space where its control should be. Revealed by clearing
  // the inline display so the stylesheet's own `flex` comes back.
  const mutedChannelsRow = settingsRowEl('Muted channels', channelChips);
  mutedChannelsRow.style.display = 'none';
  settingsPanel.appendChild(mutedChannelsRow);

  renderChannelChips = () => {
    channelChips.replaceChildren();
    const muted = [...mutedChannelsSet()];
    mutedChannelsRow.style.display = muted.length ? '' : 'none';
    for (const href of muted) {
      const chip = document.createElement('div');
      chip.className = 'settings-chip';
      const text = document.createElement('span');
      text.textContent = href.split('/').filter(Boolean).pop() || href;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-chip-remove';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        const list = mutedChannelsSet();
        list.delete(href);
        lsSet('itube-mute-channels', JSON.stringify([...list]));
        refreshMuteState();
        renderChannelChips();
      });
      chip.append(text, remove);
      channelChips.appendChild(chip);
    }
  };

  hideWatchedToggle = settingsToggle(
    () => hideWatchedOn(),
    (on) => {
      lsSet('itube-hide-watched', on ? '1' : '0');
      refreshMuteState();
    },
  );
  settingsPanel.appendChild(settingsRowEl('Hide watched videos', hideWatchedToggle.el));

  settingsPanel.appendChild(settingsSectionHeading('Keyboard shortcuts'));

  const shortcutsList = document.createElement('div');
  shortcutsList.className = 'settings-shortcuts';
  for (const { display, label } of KEYBOARD_SHORTCUTS) {
    const row = document.createElement('div');
    row.className = 'settings-shortcut-row';
    const keysWrap = document.createElement('div');
    keysWrap.className = 'settings-shortcut-keys';
    display.forEach((k, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'settings-shortcut-sep';
        sep.textContent = '/';
        keysWrap.appendChild(sep);
      }
      const kbd = document.createElement('span');
      kbd.className = 'settings-kbd';
      kbd.textContent = k;
      keysWrap.appendChild(kbd);
    });
    const desc = document.createElement('div');
    desc.className = 'settings-shortcut-label';
    desc.textContent = label;
    row.append(keysWrap, desc);
    shortcutsList.appendChild(row);
  }
  settingsPanel.appendChild(shortcutsList);

  settingsOverlay.appendChild(settingsPanel);

  settingsWire = wireOverlay(settingsOverlay, settingsPanel);
  settingsClose.addEventListener('click', closeSettings);
  }

  const openSettings = () => {
    buildSettingsPanel();
    syncSettingsAccent();
    speedSelect.value = lsGet('itube-speed') || '1';
    qualitySelect.value = lsGet('itube-quality') || 'auto';
    autoplayToggle.sync();
    skipSponsorsToggle.sync();
    reduceMotionToggle.sync();
    renderKeywordChips();
    renderChannelChips();
    hideWatchedToggle.sync();
    settingsWire.open();
  };
  const closeSettings = () => { if (settingsWire) settingsWire.close(); };
  settingsRow.addEventListener('click', openSettings);

  const whenReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  // Two different intents used to share one helper, and that is expensive on
  // the engine this app targets: Safari implements neither requestIdleCallback
  // nor scheduler.postTask, so `idle()` is a flat 200ms delay there.
  //
  //   idle()  deferred BACKGROUND work — the account menu, the guide fetch,
  //           the watch-later set. A delay is exactly what these want: they
  //           must not compete with first paint.
  //   soon()  user-visible RENDERING — appending a continuation, restoring a
  //           cached list. A blind 200ms here is pure added latency before
  //           cards appear. tryAppend already refuses to run during an active
  //           scroll, so this only needs to leave the current task.
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  const soon = (cb) => requestAnimationFrame(() => cb());
  const yieldTask = () => (window.scheduler && scheduler.yield ? scheduler.yield() : new Promise((r) => setTimeout(r)));
  const MAX_GUIDE_CHANNELS = 30;
  const GUIDE_POLL_MS = 200;
  const GUIDE_MAX_WAIT = 15000;
  const GUIDE_RETRY_MS = 600;
  const GUIDE_MAX_ATTEMPTS = 3;
  // Subscriptions change rarely — persist the collected list so the sidebar
  // and subscribe-state source of truth are correct instantly on boot instead
  // of after 5–25 sequential FEchannels pages. Subscribe/unsubscribe actions
  // update both the live cache and the stored copy.
  const GUIDE_CACHE_KEY = 'itube-guide-cache';
  const GUIDE_CACHE_TTL = 6 * 3600 * 1000;
  const readGuideCacheStore = () => {
    try {
      const parsed = JSON.parse(lsGet(GUIDE_CACHE_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.channels) || !parsed.channels.length) return null;
      if (typeof parsed.at !== 'number' || Date.now() - parsed.at > GUIDE_CACHE_TTL) return null;
      return parsed.channels;
    } catch (e) { return null; }
  };
  let guideChannelsCache = readGuideCacheStore();
  let guideChannelsFailed = false;
  const persistGuideCache = () => {
    if (!guideChannelsCache || !guideChannelsCache.length) return;
    lsSet(GUIDE_CACHE_KEY, JSON.stringify({ at: Date.now(), channels: guideChannelsCache }));
  };
  let guideChannelsPromise = null;
  let guideChannelsScheduled = false;
  let guideAttempts = 0;
  let guidePaintedSig = null;
  const guideWaitStart = Date.now();
  const paintGuideChannels = () => {
    const cache = guideChannelsCache;
    const sig = (cache && cache.length) ? cache.length + ':' + (cache[0].browseId || '') + ':' + (cache[cache.length - 1].browseId || '') : '0';
    if (sig === guidePaintedSig) return;
    guidePaintedSig = sig;
    const channels = cache || [];
    if (!channels.length) { subsSection.replaceChildren(); return; }
    const label = document.createElement('div');
    label.className = 'nav-section-label';
    label.textContent = 'SUBSCRIPTIONS';
    /** @type {HTMLElement[]} */
    const rows = [label];
    for (const ch of channels.slice(0, MAX_GUIDE_CHANNELS)) {
      const row = document.createElement('a');
      row.className = 'nav-chan';
      row.href = '/channel/' + encodeURIComponent(ch.browseId);
      const av = document.createElement('img');
      av.className = 'nav-chan-avatar';
      av.src = ch.avatar;
      av.setAttribute('loading', 'lazy');
      const name = document.createElement('span');
      name.textContent = ch.title;
      row.append(av, name);
      rows.push(row);
    }
    subsSection.replaceChildren(...rows);
  };
  // Authoritative subscribe state: the per-channel/per-video button payload
  // (subscribeButtonRenderer/subscribeButtonViewModel) misses YouTube's modern
  // subscribe-button shape and always reads as "not subscribed". The guide
  // sidebar list (which powers the "SUBSCRIPTIONS" nav section) is the one
  // source that's actually correct, so prefer it and only fall back to the
  // button payload while the guide hasn't loaded yet.
  const subscribedByGuide = (channelId) => {
    if (!channelId || !guideChannelsCache || guideChannelsFailed) return null;
    return guideChannelsCache.some((ch) => ch.browseId === channelId);
  };
  // ---- Watch Later membership -------------------------------------------
  // One VLWL fetch per session (kicked at idle, logged-in only) gives every
  // Save control its true initial state — the alternative, an extra API call
  // per watch navigation, is exactly the per-nav cost the perf mandate bans.
  // Local toggles keep the set current without refetching.
  let wlSet = null;
  let wlLoading = null;
  const WL_MAX_PAGES = 5; // 100 ids/page — beyond ~500 the set stays partial (unknown ids just read as "not saved")
  const loadWlSet = () => {
    if (wlSet || wlLoading || loggedOut() || !cfg()?.INNERTUBE_API_KEY) return wlLoading;
    wlLoading = (async () => {
      const ids = new Set();
      const collect = (res) => walk(res, (n) => {
        if (n?.playlistVideoRenderer?.videoId) ids.add(n.playlistVideoRenderer.videoId);
      });
      const first = await innertube('browse', { browseId: 'VLWL' });
      if (!first) { wlLoading = null; return; }
      collect(first);
      let token = findContinuationToken(first);
      for (let page = 1; token && page < WL_MAX_PAGES; page++) {
        const more = await innertube('browse', { continuation: token });
        if (!more) break;
        collect(more);
        token = findContinuationToken(more);
      }
      wlSet = ids;
      wlLoading = null;
    })();
    return wlLoading;
  };
  // true/false when known, null when the set hasn't loaded (treat as unknown).
  const wlHas = (videoId) => (wlSet && videoId ? wlSet.has(videoId) : null);
  const wlMark = (videoId, inWl) => {
    if (!wlSet || !videoId) return;
    if (inWl) wlSet.add(videoId); else wlSet.delete(videoId);
  };
  const wlToggle = async (videoId) => {
    const adding = wlHas(videoId) !== true;
    const action = adding
      ? { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }
      : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId };
    const res = await innertube('browse/edit_playlist', { playlistId: 'WL', actions: [action] });
    const ok = playlistEditConfirmed(res);
    if (ok) wlMark(videoId, adding);
    return { ok, inWl: ok ? adding : !adding };
  };

  // Calls `cb` once the guide list has settled (loaded or given up), kicking
  // off the fetch if it hasn't started. Returns a canceller so callers can
  // stop waiting once they're no longer the current view.
  const onGuideReady = (cb) => {
    if (guideChannelsCache) { cb(); return () => {}; }
    startGuideChannelsFetch();
    const poll = setInterval(() => {
      if (guideChannelsCache) { clearInterval(poll); cb(); }
    }, GUIDE_POLL_MS);
    return () => clearInterval(poll);
  };
  // Keeps the sidebar subscriptions list truthful immediately after a
  // subscribe/unsubscribe action succeeds, instead of waiting on a re-fetch.
  const updateGuideOnSubscribeChange = (channelId, isSubscribed, title, avatar) => {
    if (!guideChannelsCache) return;
    const idx = guideChannelsCache.findIndex((ch) => ch.browseId === channelId);
    if (isSubscribed) {
      if (idx !== -1 || !channelId || !title || !avatar) return;
      guideChannelsCache = [...guideChannelsCache, { browseId: channelId, title, avatar }];
    } else {
      if (idx === -1) return;
      guideChannelsCache = guideChannelsCache.filter((ch) => ch.browseId !== channelId);
    }
    persistGuideCache();
    paintGuideChannels();
  };
  // The empty-array sentinel stops the onGuideReady polls and the refetch
  // loop, but it must not read as "authoritatively zero subscriptions" —
  // guideChannelsFailed marks it as a give-up so subscribedByGuide answers
  // "unknown" (fall back to per-channel state) and the Following page says
  // "couldn't load" instead of "you're not following anything".
  const guideRetry = (delay) => {
    if (guideAttempts >= GUIDE_MAX_ATTEMPTS) {
      console.warn('[itube] guide channels unavailable after ' + guideAttempts + ' attempts');
      guideChannelsFailed = true;
      guideChannelsCache = [];
      return;
    }
    guideAttempts++;
    setTimeout(startGuideChannelsFetch, delay);
  };
  const startGuideChannelsFetch = () => {
    if (guideChannelsPromise || guideChannelsCache) return;
    if (!cfg()?.INNERTUBE_API_KEY && !collectGuideChannels(window.ytInitialGuideData).length) {
      if (Date.now() - guideWaitStart > GUIDE_MAX_WAIT) {
        console.warn('[itube] no INNERTUBE_API_KEY for guide after ' + GUIDE_MAX_WAIT + 'ms');
        guideChannelsFailed = true;
        guideChannelsCache = [];
        return;
      }
      setTimeout(startGuideChannelsFetch, GUIDE_POLL_MS);
      return;
    }
    guideChannelsPromise = fetchGuideChannels()
      .then((channels) => {
        guideChannelsPromise = null;
        if (!channels) { guideRetry(GUIDE_RETRY_MS * guideAttempts + GUIDE_RETRY_MS); return; }
        guideChannelsFailed = false;
        guideChannelsCache = channels;
        persistGuideCache();
        paintGuideChannels();
      })
      .catch((e) => {
        guideChannelsPromise = null;
        console.warn('[itube] guide channels fetch failed', e);
        guideRetry(GUIDE_RETRY_MS * guideAttempts + GUIDE_RETRY_MS);
      });
  };
  const renderGuideChannels = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderGuideChannels, { once: true });
      return;
    }
    if (guideChannelsCache) { paintGuideChannels(); return; }
    if (guideChannelsScheduled) return;
    guideChannelsScheduled = true;
    idle(startGuideChannelsFetch);
  };
  renderGuideChannels();
  idle(loadWlSet);

  const cmdkOverlay = document.createElement('div');
  cmdkOverlay.className = 'cmdk-overlay';
  const cmdkPanel = document.createElement('div');
  cmdkPanel.className = 'cmdk-panel';
  const cmdkInput = document.createElement('input');
  cmdkInput.type = 'text';
  cmdkInput.className = 'cmdk-input';
  cmdkInput.placeholder = 'Search subscriptions, pages, actions…';
  const cmdkList = document.createElement('div');
  cmdkList.className = 'cmdk-list';
  cmdkPanel.append(cmdkInput, cmdkList);
  cmdkOverlay.appendChild(cmdkPanel);
  root.appendChild(cmdkOverlay);

  let cmdkItems = [];
  let cmdkVisible = [];

  const buildCmdkItems = () => {
    /** @type {{type: string, label: string, kind: string, run?: () => void, href?: string, avatar?: string}[]} */
    const items = [];
    items.push({ type: 'action', label: 'Open Settings', kind: 'Action', run: () => { /** @type {HTMLElement} */ (document.querySelector('.nav-settings'))?.click(); } });
    for (const item of NAV_ITEMS) items.push({ type: 'nav', label: item.label, kind: 'Page', href: item.href });
    for (const ch of guideChannelsCache || []) {
      items.push({ type: 'channel', label: ch.title, kind: 'Channel', href: '/channel/' + encodeURIComponent(ch.browseId), avatar: ch.avatar });
    }
    return items;
  };

  const cmdkMatchTier = (query, label) => {
    if (!query) return 3;
    const q = query.toLowerCase();
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 0;
    if (l.includes(q)) return 1;
    let qi = 0;
    for (let li = 0; li < l.length && qi < q.length; li++) {
      if (l[li] === q[qi]) qi++;
    }
    return qi === q.length ? 2 : -1;
  };

  const CMDK_MAX_ROWS = 20;

  const cmdkFilter = (query) => {
    const ranked = [];
    cmdkItems.forEach((item, idx) => {
      const tier = cmdkMatchTier(query, item.label);
      if (tier >= 0) ranked.push({ item, tier, idx });
    });
    ranked.sort((a, b) => (a.tier - b.tier) || (a.idx - b.idx));
    return ranked.slice(0, CMDK_MAX_ROWS).map((r) => r.item);
  };

  const cmdkKindIcon = (item) => {
    if (item.avatar) {
      const img = document.createElement('img');
      img.src = item.avatar;
      img.setAttribute('loading', 'lazy');
      return img;
    }
    return null;
  };

  const activateCmdkItem = (item) => {
    if (!item) return;
    closeCmdk();
    if (item.run) item.run();
    else if (item.href) { history.pushState({}, '', item.href); spaRoute(); }
  };

  const renderCmdkList = () => {
    const rows = cmdkVisible.map((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cmdk-item' + (i === 0 ? ' selected' : '');
      const av = cmdkKindIcon(item);
      if (av) row.appendChild(av);
      const label = document.createElement('span');
      label.className = 'cmdk-item-label';
      label.textContent = item.label;
      row.appendChild(label);
      // "PAGE" on every row is noise — the palette is mostly pages, so the
      // label only says anything when a row is something else (an action, a
      // channel). Repeating the majority case just adds a column of grey.
      if (item.kind && item.kind !== 'Page') {
        const kind = document.createElement('span');
        kind.className = 'cmdk-item-kind';
        kind.textContent = item.kind;
        row.appendChild(kind);
      }
      row.addEventListener('click', () => activateCmdkItem(item));
      return row;
    });
    cmdkList.replaceChildren(...rows);
  };

  const cmdkSelectedIndex = () => {
    const rows = cmdkList.querySelectorAll('.cmdk-item');
    for (let i = 0; i < rows.length; i++) if (rows[i].classList.contains('selected')) return i;
    return -1;
  };

  const cmdkMoveSelection = (delta) => {
    const rows = cmdkList.querySelectorAll('.cmdk-item');
    if (!rows.length) return;
    let i = cmdkSelectedIndex();
    if (i >= 0) rows[i].classList.remove('selected');
    i = (i + delta + rows.length) % rows.length;
    rows[i].classList.add('selected');
    rows[i].scrollIntoView({ block: 'nearest' });
  };

  const cmdkWire = wireOverlay(cmdkOverlay, cmdkPanel);
  const openPalette = () => {
    cmdkItems = buildCmdkItems();
    cmdkInput.value = '';
    cmdkVisible = cmdkFilter('');
    renderCmdkList();
    cmdkWire.open();
    cmdkInput.focus();
  };
  const closeCmdk = () => cmdkWire.close();

  cmdkInput.addEventListener('input', () => {
    cmdkVisible = cmdkFilter(cmdkInput.value);
    renderCmdkList();
  });
  cmdkInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMoveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMoveSelection(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activateCmdkItem(cmdkVisible[cmdkSelectedIndex()]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); openPalette(); return; }
    // Cmd-, is the macOS-wide Preferences shortcut. Nothing on youtube.com
    // claims it, and an app that renders its own chrome should answer it.
    if (e.key === ',') { e.preventDefault(); openSettings(); }
  }, true);

  const syncNav = () => {
    for (const item of NAV_ITEMS) {
      const row = navRows[item.key];
      if (!row) continue;
      let active = false;
      try {
        const url = new URL(item.href || '/', location.origin);
        active = location.pathname === url.pathname
          && (url.search === '' || new URLSearchParams(location.search).get('list') === new URLSearchParams(url.search).get('list'));
      } catch (e) {
        active = false;
      }
      row.classList.toggle('active', active);
    }
  };

  const content = document.createElement('div');
  content.className = 'content';
  const view = document.createElement('div');
  content.appendChild(view);

  // ---- Watch Later quick-save on cards -----------------------------------
  // One shared button, delegated from the content root: created once and
  // moved into whichever card thumb the pointer is over. Keeps the grid's
  // DOM flat (no extra node per card, no per-card listeners).
  const wlQuick = document.createElement('button');
  wlQuick.type = 'button';
  wlQuick.className = 'wl-quick';
  wlQuick.appendChild(ICONS.later());
  let wlQuickId = null;
  let wlQuickBusy = false;
  const wlQuickSync = () => {
    const inWl = wlHas(wlQuickId) === true;
    wlQuick.classList.toggle('active', inWl);
    wlQuick.title = inWl ? 'Remove from Watch later' : 'Watch later';
    wlQuick.setAttribute('aria-label', wlQuick.title);
  };
  const videoIdFromCard = (card) => {
    const href = card.querySelector('.c-link, .row-link, .rc-link')?.getAttribute('href') || '';
    const m = href.match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  };

  // ---- "Less of this" cluster on cards -----------------------------------
  // Three shared hover buttons in one cluster, same one-node-for-the-whole-
  // grid trick as Watch Later: not this VIDEO, not this CHANNEL's
  // recommendations, and drop the subscription. Each one appears only when
  // it can actually do something — the first two need their feedback token,
  // and unfollow needs the guide to confirm you follow the channel at all.
  //
  // Feedback is gated on the card CARRYING tokens rather than on being signed
  // in: logged-out payloads ship none at all, so token presence is the honest
  // precondition (and it is the one the test can drive).
  const qaBtn = (cls, iconFn, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qa-btn ' + cls;
    b.appendChild(iconFn());
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  };
  const qa = document.createElement('div');
  qa.className = 'qa';
  const nrQuick = qaBtn('nr-quick', ICONS.close, 'Not interested');
  const dncQuick = qaBtn('dnc-quick', ICONS.block, "Don't recommend this channel");
  const unfQuick = qaBtn('unf-quick', ICONS.unfollow, 'Unfollow this channel');
  let qaCard = null;
  let qaBusy = false;

  let hoverCard = null;
  const detachQuick = () => {
    wlQuick.remove();
    qa.remove();
    qa.replaceChildren();
    wlQuickId = null;
    qaCard = null;
    hoverCard = null;
  };
  content.addEventListener('pointerover', (e) => {
    if (loggedOut() && !anyCardFeedback) return;
    const card = /** @type {Element} */ (e.target).closest?.('.c, .row, .rc');
    if (card === hoverCard) return;
    detachQuick();
    if (!card) return;
    const thumb = card.querySelector('.c-thumb, .row-thumb, .rc-thumb');
    if (!thumb) return;
    hoverCard = card;
    const id = videoIdFromCard(card);
    if (id && !loggedOut()) {
      wlQuickId = id;
      wlQuickSync();
      thumb.appendChild(wlQuick);
      if (wlHas(id) === null) loadWlSet()?.then(() => { if (wlQuickId === id) wlQuickSync(); });
    }
    const act = cardActions.get(card);
    if (act) {
      qaCard = card;
      if (act.feedback?.video) qa.appendChild(nrQuick);
      if (act.feedback?.channel) qa.appendChild(dncQuick);
      // subscribedByGuide answers null while the guide is still loading or
      // gave up — only an explicit true offers Unfollow, so the button never
      // appears for a channel you don't actually follow.
      if (!loggedOut() && act.channelId && subscribedByGuide(act.channelId) === true) {
        unfQuick.title = 'Unfollow ' + (act.channel || 'this channel');
        unfQuick.setAttribute('aria-label', unfQuick.title);
        qa.appendChild(unfQuick);
      }
      if (qa.childElementCount) thumb.appendChild(qa);
      else qaCard = null;
    }
  });
  content.addEventListener('pointerleave', detachQuick);
  wlQuick.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (wlQuickBusy || !wlQuickId) return;
    wlQuickBusy = true;
    const id = wlQuickId;
    // Already confirm-first; this only adds the ring so the round trip is
    // visible on a hover button that otherwise looks inert while it waits.
    await runPending(wlQuick, async () => {
      const res = await wlToggle(id);
      if (res.ok && wlQuickId === id) wlQuickSync();
    });
    wlQuickBusy = false;
  });

  const sendFeedback = async (token) => {
    const res = await innertube('feedback', {
      feedbackTokens: [token],
      isFeedbackTokenUnencrypted: false,
      shouldMerge: false,
    });
    return Array.isArray(res?.feedbackResponses) && res.feedbackResponses.some((r) => r?.isProcessed);
  };

  // Fades the card out and detaches it, returning a handle so a failed
  // feedback call (or an Undo) can cancel a still-running exit instead of
  // having it yank the restored card back out from under the user.
  const dismissCard = (card) => {
    card.classList.add('nr-going');
    if (prefersReducedMotion()) { card.remove(); return null; }
    return afterTransition(card, 'opacity', CARD_DISMISS_MS + 200, () => card.remove());
  };

  // Shared by both dismissal buttons: they differ only in which token they
  // send and what the confirmation says.
  const runDismiss = async (card, entry, channelWide) => {
    if (qaBusy || !card || !entry) return;
    qaBusy = true;
    const id = videoIdFromCard(card);
    const parent = card.parentNode;
    const next = card.nextSibling;
    detachQuick();
    if (id) dismissedIds.add(id);
    // Optimistic: the card leaves on the click and comes back if the call
    // fails. Waiting out the round trip first would make every dismissal feel
    // like a dead button for a few hundred milliseconds.
    const exit = dismissCard(card);
    const restore = () => {
      if (exit) exit.cancel();
      card.classList.remove('nr-going');
      if (id) dismissedIds.delete(id);
      if (!parent || !parent.isConnected) return;
      const anchor = (next && next.parentNode === parent) ? next : parent.querySelector('.sentinel');
      if (anchor) parent.insertBefore(card, anchor);
      else parent.appendChild(card);
    };
    // finally, not a bare assignment: a rejection here would otherwise leave
    // the flag stuck on and wedge the whole cluster for the rest of the session.
    let ok = false;
    try {
      ok = await sendFeedback(entry.token);
    } finally {
      qaBusy = false;
    }
    if (!ok) {
      restore();
      showFbToast(channelWide ? 'Could not update that channel' : 'Could not remove that video', null);
      return;
    }
    showFbToast(
      channelWide ? "We won't recommend this channel" : 'Video removed',
      entry.undo ? { run: () => sendFeedback(entry.undo), restore } : null
    );
  };

  const qaClick = (btn, fn) => btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const card = qaCard;
    const act = card ? cardActions.get(card) : null;
    if (act) fn(card, act);
  });

  qaClick(nrQuick, (card, act) => runDismiss(card, act.feedback?.video, false));
  qaClick(dncQuick, (card, act) => runDismiss(card, act.feedback?.channel, true));

  // Unfollow deliberately leaves the card where it is. Dropping a subscription
  // is not a statement about THIS video, and silently vanishing the thing you
  // were looking at is a worse surprise than a row that stays put.
  qaClick(unfQuick, async (card, act) => {
    const channelId = act.channelId;
    if (qaBusy || !channelId) return;
    qaBusy = true;
    // Snapshot the guide entry BEFORE unsubscribing: putting the channel back
    // in the sidebar on Undo needs its title and avatar, and the guide cache
    // is the only place they exist.
    const prev = (guideChannelsCache || []).find((ch) => ch.browseId === channelId) || null;
    const name = prev?.title || act.channel || 'that channel';
    detachQuick();
    let ok = false;
    try {
      const res = await innertube('subscription/unsubscribe', { channelIds: [channelId], params: 'CgIIAg==' });
      ok = subscribeConfirmed(res, false);
    } finally {
      qaBusy = false;
    }
    if (!ok) { showFbToast('Could not unfollow ' + name, null); return; }
    updateGuideOnSubscribeChange(channelId, false);
    showFbToast('Unfollowed ' + name, {
      run: async () => {
        const res = await innertube('subscription/subscribe', { channelIds: [channelId], params: 'EgIIAg==' });
        const back = subscribeConfirmed(res, true);
        if (back) updateGuideOnSubscribeChange(channelId, true, prev?.title, prev?.avatar);
        return back;
      },
    });
  });

  const fbToast = document.createElement('div');
  fbToast.className = 'fb-toast';
  fbToast.setAttribute('role', 'status');
  const fbToastText = document.createElement('span');
  fbToastText.className = 'fb-toast-text';
  const fbToastUndo = document.createElement('button');
  fbToastUndo.type = 'button';
  fbToastUndo.className = 'fb-toast-undo';
  fbToastUndo.textContent = 'Undo';
  fbToast.append(fbToastText, fbToastUndo);

  let fbToastTimer = null;
  let fbUndo = null;
  const hideFbToast = () => {
    clearTimeout(fbToastTimer);
    fbToastTimer = null;
    fbUndo = null;
    fbToast.classList.remove('show');
  };
  function showFbToast(text, undo) {
    clearTimeout(fbToastTimer);
    fbUndo = undo || null;
    fbToastText.textContent = text;
    fbToastUndo.classList.toggle('hidden', !fbUndo);
    fbToast.classList.add('show');
    fbToastTimer = setTimeout(hideFbToast, FEEDBACK_UNDO_MS);
  }
  fbToastUndo.addEventListener('click', async () => {
    const undo = fbUndo;
    hideFbToast();
    if (!undo) return;
    if (undo.restore) undo.restore();
    // Any card is already back on screen. If the undo call did NOT land, say
    // so — otherwise the restored state implies the action was withdrawn when
    // YouTube still has it.
    if (!(await undo.run())) showFbToast('Could not undo that', null);
  });

  const body = document.createElement('div');
  body.className = 'body';
  body.append(nav, content);

  root.append(body, fbToast);

  const mini = document.createElement('div');
  mini.id = 'itube-mini';
  const miniBar = document.createElement('div');
  miniBar.className = 'mini-bar';
  const miniPlay = document.createElement('button');
  miniPlay.className = 'mini-play';
  miniPlay.type = 'button';
  miniPlay.appendChild(ICONS.pause());
  const miniExpand = document.createElement('button');
  miniExpand.className = 'mini-expand';
  miniExpand.type = 'button';
  miniExpand.appendChild(ICONS.expand());
  const miniClose = document.createElement('button');
  miniClose.className = 'mini-close';
  miniClose.type = 'button';
  miniClose.appendChild(ICONS.close());
  miniBar.append(miniPlay, miniExpand, miniClose);
  mini.appendChild(miniBar);
  root.appendChild(mini);

  let miniActive = false;
  let miniVideoId = null;
  let miniDismissed = false;
  let miniVideoEl = null;
  let expandFromMini = false;
  let miniFlying = false;

  const syncMiniPlayIcon = () => {
    miniPlay.replaceChildren(miniVideoEl && miniVideoEl.paused ? ICONS.play() : ICONS.pause());
  };
  const onMiniPlay = () => syncMiniPlayIcon();
  const onMiniPause = () => syncMiniPlayIcon();

  const activateMini = (video, videoId) => {
    if (miniVideoEl && miniVideoEl !== video) {
      miniVideoEl.removeEventListener('play', onMiniPlay);
      miniVideoEl.removeEventListener('pause', onMiniPause);
    }
    miniVideoEl = video;
    video.addEventListener('play', onMiniPlay);
    video.addEventListener('pause', onMiniPause);
    if (video.parentElement !== mini) mini.insertBefore(video, mini.firstChild);
    mini.style.display = 'block';
    miniActive = true;
    miniVideoId = videoId;
    // The player is live again, so ytd-app has to be rendered again — see the
    // body.flyt-yt-dormant rule.
    syncYtDormant();
    video.play().catch(() => {});
    syncMiniPlayIcon();
  };

  const deactivateMini = () => {
    if (miniVideoEl) {
      miniVideoEl.removeEventListener('play', onMiniPlay);
      miniVideoEl.removeEventListener('pause', onMiniPause);
      miniVideoEl = null;
    }
    miniActive = false;
    mini.style.display = 'none';
    syncYtDormant();
  };

  const closeMini = () => {
    if (miniFlying) return;
    if (miniVideoEl) {
      miniVideoEl.pause();
      const moviePlayer = player();
      if (moviePlayer) moviePlayer.appendChild(miniVideoEl);
    }
    deactivateMini();
    miniDismissed = true;
  };

  const expandMini = () => {
    if (!miniVideoId) return;
    expandFromMini = true;
    watchNav(miniVideoId);
  };

  miniPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!miniVideoEl) return;
    if (miniVideoEl.paused) miniVideoEl.play().catch(() => {});
    else miniVideoEl.pause();
  });
  miniExpand.addEventListener('click', (e) => {
    e.stopPropagation();
    expandMini();
  });
  miniClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMini();
  });

  // Drag moves the box with `transform` and commits real geometry ONCE on
  // drop. Writing left/top on every pointermove re-positions and repaints the
  // box every frame for the whole gesture — the same layout-property animation
  // the motion policy rules out everywhere else — while a transform is
  // compositor-only. The clamp is unchanged, just applied in the same space
  // before being expressed as an offset.
  let miniDrag = null;
  const clampMiniInto = (left, top, w, h) => ({
    left: Math.max(0, Math.min(window.innerWidth - w, left)),
    top: Math.max(0, Math.min(window.innerHeight - h, top)),
  });
  mini.addEventListener('pointerdown', (e) => {
    if (/** @type {Element} */ (e.target).closest('button')) return;
    if (miniFlying) return;
    const rect = mini.getBoundingClientRect();
    miniDrag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height, moved: false, to: null };
    // Clear any transition the fly animation may have left behind, or the drag
    // would lag a frame behind the pointer.
    mini.style.transition = '';
    mini.setPointerCapture(e.pointerId);
  });
  mini.addEventListener('pointermove', (e) => {
    if (!miniDrag) return;
    const dx = e.clientX - miniDrag.startX;
    const dy = e.clientY - miniDrag.startY;
    if (!miniDrag.moved && Math.hypot(dx, dy) < 5) return;
    miniDrag.moved = true;
    const to = clampMiniInto(miniDrag.left + dx, miniDrag.top + dy, miniDrag.w, miniDrag.h);
    miniDrag.to = to;
    mini.style.transform = 'translate(' + (to.left - miniDrag.left) + 'px, ' + (to.top - miniDrag.top) + 'px)';
  });
  const endMiniDrag = (e) => {
    if (!miniDrag) return;
    const { moved, to } = miniDrag;
    miniDrag = null;
    if (moved && to) {
      // Commit to real geometry and drop the transform: the fly-to-stage
      // animation owns `transform`, so leaving a drag offset on it would
      // compose with the fly and send the box to the wrong place.
      mini.style.transform = '';
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
      mini.style.left = to.left + 'px';
      mini.style.top = to.top + 'px';
    }
    if (!moved && !e.target.closest('button')) expandMini();
  };
  mini.addEventListener('pointerup', endMiniDrag);
  // A cancelled gesture reverts rather than commits — dropping the transform
  // puts the box back where it started.
  mini.addEventListener('pointercancel', () => { miniDrag = null; mini.style.transform = ''; });

  // A dragged mini is positioned in absolute px, so shrinking the window left
  // it partly or entirely outside the viewport with no way to reach it again.
  // Re-clamp on resize, but only once it has actually been dragged — until
  // then it sits on its CSS right/bottom corner and follows the viewport by
  // itself.
  window.addEventListener('resize', () => {
    if (!miniActive || miniDrag) return;
    const left = parseFloat(mini.style.left);
    const top = parseFloat(mini.style.top);
    if (!isFinite(left) || !isFinite(top)) return;
    const rect = mini.getBoundingClientRect();
    const to = clampMiniInto(left, top, rect.width, rect.height);
    mini.style.left = to.left + 'px';
    mini.style.top = to.top + 'px';
  });

  const mountRoot = () => {
    if (!document.body) { setTimeout(mountRoot, 0); return; }
    document.body.appendChild(root);
    // Theme before accent: applyTheme sets the .light class that setAccent
    // reads to decide whether --accent needs darkening, and calls it for us.
    applyTheme(themeMode(), false);
    if (lsGet('itube-reduce-motion') === '1') root.classList.add('itube-reduce-motion');
  };
  mountRoot();

  let lastScroll = 0;
  content.addEventListener('scroll', () => { lastScroll = Date.now(); }, { passive: true });
  let spaNav = false;
  // Latches once any SPA navigation happens: window.ytInitialData stops being
  // "the payload for the current pathname" the moment the router first moves.
  let hadSpaNav = false;

  const LIST_CACHE_MAX = 8;
  const listCache = new Map();
  const touchListCache = (key, entry) => {
    listCache.delete(key);
    listCache.set(key, entry);
    while (listCache.size > LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value);
  };
  const takeListCache = (key) => {
    const entry = listCache.get(key);
    if (entry) touchListCache(key, entry);
    return entry || null;
  };
  let activeListCache = null;
  let popNav = false;

  const createListView = ({ itemClass, containerClass, renderItem, fetchInitial, fetchMore, emptyMessage, eagerFirst = 0 }) => {
    const container = document.createElement('div');
    container.className = containerClass;
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.textContent = 'Loading…';
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    container.append(sentinel);

    const seen = new Set();
    let token = null;
    let loading = false;
    let appendScheduled = false;
    let pendingItems = null;
    let generation = 0;
    let capturedItems = [];
    // How many items have been rendered since the last clear(), so only the
    // first screenful of a fresh list gets eager thumbnails — a continuation
    // appended 40 cards down must not claim high fetch priority.
    let renderedCount = 0;

    const MAX_ITEMS = 200;
    const remember = (items) => {
      capturedItems = capturedItems.concat(items);
      if (capturedItems.length > MAX_ITEMS) capturedItems = capturedItems.slice(-MAX_ITEMS);
    };
    const cap = () => {
      const items = container.querySelectorAll('.' + itemClass);
      const excess = items.length - MAX_ITEMS;
      if (excess <= 0) return;
      const heightBefore = container.getBoundingClientRect().height;
      for (let i = 0; i < excess; i++) items[i].remove();
      const heightAfter = container.getBoundingClientRect().height;
      const removedHeight = heightBefore - heightAfter;
      let spacer = /** @type {HTMLElement} */ (container.querySelector('.spacer'));
      if (!spacer) {
        spacer = document.createElement('div');
        spacer.className = 'spacer';
        container.insertBefore(spacer, container.firstChild);
      }
      const current = parseFloat(spacer.style.height) || 0;
      spacer.style.height = (current + removedHeight) + 'px';
    };

    // One insertion for the whole batch, not one per card. Inserting N cards
    // individually invalidates layout N times; a fragment is a single
    // structural mutation, so a 30-item continuation costs one layout pass
    // instead of thirty. A fully-filtered batch touches the DOM not at all.
    const insertBatch = (items) => {
      const frag = document.createDocumentFragment();
      let n = 0;
      for (const item of items) {
        if (isFeedFiltered(item)) continue;
        frag.appendChild(renderItem(item, renderedCount < eagerFirst));
        renderedCount++;
        n++;
      }
      if (n) container.insertBefore(frag, sentinel);
      return n;
    };

    const appendItems = (items) => {
      remember(items);
      insertBatch(items);
      cap();
    };

    const tryAppend = () => {
      appendScheduled = false;
      if (Date.now() - lastScroll < 200) {
        appendScheduled = true;
        setTimeout(tryAppend, 200);
        return;
      }
      const items = pendingItems;
      pendingItems = null;
      if (items) appendItems(items);
    };
    const scheduleAppend = (items) => {
      pendingItems = pendingItems ? pendingItems.concat(items) : items;
      if (appendScheduled) return;
      appendScheduled = true;
      soon(tryAppend);
    };

    const showEmpty = (msg) => {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = msg;
      container.replaceChildren(empty);
    };

    const SKELETON_COUNT = 8;
    const skeletonClass = itemClass === 'row' ? 'row-skel' : 'c-skel';
    const makeSkeleton = itemClass === 'row' ? createRowSkeleton : createCardSkeleton;
    const clearSkeleton = () => {
      for (const n of container.querySelectorAll('.' + skeletonClass)) n.remove();
    };
    const showSkeleton = () => {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < SKELETON_COUNT; i++) frag.appendChild(makeSkeleton());
      container.insertBefore(frag, sentinel);
    };

    const clear = () => {
      for (const n of container.querySelectorAll('.' + itemClass)) n.remove();
      clearSkeleton();
      const spacer = container.querySelector('.spacer');
      if (spacer) spacer.remove();
      for (const n of container.querySelectorAll('.empty')) n.remove();
      pendingItems = null;
      renderedCount = 0;
      if (sentinel.parentNode !== container || sentinel !== container.lastChild) container.append(sentinel);
    };

    const loadMore = async () => {
      if (loading || !token) return;
      const gen = generation;
      loading = true;
      spinner.classList.add('show');
      try {
        const res = await fetchMore(token, seen);
        if (gen !== generation) return;
        if (!res) return;
        token = res.token;
        scheduleAppend(res.items);
      } finally {
        if (gen === generation) {
          loading = false;
          spinner.classList.remove('show');
        }
      }
    };

    const IO_ROOT_MARGIN = 600;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { root: content, rootMargin: IO_ROOT_MARGIN + 'px' });
    io.observe(sentinel);

    const load = async (fetchFn) => {
      const gen = ++generation;
      seen.clear();
      token = null;
      capturedItems = [];
      clear();
      showSkeleton();
      loading = true;
      spinner.classList.add('show');
      try {
        const res = await fetchFn(seen);
        if (gen !== generation) return;
        clearSkeleton();
        if (res && res.signIn) {
          container.replaceChildren(createSignInBlock(res.signIn));
          return;
        }
        if (!res || (res.items.length === 0 && !res.token)) {
          showEmpty((res && res.message) || emptyMessage);
          return;
        }
        token = res.token;
        remember(res.items);
        insertBatch(res.items);
      } catch (e) {
        if (gen === generation) {
          clearSkeleton();
          showEmpty(emptyMessage);
        }
      } finally {
        if (gen === generation) {
          loading = false;
          spinner.classList.remove('show');
        }
      }
    };

    const loadInitial = () => load(fetchInitial);

    const RESTORE_CHUNK = 24;
    const restoreFromCache = (entry) => {
      const gen = ++generation;
      seen.clear();
      clear();
      capturedItems = entry.items.slice();
      token = entry.token;
      for (const it of capturedItems) seen.add(it.id);
      loading = false;
      spinner.classList.remove('show');
      if (!capturedItems.length) { showEmpty(emptyMessage); return; }
      let i = 0;
      const renderSlice = () => {
        const slice = capturedItems.slice(i, i + RESTORE_CHUNK);
        i += RESTORE_CHUNK;
        insertBatch(slice);
      };
      const target = entry.scrollTop || 0;
      // clientHeight is read ONCE: it cannot change while this loop only
      // appends into an already-scrolling pane, and re-reading it after each
      // chunk's writes forced a fresh layout every iteration.
      const viewportH = content.clientHeight;
      const prefetchTo = target + viewportH + IO_ROOT_MARGIN;
      while (i < capturedItems.length && content.scrollHeight - viewportH < prefetchTo) renderSlice();
      cap();
      content.scrollTop = target;
      if (i < capturedItems.length) {
        const pump = async () => {
          while (gen === generation && i < capturedItems.length) {
            renderSlice();
            cap();
            await yieldTask();
          }
        };
        soon(pump);
      }
    };
    const getState = () => ({ items: capturedItems.slice(), token });

    return { container, spinner, seen, loadInitial, load, showEmpty, cleanup: () => io.disconnect(), getState, restoreFromCache };
  };

  const HOME_SIGNED_OUT = { title: 'Try searching to get started', message: 'Sign in to build a feed of videos you’ll love.' };
  const WATCH_LATER_SIGNED_OUT = { title: 'Enjoy your favorite videos', message: 'Sign in to access videos that you’ve saved to Watch later.' };
  const PLAYLISTS_SIGNED_OUT = { title: 'Keep your collections handy', message: 'Sign in to see your playlists.' };

  const mountHome = (cacheEntry) => {
    const heading = document.createElement('h2');
    heading.className = 'section-heading';
    heading.textContent = 'Recommended';
    heading.style.display = 'none';

    let cwItems = [];
    // Per-mount, so the channel tally resets when you leave and come back
    // rather than persisting for the life of the tab.
    const rankState = newRankState();
    const renderContinueWatching = (resumeItems) => {
      if (!resumeItems.length) return;
      // Bail if home is no longer mounted. This runs from inside fetchInitial,
      // i.e. after an await, so a navigation can land first — and then
      // `heading` is detached and insertBefore(…, heading) throws
      // NotFoundError, which load()'s catch swallows into "Nothing here yet."
      if (heading.parentNode !== view) return;
      const cwHeading = document.createElement('h2');
      cwHeading.className = 'section-heading';
      cwHeading.textContent = 'Continue watching';
      const cwGrid = document.createElement('div');
      cwGrid.className = 'grid';
      // Continue watching sits ABOVE the recommended grid, so when it exists
      // its first row is the real above-the-fold content — eager applies here
      // rather than only to the list below it.
      let n = 0;
      for (const it of resumeItems) {
        if (isFeedFiltered(it)) continue;
        cwGrid.appendChild(createCard(it, n < EAGER_THUMBS));
        n++;
      }
      // One insertion, not two: a fragment keeps the heading and its grid a
      // single structural mutation of the live view.
      const frag = document.createDocumentFragment();
      frag.append(cwHeading, cwGrid);
      view.insertBefore(frag, heading);
    };

    const list = createListView({
      itemClass: 'c',
      containerClass: 'grid',
      renderItem: createCard,
      // Home is the ONLY surface that re-ranks. Subscriptions stays purely
      // chronological (sortByRecency in mountFeed), search is left alone
      // because the user stated an intent, and the watch rail is untouched
      // because its first card is what autoplay actually plays — reordering
      // it would silently change playback, not just presentation.
      fetchMore: continuationFetcher('browse', (res, seen) => rankBatch(extractVideos(res, seen, thumbTarget(GRID_THUMB_W)), rankState)),
      fetchInitial: async (seen) => {
        let data = spaNav ? null : window.ytInitialData;
        if (!data) data = await innertube('browse', { browseId: 'FEwhat_to_watch' });
        if (!data) return null;
        const resumeItems = extractResumeItems(data, new Set(), thumbTarget(GRID_THUMB_W));
        for (const it of resumeItems) seen.add(it.id);
        cwItems = resumeItems;
        renderContinueWatching(resumeItems);
        const items = rankBatch(extractVideos(data, seen, thumbTarget(GRID_THUMB_W)), rankState);
        heading.style.display = items.length ? '' : 'none';
        if (!items.length && !resumeItems.length && loggedOut()) {
          const prompt = feedSignInPrompt(data) || feedNudgePrompt(data) || HOME_SIGNED_OUT;
          return { items: [], token: null, signIn: prompt };
        }
        return { items, token: findContinuationToken(data) };
      },
      emptyMessage: 'Nothing here yet.',
      eagerFirst: EAGER_THUMBS,
    });

    view.replaceChildren(heading, list.container, list.spinner);
    if (cacheEntry) {
      cwItems = cacheEntry.resumeItems || [];
      renderContinueWatching(cwItems);
      heading.style.display = cacheEntry.items.length ? '' : 'none';
      whenReady(() => {
        list.restoreFromCache(cacheEntry);
        for (const it of cwItems) list.seen.add(it.id);
      });
    } else {
      whenReady(() => list.loadInitial());
    }
    activeListCache = { getState: () => ({ ...list.getState(), resumeItems: cwItems }) };

    return list.cleanup;
  };

  const SEARCH_SORT_OPTIONS = [
    ['', 'Sort by: Relevance'],
    ['CAISAhAB', 'Sort by: Upload date'],
    ['CAMSAhAB', 'Sort by: View count'],
    ['CAESAhAB', 'Sort by: Rating'],
  ];
  const SEARCH_DATE_OPTIONS = [
    ['', 'Upload date: Any'],
    ['EgQIARAB', 'Upload date: Last hour'],
    ['EgQIAhAB', 'Upload date: Today'],
    ['EgQIAxAB', 'Upload date: This week'],
    ['EgQIBBAB', 'Upload date: This month'],
    ['EgQIBRAB', 'Upload date: This year'],
  ];
  const SEARCH_DURATION_OPTIONS = [
    ['', 'Duration: Any'],
    ['EgQQARgB', 'Duration: Under 4 min'],
    ['EgQQARgD', 'Duration: 4-20 min'],
    ['EgQQARgC', 'Duration: Over 20 min'],
  ];

  const mountSearch = (cacheEntry) => {
    const query = new URLSearchParams(location.search).get('search_query') || '';
    search.value = query;

    let activeFilter = null;
    let usedInitialData = false;

    const spParam = new URLSearchParams(location.search).get('sp') || '';

    const fetchSearch = async (seen) => {
      if (!query) return { items: [], token: null, message: 'Type something to search.' };
      if (!spaNav && !usedInitialData) {
        usedInitialData = true;
        const data = window.ytInitialData;
        if (data) {
          const items = extractVideos(data, seen, thumbTarget(ROW_THUMB_W));
          if (items.length) return { items, token: findContinuationToken(data), message: 'No results for "' + query + '"' };
        }
      }
      const body = activeFilter ? { query, params: activeFilter.value } : { query };
      const res = await innertube('search', body);
      if (!res) return { items: [], token: null, message: 'Something went wrong.' };
      return { items: extractVideos(res, seen, thumbTarget(ROW_THUMB_W)), token: findContinuationToken(res), message: 'No results for "' + query + '"' };
    };

    const list = createListView({
      itemClass: 'row',
      containerClass: 'list',
      renderItem: createRowCard,
      // Every other view passes this and search did not. Two paths read it with
      // no fallback — the fetch-threw path and a back/forward restore that
      // captured nothing — and both rendered an empty-state box with no text
      // at all, because textContent = undefined is the empty string.
      emptyMessage: 'No results for "' + query + '"',
      fetchInitial: fetchSearch,
      fetchMore: continuationFetcher('search', (res, seen) => extractVideos(res, seen, thumbTarget(ROW_THUMB_W))),
      eagerFirst: EAGER_THUMBS,
    });

    const makeFilterSelect = (options) => {
      const sel = document.createElement('select');
      sel.className = 'search-filter-select';
      for (const [value, label] of options) sel.appendChild(new Option(label, value));
      return sel;
    };
    const sortSelect = makeFilterSelect(SEARCH_SORT_OPTIONS);
    const dateSelect = makeFilterSelect(SEARCH_DATE_OPTIONS);
    const durSelect = makeFilterSelect(SEARCH_DURATION_OPTIONS);
    const filterRow = document.createElement('div');
    filterRow.className = 'search-filters';
    filterRow.append(sortSelect, dateSelect, durSelect);

    if (spParam) {
      /** @type {[HTMLSelectElement, string[][]][]} */
      const filterPairs = [[sortSelect, SEARCH_SORT_OPTIONS], [dateSelect, SEARCH_DATE_OPTIONS], [durSelect, SEARCH_DURATION_OPTIONS]];
      for (const [select, options] of filterPairs) {
        if (options.some(([value]) => value === spParam)) {
          select.value = spParam;
          activeFilter = { select, value: spParam };
          break;
        }
      }
    }

    const onFilterChange = (select) => {
      if (select.value === '') {
        if (activeFilter?.select === select) activeFilter = null;
      } else {
        activeFilter = { select, value: select.value };
        for (const s of [sortSelect, dateSelect, durSelect]) if (s !== select) s.value = '';
      }
      const params = new URLSearchParams(location.search);
      if (activeFilter) params.set('sp', activeFilter.value);
      else params.delete('sp');
      const qs = params.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : ''));
      currentKey = keyFor('search', location.pathname, location.search);
      list.load(fetchSearch);
    };
    sortSelect.addEventListener('change', () => onFilterChange(sortSelect));
    dateSelect.addEventListener('change', () => onFilterChange(dateSelect));
    durSelect.addEventListener('change', () => onFilterChange(durSelect));

    if (query) {
      const label = document.createElement('div');
      label.className = 'search-label';
      label.textContent = 'Results for';
      const queryHeading = document.createElement('h1');
      queryHeading.className = 'search-query';
      queryHeading.textContent = query;
      view.replaceChildren(label, queryHeading, filterRow, list.container, list.spinner);
    } else {
      view.replaceChildren(list.container, list.spinner);
    }

    if (cacheEntry) whenReady(() => list.restoreFromCache(cacheEntry));
    else whenReady(() => list.loadInitial());
    activeListCache = { getState: list.getState };

    return list.cleanup;
  };

  const mountChannel = () => {
    let cancelled = false;
    let stopGuideWait = null;
    const CHANNEL_ID_IN_PATH_RE = /^\/channel\/([^/]+)/;
    const resolveBrowseId = async () => {
      const m = location.pathname.match(CHANNEL_ID_IN_PATH_RE);
      if (m) return m[1];
      if (!spaNav) {
        const data = window.ytInitialData;
        const metaNode = findNode(data, (n) => typeof n?.metadata?.channelMetadataRenderer?.externalId === 'string');
        if (metaNode) return metaNode.metadata.channelMetadataRenderer.externalId;
        const idNode = findNode(data, (n) => typeof n?.browseId === 'string' && n.browseId.startsWith('UC'));
        if (idNode) return idNode.browseId;
      }
      const resolved = await innertube('navigation/resolve_url', { url: location.href });
      return resolved?.endpoint?.browseEndpoint?.browseId || null;
    };

    const showEmpty = (msg) => {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = msg;
      view.replaceChildren(empty);
    };

    const header = document.createElement('div');
    header.className = 'ch-header';

    const thumbFrom = (node) => {
      const thumbs = node?.thumbnails;
      if (Array.isArray(thumbs) && thumbs.length) return thumbs[thumbs.length - 1]?.url || null;
      return getThumb(node);
    };

    let browseId = null;
    const tabParams = (want) => findTabParams(window.ytInitialData, want);

    const CHANNEL_TABS = ['videos', 'playlists', 'about'];
    const tabFromPath = () => {
      const seg = location.pathname.replace(/\/+$/, '').split('/').pop();
      return CHANNEL_TABS.includes(seg) ? seg : 'videos';
    };
    const channelBase = () => {
      const m = location.pathname.match(/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
      return m ? m[0] : location.pathname;
    };

    let activeTab = tabFromPath();
    const tabBtns = {};
    const aboutEl = document.createElement('div');
    aboutEl.className = 'ch-about';
    let aboutLoaded = false;

    let ownerName = '';
    const fillOwner = (items) => {
      for (const item of items) {
        if (item.channelHref) continue;
        item.channelHref = channelBase();
        if (!item.channel) item.channel = ownerName;
      }
      return items;
    };

    const list = createListView({
      itemClass: 'c',
      containerClass: 'grid',
      renderItem: createCard,
      fetchMore: continuationFetcher('browse', (res, seen) => {
        const extractor = activeTab === 'playlists' ? extractPlaylists : extractVideos;
        return fillOwner(extractor(res, seen, thumbTarget(GRID_THUMB_W)));
      }),
      fetchInitial: async (seen) => {
        const params = tabParams(activeTab);
        const res = await innertube('browse', params ? { browseId, params } : { browseId });
        if (!res) return null;
        paintHeader(res);
        const extractor = activeTab === 'playlists' ? extractPlaylists : extractVideos;
        return { items: fillOwner(extractor(res, seen, thumbTarget(GRID_THUMB_W))), token: findContinuationToken(res) };
      },
      emptyMessage: "Couldn't load this channel.",
      eagerFirst: EAGER_THUMBS,
    });

    let tabSwitching = false;
    const makeTabBtn = (key, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ch-tab';
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        if (activeTab === key || tabSwitching) return;
        activeTab = key;
        for (const k in tabBtns) tabBtns[k].classList.toggle('active', k === key);
        const href = channelBase() + (key === 'videos' ? '/videos' : '/' + key);
        history.pushState({}, '', href);
        setCurrentKey();
        tabSwitching = true;
        try {
          if (key === 'about') {
            view.replaceChildren(header, aboutEl);
            await loadAbout();
          } else {
            view.replaceChildren(header, list.container, list.spinner);
            await list.loadInitial();
          }
        } finally {
          tabSwitching = false;
        }
      });
      tabBtns[key] = btn;
      return btn;
    };

    let headerBuilt = false;
    const paintHeader = (res) => {
      if (cancelled || headerBuilt) return;
      const getHeaderRenderer = (data) => (
        findNode(data, (n) => n?.c4TabbedHeaderRenderer)?.c4TabbedHeaderRenderer
        || findNode(data, (n) => n?.pageHeaderRenderer)?.pageHeaderRenderer
        || null
      );
      const h = getHeaderRenderer(res);
      if (!h) return;
      headerBuilt = true;
      const imgFrom = (node) => {
        let best = null;
        walk(node, (n) => {
          if (best) return;
          const thumbs = Array.isArray(n.sources) ? n.sources : (Array.isArray(n.thumbnails) ? n.thumbnails : null);
          if (thumbs && thumbs.length) {
            const u = thumbs[thumbs.length - 1]?.url;
            if (u) best = u;
          }
        });
        return best;
      };
      const vm = h?.content?.pageHeaderViewModel;
      const metaTexts = [];
      walk(vm?.metadata, (n) => {
        if (typeof n.content === 'string' && n.content && n.content.length < 40) metaTexts.push(n.content);
      });
      const name = (typeof h?.title === 'string' ? h.title : null)
        || h?.title?.runs?.[0]?.text || h?.title?.simpleText
        || vm?.title?.dynamicTextViewModel?.text?.content || null;
      if (name) ownerName = name;
      const handle = h?.channelHandleText?.runs?.[0]?.text || h?.channelHandleText?.simpleText
        || metaTexts.find((t) => t.startsWith('@')) || null;
      const avatarUrl = thumbFrom(h?.avatar) || imgFrom(vm?.image);
      const subCount = h?.subscriberCountText?.simpleText || h?.subscriberCountText?.runs?.[0]?.text
        || metaTexts.find((t) => /subscriber/i.test(t)) || null;
      const videoCount = (h?.videosCountText?.runs || []).map((r) => r?.text || '').join('')
        || h?.videosCountText?.simpleText
        || metaTexts.find((t) => /video/i.test(t)) || null;
      const bannerUrl = thumbFrom(h?.banner) || imgFrom(vm?.banner);

      if (bannerUrl) {
        const banner = fadeInImg(bannerUrl);
        banner.className = 'ch-banner';
        header.appendChild(banner);
      }
      if (avatarUrl) {
        const avatar = fadeInImg(avatarUrl);
        avatar.className = 'ch-avatar';
        header.appendChild(avatar);
      }
      const nameEl = document.createElement('h1');
      nameEl.className = 'ch-name';
      nameEl.textContent = name || '';
      if (name) setTitle(name);
      const meta = document.createElement('div');
      meta.className = 'ch-meta';
      meta.textContent = [handle, subCount, videoCount].filter(Boolean).join(' · ');

      const titleRow = document.createElement('div');
      titleRow.className = 'ch-title-row';
      const titleCol = document.createElement('div');
      titleCol.className = 'ch-title-col';
      titleCol.append(nameEl, meta);

      const { btn: chSubscribeBtn, label: chSubscribeLabel } = pillButton(null, '', 'watch-subscribe');
      const chGuideState = subscribedByGuide(browseId);
      let chSubscribed = chGuideState === null ? readSubscribedState(res) : chGuideState;
      let chSubscribeBusy = false;
      const setChSubscribeUI = () => {
        chSubscribeBtn.replaceChildren();
        if (chSubscribed) chSubscribeBtn.appendChild(ICONS.check());
        chSubscribeBtn.appendChild(chSubscribeLabel);
        chSubscribeBtn.classList.toggle('subscribed', chSubscribed);
        chSubscribeBtn.setAttribute('aria-pressed', String(chSubscribed));
        chSubscribeLabel.textContent = chSubscribed ? 'Following' : 'Follow';
      };
      chSubscribeBtn.disabled = !browseId;
      setChSubscribeUI();
      if (chGuideState === null) {
        stopGuideWait = onGuideReady(() => {
          if (cancelled) return;
          const v = subscribedByGuide(browseId);
          if (v !== null) { chSubscribed = v; setChSubscribeUI(); }
        });
      }
      chSubscribeBtn.addEventListener('click', async () => {
        if (chSubscribeBtn.disabled || chSubscribeBusy || !browseId) return;
        chSubscribeBusy = true;
        const want = !chSubscribed;
        await runPending(chSubscribeBtn, async () => {
          const subRes = want
            ? await innertube('subscription/subscribe', { channelIds: [browseId], params: 'EgIIAg==' })
            : await innertube('subscription/unsubscribe', { channelIds: [browseId], params: 'CgIIAg==' });
          if (!subscribeConfirmed(subRes, want)) return;
          chSubscribed = want;
          setChSubscribeUI();
          updateGuideOnSubscribeChange(browseId, want, name || ownerName, avatarUrl);
        });
        chSubscribeBusy = false;
      });

      const { btn: chMuteBtn, label: chMuteLabel } = pillButton(null, '', 'watch-action-btn');
      const chMuteKey = normChannel(channelBase());
      const setChMuteUI = (muted) => {
        chMuteLabel.textContent = muted ? 'Muted' : 'Mute';
        chMuteBtn.classList.toggle('active', muted);
      };
      setChMuteUI(muteChannels.has(chMuteKey));
      chMuteBtn.addEventListener('click', () => {
        const list = mutedChannelsSet();
        const muted = list.has(chMuteKey);
        if (muted) list.delete(chMuteKey);
        else list.add(chMuteKey);
        lsSet('itube-mute-channels', JSON.stringify([...list]));
        refreshMuteState();
        setChMuteUI(!muted);
      });

      titleRow.append(titleCol, chSubscribeBtn, chMuteBtn);
      header.appendChild(titleRow);

      const tabsEl = document.createElement('div');
      tabsEl.className = 'ch-tabs';
      tabsEl.appendChild(makeTabBtn('videos', 'Videos'));
      if (tabParams('playlists') || activeTab === 'playlists') tabsEl.appendChild(makeTabBtn('playlists', 'Playlists'));
      tabsEl.appendChild(makeTabBtn('about', 'About'));
      (tabBtns[activeTab] || tabBtns.videos).classList.add('active');
      header.appendChild(tabsEl);
    };

    const asAboutText = (v) => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      return v.content || v.simpleText || (Array.isArray(v.runs) ? v.runs.map((r) => r?.text || '').join('') : '') || '';
    };

    const fetchAboutPage = async () => {
      try {
        const res = await fetch(channelBase() + '/about', { credentials: 'include' });
        if (!res.ok) return null;
        const html = await res.text();
        const marker = 'var ytInitialData = ';
        const start = html.indexOf(marker);
        if (start === -1) return null;
        const from = start + marker.length;
        let i = from;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let strCh = '';
        for (; i < html.length; i++) {
          const c = html[i];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === strCh) inStr = false;
            continue;
          }
          if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { i++; break; }
          }
        }
        return JSON.parse(html.slice(from, i));
      } catch (e) {
        console.warn('[itube] channel about fetch failed', e);
        return null;
      }
    };

    const extractAboutLinks = (links) => {
      if (!Array.isArray(links)) return [];
      const out = [];
      for (const entry of links) {
        const vm = entry?.channelExternalLinkViewModel;
        if (!vm) continue;
        const label = asAboutText(vm.title) || asAboutText(vm.link);
        if (!label) continue;
        const cmd = vm.link?.commandRuns?.[0]?.onTap?.innertubeCommand;
        const url = cmd?.commandMetadata?.webCommandMetadata?.url || cmd?.urlEndpoint?.url || null;
        out.push({ label, url });
      }
      return out;
    };

    const buildAboutContent = (vm) => {
      aboutEl.replaceChildren();
      if (!vm) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = "Couldn't load channel info.";
        aboutEl.appendChild(empty);
        return;
      }
      const description = asAboutText(vm.description);
      if (description) {
        const descEl = document.createElement('div');
        descEl.className = 'ch-about-desc';
        descEl.textContent = description;
        aboutEl.appendChild(descEl);
      }
      const stats = document.createElement('div');
      stats.className = 'ch-about-stats';
      const addRow = (label, value) => {
        if (!value) return;
        const row = document.createElement('div');
        row.className = 'ch-about-row';
        const strong = document.createElement('strong');
        strong.textContent = label;
        const span = document.createElement('span');
        span.textContent = value;
        row.append(strong, span);
        stats.appendChild(row);
      };
      addRow('Joined', asAboutText(vm.joinedDateText));
      addRow('Views', asAboutText(vm.viewCountText));
      addRow('Subscribers', asAboutText(vm.subscriberCountText));
      addRow('Country', asAboutText(vm.country));
      if (stats.childElementCount) aboutEl.appendChild(stats);
      const links = extractAboutLinks(vm.links);
      if (links.length) {
        const linksEl = document.createElement('div');
        linksEl.className = 'ch-about-links';
        for (const link of links) {
          if (!isHttpUrl(link.url)) continue;
          const a = document.createElement('a');
          a.className = 'ch-about-link';
          a.textContent = link.label;
          a.href = link.url;
          a.target = '_blank';
          a.rel = 'noopener';
          linksEl.appendChild(a);
        }
        if (linksEl.childElementCount) aboutEl.appendChild(linksEl);
      }
      if (!aboutEl.childElementCount) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No channel info available.';
        aboutEl.appendChild(empty);
      }
    };

    const loadAbout = async () => {
      if (aboutLoaded) return;
      const data = await fetchAboutPage();
      if (data) paintHeader(data);
      const vm = findNode(data, (n) => n?.aboutChannelViewModel)?.aboutChannelViewModel
        || findNode(data, (n) => n?.channelAboutFullMetadataRenderer)?.channelAboutFullMetadataRenderer
        || null;
      buildAboutContent(vm);
      if (vm) aboutLoaded = true;
    };

    whenReady(async () => {
      browseId = await resolveBrowseId();
      if (!browseId) {
        showEmpty("Couldn't load this channel.");
        return;
      }
      if (activeTab === 'about') {
        view.replaceChildren(header, aboutEl);
        await loadAbout();
      } else {
        view.replaceChildren(header, list.container, list.spinner);
        await list.loadInitial();
      }
    });

    return () => {
      cancelled = true;
      if (stopGuideWait) stopGuideWait();
      list.cleanup();
    };
  };

  const mountFeed = (browseIds, heading, opts = {}) => {
    const cacheEntry = opts.cacheEntry || null;
    const ids = Array.isArray(browseIds) ? browseIds : [browseIds];
    const useInitialData = !!opts.useInitialData;
    const listId = ids[0] && ids[0].startsWith('VL') ? ids[0].slice(2) : null;
    const isSubscriptions = ids.includes('FEsubscriptions');
    const extractOrdered = (res, seen) => {
      const items = extractVideos(res, seen, thumbTarget(GRID_THUMB_W));
      return isSubscriptions ? sortByRecency(items) : items;
    };

    const headingEl = document.createElement('h1');
    headingEl.className = 'page-heading';
    headingEl.textContent = heading;

    const setPlaylistTitle = (res) => {
      try {
        const node = findNode(res, (n) => n?.playlistHeaderRenderer)?.playlistHeaderRenderer;
        const title = node?.title?.runs?.[0]?.text || node?.title?.simpleText || node?.title?.content;
        if (title) headingEl.textContent = title;
      } catch (e) {
        console.warn('[itube] playlist title parse failed', e);
      }
    };

    const signedOutPrompt = (res) => (loggedOut() ? feedSignInPrompt(res) : null);

    const fetchFromApi = async (seen) => {
      for (const id of ids) {
        const res = await innertube('browse', { browseId: id });
        if (!res) {
          if (id === 'VLWL' && loggedOut()) return { items: [], token: null, signIn: WATCH_LATER_SIGNED_OUT };
          continue;
        }
        const prompt = signedOutPrompt(res);
        if (prompt) return { items: [], token: null, signIn: prompt };
        if (id.startsWith('VL')) setPlaylistTitle(res);
        const items = extractOrdered(res, seen);
        const token = findContinuationToken(res);
        if (items.length || token) return { items, token };
      }
      return null;
    };

    const list = createListView({
      itemClass: 'c',
      containerClass: 'grid',
      renderItem: listId ? (item, eager) => createCard({ ...item, listId }, eager) : createCard,
      fetchInitial: async (seen) => {
        if (useInitialData && !spaNav) {
          const pageData = window.ytInitialData;
          const prompt = signedOutPrompt(pageData);
          if (prompt) return { items: [], token: null, signIn: prompt };
          const initialItems = pageData ? extractOrdered(pageData, seen) : [];
          if (initialItems.length) {
            if (ids[0].startsWith('VL')) setPlaylistTitle(pageData);
            return { items: initialItems, token: findContinuationToken(pageData) };
          }
        }
        const result = await fetchFromApi(seen);
        return result || { items: [], token: null };
      },
      fetchMore: continuationFetcher('browse', extractOrdered),
      emptyMessage: 'Nothing here yet.',
      eagerFirst: EAGER_THUMBS,
    });

    view.replaceChildren(headingEl, list.container, list.spinner);
    if (cacheEntry) {
      if (cacheEntry.heading) headingEl.textContent = cacheEntry.heading;
      whenReady(() => list.restoreFromCache(cacheEntry));
    } else {
      whenReady(() => list.loadInitial());
    }
    activeListCache = { getState: () => ({ ...list.getState(), heading: headingEl.textContent }) };

    return list.cleanup;
  };

  // The Playlists library (/feed/playlists): the user's own playlists as a
  // grid of playlist tiles. Playlist PAGES already render through the generic
  // feed mount (VL<listId>); this page is just the index of them.
  const mountPlaylists = (cacheEntry) => {
    const headingEl = document.createElement('h1');
    headingEl.className = 'page-heading';
    headingEl.textContent = 'Playlists';

    const extract = (res, seen) => extractPlaylists(res, seen, thumbTarget(GRID_THUMB_W));

    const list = createListView({
      itemClass: 'c',
      containerClass: 'grid',
      renderItem: createCard,
      fetchInitial: async (seen) => {
        if (!spaNav) {
          const pageData = window.ytInitialData;
          const prompt = loggedOut() ? (feedSignInPrompt(pageData) || PLAYLISTS_SIGNED_OUT) : null;
          if (prompt) return { items: [], token: null, signIn: prompt };
          const initialItems = pageData ? extract(pageData, seen) : [];
          if (initialItems.length) return { items: initialItems, token: findContinuationToken(pageData) };
        }
        const res = await innertube('browse', { browseId: 'FEplaylists' });
        if (!res) return { items: [], token: null };
        if (loggedOut()) {
          return { items: [], token: null, signIn: feedSignInPrompt(res) || PLAYLISTS_SIGNED_OUT };
        }
        return { items: extract(res, seen), token: findContinuationToken(res) };
      },
      fetchMore: continuationFetcher('browse', extract),
      emptyMessage: 'No playlists yet.',
      eagerFirst: EAGER_THUMBS,
    });

    view.replaceChildren(headingEl, list.container, list.spinner);
    if (cacheEntry) whenReady(() => list.restoreFromCache(cacheEntry));
    else whenReady(() => list.loadInitial());
    activeListCache = { getState: () => ({ ...list.getState(), heading: headingEl.textContent }) };
    return list.cleanup;
  };

  const mountUnhandled = () => {
    const wrap = document.createElement('div');
    wrap.className = 'unhandled';
    const msg = document.createElement('div');
    msg.textContent = "This page isn't available in Flyt yet.";
    const home = document.createElement('a');
    home.className = 'unhandled-home';
    home.href = '/';
    home.textContent = 'Home';
    wrap.append(msg, home);
    view.replaceChildren(wrap);
    return () => {};
  };

  const extractChannelStats = (res) => {
    const h = findNode(res, (n) => n?.c4TabbedHeaderRenderer)?.c4TabbedHeaderRenderer
      || findNode(res, (n) => n?.pageHeaderRenderer)?.pageHeaderRenderer
      || null;
    if (!h) return { subsText: null, subsNum: null, videosText: null, videosNum: null };
    let subsText = h?.subscriberCountText?.simpleText || h?.subscriberCountText?.runs?.[0]?.text || null;
    let videosText = (h?.videosCountText?.runs || []).map((r) => r?.text || '').join('')
      || h?.videosCountText?.simpleText || null;
    if (subsText == null || videosText == null) {
      const metadataRows = [];
      walk(h?.content?.pageHeaderViewModel?.metadata, (n) => {
        if (Array.isArray(n.metadataParts)) metadataRows.push(n.metadataParts);
      });
      const numericParts = [];
      for (const parts of metadataRows) {
        for (const part of parts) {
          // A real subscriber/video count always STARTS with a digit
          // ("1,2 Mio. Abonnenten", "893 videos"); a handle like "@pal2tech"
          // or "@penguinz0" does not, even though parseCount() matches the
          // stray digit inside it — without the leading-digit guard, the
          // handle would win the filter and land in the Subscribers column
          // while the real count shifts into Videos.
          const t = (part?.text?.content || '').trim();
          if (/^\d/.test(t) && parseCount(t) != null) numericParts.push(t);
        }
      }
      if (subsText == null) subsText = numericParts[0] || null;
      if (videosText == null) videosText = numericParts[1] || null;
    }
    return {
      subsText,
      subsNum: subsText ? parseCount(subsText) : null,
      videosText,
      videosNum: videosText ? parseCount(videosText) : null,
    };
  };

  const CHANNEL_VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

  const resolveVideosTabRes = async (browseId) => {
    const res = await innertube('browse', { browseId, params: CHANNEL_VIDEOS_TAB_PARAMS });
    if (!res) return null;
    const tabWrapper = findNode(res, (n) => n?.tabRenderer?.selected || n?.expandableTabRenderer?.selected);
    const selected = tabWrapper?.tabRenderer || tabWrapper?.expandableTabRenderer || null;
    const selectedParams = selected?.endpoint?.browseEndpoint?.params;
    return (selectedParams && decodeParams(selectedParams).includes('videos')) ? res : null;
  };

  const deriveUploadCadence = (items) => {
    const secsList = items
      .map((it) => parseRelativeTime(it.published))
      .filter((s) => s != null)
      .sort((a, b) => a - b);
    if (!secsList.length) return { lastUploadSecs: null, freqPerWeek: null };
    const lastUploadSecs = secsList[0];
    if (secsList.length < 2) return { lastUploadSecs, freqPerWeek: null };
    const span = secsList[secsList.length - 1] - secsList[0];
    if (span <= 0) return { lastUploadSecs, freqPerWeek: null };
    const freqPerWeek = ((secsList.length - 1) / span) * 604800;
    return { lastUploadSecs, freqPerWeek };
  };

  const formatFrequency = (perWeek) => {
    if (perWeek == null || !Number.isFinite(perWeek)) return null;
    const v = perWeek < 10 ? Math.round(perWeek * 10) / 10 : Math.round(perWeek);
    return '~' + v + '/week';
  };

  const FOLLOWING_COLUMNS = [
    { key: 'name', label: 'Channel' },
    { key: 'subs', label: 'Subscribers' },
    { key: 'videos', label: 'Videos' },
    { key: 'lastUpload', label: 'Last upload' },
    { key: 'freq', label: 'Upload frequency' },
  ];

  const followingSortValue = (row, key) => {
    if (key === 'name') return row.title.toLowerCase();
    if (key === 'subs') return row.subsNum;
    if (key === 'videos') return row.videosNum;
    if (key === 'lastUpload') return row.lastUploadTs;
    if (key === 'freq') return row.freqPerWeek;
    return null;
  };

  const sortFollowingRows = (rows, key, dir) => {
    const known = [];
    const unknown = [];
    for (const row of rows) (followingSortValue(row, key) == null ? unknown : known).push(row);
    known.sort((a, b) => {
      const av = followingSortValue(a, key);
      const bv = followingSortValue(b, key);
      const cmp = key === 'name' ? av.localeCompare(bv, undefined, { sensitivity: 'base' }) : (av - bv);
      return dir === 'asc' ? cmp : -cmp;
    });
    return known.concat(unknown);
  };

  let followingGeneration = 0;
  const followingStatsCache = new Map();

  // Per-channel enrichment is a `browse` fetch per followed channel — cheap
  // one at a time, but expensive (and CAPTCHA/rate-limit risky) in aggregate
  // for anyone following hundreds of channels. Persisting results to
  // localStorage means that cost is paid once per channel per
  // FOLLOWING_CACHE_TTL_MS window, not once per page load.
  const hydrateFollowingCache = () => {
    try {
      const raw = lsGet(FOLLOWING_CACHE_LS_KEY);
      if (!raw || raw.length > 2_000_000) return;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return;
      const now = Date.now();
      for (const [browseId, entry] of Object.entries(obj)) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.cachedAt !== 'number') continue;
        if (now - entry.cachedAt >= FOLLOWING_CACHE_TTL_MS) continue;
        followingStatsCache.set(browseId, entry);
      }
    } catch (e) {
      // malformed/oversized — ignore, treat as a cold cache
    }
  };
  hydrateFollowingCache();

  let followingCachePersistScheduled = false;
  const persistFollowingCache = () => {
    try {
      let entries = Array.from(followingStatsCache.entries());
      entries.sort((a, b) => (b[1]?.cachedAt || 0) - (a[1]?.cachedAt || 0));
      if (entries.length > FOLLOWING_CACHE_MAX_ENTRIES) entries = entries.slice(0, FOLLOWING_CACHE_MAX_ENTRIES);
      const obj = {};
      for (const [browseId, entry] of entries) obj[browseId] = entry;
      lsSet(FOLLOWING_CACHE_LS_KEY, JSON.stringify(obj));
    } catch (e) {
      // quota exceeded or serialization failure — the in-memory cache still
      // works for this session, just don't persist it
    }
  };
  // Coalesce writes: enrichment can settle many rows back-to-back, and
  // stringifying/writing the whole cache on every single one thrashes
  // localStorage for no benefit. One idle-callback flush per batch is enough.
  const scheduleFollowingCachePersist = () => {
    if (followingCachePersistScheduled) return;
    followingCachePersistScheduled = true;
    idle(() => {
      followingCachePersistScheduled = false;
      persistFollowingCache();
    });
  };

  const mountFollowing = () => {
    if (loggedOut()) {
      const wrap = document.createElement('div');
      wrap.className = 'following-wrap';
      const headingEl = document.createElement('h1');
      headingEl.className = 'page-heading';
      headingEl.textContent = 'Following';
      wrap.append(headingEl, createSignInBlock({
        title: 'Following',
        message: 'Sign in to see the channels you follow.',
      }));
      view.replaceChildren(wrap);
      return () => {};
    }

    const gen = ++followingGeneration;

    const headingEl = document.createElement('h1');
    headingEl.className = 'page-heading';
    headingEl.textContent = 'Following';

    const progressEl = document.createElement('div');
    progressEl.className = 'following-progress';
    progressEl.style.display = 'none';
    const progressFill = document.createElement('div');
    progressFill.className = 'following-progress-fill';
    progressEl.appendChild(progressFill);

    const statusEl = document.createElement('div');
    statusEl.className = 'following-status';
    statusEl.textContent = 'Loading channels…';

    const tableWrap = document.createElement('div');
    tableWrap.className = 'following-table-wrap';
    const table = document.createElement('table');
    table.className = 'following-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const tbody = document.createElement('tbody');
    thead.appendChild(headRow);
    table.append(thead, tbody);
    tableWrap.appendChild(table);

    const wrap = document.createElement('div');
    wrap.className = 'following-wrap';
    wrap.append(headingEl, progressEl, statusEl, tableWrap);
    view.replaceChildren(wrap);

    let sortKey = 'name';
    let sortDir = 'asc';
    let rows = [];
    let enrichTruncated = false;

    const sortBtns = {};
    for (const col of FOLLOWING_COLUMNS) {
      const th = document.createElement('th');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'following-sort-btn';
      const label = document.createElement('span');
      label.textContent = col.label;
      const arrow = document.createElement('span');
      arrow.className = 'following-sort-arrow';
      arrow.textContent = '▲';
      btn.append(label, arrow);
      btn.addEventListener('click', () => {
        // Enrichment fills in the columns being sorted on (subs/videos/last
        // upload/frequency) — sorting mid-load would reorder rows out from
        // under the user every time another channel resolves, so sorting
        // stays inert until every row has settled.
        if (btn.disabled) return;
        if (sortKey === col.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = col.key; sortDir = 'asc'; }
        renderRows();
      });
      th.appendChild(btn);
      headRow.appendChild(th);
      sortBtns[col.key] = { btn, arrow };
    }

    const dashOrText = (text) => {
      if (text) return text;
      const span = document.createElement('span');
      span.className = 'following-dim';
      span.textContent = '—';
      return span;
    };

    // While a row hasn't been enriched yet, its metric cells render a
    // shimmer placeholder instead of "—" — otherwise "still loading" and
    // "genuinely empty" look identical.
    const metricCell = (row, text) => {
      if (!row.enriched) {
        const span = document.createElement('span');
        span.className = 'following-skeleton sk-shimmer';
        return span;
      }
      return dashOrText(text);
    };

    const appendCell = (tr, content) => {
      const td = document.createElement('td');
      if (typeof content === 'string') td.textContent = content;
      else td.appendChild(content);
      tr.appendChild(td);
    };

    const lastUploadContent = (row) => {
      if (!row.enriched) return metricCell(row, null);
      if (row.lastUploadText && row.lastUploadTs != null) {
        const span = document.createElement('span');
        span.textContent = row.lastUploadText;
        span.title = 'Approx. ' + new Date(row.lastUploadTs).toLocaleString();
        return span;
      }
      return dashOrText(row.lastUploadText);
    };

    // When a single row's enrichment settles, swap that row's four metric
    // cells in place instead of rebuilding the whole table. Sorting is locked
    // until every row is enriched, so the order can't change mid-load and a
    // full rebuild per settle bought nothing but node churn (500 channels ≈
    // 500 rebuilds × ~5k nodes).
    const updateRowCells = (row) => {
      const tds = row.tr.children;
      const fill = (td, content) => {
        if (!td) return;
        if (typeof content === 'string') td.replaceChildren(document.createTextNode(content));
        else td.replaceChildren(content);
      };
      fill(tds[1], metricCell(row, row.subsText));
      fill(tds[2], metricCell(row, row.videosText));
      fill(tds[3], lastUploadContent(row));
      fill(tds[4], metricCell(row, row.freqText));
    };

    const renderRows = () => {
      // Sorting stays disabled until every row is enriched — either freshly
      // fetched or served instantly from the persistent cache — so the sort
      // order can't shuffle underneath the user mid-load.
      const allEnriched = rows.length > 0 && rows.every((row) => row.enriched);
      for (const col of FOLLOWING_COLUMNS) {
        const { btn, arrow } = sortBtns[col.key];
        const isActive = sortKey === col.key;
        btn.classList.toggle('active', isActive);
        arrow.textContent = sortDir === 'asc' ? '▲' : '▼';
        btn.disabled = !allEnriched;
        btn.title = allEnriched ? '' : 'Sortable once all channels have loaded';
      }
      // Topic channels (auto-generated by YouTube, title ends with
      // " - Topic") have no real stats and just clutter the list next to
      // real channels — they're sorted and rendered as their own group,
      // pinned below every real channel regardless of sort direction, with
      // a section header separating them.
      const nonTopicRows = rows.filter((row) => !row.isTopic);
      const topicRows = rows.filter((row) => row.isTopic);
      const sortedNonTopic = sortFollowingRows(nonTopicRows, sortKey, sortDir);
      const sortedTopic = sortFollowingRows(topicRows, sortKey, sortDir);

      const buildRow = (row) => {
        const tr = document.createElement('tr');
        if (row.isTopic) tr.className = 'following-topic-row';
        const chanLink = document.createElement('a');
        chanLink.className = 'following-chan-cell';
        chanLink.href = '/channel/' + encodeURIComponent(row.browseId);
        const av = document.createElement('img');
        av.className = 'following-avatar';
        av.src = row.avatar;
        av.setAttribute('loading', 'lazy');
        const name = document.createElement('span');
        name.className = 'following-chan-name';
        name.textContent = row.title;
        chanLink.appendChild(av);
        chanLink.appendChild(name);
        if (row.isTopic) {
          const badge = document.createElement('span');
          badge.className = 'following-topic-badge';
          badge.textContent = 'Topic';
          chanLink.appendChild(badge);
        }
        const chanTd = document.createElement('td');
        chanTd.appendChild(chanLink);
        tr.appendChild(chanTd);

        appendCell(tr, metricCell(row, row.subsText));
        appendCell(tr, metricCell(row, row.videosText));
        appendCell(tr, lastUploadContent(row));
        appendCell(tr, metricCell(row, row.freqText));
        row.tr = tr;
        return tr;
      };

      const trs = sortedNonTopic.map(buildRow);
      if (sortedTopic.length) {
        const sepTr = document.createElement('tr');
        sepTr.className = 'following-section-row';
        const sepTd = document.createElement('td');
        sepTd.colSpan = FOLLOWING_COLUMNS.length;
        sepTd.textContent = 'Topics';
        sepTr.appendChild(sepTd);
        trs.push(sepTr);
        trs.push(...sortedTopic.map(buildRow));
      }
      tbody.replaceChildren(...trs);
    };

    let renderScheduled = false;
    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        if (gen === followingGeneration) renderRows();
      });
    };

    const updateStatus = (enrichedCount, enrichTotal) => {
      if (gen !== followingGeneration) return;
      const topicCount = rows.reduce((n, row) => n + (row.isTopic ? 1 : 0), 0);
      const base = topicCount > 0
        ? rows.length + (rows.length === 1 ? ' channel' : ' channels') + ' · ' + topicCount + (topicCount === 1 ? ' topic' : ' topics')
        : rows.length + (rows.length === 1 ? ' channel' : ' channels');
      if (enrichTotal > 0 && enrichedCount < enrichTotal) {
        progressEl.style.display = '';
        progressFill.style.width = Math.round((enrichedCount / enrichTotal) * 100) + '%';
        statusEl.replaceChildren();
        if (!prefersReducedMotion()) {
          const spinner = document.createElement('span');
          spinner.className = 'following-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          statusEl.appendChild(spinner);
        }
        const text = document.createElement('span');
        text.textContent = 'Loading details… ' + enrichedCount + ' / ' + enrichTotal;
        statusEl.appendChild(text);
      } else {
        progressEl.style.display = 'none';
        statusEl.textContent = enrichTruncated
          ? 'Showing details for first ' + MAX_FOLLOWING_ENRICH + ' of ' + base
          : base;
      }
    };

    const enrichRows = async (candidates) => {
      let idx = 0;
      let done = 0;
      const total = candidates.length;
      updateStatus(done, total);
      const worker = async () => {
        while (idx < candidates.length) {
          const row = candidates[idx++];
          if (gen !== followingGeneration) return;
          try {
            const res = await resolveVideosTabRes(row.browseId) || await innertube('browse', { browseId: row.browseId });
            if (gen !== followingGeneration) return;
            if (res) {
              const stats = extractChannelStats(res);
              row.subsText = stats.subsText;
              row.subsNum = stats.subsNum;
              row.videosText = stats.videosText;
              row.videosNum = stats.videosNum;
              const items = extractVideos(res, new Set(), thumbTarget(GRID_THUMB_W));
              const cadence = deriveUploadCadence(items);
              row.lastUploadSecs = cadence.lastUploadSecs;
              row.lastUploadTs = cadence.lastUploadSecs != null ? Date.now() - cadence.lastUploadSecs * 1000 : null;
              row.lastUploadText = cadence.lastUploadSecs != null
                ? (items.find((it) => parseRelativeTime(it.published) === cadence.lastUploadSecs)?.published || null)
                : null;
              row.freqPerWeek = cadence.freqPerWeek;
              row.freqText = formatFrequency(cadence.freqPerWeek);
              followingStatsCache.set(row.browseId, {
                subsText: row.subsText,
                subsNum: row.subsNum,
                videosText: row.videosText,
                videosNum: row.videosNum,
                lastUploadSecs: row.lastUploadSecs,
                lastUploadTs: row.lastUploadTs,
                lastUploadText: row.lastUploadText,
                freqPerWeek: row.freqPerWeek,
                freqText: row.freqText,
                cachedAt: Date.now(),
              });
              scheduleFollowingCachePersist();
            }
          } catch (e) {
            console.warn('[itube] following enrichment failed for', row.browseId, e);
          }
          row.enriched = true;
          done++;
          if (gen === followingGeneration) {
            updateStatus(done, total);
            if (row.tr && row.tr.isConnected) updateRowCells(row);
            else scheduleRender();
            // Once everything settled, one full render re-enables sorting.
            if (done === total) scheduleRender();
          }
          // Throttle, don't hammer: a channel `browse` fetch per followed
          // channel adds up fast and reads as scraping to YouTube's abuse
          // detection, so each worker paces itself with a jittered gap
          // between successive channels rather than firing back-to-back.
          if (idx < candidates.length && gen === followingGeneration) {
            const delay = FOLLOWING_ENRICH_DELAY_MIN_MS + Math.random() * FOLLOWING_ENRICH_DELAY_JITTER_MS;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      };
      const workerCount = Math.min(FOLLOWING_ENRICH_CONCURRENCY, candidates.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
    };

    const loadChannels = async () => {
      // A failed-and-gave-up cache ([] with the failed flag) is not an answer —
      // retry the fetch on this visit instead of reporting "no subscriptions".
      const cached = guideChannelsFailed ? null : guideChannelsCache;
      const channels = (cached && cached.length ? cached : null) || await fetchGuideChannels();
      if (gen !== followingGeneration) return;
      if (!channels || !channels.length) {
        statusEl.textContent = (channels && !guideChannelsFailed) ? "You're not following any channels yet." : "Couldn't load your followed channels.";
        tableWrap.style.display = 'none';
        return;
      }
      if (!guideChannelsCache || guideChannelsFailed || !guideChannelsCache.length) {
        guideChannelsFailed = false;
        guideChannelsCache = channels;
        persistGuideCache();
        paintGuideChannels();
      }
      rows = channels.map((ch) => {
        const cached = followingStatsCache.get(ch.browseId);
        // A cached entry's lastUploadText was captured (or last recomputed)
        // whenever it was written — re-derive it from the absolute
        // timestamp so "4 days ago" doesn't read stale on a later visit.
        const lastUploadText = cached?.lastUploadTs != null
          ? (formatRelativeAgo((Date.now() - cached.lastUploadTs) / 1000) ?? cached.lastUploadText ?? null)
          : (cached?.lastUploadText ?? null);
        return {
          browseId: ch.browseId,
          title: ch.title,
          isTopic: ch.title.endsWith(' - Topic'),
          avatar: ch.avatar,
          subsText: cached?.subsText ?? null,
          subsNum: cached?.subsNum ?? null,
          videosText: cached?.videosText ?? null,
          videosNum: cached?.videosNum ?? null,
          lastUploadSecs: cached?.lastUploadSecs ?? null,
          lastUploadTs: cached?.lastUploadTs ?? null,
          lastUploadText,
          freqPerWeek: cached?.freqPerWeek ?? null,
          freqText: cached?.freqText ?? null,
          enriched: !!cached,
        };
      });
      renderRows();
      const uncached = rows.filter((row) => !row.enriched);
      enrichTruncated = uncached.length > MAX_FOLLOWING_ENRICH;
      const toEnrich = enrichTruncated ? uncached.slice(0, MAX_FOLLOWING_ENRICH) : uncached;
      updateStatus(0, toEnrich.length);
      idle(() => enrichRows(toEnrich));
    };

    loadChannels();

    return () => { followingGeneration++; };
  };

  /**
   * The borrowed playback engine. Its methods are declared in types/flyt.d.ts;
   * `#movie_player` is a plain element to the DOM and a whole API to us.
   * @returns {YtPlayer}
   */
  const player = () => /** @type {YtPlayer} */ (document.getElementById('movie_player'));
  // True/false when the player can report caption state, null when it can't
  // (captions module not loaded — getOption throws then; never force-load it,
  // cycling loadModule('captions') wedges the player).
  const ccActive = (p) => {
    try {
      const track = p?.getOption?.('captions', 'track');
      return !!(track && (track.languageCode || track.vss_id));
    } catch (e) { return null; }
  };

  const playerVolume = () => {
    const p = player();
    if (p && typeof p.getVolume === 'function') return Math.round(p.getVolume());
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
    return v ? Math.round(v.volume * 100) : 100;
  };

  const setPlayerVolume = (value) => {
    const vol = Math.max(0, Math.min(100, Math.round(value)));
    const p = player();
    if (p && typeof p.setVolume === 'function') {
      p.unMute?.();
      p.setVolume(vol);
    } else {
      const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
      if (v) { v.muted = false; v.volume = vol / 100; }
    }
    return vol;
  };

  const isMuted = () => {
    const p = player();
    if (p && typeof p.isMuted === 'function') return p.isMuted();
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
    return v ? v.muted : false;
  };

  const setMuted = (muted) => {
    const p = player();
    if (p && typeof p.mute === 'function') {
      if (muted) p.mute(); else p.unMute?.();
    }
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
    if (v) v.muted = muted;
  };

  const SKIP_AD_SELECTOR = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad',
    '.ytp-ad-skip-button-container button',
  ].join(', ');

  const adShowing = () => {
    const p = player();
    if (!p) return false;
    return p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
  };

  const clickSkipAd = () => {
    const p = player();
    if (!p) return;
    for (const b of p.querySelectorAll(SKIP_AD_SELECTOR)) {
      if (/** @type {HTMLElement} */ (b).offsetParent !== null) /** @type {HTMLElement} */ (b).click();
    }
  };

  const killAd = (video) => {
    clickSkipAd();
    if (!video || !isFinite(video.duration) || video.duration <= 0) return false;
    if (video.currentTime >= video.duration) return true;
    try {
      video.currentTime = video.duration;
    } catch (e) {
      return false;
    }
    return true;
  };

  const adoptVideo = (stage) => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video, #itube-mini video, #movie_player video'));
    if (!v || v.parentElement === stage) return;
    stage.insertBefore(v, stage.firstChild);
  };

  const CAPTION_CONTAINER = '.ytp-caption-window-container';

  let ownedCaptions = null;

  const adoptCaptions = (stage) => {
    const fresh = document.querySelector('#movie_player ' + CAPTION_CONTAINER) || ownedCaptions;
    if (!fresh) return;
    const held = stage.querySelector(CAPTION_CONTAINER);
    if (held === fresh) return;
    if (held) {
      const moviePlayer = player();
      if (!moviePlayer) return;
      moviePlayer.appendChild(held);
    }
    ownedCaptions = fresh;
    const video = stage.querySelector('video');
    if (video && video.nextSibling) stage.insertBefore(fresh, video.nextSibling);
    else stage.appendChild(fresh);
  };

  const releaseCaptions = (stage) => {
    const held = stage.querySelector(CAPTION_CONTAINER);
    if (!held) return;
    ownedCaptions = held;
    const moviePlayer = player();
    if (moviePlayer) moviePlayer.appendChild(held);
  };

  const fit = (v) => {
    if (v.style.width !== '100%') v.style.width = '100%';
    if (v.style.height !== '100%') v.style.height = '100%';
    if (v.style.left !== '0px') v.style.left = '0px';
    if (v.style.top !== '0px') v.style.top = '0px';
    if (v.style.position !== 'absolute') v.style.position = 'absolute';
    if (v.style.objectFit !== 'contain') v.style.objectFit = 'contain';
  };

  const CROSSFADE_HARD_TIMEOUT_MS = 1500;

  let crossfadeState = null;

  const teardownCrossfade = (immediate) => {
    const st = crossfadeState;
    if (!st) return;
    crossfadeState = null;
    clearTimeout(st.hardTimeout);
    EventTarget.prototype.removeEventListener.call(st.video, 'loadeddata', st.onReady);
    EventTarget.prototype.removeEventListener.call(st.video, 'playing', st.onReady);
    if (immediate) {
      st.canvas.remove();
      return;
    }
    // Same "whichever comes first" shape as everything else that hands off on
    // a transition; previously hand-rolled here, where the timer winning left
    // the transitionend listener attached.
    afterTransition(st.canvas, 'opacity', 320, () => st.canvas.remove());
    requestAnimationFrame(() => { st.canvas.style.opacity = '0'; });
  };

  const beginVideoCrossfade = () => {
    teardownCrossfade(true);
    if (document.pictureInPictureElement) return;
    const stage = document.getElementById('itube-stage');
    if (!stage) return;
    const video = stage.querySelector('video');
    if (!video || video.readyState < 2) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'itube-crossfade';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      return;
    }
    stage.appendChild(canvas);
    const st = { video, canvas, hardTimeout: null, onReady: null };
    const finish = () => teardownCrossfade(false);
    const onReady = () => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(finish);
      } else {
        finish();
      }
    };
    st.onReady = onReady;
    EventTarget.prototype.addEventListener.call(video, 'loadeddata', onReady, { once: true });
    EventTarget.prototype.addEventListener.call(video, 'playing', onReady, { once: true });
    st.hardTimeout = setTimeout(finish, CROSSFADE_HARD_TIMEOUT_MS);
    crossfadeState = st;
  };

  // Returns { start, title } per chapter. The title used to be parsed and
  // thrown away — only the offsets were kept, so the seek bar grew tick marks
  // dividing the video into sections with no way to find out what any section
  // WAS. Ticks without names are just confusing.
  const parseChapters = (data) => {
    try {
      for (const ep of data?.engagementPanels || []) {
        const c = ep.engagementPanelSectionListRenderer;
        if (!/macro|chapter/i.test(c?.targetId || '')) continue;
        const items = c.content?.macroMarkersListRenderer?.contents || [];
        return items.map((i) => {
          const r = i.macroMarkersListItemRenderer;
          const t = r?.timeDescription?.simpleText || '';
          const parts = t.split(':').map(Number);
          if (!parts.length || parts.some(isNaN)) return null;
          return {
            start: parts.reduce((a, b) => a * 60 + b, 0),
            title: runsText(r?.title) || r?.title?.simpleText || '',
          };
        }).filter((v) => v !== null);
      }
    } catch (e) {
      console.warn('[itube] chapter parse failed', e);
    }
    return [];
  };

  const pickCaptionTrack = (tracks) => {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const uiLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const nonAsr = tracks.filter((t) => t.kind !== 'asr');
    const pool = nonAsr.length ? nonAsr : tracks;
    return pool.find((t) => (t.languageCode || '').toLowerCase().startsWith(uiLang))
      || pool.find((t) => (t.languageCode || '').toLowerCase().startsWith('en'))
      || pool[0];
  };

  const parseJson3Transcript = (tj) => {
    const out = [];
    try {
      for (const ev of tj?.events || []) {
        if (!Array.isArray(ev?.segs)) continue;
        const text = ev.segs.map((s) => s?.utf8 || '').join('').replace(/\n/g, ' ').trim();
        if (!text) continue;
        if (!Number.isFinite(ev.tStartMs)) continue;
        out.push({ start: ev.tStartMs / 1000, text });
      }
    } catch (e) {
      console.warn('[itube] transcript json3 parse failed', e);
    }
    return out;
  };

  const parseStoryboard = (p) => {
    try {
      const spec = p.getPlayerResponse?.()?.storyboards?.playerStoryboardSpecRenderer?.spec;
      if (!spec) return null;
      const parts = spec.split('|');
      if (parts.length < 2) return null;
      const L = parts.length - 1;
      const sp = parts[L].split('#');
      if (sp.length < 8) return null;
      const [w, h, count, rows, cols, interval] = sp.slice(0, 6).map(Number);
      if (!w || !h || !count || !rows || !cols) return null;
      const url = parts[0].replace('$L', String(L - 1)).replace('$N', sp[6])
        + '&sigh=' + encodeURIComponent(sp[7]);
      return { url, w, h, count, rows, cols, interval };
    } catch (e) {
      console.warn('[itube] storyboard parse failed', e);
      return null;
    }
  };

  const el = (tag, id, child) => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (typeof child === 'string') e.textContent = child;
    else if (child) e.appendChild(child);
    return e;
  };

  // `previewLayer` is the stage's non-clipped wrapper (.stage-wrap): #itube-stage
  // has `overflow: hidden` + a rounded-corner `clip-path` for the video, so the
  // seek-preview thumbnail — which can be taller than the space between the
  // seekbar and the video's top edge (short videos, scrubbing near the start)
  // — is appended there instead of inside the seekwrap, and positioned in
  // pixels (via getBoundingClientRect, see wireBar's pointermove handler and
  // updatePreview) rather than the CSS percentages that only worked while it
  // was a descendant of the seekwrap it tracks.
  // Every surface that counts as player chrome rather than "the video".
  // Three behaviours key off this: click-to-pause and dblclick-to-fullscreen
  // on the stage must ignore clicks that land on a control, and the keyboard
  // handler must still own Space when a player button has focus. This was
  // literally '#itube-bar' until the controls moved out into floating
  // capsules — after which clicking the play button toggled playback TWICE
  // (once via the button, once via the stage underneath), which presented as
  // "video refuses to stay playing".
  const PLAYER_CHROME_SEL = '#itube-bar, #itube-tools, #itube-sound, #itube-viewer, #itube-transport, .itube-ctx';

  const buildBar = (stage, previewLayer) => {
    const bar = el('div', 'itube-bar');
    const prev = el('button', 'itube-prev', ICONS.prev());
    const next = el('button', 'itube-next', ICONS.next());
    const play = el('button', 'itube-play', ICONS.pause());
    const timeCur = el('span', null); timeCur.className = 'itube-time';
    const seek = el('input', 'itube-seek'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
    const timeDur = el('span', null); timeDur.className = 'itube-time';
    const mute = el('button', 'itube-mute', ICONS.vol());
    const vol = el('input', 'itube-vol'); vol.type = 'range'; vol.min = 0; vol.max = 100;
    const pip = el('button', 'itube-pip', ICONS.pip());
    const theater = el('button', 'itube-theater', ICONS.theater());
    theater.setAttribute('aria-label', 'Theater mode');
    theater.title = 'Theater mode (t)';
    const shot = el('button', 'itube-shot', ICONS.camera());
    shot.setAttribute('aria-label', 'Save frame');
    shot.title = 'Save current frame (PNG)';
    const fs = el('button', 'itube-fs', ICONS.fs());
    const seekwrap = el('div', 'itube-seekwrap');
    seekwrap.appendChild(seek);
    const preview = el('div', 'itube-preview');
    const ptime = el('span', null); ptime.className = 'itube-ptime';
    preview.appendChild(ptime);
    previewLayer.appendChild(preview);
    // Sibling, not a child: the preview box is sized to the storyboard sprite
    // (usually 160px), far too narrow for a chapter title, and it clips its
    // own overflow to keep the sprite inside its corners.
    const pchapter = el('div', null); pchapter.className = 'itube-pchapter';
    previewLayer.appendChild(pchapter);
    const live = el('button', 'itube-live', 'LIVE');
    live.style.display = 'none';
    const cue = el('div', 'itube-cue');
    // Apple's transport grammar: floating capsules pinned to the corners plus
    // a centre cluster, instead of one full-width strip holding twelve
    // controls in a row. Every element id is unchanged — the regrouping is
    // parentage only, so selectors and handlers elsewhere still resolve.
    //
    // #itube-bar deliberately stays the bottom rail rather than growing to
    // cover the stage: its rect is what `bar-click-no-toggle` clicks, and a
    // full-stage bar would put that click on the play button.
    const left = el('div', 'itube-bar-left');
    const right = el('div', 'itube-bar-right');
    const tools = el('div', 'itube-tools');
    const sound = el('div', 'itube-sound');
    const transport = el('div', 'itube-transport');
    const viewer = el('div', 'itube-viewer');
    tools.append(pip, shot);
    sound.append(vol, mute);
    transport.append(prev, play, next);
    viewer.append(theater, fs);
    left.append(timeCur, live);
    right.append(timeDur);
    bar.append(left, seekwrap, right);
    stage.append(tools, sound, transport, viewer, bar, cue);
    return {
      bar, prev, next, play, timeCur, seek, seekwrap, preview, ptime, pchapter, timeDur, live, mute, vol,
      pip, theater, shot, fs, left, right, cue, tools, sound, transport, viewer,
      scrubbing: false, isLive: false,
    };
  };

  const mountWatch = () => {
    const fromMini = expandFromMini && miniActive;
    expandFromMini = false;
    if (miniActive && !fromMini) deactivateMini();
    let miniHandoffPending = fromMini;
    let miniFlyCancel = null;
    let miniFlySafety = null;
    let miniFlyAnim = null;
    let pendingTheater = null;
    const flyVideoId = fromMini ? miniVideoId : null;
    const stage = el('div', 'itube-stage');
    const stageAudio = document.createElement('div');
    stageAudio.className = 'stage-audio';
    const stageAudioBack = document.createElement('div');
    stageAudioBack.className = 'stage-audio-back';
    const stageAudioArt = document.createElement('img');
    stageAudioArt.className = 'stage-audio-art';
    const stageAudioTitle = document.createElement('div');
    stageAudioTitle.className = 'stage-audio-title';
    const stageAudioTag = document.createElement('div');
    stageAudioTag.className = 'stage-audio-tag';
    stageAudioTag.textContent = '♪ Audio only';
    stageAudio.append(stageAudioBack, stageAudioArt, stageAudioTitle, stageAudioTag);
    stage.appendChild(stageAudio);
    const watch = document.createElement('div');
    watch.className = 'watch';
    const watchLeft = document.createElement('div');
    watchLeft.className = 'watch-left';
    const watchRight = document.createElement('div');
    watchRight.className = 'watch-right';
    const queueWrap = document.createElement('div');
    queueWrap.className = 'queue-wrap';
    const relatedWrap = document.createElement('div');
    relatedWrap.className = 'related-wrap';

    const title = document.createElement('h1');
    title.className = 'watch-title';
    const meta = document.createElement('div');
    meta.className = 'watch-meta';
    const channelRow = document.createElement('div');
    channelRow.className = 'watch-channel';
    const avatar = document.createElement('img');
    avatar.className = 'watch-avatar';
    const followBadge = document.createElement('span');
    followBadge.className = 'watch-follow-badge';
    const channelInfo = document.createElement('div');
    channelInfo.className = 'watch-channel-info';
    const channelName = document.createElement('a');
    channelName.className = 'watch-channel-name';
    const subs = document.createElement('div');
    subs.className = 'watch-subs';
    channelInfo.append(channelName, subs);
    const channelSpacer = document.createElement('div');
    channelSpacer.className = 'watch-channel-spacer';

    const actions = document.createElement('div');
    actions.className = 'watch-actions';

    const likes = document.createElement('div');
    likes.className = 'watch-likes';
    const { btn: likeBtn, label: likeLabel } = pillButton(ICONS.thumbsUp, '', 'watch-like-btn');
    const likeDivider = document.createElement('div');
    likeDivider.className = 'watch-like-divider';
    const { btn: dislikeBtn, label: dislikeLabel } = pillButton(ICONS.thumbsDown, '', 'watch-dislike-btn');
    likes.append(likeBtn, likeDivider, dislikeBtn);

    const { btn: saveBtn, label: saveLabel } = pillButton(ICONS.save, '', 'watch-action-btn');
    const { btn: descBtn } = pillButton(ICONS.desc, 'Description', 'watch-action-btn');
    const { btn: transcriptBtn } = pillButton(ICONS.transcript, 'Transcript', 'watch-action-btn');
    const { btn: shareBtn, label: shareLabel } = pillButton(ICONS.share, 'Share', 'watch-action-btn');
    const { btn: toolsBtn } = pillButton(ICONS.tools, 'Tools', 'watch-action-btn');
    saveBtn.title = 'Save';
    saveBtn.setAttribute('aria-label', 'Save');
    descBtn.title = 'Description';
    descBtn.setAttribute('aria-label', 'Description');
    descBtn.style.display = 'none';
    transcriptBtn.title = 'Transcript';
    transcriptBtn.setAttribute('aria-label', 'Transcript');
    transcriptBtn.style.display = 'none';
    shareBtn.title = 'Share';
    shareBtn.setAttribute('aria-label', 'Share');
    toolsBtn.title = 'Tools';
    toolsBtn.setAttribute('aria-label', 'Tools');
    toolsBtn.setAttribute('aria-expanded', 'false');
    toolsBtn.setAttribute('aria-haspopup', 'menu');
    const toolsChevron = icon([['path', {
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M4.5 6.2 8 9.7l3.5-3.5',
    }]]);
    toolsChevron.classList.add('tools-chevron');
    toolsBtn.appendChild(toolsChevron);
    const { btn: subscribeBtn, label: subscribeLabel } = pillButton(null, '', 'watch-subscribe');

    const actionsSpacer = document.createElement('div');
    actionsSpacer.className = 'watch-actions-spacer';
    actions.append(likes, actionsSpacer, saveBtn, descBtn, transcriptBtn, shareBtn, toolsBtn);
    subscribeBtn.classList.add('watch-avatar-follow');
    subscribeLabel.className = 'watch-subscribe-label';
    subscribeBtn.append(avatar, followBadge, subscribeLabel);
    channelRow.append(subscribeBtn, channelInfo, channelSpacer);

    const toolsRow = document.createElement('div');
    toolsRow.className = 'watch-tools';
    toolsRow.inert = true;
    const toolBtn = (label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'watch-tool';
      const t = document.createElement('span');
      t.className = 'watch-tool-label';
      t.textContent = label;
      const v = document.createElement('span');
      v.className = 'watch-tool-val';
      b.append(t, v);
      return { b, v };
    };
    const tAb = toolBtn('A–B repeat');
    const tSpeed = toolBtn('Speed');
    const tQuality = toolBtn('Quality');
    const tCC = toolBtn('Captions');
    const tAudioTrack = toolBtn('Audio track');
    tAudioTrack.b.style.display = 'none';
    const tAuto = toolBtn('Autoplay');
    const tSkip = toolBtn('Skip sponsors');
    const tBoost = toolBtn('Volume boost');
    const tAudio = toolBtn('Audio only');
    toolsRow.append(tAb.b, tSpeed.b, tQuality.b, tCC.b, tAudioTrack.b, tAuto.b, tSkip.b, tBoost.b, tAudio.b);

    const audioMeta = (t) => t && Object.values(t).find((v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && typeof v.isDefault === 'boolean' && typeof v.id === 'string');
    let audioTracks = [];

    const syncAudioTrack = (p) => {
      const tracks = p && typeof p.getAvailableAudioTracks === 'function' ? p.getAvailableAudioTracks() || [] : [];
      audioTracks = tracks;
      if (tracks.length <= 1) {
        tAudioTrack.b.style.display = 'none';
        return;
      }
      tAudioTrack.b.style.display = '';
      const cur = typeof p.getAudioTrack === 'function' ? p.getAudioTrack() : null;
      const curId = audioMeta(cur)?.id;
      const idx = curId ? tracks.findIndex((t) => audioMeta(t)?.id === curId) : -1;
      const meta = audioMeta(tracks[idx === -1 ? 0 : idx]);
      tAudioTrack.v.textContent = meta?.name || `Track ${(idx === -1 ? 0 : idx) + 1}`;
    };

    const syncTools = () => {
      const abOn = abA != null && abB != null;
      tAb.b.classList.toggle('active', abOn);
      tAb.v.textContent = abA != null && abB == null ? 'Set B' : abOn ? 'On' : 'Off';
      tSpeed.v.textContent = desiredRate + '×';
      const p = player();
      const q = p && p.getPlaybackQuality ? p.getPlaybackQuality() : '';
      tQuality.v.textContent = q && q !== 'unknown' ? (QUALITY_LABELS[q] || q) : 'Auto';
      tCC.v.textContent = 'CC';
      // Read real caption state so the indicator can't drift from the 'c'
      // shortcut (which toggles subtitles without touching this button).
      const cc = ccActive(p);
      if (cc !== null) tCC.b.classList.toggle('active', cc);
      syncAudioTrack(p);
      tAuto.b.classList.toggle('active', autoplayEnabled);
      tAuto.v.textContent = autoplayEnabled ? 'On' : 'Off';
      tSkip.b.classList.toggle('active', sbEnabled);
      tSkip.v.textContent = sbEnabled ? 'On' : 'Off';
      tBoost.b.classList.toggle('active', boost > 1);
      tBoost.v.textContent = boost > 1 ? Math.round(boost * 100) + '%' : 'Off';
      tAudio.b.classList.toggle('active', audioOnly);
      tAudio.v.textContent = audioOnly ? 'On' : 'Off';
    };
    let toolsOpen = false;
    let toolsMenuH = 0;
    const TOOLS_MENU_H_GUESS = 320;
    const syncToolsChevron = () => {
      // While the menu is open, positionTools owns the direction — it measured
      // the real height and placed the menu from it. A late renderMeta reveal
      // calling in here would recompute the class from the estimate and could
      // flip it, leaving the chevron pointing away from an open menu.
      if (toolsOpen) return;
      const r = toolsBtn.getBoundingClientRect();
      const h = toolsMenuH || TOOLS_MENU_H_GUESS;
      const spaceBelow = window.innerHeight - r.bottom;
      toolsBtn.classList.toggle('menu-up', h + 8 > spaceBelow - 8 && r.top > spaceBelow);
    };
    const positionTools = () => {
      const r = toolsBtn.getBoundingClientRect();
      const gap = 8;
      // Never 0: a zero measurement makes the menu look like it fits below and
      // flips the placement the wrong way.
      const h = toolsRow.offsetHeight || toolsMenuH || TOOLS_MENU_H_GUESS;
      const w = toolsRow.offsetWidth || 236;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = h + gap > spaceBelow - 8 && r.top > spaceBelow;
      toolsMenuH = h || toolsMenuH;
      toolsBtn.classList.toggle('menu-up', openUp);
      toolsRow.style.top = openUp
        ? Math.max(8, Math.round(r.top - gap - h)) + 'px'
        : Math.round(r.bottom + gap) + 'px';
      let left = Math.round(r.right - w);
      if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
      if (left < 8) left = 8;
      toolsRow.style.left = left + 'px';
    };
    const setToolsOpen = (open) => {
      toolsOpen = open;
      if (open) {
        toolsRow.classList.add('shown');
        positionTools();
        requestAnimationFrame(() => { if (toolsOpen) toolsRow.classList.add('open'); });
      } else {
        toolsRow.classList.remove('open');
        setTimeout(() => { if (!toolsOpen) toolsRow.classList.remove('shown'); }, 220);
      }
      toolsRow.inert = !open;
      toolsBtn.classList.toggle('active', open);
      toolsBtn.setAttribute('aria-expanded', String(open));
      if (open) syncTools();
      else if (toolsRow.contains(document.activeElement)) toolsBtn.focus();
    };

    let toolMenuSeq = 0;
    const createToolMenu = (btn) => {
      const menu = document.createElement('div');
      menu.className = 'tool-menu';
      menu.setAttribute('role', 'menu');
      if (supportsPopover) menu.setAttribute('popover', 'auto');
      if (supportsAnchor) {
        const anchorName = '--itube-tool-anchor-' + (++toolMenuSeq);
        btn.style.setProperty('anchor-name', anchorName);
        menu.style.setProperty('position-anchor', anchorName);
      }
      root.appendChild(menu);
      let open = false;
      const position = () => {
        const r = btn.getBoundingClientRect();
        const gap = 6;
        const mh = menu.offsetHeight || 0;
        const spaceBelow = window.innerHeight - r.bottom;
        // Open upward when the menu would overflow the bottom edge and there's
        // more room above (e.g. the Tools menus anchored to the player bar,
        // which sits near the bottom of the viewport).
        const openUp = mh + gap > spaceBelow - 8 && r.top > spaceBelow;
        menu.style.bottom = 'auto';
        menu.style.top = openUp
          ? Math.max(8, Math.round(r.top - gap - mh)) + 'px'
          : Math.round(r.bottom + gap) + 'px';
        let left = Math.round(r.left);
        const w = menu.offsetWidth || 160;
        if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
        if (left < 8) left = 8;
        menu.style.left = left + 'px';
      };
      const menuItems = () => /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('.tool-menu-item')));
      const close = () => {
        if (!open) return;
        open = false;
        const wasInside = menu.contains(document.activeElement);
        if (supportsPopover) { try { menu.hidePopover(); } catch (e) {} }
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        if (wasInside) btn.focus();
      };
      const show = () => {
        if (open) return;
        open = true;
        if (supportsPopover) { try { menu.showPopover(); } catch (e) {} }
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        position();
        const items = menuItems();
        if (items.length) items[0].focus();
      };
      const onMenuClick = (e) => e.stopPropagation();
      menu.addEventListener('click', onMenuClick);
      const onMenuKeydown = (e) => {
        const items = menuItems();
        if (!items.length) return;
        const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      };
      menu.addEventListener('keydown', onMenuKeydown);
      const onToggle = (e) => {
        open = e.newState === 'open';
        menu.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          position();
          const items = menuItems();
          if (items.length) items[0].focus();
        }
      };
      const onDocClick = (e) => {
        if (open && !menu.contains(e.target) && e.target !== btn) close();
      };
      const onDocKeydown = (e) => { if (open && e.key === 'Escape') close(); };
      if (supportsPopover) {
        menu.addEventListener('toggle', onToggle);
      } else {
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeydown);
      }
      const onResize = () => { if (open && !supportsAnchor) position(); };
      window.addEventListener('resize', onResize);
      return {
        isOpen: () => open,
        toggle: () => (open ? close() : show()),
        close,
        // heading: Apple labels each of these menus ("Subtitles", "Audio",
        // "Speed") above the list rather than relying on the button you came
        // from, which matters once the menu is a floating panel that can open
        // upward and lose its visual tie to the trigger.
        setItems: (items, heading) => {
          menu.replaceChildren();
          if (heading) {
            const h = document.createElement('div');
            h.className = 'tool-menu-heading';
            h.textContent = heading;
            menu.appendChild(h);
          }
          for (const it of items) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'tool-menu-item' + (it.active ? ' active' : '');
            row.setAttribute('role', 'menuitemradio');
            row.setAttribute('aria-checked', String(!!it.active));
            row.append(ICONS.check(), document.createTextNode(it.label));
            row.addEventListener('click', () => { it.onSelect(); close(); });
            menu.appendChild(row);
          }
        },
        destroy: () => {
          close();
          menu.removeEventListener('click', onMenuClick);
          menu.removeEventListener('keydown', onMenuKeydown);
          menu.removeEventListener('toggle', onToggle);
          document.removeEventListener('click', onDocClick);
          document.removeEventListener('keydown', onDocKeydown);
          window.removeEventListener('resize', onResize);
          menu.remove();
        },
      };
    };

    const qualityMenu = createToolMenu(tQuality.b);
    const speedMenu = createToolMenu(tSpeed.b);
    const audioTrackMenu = createToolMenu(tAudioTrack.b);

    const openQualityMenu = () => {
      const p = player();
      const levels = p && p.getAvailableQualityLevels ? p.getAvailableQualityLevels() : [];
      if (!levels.length) return;
      const cur = p.getPlaybackQuality ? p.getPlaybackQuality() : levels[0];
      const seen = new Set();
      const items = [];
      for (const lvl of levels) {
        if (lvl === 'auto' || seen.has(lvl)) continue;
        seen.add(lvl);
        items.push({
          label: QUALITY_LABELS[lvl] || lvl,
          active: lvl === cur,
          onSelect: () => {
            p.setPlaybackQualityRange?.(lvl, lvl);
            lsSet('itube-quality', lvl);
            syncTools();
            showOSD(ICONS.tools, QUALITY_LABELS[lvl] || lvl);
          },
        });
      }
      if (levels.includes('auto')) {
        items.unshift({
          label: 'Auto',
          active: cur === 'auto' || !cur,
          onSelect: () => {
            p.setPlaybackQualityRange?.('auto', 'auto');
            lsSet('itube-quality', 'auto');
            syncTools();
            showOSD(ICONS.tools, 'Auto');
          },
        });
      }
      qualityMenu.setItems(items, 'Quality');
      qualityMenu.toggle();
    };

    const openSpeedMenu = () => {
      const items = SPEEDS.map((rate) => ({
        label: rate + '×',
        active: rate === desiredRate,
        onSelect: () => {
          applyRate(rate);
          syncTools();
          showOSD(ICONS.speed, rate + '×');
        },
      }));
      speedMenu.setItems(items, 'Speed');
      speedMenu.toggle();
    };

    const signInHint = document.createElement('div');
    signInHint.className = 'watch-signin-hint';
    signInHint.style.display = 'none';
    const signInHintText = document.createElement('span');
    const signInHintLink = document.createElement('a');
    signInHintLink.className = 'signin-btn';
    signInHintLink.href = '/signin';
    signInHintLink.textContent = 'Sign in';
    signInHint.append(signInHintText, signInHintLink);

    const requireSignIn = (message) => {
      signInHintText.textContent = message;
      signInHint.style.display = '';
    };

    let actionsVideoId = null;
    let actionsChannelId = null;
    let liked = false;
    let disliked = false;
    let saved = false;
    let subscribed = false;
    let likeBusy = false;
    let saveBusy = false;
    let subscribeBusy = false;
    let shareBusy = false;
    let dislikeCountGeneration = 0;
    let stopGuideWait = null;
    let likeBaseNum = null;
    let dislikeBaseNum = null;
    let likeRawText = '';
    let initialLiked = false;
    let initialDisliked = false;

    const renderLikeCount = () => {
      likeLabel.textContent = likeBaseNum != null
        ? formatCompact(Math.max(0, likeBaseNum + (liked ? 1 : 0) - (initialLiked ? 1 : 0)))
        : likeRawText;
    };
    const renderDislikeCount = () => {
      if (dislikeBaseNum == null) return;
      dislikeLabel.textContent = formatCompact(Math.max(0, dislikeBaseNum + (disliked ? 1 : 0) - (initialDisliked ? 1 : 0)));
    };

    const setLikeUI = () => {
      likeBtn.classList.toggle('active', liked);
      likeBtn.setAttribute('aria-pressed', String(liked));
      dislikeBtn.classList.toggle('active', disliked);
      dislikeBtn.setAttribute('aria-pressed', String(disliked));
      renderLikeCount();
      renderDislikeCount();
    };
    const setSaveUI = () => {
      saveBtn.classList.toggle('active', saved);
      saveBtn.setAttribute('aria-pressed', String(saved));
      saveLabel.textContent = saved ? 'Saved' : 'Save';
    };
    const setSubscribeUI = () => {
      followBadge.replaceChildren(subscribed ? ICONS.check() : ICONS.plus());
      subscribeBtn.classList.toggle('subscribed', subscribed);
      subscribeBtn.setAttribute('aria-pressed', String(subscribed));
      subscribeLabel.textContent = subscribed ? 'Following' : 'Follow';
      subscribeBtn.title = subscribed ? 'Following — click to unfollow' : 'Follow this channel';
    };

    likeBtn.addEventListener('click', async () => {
      if (likeBtn.disabled || likeBusy || !actionsVideoId) return;
      if (loggedOut()) { requireSignIn('Sign in to like this video.'); return; }
      likeBusy = true;
      const wasLiked = liked;
      await runPending(likeBtn, async () => {
        const res = await innertube(wasLiked ? 'like/removelike' : 'like/like', { target: { videoId: actionsVideoId } });
        if (!likeConfirmed(res)) return;
        liked = !wasLiked;
        if (liked) disliked = false;
        setLikeUI();
      });
      likeBusy = false;
    });

    dislikeBtn.addEventListener('click', async () => {
      if (dislikeBtn.disabled || likeBusy || !actionsVideoId) return;
      if (loggedOut()) { requireSignIn('Sign in to dislike this video.'); return; }
      likeBusy = true;
      const wasDisliked = disliked;
      await runPending(dislikeBtn, async () => {
        const res = await innertube(wasDisliked ? 'like/removelike' : 'like/dislike', { target: { videoId: actionsVideoId } });
        if (!likeConfirmed(res)) return;
        disliked = !wasDisliked;
        if (disliked) liked = false;
        setLikeUI();
      });
      likeBusy = false;
    });

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled || saveBusy || !actionsVideoId) return;
      if (loggedOut()) { requireSignIn('Sign in to add this video to a playlist.'); return; }
      saveBusy = true;
      const want = !saved;
      await runPending(saveBtn, async () => {
        const action = want
          ? { action: 'ACTION_ADD_VIDEO', addedVideoId: actionsVideoId }
          : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: actionsVideoId };
        const res = await innertube('browse/edit_playlist', { playlistId: 'WL', actions: [action] });
        if (!playlistEditConfirmed(res)) return;
        saved = want;
        setSaveUI();
        wlMark(actionsVideoId, want);
      });
      saveBusy = false;
    });

    shareBtn.addEventListener('click', async () => {
      if (shareBtn.disabled || shareBusy || !actionsVideoId) return;
      shareBusy = true;
      try {
        await navigator.clipboard.writeText('https://www.youtube.com/watch?v=' + actionsVideoId);
        shareLabel.textContent = 'Copied';
        setTimeout(() => { shareLabel.textContent = 'Share'; }, 1500);
      } catch (e) {
        console.warn('[itube] copy share link failed', e);
      } finally {
        shareBusy = false;
      }
    });

    subscribeBtn.addEventListener('click', async () => {
      if (subscribeBtn.disabled || subscribeBusy || !actionsChannelId) return;
      if (loggedOut()) { requireSignIn('Sign in to follow this channel.'); return; }
      subscribeBusy = true;
      const channelId = actionsChannelId;
      const want = !subscribed;
      await runPending(subscribeBtn, async () => {
        const res = want
          ? await innertube('subscription/subscribe', { channelIds: [channelId], params: 'EgIIAg==' })
          : await innertube('subscription/unsubscribe', { channelIds: [channelId], params: 'CgIIAg==' });
        if (!subscribeConfirmed(res, want)) return;
        subscribed = want;
        setSubscribeUI();
        updateGuideOnSubscribeChange(channelId, want, channelName.textContent, avatar.src);
      });
      subscribeBusy = false;
    });

    toolsBtn.addEventListener('click', () => setToolsOpen(!toolsOpen));
    tAb.b.addEventListener('click', () => { cycleAb(); syncTools(); });
    tSpeed.b.setAttribute('aria-haspopup', 'menu');
    tSpeed.b.addEventListener('click', (e) => { e.stopPropagation(); openSpeedMenu(); });
    tQuality.b.setAttribute('aria-haspopup', 'menu');
    tQuality.b.addEventListener('click', (e) => { e.stopPropagation(); openQualityMenu(); });
    tCC.b.addEventListener('click', () => {
      player()?.toggleSubtitles?.();
      // Optimistic flip for instant feedback; the syncTools pass corrects it
      // from the player's real state (toggleSubtitles may be a no-op).
      const cc = ccActive(player());
      tCC.b.classList.toggle('active', cc === null ? !tCC.b.classList.contains('active') : cc);
    });
    // A list, not a cycle. This used to step blindly to the next track on
    // every click, so picking Ukrainian out of eleven dubs meant clicking
    // through the ones you did not want and reading the pill to find out where
    // you had landed. Same component as Speed and Quality, so it inherits the
    // checkmark, the heading and the keyboard handling.
    const openAudioMenu = () => {
      const p = player();
      if (!p || audioTracks.length < 2) return;
      const cur = typeof p.getAudioTrack === 'function' ? p.getAudioTrack() : null;
      const curId = audioMeta(cur)?.id;
      const items = audioTracks.map((track, i) => {
        const meta = audioMeta(track);
        return {
          label: meta?.name || `Track ${i + 1}`,
          active: !!meta?.id && meta.id === curId,
          onSelect: () => {
            p.setAudioTrack?.(track);
            syncTools();
            showOSD(ICONS.tools, meta?.name || 'Audio track');
          },
        };
      });
      audioTrackMenu.setItems(items, 'Audio');
      audioTrackMenu.toggle();
    };
    tAudioTrack.b.addEventListener('click', openAudioMenu);
    tAuto.b.addEventListener('click', () => {
      autoplayEnabled = !autoplayEnabled;
      lsSet('itube-autoplay', autoplayEnabled ? '1' : '0');
      root.classList.toggle('autoplay-on', autoplayEnabled);
      syncTools();
      showOSD(ICONS.tools, autoplayEnabled ? 'Autoplay on' : 'Autoplay off');
    });
    tSkip.b.addEventListener('click', () => {
      sbEnabled = !sbEnabled;
      setSponsorSkipOn(sbEnabled);
      if (sbEnabled) {
        sbVideoId = null;
        const vid = player()?.getVideoData?.()?.video_id;
        if (vid) sbLoad(vid);
      }
      syncTools();
      showOSD(ICONS.tools, sbEnabled ? 'Skip sponsors on' : 'Skip sponsors off');
    });
    tBoost.b.addEventListener('click', () => { cycleBoost(); syncTools(); });
    tAudio.b.addEventListener('click', () => {
      applyAudioOnly(!audioOnly);
      syncTools();
      showOSD(ICONS.tools, audioOnly ? 'Audio only on' : 'Audio only off');
    });

    const refreshActions = (data, details, ownerId) => {
      signInHint.style.display = 'none';
      actionsVideoId = resolveVideoId();
      // renderMeta already resolved the owner id (a full-tree walk) — reuse it.
      actionsChannelId = ownerId !== undefined ? ownerId : resolveOwnerChannelId(data, details);

      const likeState = readLikeState(data);
      liked = likeState.liked;
      disliked = likeState.disliked;
      initialLiked = likeState.liked;
      initialDisliked = likeState.disliked;
      likeRawText = likeState.likeCountText || '';
      likeBaseNum = parseCount(likeRawText);
      dislikeBaseNum = null;
      setLikeUI();

      dislikeLabel.textContent = '';
      dislikeBtn.title = '';
      const dislikeVideoId = actionsVideoId;
      const dislikeGen = ++dislikeCountGeneration;
      if (dislikeVideoId) {
        fetchDislikes(dislikeVideoId).then((count) => {
          if (dislikeGen !== dislikeCountGeneration) return;
          if (count === null) return;
          dislikeBaseNum = count;
          renderDislikeCount();
          dislikeBtn.title = 'Estimated dislikes · Return YouTube Dislike';
        });
      }

      // True membership, not just "came from the WL page": known instantly
      // when the session's WL set has loaded, refined async when it hasn't.
      const savedVideoId = actionsVideoId;
      saved = new URLSearchParams(location.search).get('list') === 'WL' || wlHas(savedVideoId) === true;
      setSaveUI();
      if (wlHas(savedVideoId) === null) {
        loadWlSet()?.then(() => {
          if (actionsVideoId !== savedVideoId) return;
          const m = wlHas(savedVideoId);
          if (m !== null && m !== saved) { saved = m; setSaveUI(); }
        });
      }

      if (stopGuideWait) { stopGuideWait(); stopGuideWait = null; }
      const channelId = actionsChannelId;
      const guideState = subscribedByGuide(channelId);
      subscribed = guideState === null ? readSubscribedState(data) : guideState;
      setSubscribeUI();
      if (guideState === null) {
        const gen = renderGeneration;
        stopGuideWait = onGuideReady(() => {
          if (gen !== renderGeneration || actionsChannelId !== channelId) return;
          const v = subscribedByGuide(channelId);
          if (v !== null) { subscribed = v; setSubscribeUI(); }
        });
      }

      likeBtn.disabled = !actionsVideoId;
      dislikeBtn.disabled = !actionsVideoId;
      saveBtn.disabled = !actionsVideoId;
      shareBtn.disabled = !actionsVideoId;
      subscribeBtn.disabled = !actionsChannelId;
    };

    const stats = document.createElement('div');
    stats.className = 'watch-stats';
    channelRow.appendChild(stats);
    const desc = document.createElement('div');
    desc.className = 'watch-description';
    const unavailable = document.createElement('div');
    unavailable.className = 'watch-unavailable';
    unavailable.textContent = "This video isn't available.";
    unavailable.style.display = 'none';

    const skeleton = document.createElement('div');
    skeleton.className = 'watch-skeleton';
    const skelChannel = document.createElement('div');
    skelChannel.className = 'watch-skeleton-channel';
    const skelAvatar = document.createElement('div');
    skelAvatar.className = 'watch-skeleton-avatar sk-shimmer';
    const skelLines = document.createElement('div');
    skelLines.className = 'watch-skeleton-lines';
    const skelName = document.createElement('div');
    skelName.className = 'watch-skeleton-bar sk-shimmer watch-skeleton-name';
    const skelSubs = document.createElement('div');
    skelSubs.className = 'watch-skeleton-bar sk-shimmer watch-skeleton-subs';
    skelLines.append(skelName, skelSubs);
    const skelPill = document.createElement('div');
    skelPill.className = 'watch-skeleton-pill sk-shimmer';
    skelChannel.append(skelAvatar, skelLines, skelPill);
    const skelActions = document.createElement('div');
    skelActions.className = 'watch-skeleton-actions';
    for (const w of [92, 108, 84]) {
      const pill = document.createElement('div');
      pill.className = 'watch-skeleton-action sk-shimmer';
      pill.style.width = w + 'px';
      skelActions.appendChild(pill);
    }
    skeleton.append(skelChannel);
    const skeletonBelow = document.createElement('div');
    skeletonBelow.className = 'watch-skeleton';
    skeletonBelow.append(skelActions);
    const SKELETON_ELS = [skeleton, skeletonBelow];

    const META_CONTENT_ELS = [channelRow, actions];
    let metaSkeletonVisible = false;

    const RELATED_SKELETON_COUNT = 6;
    const ensureRelatedSkeleton = () => {
      if (relatedWrap.firstElementChild?.classList.contains('rc-skel')) return;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < RELATED_SKELETON_COUNT; i++) frag.appendChild(createRelatedSkeleton());
      relatedWrap.replaceChildren(frag);
    };

    const showMetaSkeleton = () => {
      metaSkeletonVisible = true;
      unavailable.style.display = 'none';
      for (const contentEl of META_CONTENT_ELS) {
        contentEl.style.display = 'none';
        contentEl.style.opacity = '0';
      }
      for (const skelEl of SKELETON_ELS) {
        skelEl.style.opacity = '1';
        skelEl.style.display = 'flex';
      }
      ensureRelatedSkeleton();
    };

    const hideMetaSkeletonImmediate = () => {
      metaSkeletonVisible = false;
      for (const skelEl of SKELETON_ELS) skelEl.style.display = 'none';
      relatedWrap.replaceChildren();
    };

    const revealMetaContent = () => {
      for (const contentEl of META_CONTENT_ELS) contentEl.style.display = '';
      if (metaSkeletonVisible) {
        metaSkeletonVisible = false;
        for (const skelEl of SKELETON_ELS) skelEl.style.opacity = '0';
        setTimeout(() => {
          if (!metaSkeletonVisible) for (const skelEl of SKELETON_ELS) skelEl.style.display = 'none';
        }, 220);
      }
      requestAnimationFrame(() => {
        for (const contentEl of META_CONTENT_ELS) contentEl.style.opacity = '1';
        syncToolsChevron();
      });
    };

    const watchHead = document.createElement('div');
    watchHead.className = 'watch-head';
    watchHead.append(channelRow);
    meta.append(unavailable, skeleton, watchHead, signInHint);
    const watchBelow = document.createElement('div');
    watchBelow.className = 'watch-below';
    watchBelow.append(skeletonBelow, actions, toolsRow);
    showMetaSkeleton();

    const descPopup = makePopup('desc-popup');
    const descPopupWire = wirePopup(descPopup.overlay, descPopup.panel, null, descBtn);
    descPopup.panel.setAttribute('role', 'dialog');
    descPopup.panel.setAttribute('aria-modal', 'true');
    descPopup.panel.setAttribute('aria-labelledby', 'itube-desc-popup-title');
    const descPopupHeader = document.createElement('div');
    descPopupHeader.className = 'popup-header';
    const descPopupTitle = document.createElement('div');
    descPopupTitle.className = 'popup-title';
    descPopupTitle.id = 'itube-desc-popup-title';
    descPopupTitle.textContent = 'Description';
    const { btn: descPopupClose } = pillButton(ICONS.close, null, 'popup-close');
    descPopupClose.setAttribute('aria-label', 'Close');
    descPopupHeader.append(descPopupTitle, descPopupClose);
    const descPopupChips = document.createElement('div');
    descPopupChips.className = 'watch-desc-chips';
    descPopup.panel.append(descPopupHeader, descPopupChips, desc);
    descPopupClose.addEventListener('click', () => descPopupWire.close());

    const transcriptPopup = makePopup('transcript-popup');
    const transcriptPopupWire = wirePopup(transcriptPopup.overlay, transcriptPopup.panel, () => { transcriptExpanded = false; }, transcriptBtn);
    transcriptPopup.panel.setAttribute('role', 'dialog');
    transcriptPopup.panel.setAttribute('aria-modal', 'true');
    transcriptPopup.panel.setAttribute('aria-labelledby', 'itube-transcript-popup-title');
    const transcriptPopupHeader = document.createElement('div');
    transcriptPopupHeader.className = 'popup-header';
    const transcriptPopupTitle = document.createElement('div');
    transcriptPopupTitle.className = 'popup-title';
    transcriptPopupTitle.id = 'itube-transcript-popup-title';
    transcriptPopupTitle.textContent = 'Transcript';
    const transcriptStatus = document.createElement('div');
    transcriptStatus.className = 'transcript-status';
    const { btn: transcriptPopupClose } = pillButton(ICONS.close, null, 'popup-close');
    transcriptPopupClose.setAttribute('aria-label', 'Close');
    transcriptPopupHeader.append(transcriptPopupTitle, transcriptStatus, transcriptPopupClose);
    const transcriptSearch = document.createElement('input');
    transcriptSearch.type = 'text';
    transcriptSearch.className = 'transcript-search';
    transcriptSearch.placeholder = 'Search transcript';
    transcriptSearch.style.display = 'none';
    const transcriptBody = document.createElement('div');
    transcriptBody.className = 'transcript-body';
    transcriptPopup.panel.append(transcriptPopupHeader, transcriptSearch, transcriptBody);
    transcriptPopupClose.addEventListener('click', () => transcriptPopupWire.close());

    const openDescPopup = () => {
      transcriptPopupWire.close();
      descPopupWire.open();
    };
    const openTranscriptPopup = () => {
      descPopupWire.close();
      transcriptExpanded = true;
      transcriptPopupWire.open();
      loadTranscript(resolveVideoId());
      if (!transcriptLinesRendered && transcriptSegments.length) renderTranscriptLines();
    };
    descBtn.addEventListener('click', openDescPopup);
    transcriptBtn.addEventListener('click', openTranscriptPopup);

    const railTabs = document.createElement('div');
    railTabs.className = 'rail-tabs';
    railTabs.setAttribute('role', 'tablist');
    const { btn: tabUpNext } = pillButton(null, 'Up next', 'rail-tab');
    const { btn: tabComments, label: tabCommentsLabel } = pillButton(null, 'Comments', 'rail-tab');
    const commentsCount = document.createElement('span');
    commentsCount.className = 'comments-count';
    tabComments.appendChild(commentsCount);
    tabUpNext.classList.add('active');
    tabUpNext.id = 'itube-rail-tab-upnext';
    tabComments.id = 'itube-rail-tab-comments';
    tabUpNext.setAttribute('role', 'tab');
    tabComments.setAttribute('role', 'tab');
    tabUpNext.setAttribute('aria-selected', 'true');
    tabComments.setAttribute('aria-selected', 'false');
    tabUpNext.setAttribute('aria-controls', 'itube-rail-panel-upnext');
    tabComments.setAttribute('aria-controls', 'itube-rail-panel-comments');
    railTabs.append(tabUpNext, tabComments);
    railTabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const goTo = e.key === 'ArrowRight' ? 'comments' : 'upnext';
      if (goTo === 'comments' && tabComments.disabled) return;
      (goTo === 'upnext' ? tabUpNext : tabComments).focus();
      setRailTab(goTo);
    });

    const upNextPanel = document.createElement('div');
    upNextPanel.className = 'rail-panel up-next-panel';
    upNextPanel.id = 'itube-rail-panel-upnext';
    upNextPanel.setAttribute('role', 'tabpanel');
    upNextPanel.setAttribute('aria-labelledby', 'itube-rail-tab-upnext');
    upNextPanel.append(queueWrap, relatedWrap);

    const commentsSort = document.createElement('div');
    commentsSort.className = 'comments-sort';
    const commentsPanel = document.createElement('div');
    commentsPanel.className = 'comments rail-panel';
    commentsPanel.id = 'itube-rail-panel-comments';
    commentsPanel.setAttribute('role', 'tabpanel');
    commentsPanel.setAttribute('aria-labelledby', 'itube-rail-tab-comments');
    commentsPanel.style.display = 'none';
    const commentsList = document.createElement('div');
    commentsList.className = 'comments-list';
    const commentsSpinner = document.createElement('div');
    commentsSpinner.className = 'comments-spinner';
    commentsSpinner.textContent = 'Loading…';
    const commentsMore = document.createElement('button');
    commentsMore.className = 'comments-more';
    commentsMore.textContent = 'Show more comments';
    commentsMore.style.display = 'none';

    const composer = document.createElement('form');
    composer.className = 'comment-composer';
    const composerAvatar = document.createElement('img');
    composerAvatar.className = 'comment-avatar comment-composer-avatar';
    composerAvatar.alt = '';
    const composerBody = document.createElement('div');
    composerBody.className = 'comment-composer-body';
    const composerInput = document.createElement('textarea');
    composerInput.className = 'comment-composer-input';
    composerInput.rows = 1;
    composerInput.setAttribute('aria-label', 'Add a comment');
    const composerActions = document.createElement('div');
    composerActions.className = 'comment-composer-actions';
    const composerError = document.createElement('div');
    composerError.className = 'comment-composer-error';
    const composerCancel = document.createElement('button');
    composerCancel.type = 'button';
    composerCancel.className = 'comment-composer-btn';
    composerCancel.textContent = 'Cancel';
    const composerSubmit = document.createElement('button');
    composerSubmit.type = 'submit';
    composerSubmit.className = 'comment-composer-btn primary';
    composerSubmit.textContent = 'Comment';
    composerSubmit.disabled = true;
    composerActions.append(composerError, composerCancel, composerSubmit);
    composerBody.append(composerInput, composerActions);
    composer.append(composerAvatar, composerBody);

    const composerSignIn = document.createElement('div');
    composerSignIn.className = 'comment-signin';
    const composerSignInText = document.createElement('span');
    composerSignInText.textContent = 'Sign in to leave a comment.';
    const composerSignInLink = document.createElement('a');
    composerSignInLink.className = 'signin-btn';
    composerSignInLink.href = '/signin';
    composerSignInLink.textContent = 'Sign in';
    composerSignIn.append(composerSignInText, composerSignInLink);

    commentsPanel.append(commentsSort, composer, composerSignIn, commentsList, commentsSpinner, commentsMore);

    const setRailTab = (tab) => {
      if (tab === 'comments' && tabComments.disabled) return;
      tabUpNext.classList.toggle('active', tab === 'upnext');
      tabComments.classList.toggle('active', tab === 'comments');
      tabUpNext.setAttribute('aria-selected', String(tab === 'upnext'));
      tabComments.setAttribute('aria-selected', String(tab === 'comments'));
      const incoming = tab === 'upnext' ? upNextPanel : commentsPanel;
      const outgoing = tab === 'upnext' ? commentsPanel : upNextPanel;
      outgoing.style.display = 'none';
      outgoing.classList.remove('entering', 'entered');
      const wasHidden = incoming.style.display === 'none';
      incoming.style.display = '';
      if (wasHidden) {
        // One frame at the offset, then settle. Without the reflow-free rAF
        // the browser would coalesce both classes into a single style pass and
        // there would be nothing to animate from.
        incoming.classList.remove('entered');
        incoming.classList.add('entering');
        requestAnimationFrame(() => {
          incoming.classList.remove('entering');
          incoming.classList.add('entered');
        });
      }
      upNextPanel.setAttribute('aria-hidden', String(tab !== 'upnext'));
      commentsPanel.setAttribute('aria-hidden', String(tab !== 'comments'));
      if (tab === 'comments' && !commentsFetched && commentsToken) {
        commentsFetched = true;
        fetchComments(true);
      }
    };
    tabUpNext.addEventListener('click', () => setRailTab('upnext'));
    tabComments.addEventListener('click', () => setRailTab('comments'));

    watchRight.append(railTabs, upNextPanel, commentsPanel);

    const stageWrap = document.createElement('div');
    stageWrap.className = 'stage-wrap';
    stageWrap.append(stage);
    const headBlock = document.createElement('div');
    headBlock.className = 'watch-headblock';
    headBlock.append(title, meta);
    watchLeft.append(headBlock, stageWrap, watchBelow);
    watch.append(watchLeft, watchRight, descPopup.overlay, transcriptPopup.overlay);

    view.replaceChildren(watch);

    const buildDescriptionSegments = (secondary) => {
      try {
        const segs = buildAttributedSegments(secondary?.attributedDescription);
        if (segs) return segs;
        return buildRunsSegments(secondary?.description?.runs);
      } catch (e) {
        console.warn('[itube] description parse failed', e);
      }
      return null;
    };

    let currentDescSegments = null;
    let currentDescFallback = '';

    const renderDescription = (segments, fallbackText, interactive) => {
      desc.replaceChildren();
      if (segments && segments.length) {
        const currentId = resolveVideoId();
        for (const seg of segments) {
          if (!seg.text) continue;
          if (seg.url && interactive) {
            const a = document.createElement('a');
            a.className = 'watch-desc-link';
            a.href = seg.url;
            a.textContent = seg.text;
            if (seg.seconds != null && (!seg.videoId || seg.videoId === currentId)) {
              a.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                seekPlayerTo(seg.seconds);
              });
            } else {
              a.target = '_blank';
              a.rel = 'noopener';
            }
            desc.appendChild(a);
          } else {
            desc.appendChild(document.createTextNode(seg.text));
          }
        }
      } else {
        desc.textContent = fallbackText || '';
      }
    };

    const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
    const extractHashtags = (text) => {
      if (!text) return [];
      const seen = new Set();
      const out = [];
      for (const m of text.matchAll(HASHTAG_RE)) {
        const key = m[0].toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m[0]);
        if (out.length >= 6) break;
      }
      return out;
    };

    // Only the player has it: `next` carries no timestamp.
    const publishedAt = () => {
      try {
        const pr = player()?.getPlayerResponse?.();
        const want = resolveVideoId();
        if (!pr || !want || pr.videoDetails?.videoId !== want) return null;
        const iso = pr.microformat?.playerMicroformatRenderer?.publishDate;
        if (!iso) return null;
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? null : d;
      } catch (e) { return null; }
    };
    let lastStats = null;
    const refreshPublishedTime = () => {
      if (!lastStats || !publishedAt()) return;
      renderStatsLine(lastStats.viewsText, lastStats.dateText, lastStats.tags);
    };
    const renderStatsLine = (viewsText, dateText, tags) => {
      lastStats = { viewsText, dateText, tags };
      stats.replaceChildren();
      // "2,045,451 views" is YouTube's register; the quiet meta corner wants
      // "2M views". Full precision stays a hover away (title attribute).
      const n = parseCount(viewsText);
      const compactViews = Number.isFinite(n) && n > 0 ? formatCompact(n) + ' views' : viewsText;
      if (viewsText && compactViews !== viewsText) stats.title = viewsText;
      const when = publishedAt();
      const dateWithTime = when && dateText
        ? dateText + ', ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : dateText;
      const text = [compactViews, dateWithTime].filter(Boolean).join(' · ');
      if (text) {
        const t = document.createElement('span');
        t.className = 'watch-stats-text';
        t.textContent = text;
        stats.appendChild(t);
      }
      for (const tag of tags) {
        const a = document.createElement('a');
        a.className = 'watch-hashtag';
        a.href = '/results?search_query=' + encodeURIComponent(tag);
        a.textContent = tag;
        stats.appendChild(a);
      }
    };

    const resolveExternalDescUrl = (raw) => {
      if (!raw) return null;
      try {
        const abs = isHttpUrl(raw) ? raw : (raw.startsWith('//') ? 'https:' + raw : null);
        if (!abs) return null;
        const u = new URL(abs);
        if (/(^|\.)youtube\.com$/i.test(u.hostname) && u.pathname === '/redirect') {
          const q = u.searchParams.get('q');
          return q && isHttpUrl(q) ? q : null;
        }
        if (/(^|\.)(youtube\.com|youtu\.be|google\.com)$/i.test(u.hostname)) return null;
        return abs;
      } catch (e) {
        return null;
      }
    };

    const extractDescriptionLinks = (segments, fallbackText) => {
      const urls = [];
      const seen = new Set();
      const addRaw = (raw) => {
        const url = resolveExternalDescUrl(raw);
        if (!url || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
      };
      if (segments) for (const seg of segments) if (seg.url) addRaw(seg.url);
      const text = fallbackText || (segments ? segments.map((s) => s.text || '').join('') : '');
      for (const m of text.matchAll(/https?:\/\/\S+/g)) addRaw(m[0].replace(/[.,)>\]]+$/, ''));
      return urls.slice(0, 8);
    };

    const paintDescChips = (target, segments, fallbackText) => {
      target.replaceChildren();
      const urls = extractDescriptionLinks(segments, fallbackText);
      for (const url of urls) {
        let domain = url;
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {  }
        const a = document.createElement('a');
        a.className = 'watch-desc-chip';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.appendChild(ICONS.link());
        const label = document.createElement('span');
        label.textContent = domain;
        a.appendChild(label);
        target.appendChild(a);
      }
    };
    const renderDescChips = (segments, fallbackText) => {
      paintDescChips(descPopupChips, segments, fallbackText);
    };

    const playabilityStatus = (data) => (
      data?.playabilityStatus?.status
      || (data === window.ytInitialData ? window.ytInitialPlayerResponse?.playabilityStatus?.status : null)
      || null
    );

    const renderMeta = (data = window.ytInitialData) => {
      if (!data) return;
      const details = data === window.ytInitialData ? window.ytInitialPlayerResponse?.videoDetails : null;
      const primary = findNode(data, (n) => n?.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
      const secondary = findNode(data, (n) => n?.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
      const status = playabilityStatus(data);
      const hasVideo = !!(primary || secondary || details?.title);
      if ((status && status !== 'OK') || !hasVideo) {
        title.textContent = '';
        setTitle(null);
        hideMetaSkeletonImmediate();
        unavailable.style.display = '';
        channelRow.style.display = 'none';
        stats.replaceChildren();
        currentDescSegments = null;
        currentDescFallback = '';
        renderDescription(null, '', true);
        descPopupChips.replaceChildren();
        relatedWrap.replaceChildren();
        firstRelatedId = null;
        return;
      }
      title.textContent = getTitle(primary) || details?.title || '';
      if (title.textContent) {
        setTitle(title.textContent);
      }
      unavailable.style.display = 'none';
      const owner = secondary?.owner?.videoOwnerRenderer;
      const ownerName = owner?.title?.runs?.[0]?.text
        || owner?.attributedTitle?.content?.trim()
        || details?.author || '';
      if (!ownerName && data === window.ytInitialData) { showMetaSkeleton(); return; }
      revealMetaContent();
      channelName.textContent = ownerName;
      // Flyt's vocabulary is Follow/Following (see the nav) — mirror it in
      // the count. Only the English word is rewritten; localized payloads
      // keep their native phrasing.
      subs.textContent = (owner?.subscriberCountText?.simpleText
        || owner?.subscriberCountText?.accessibility?.accessibilityData?.label
        || findNode(owner, (n) => typeof n?.content === 'string' && /subscriber/i.test(n.content))?.content
        || '').replace(/\bsubscribers?\b/i, 'followers');
      const ownerId = resolveOwnerChannelId(data, details);
      const ownerHref = channelHrefFrom(owner?.navigationEndpoint)
        || channelHrefFrom(owner?.title?.runs?.[0]?.navigationEndpoint)
        || (ownerId ? '/channel/' + ownerId : null);
      if (ownerHref) channelName.href = ownerHref;
      else channelName.removeAttribute('href');
      const avatarUrl = getThumb(owner)
        || owner?.avatarStack?.avatarStackViewModel?.avatars?.[0]?.avatarViewModel?.image?.sources?.[0]?.url
        || null;
      if (avatarUrl) avatar.src = avatarUrl;
      else avatar.removeAttribute('src');
      refreshActions(data, details, ownerId);
      const viewsText = primary?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText
        || (details?.viewCount ? details.viewCount + ' views' : '');
      const dateText = primary?.dateText?.simpleText || '';
      const hashtags = extractHashtags([title.textContent, details?.shortDescription].filter(Boolean).join(' '));
      renderStatsLine(viewsText, dateText, hashtags);

      const descSegments = buildDescriptionSegments(secondary);
      const descFallback = details?.shortDescription || '';
      currentDescSegments = descSegments;
      currentDescFallback = descFallback;
      renderDescription(descSegments, descFallback, true);
      renderDescChips(descSegments, descFallback);
      descBtn.style.display = ((desc.textContent || '').trim() || descPopupChips.children.length) ? '' : 'none';

      const related = extractVideos(data, new Set(), thumbTarget(COMPACT_THUMB_W)).slice(0, 20);
      firstRelatedId = related[0]?.id || null;
      relatedWrap.replaceChildren();
      for (const item of related) relatedWrap.appendChild(createCompactCard(item));
      updateMediaSessionMetadata();
    };

    let currentPlaylist = null;
    let renderGeneration = 0;
    let lastNavHandledId = null;
    let firstRelatedId = null;

    const resolveNextId = () => {
      const p = player();
      const curId = p?.getVideoData?.()?.video_id;
      if (currentPlaylist) {
        const idx = currentPlaylist.items.findIndex((it) => it.id === curId);
        if (idx !== -1 && idx + 1 < currentPlaylist.items.length) {
          return { nextId: currentPlaylist.items[idx + 1].id, listId: currentPlaylist.id };
        }
        return { nextId: null, listId: null };
      }
      return { nextId: firstRelatedId, listId: null };
    };

    const resolvePrevId = () => {
      const p = player();
      const curId = p?.getVideoData?.()?.video_id;
      if (currentPlaylist) {
        const idx = currentPlaylist.items.findIndex((it) => it.id === curId);
        if (idx > 0) return { prevId: currentPlaylist.items[idx - 1].id, listId: currentPlaylist.id };
      }
      return { prevId: null, listId: null };
    };

    const updateMediaSessionMetadata = () => {
      if (!('mediaSession' in navigator)) return;
      try {
        const vid = resolveVideoId();
        if (!vid) return;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title.textContent || '',
          artist: channelName.textContent || '',
          artwork: [
            { src: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg', sizes: '320x180', type: 'image/jpeg' },
            { src: 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg', sizes: '480x360', type: 'image/jpeg' },
          ],
        });
      } catch (e) {}
    };

    const syncMediaSessionQueueActions = () => {
      if (!('mediaSession' in navigator)) return;
      try {
        const { prevId, listId: prevListId } = resolvePrevId();
        navigator.mediaSession.setActionHandler('previoustrack', prevId ? () => watchNav(prevId, prevListId) : null);
        const { nextId, listId } = resolveNextId();
        navigator.mediaSession.setActionHandler('nexttrack', nextId ? () => watchNav(nextId, listId) : null);
      } catch (e) {}
    };

    const setMediaSessionAvActions = () => {
      if (!('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.setActionHandler('play', () => setPlaying(true));
        navigator.mediaSession.setActionHandler('pause', () => setPlaying(false));
        navigator.mediaSession.setActionHandler('seekbackward', () => {
          if (wired) wired.currentTime = Math.max(0, wired.currentTime - 10);
        });
        navigator.mediaSession.setActionHandler('seekforward', () => {
          if (wired && isFinite(wired.duration)) wired.currentTime = Math.min(wired.duration, wired.currentTime + 10);
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (!wired || ui?.isLive || !isFinite(wired.duration)) return;
          if (details.fastSeek && wired.fastSeek) wired.fastSeek(details.seekTime);
          else wired.currentTime = details.seekTime;
        });
      } catch (e) {}
    };

    const renderQueuePanel = (videoId) => {
      queueWrap.replaceChildren();
      if (!currentPlaylist) return;
      const panel = document.createElement('div');
      panel.className = 'queue-panel';
      const qHeader = document.createElement('div');
      qHeader.className = 'queue-header';
      const qTitle = document.createElement('div');
      qTitle.className = 'queue-title';
      qTitle.textContent = currentPlaylist.title || 'Playlist';
      const qCount = document.createElement('div');
      qCount.className = 'queue-count';
      const idx = currentPlaylist.items.findIndex((it) => it.id === videoId);
      qCount.textContent = (idx === -1 ? 1 : idx + 1) + ' / ' + currentPlaylist.items.length;
      qHeader.append(qTitle, qCount);
      panel.appendChild(qHeader);
      const qList = document.createElement('div');
      qList.className = 'queue-list';
      for (const item of currentPlaylist.items) {
        const card = createCompactCard(item);
        card.classList.add('queue-item');
        const cardLink = /** @type {HTMLAnchorElement} */ (card.querySelector('.rc-link'));
        if (cardLink) cardLink.href = '/watch?v=' + encodeURIComponent(item.id) + '&list=' + encodeURIComponent(currentPlaylist.id);
        if (item.id === videoId) card.classList.add('current');
        qList.appendChild(card);
      }
      panel.appendChild(qList);
      queueWrap.appendChild(panel);
    };

    const updateQueue = async (videoId, prefetched) => {
      const listId = new URLSearchParams(location.search).get('list');
      if (!listId) {
        currentPlaylist = null;
        renderQueuePanel(videoId);
        syncMediaSessionQueueActions();
        return;
      }
      if (!currentPlaylist || currentPlaylist.id !== listId) {
        // renderWatchFor already fetched `next` with the playlistId — reuse
        // its response for the panel instead of refetching the endpoint.
        let panel = prefetched ? extractPlaylistPanel(prefetched) : null;
        if (!panel) {
          const gen = renderGeneration;
          const res = await innertube('next', { videoId, playlistId: listId });
          if (gen !== renderGeneration || listId !== new URLSearchParams(location.search).get('list')) return;
          panel = res ? extractPlaylistPanel(res) : null;
        }
        currentPlaylist = panel ? { id: listId, title: panel.title, items: panel.items } : null;
      }
      renderQueuePanel(videoId);
      syncMediaSessionQueueActions();
    };

    const mountedFromSpa = spaNav;
    if (!mountedFromSpa) {
      renderMeta();
      updateQueue(resolveVideoId());
    }

    let commentsToken = null;
    let commentsSeen = new Set();
    let commentsShown = 0;
    let commentsLoading = false;
    let commentsFetched = false;
    let commentsGeneration = 0;

    let composerParams = null;
    const setComposerOpen = (open) => {
      composer.classList.toggle('open', open);
      if (!open) composerError.textContent = '';
    };
    const clearComposerInput = () => {
      composerInput.value = '';
      composerInput.style.height = '';
      composerSubmit.disabled = true;
    };
    const resetComposer = () => {
      composerParams = null;
      clearComposerInput();
      setComposerOpen(false);
      composer.classList.remove('show');
      composerSignIn.classList.remove('show');
    };
    const applyComposerInfo = (info) => {
      composerParams = info ? info.params : null;
      if (info) {
        composerInput.placeholder = info.placeholder;
        composerSubmit.textContent = info.submitLabel;
        if (info.avatar) composerAvatar.src = info.avatar;
      }
      composer.classList.toggle('show', !!info);
      composerSignIn.classList.toggle('show', !info && loggedOut());
    };

    composerInput.addEventListener('focus', () => setComposerOpen(true));
    composerInput.addEventListener('input', () => {
      composerSubmit.disabled = !composerInput.value.trim();
      composerInput.style.height = 'auto';
      composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + 'px';
    });
    composerCancel.addEventListener('click', () => {
      clearComposerInput();
      setComposerOpen(false);
      composerInput.blur();
    });
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = composerInput.value.trim();
      if (!text || !composerParams || composerSubmit.disabled) return;
      const gen = commentsGeneration;
      const params = composerParams;
      composerSubmit.disabled = true;
      composerInput.disabled = true;
      composerError.textContent = '';
      let posted;
      try {
        posted = await postComment(params, text);
      } finally {
        composerInput.disabled = false;
      }
      if (gen !== commentsGeneration) return;
      if (!posted.ok) {
        composerError.textContent = 'Could not post that comment.';
        composerSubmit.disabled = false;
        return;
      }
      commentsList.prepend(createCommentRow(posted.item || {
        author: 'You',
        avatar: composerAvatar.src || null,
        published: 'now',
        textSegments: [{ text }],
      }));
      commentsShown++;
      clearComposerInput();
      setComposerOpen(false);
    });

    let transcriptGeneration = 0;
    let transcriptSegments = [];
    let transcriptLineEls = [];
    let transcriptLinesRendered = false;
    let transcriptActiveIndex = -1;
    let transcriptExpanded = false;
    let transcriptLoading = false;
    let transcriptLoadedId = null;

    const applyTranscriptFilter = () => {
      const q = transcriptSearch.value.trim().toLowerCase();
      transcriptLineEls.forEach((line, i) => {
        line.classList.toggle('hidden', !(!q || transcriptSegments[i].text.toLowerCase().includes(q)));
      });
    };
    transcriptSearch.addEventListener('input', applyTranscriptFilter);

    const renderTranscriptLines = () => {
      transcriptLinesRendered = true;
      transcriptBody.replaceChildren();
      transcriptActiveIndex = -1;
      transcriptLineEls = transcriptSegments.map((seg) => {
        const line = document.createElement('button');
        line.type = 'button';
        line.className = 'transcript-line';
        const time = document.createElement('span');
        time.className = 'transcript-time';
        time.textContent = fmt(seg.start);
        const text = document.createElement('span');
        text.className = 'transcript-text';
        text.textContent = seg.text;
        line.append(time, text);
        line.addEventListener('click', () => seekPlayerTo(seg.start));
        transcriptBody.appendChild(line);
        return line;
      });
      applyTranscriptFilter();
    };

    const findActiveTranscriptIndex = (t) => {
      let lo = 0, hi = transcriptSegments.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (transcriptSegments[mid].start <= t) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    };

    const resetTranscript = () => {
      transcriptGeneration++;
      transcriptLoading = false;
      transcriptLoadedId = null;
      transcriptBody.replaceChildren();
      transcriptLineEls = [];
      transcriptSegments = [];
      transcriptLinesRendered = false;
      transcriptActiveIndex = -1;
      transcriptExpanded = false;
      transcriptSearch.value = '';
      transcriptSearch.style.display = 'none';
      transcriptStatus.textContent = '';
      transcriptBtn.style.display = 'none';
      if (!transcriptEnabled()) return;
      const gen = transcriptGeneration;
      const videoId = resolveVideoId();
      loadTranscript(videoId).then(() => {
        if (gen !== transcriptGeneration) return;
        transcriptBtn.style.display = (transcriptLoadedId === videoId && transcriptSegments.length) ? '' : 'none';
      });
    };

    const waitForPlayerResponse = async (videoId, gen) => {
      const deadline = Date.now() + 3000;
      while (true) {
        const pres = player()?.getPlayerResponse?.();
        if (pres?.videoDetails?.videoId === videoId) return pres;
        if (window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) return window.ytInitialPlayerResponse;
        if (gen !== transcriptGeneration || Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    const transcriptProvedUnavailable = () => {
      transcriptBtn.style.display = 'none';
      if (transcriptExpanded) transcriptPopupWire.close();
    };

    const loadTranscript = async (videoId) => {
      if (!videoId || transcriptLoadedId === videoId || transcriptLoading) return;
      const gen = transcriptGeneration;
      transcriptLoading = true;
      transcriptSearch.style.display = 'none';
      transcriptStatus.textContent = 'Loading transcript…';
      const pres = await waitForPlayerResponse(videoId, gen);
      if (gen !== transcriptGeneration) return;
      const track = pickCaptionTrack(pres?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
      if (!track?.baseUrl) {
        transcriptLoading = false;
        if (pres) {
          transcriptLoadedId = videoId;
          transcriptStatus.textContent = 'Transcript unavailable';
          transcriptProvedUnavailable();
        } else {
          transcriptStatus.textContent = 'Transcript not ready — try again';
        }
        return;
      }
      const tr = await fetch(track.baseUrl + '&fmt=json3', { credentials: 'omit' }).catch(() => null);
      if (gen !== transcriptGeneration) return;
      if (!tr?.ok) {
        transcriptLoading = false;
        transcriptLoadedId = videoId;
        transcriptStatus.textContent = 'Transcript unavailable';
        transcriptProvedUnavailable();
        return;
      }
      const tj = await tr.json().catch(() => null);
      if (gen !== transcriptGeneration) return;
      const segments = parseJson3Transcript(tj);
      transcriptLoading = false;
      transcriptLoadedId = videoId;
      if (!segments.length) {
        transcriptStatus.textContent = 'Transcript unavailable';
        transcriptProvedUnavailable();
        return;
      }
      transcriptSegments = segments;
      transcriptStatus.textContent = '';
      // Building one <button> per segment is ~16k nodes on a 3h video — only
      // worth it once the popup is actually open. The opt-in eager load only
      // needs the segments array to decide button visibility.
      transcriptLinesRendered = false;
      if (transcriptExpanded) renderTranscriptLines();
      transcriptSearch.style.display = '';
    };

    const showCommentsOff = () => {
      tabCommentsLabel.textContent = 'Comments';
      commentsCount.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = 'Comments are turned off.';
      commentsList.replaceChildren(empty);
    };

    const fetchComments = async (initial) => {
      if (commentsLoading || !commentsToken || commentsShown >= MAX_COMMENTS) return;
      const gen = commentsGeneration;
      commentsLoading = true;
      commentsSpinner.classList.add('show');
      commentsMore.style.display = 'none';
      if (initial) commentsList.replaceChildren();
      try {
        const res = await innertube('next', { continuation: commentsToken });
        if (gen !== commentsGeneration) return;
        if (!res) {
          console.warn('[itube] comments fetch failed');
          commentsFetched = false;
          if (commentsShown === 0) {
            const failed = document.createElement('div');
            failed.className = 'comments-empty';
            failed.textContent = "Couldn't load comments.";
            commentsList.replaceChildren(failed);
          }
          commentsMore.style.display = commentsToken ? '' : 'none';
          return;
        }
        const refs = collectCommentsRefs(res);
        if (initial) {
          const label = countLabelFromHeader(refs.header);
          commentsCount.textContent = label ? ' · ' + label : '';
          applyComposerInfo(commentComposerInfo(refs.header));
        }
        const entityMap = commentEntityMap(res);
        const items = extractComments(res, entityMap, commentsSeen);
        commentsToken = commentsTokenFromRefs(refs, res);
        const page = initial ? COMMENTS_PAGE : (MAX_COMMENTS - commentsShown);
        const room = Math.min(page, MAX_COMMENTS - commentsShown);
        const batch = items.slice(0, Math.max(0, room));
        let appended = 0;
        for (let bi = 0; bi < batch.length; bi++) {
          if (gen !== commentsGeneration) break;
          commentsList.appendChild(createCommentRow(batch[bi]));
          appended++;
          if ((bi + 1) % 10 === 0) {
            await yieldTask();
            if (gen !== commentsGeneration) break;
          }
        }
        if (gen !== commentsGeneration) return;
        commentsShown += appended;
        if (initial && commentsShown === 0 && !commentsToken) {
          showCommentsOff();
          return;
        }
        commentsMore.style.display = (commentsToken && commentsShown < MAX_COMMENTS) ? '' : 'none';
      } finally {
        if (gen === commentsGeneration) {
          commentsLoading = false;
          commentsSpinner.classList.remove('show');
        }
      }
    };
    commentsMore.addEventListener('click', () => fetchComments(false));

    let sortOptions = [];
    let activeSortIndex = 0;
    const updateSortVisibility = () => {
      commentsSort.style.display = sortOptions.length ? 'flex' : 'none';
    };
    const renderSortPills = () => {
      commentsSort.replaceChildren();
      updateSortVisibility();
      if (!sortOptions.length) return;
      sortOptions.forEach((opt, i) => {
        const { btn } = pillButton(null, opt.label, 'comments-sort-btn');
        btn.classList.toggle('active', i === activeSortIndex);
        btn.setAttribute('aria-pressed', String(i === activeSortIndex));
        btn.addEventListener('click', () => {
          if (i === activeSortIndex || commentsLoading) return;
          activeSortIndex = i;
          renderSortPills();
          commentsList.replaceChildren();
          commentsSeen = new Set();
          commentsShown = 0;
          commentsToken = opt.token;
          commentsFetched = true;
          fetchComments(true);
        });
        commentsSort.appendChild(btn);
      });
    };

    const resetComments = (data = window.ytInitialData, fresh = true) => {
      commentsGeneration++;
      commentsList.replaceChildren();
      commentsSpinner.classList.remove('show');
      commentsMore.style.display = 'none';
      commentsSeen = new Set();
      commentsShown = 0;
      commentsLoading = false;
      commentsFetched = false;
      resetComposer();
      setRailTab('upnext');
      const commentsRefs = collectCommentsRefs(data);
      commentsToken = commentsTokenFromRefs(commentsRefs, data);
      const label = countLabelFromHeader(commentsRefs.header);
      tabCommentsLabel.textContent = commentsToken ? 'Comments' : (fresh ? 'Comments are turned off.' : 'Comments');
      commentsCount.textContent = (commentsToken && label) ? ' · ' + label : '';
      tabComments.disabled = !commentsToken;
      sortOptions = sortOptionsFromMenu(commentsRefs.sortMenu);
      activeSortIndex = 0;
      renderSortPills();
    };
    // On an SPA mount, window.ytInitialData is the BOOT page's payload (Home,
    // a channel, …) — scanning it for a comments token would wire the tab to
    // some unrelated continuation. Seed empty; renderWatchFor supplies the
    // real payload right after.
    resetComments(mountedFromSpa ? null : window.ytInitialData, !mountedFromSpa);
    resetTranscript();

    let chapters = parseChapters(mountedFromSpa ? null : window.ytInitialData);
    let storyboard = null;
    let previewRects = null;
    let storyboardTries = 0;
    let ui = null;
    let wired = null;
    let lastVideoId = null;
    // Drive playback through YouTube's player API, not just the raw <video>.
    // Pausing only the element leaves the player's own state machine at
    // "playing", and its controller reconciles by re-playing the element a
    // beat later — the "tap space, it stops for a moment then continues" bug.
    // pauseVideo()/playVideo() move that state so the pause actually sticks.
    // Declare the intent, then let the one reconciler issue the command — and
    // keep issuing it if the player argues back. The intent is recorded BEFORE
    // anything is sent, because reconcile also runs from this element's own
    // play/pause events and must see the new intent when they fire.
    const setPlaying = (shouldPlay) => {
      const v = wired;
      if (!v) return;
      setIntent(shouldPlay, { user: true });
      reconcilePlayback(v, { suspended: miniHandoffPending });
    };
    // No time-based dedup here: it used to eat a deliberate Space arriving
    // shortly after a play-button click (two DISTINCT gestures). The double
    // it guarded against — Space both activating the focused bar button and
    // hitting the keydown handler — is killed at the source instead: the
    // keydown path preventDefault()s (cancelling native space-activation)
    // and ignores key repeats.
    const togglePlayback = () => {
      const v = wired;
      if (!v) return;
      const willPlay = v.paused;
      setPlaying(willPlay);
      showOSD(willPlay ? ICONS.play : ICONS.pause, willPlay ? 'Playing' : 'Paused');
    };
    let adActive = false;
    let adStartedAt = 0;
    let adFrameSeen = false;
    let adFrameFlushed = false;
    let adLastTime = -1;
    let adEndNudgedAt = 0;
    let adRestoring = false;
    let adRestoreUntil = 0;
    let adObserver = null;
    let adObserved = null;
    const mountAbort = new AbortController();
    const bound = { signal: mountAbort.signal };
    document.addEventListener('click', (e) => {
      if (!toolsOpen) return;
      const t = /** @type {Node} */ (e.target);
      if (toolsRow.contains(t) || toolsBtn.contains(t)) return;
      setToolsOpen(false);
    }, bound);
    window.addEventListener('resize', () => {
      if (toolsOpen) positionTools();
      else syncToolsChevron();
    }, bound);
    syncToolsChevron();
    let autoplayEnabled = lsGet('itube-autoplay') !== '0';
    // Drives the NEXT tag on the first Up-next poster — it only tells the
    // truth while autoplay will actually play that card.
    root.classList.toggle('autoplay-on', autoplayEnabled);
    let sbEnabled = sponsorSkipOn();
    let sbSegments = [];
    let sbVideoId = null;
    let sbAbort = null;
    const sbCache = new Map();
    // Hygiene cap: one entry per distinct video in a watch session; evict the
    // oldest (Map preserves insertion order) past 50.
    const sbCacheSet = (id, segs) => {
      if (sbCache.size >= 50 && !sbCache.has(id)) sbCache.delete(sbCache.keys().next().value);
      sbCache.set(id, segs);
    };
    const SB_CATS = ['sponsor', 'selfpromo', 'interaction'];
    const sbLoad = async (videoId) => {
      if (!sbEnabled) return;
      if (!videoId || videoId === sbVideoId) return;
      sbVideoId = videoId;
      sbSegments = [];
      renderSbMarkers();
      if (sbCache.has(videoId)) { sbSegments = sbCache.get(videoId); renderSbMarkers(); return; }
      try {
        if (sbAbort) sbAbort.abort();
        sbAbort = new AbortController();
        const to = setTimeout(() => sbAbort.abort(), 5000);
        const prefix = (await sha256Hex(videoId)).slice(0, 4);
        const url = 'https://sponsor.ajay.app/api/skipSegments/' + prefix + '?categories=' + encodeURIComponent(JSON.stringify(SB_CATS)) + '&actionType=skip';
        const res = await fetch(url, { credentials: 'omit', signal: sbAbort.signal });
        clearTimeout(to);
        if (!res.ok) { sbCacheSet(videoId, []); return; }
        const data = await res.json();
        if (sbVideoId !== videoId) return;
        const segs = [];
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (!entry || entry.videoID !== videoId || !Array.isArray(entry.segments)) continue;
            for (const s of entry.segments) {
              if (s && s.actionType === 'skip' && Array.isArray(s.segment) && s.segment.length === 2) {
                segs.push({ start: +s.segment[0], end: +s.segment[1], category: s.category });
              }
            }
          }
        }
        segs.sort((a, b) => a.start - b.start);
        sbCacheSet(videoId, segs);
        sbSegments = segs;
        renderSbMarkers();
      } catch (e) {}
    };
    const SB_COLORS = { sponsor: '#00d46a', selfpromo: '#ffd000', interaction: '#c14bff' };
    // adActive, like renderTicks: during an ad the <video>'s duration is the
    // AD's (~20s) while sbSegments still hold content timestamps (up to hours),
    // so start/dur*100 came out in the thousands of percent and parked markers
    // ~35,000px off-screen. Percentages are also clamped and out-of-range
    // segments dropped, so a duration that is merely unexpected — rather than
    // an ad — still cannot place a marker outside the bar.
    const renderSbMarkers = () => {
      if (!ui || adActive) return;
      ui.seekwrap.querySelectorAll('.itube-sb-marker').forEach((m) => m.remove());
      const video = stage.querySelector('video');
      const dur = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      if (!dur || !sbSegments.length) return;
      for (const s of sbSegments) {
        const start = Math.max(0, Math.min(dur, s.start));
        const end = Math.max(start, Math.min(dur, s.end));
        if (end <= start) continue;
        const m = document.createElement('div');
        m.className = 'itube-sb-marker';
        m.style.left = (start / dur * 100) + '%';
        m.style.width = ((end - start) / dur * 100) + '%';
        m.style.background = SB_COLORS[s.category] || '#00d46a';
        ui.seekwrap.appendChild(m);
      }
    };
    const sbSkipCheck = (video) => {
      if (!sbEnabled || !sbSegments.length || !video || video.paused) return;
      const t = video.currentTime;
      for (const s of sbSegments) {
        if (t >= s.start && t < s.end - 0.4) {
          video.currentTime = s.end;
          if (typeof showOSD === 'function') showOSD(ICONS.next, 'Skipped ' + (s.category === 'selfpromo' ? 'self-promo' : s.category));
          break;
        }
      }
    };
    let desiredRate = (() => { const v = parseFloat(lsGet('itube-speed')); return v >= 0.1 && v <= 5 ? v : 1; })();
    const applyRate = (rate) => {
      rate = Math.min(5, Math.max(0.1, rate));
      desiredRate = rate;
      const video = stage.querySelector('video');
      if (video) video.playbackRate = rate;
      if (rate <= 2) player()?.setPlaybackRate?.(rate);
      lsSet('itube-speed', String(rate));
    };
    let boost = savedBoost();
    let boostCtx = null;
    const boostGain = new WeakMap();
    const boostGraphs = [];
    const BOOST_STEPS = [1, 1.25, 1.5, 2];
    const ensureBoostGraph = (video) => {
      if (!video) return null;
      if (boostGain.has(video)) return boostGain.get(video);
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        if (!boostCtx) boostCtx = new Ctor();
        const src = boostCtx.createMediaElementSource(video);
        const gain = boostCtx.createGain();
        src.connect(gain);
        gain.connect(boostCtx.destination);
        boostGain.set(video, gain);
        boostGraphs.push({ src, gain });
        return gain;
      } catch (e) { return null; }
    };
    const applyBoost = (video) => {
      if (boost <= 1) {
        if (video && boostGain.has(video)) boostGain.get(video).gain.value = 1;
        return;
      }
      const gain = ensureBoostGraph(video);
      if (!gain) return;
      if (boostCtx && boostCtx.state === 'suspended') boostCtx.resume().catch(() => {});
      gain.gain.value = boost;
    };
    const cycleBoost = () => {
      const i = BOOST_STEPS.indexOf(boost);
      boost = BOOST_STEPS[(i + 1) % BOOST_STEPS.length];
      setSavedBoost(boost);
      applyBoost(stage.querySelector('video'));
      showOSD(ICONS.vol, boost > 1 ? 'Boost ' + Math.round(boost * 100) + '%' : 'Boost off');
    };
    const captureFrame = () => {
      const video = stage.querySelector('video');
      if (!video || !video.videoWidth) return;
      try {
        const c = document.createElement('canvas');
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          if (!blob) { showOSD(ICONS.camera, 'Capture unavailable'); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const vid = player()?.getVideoData?.()?.video_id || 'frame';
          a.download = 'itube-' + vid + '-' + Math.floor(video.currentTime) + 's.png';
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          showOSD(ICONS.camera, 'Frame saved');
        }, 'image/png');
      } catch (e) {
        showOSD(ICONS.camera, 'Capture unavailable');
      }
    };
    const audioOnlyPref = () => lsGet('itube-audio-only') === '1';
    const setAudioOnlyPref = (on) => lsSet('itube-audio-only', on ? '1' : '0');
    let audioOnly = audioOnlyPref();
    let audioOnlyPrevQuality = null;
    if (audioOnly) stage.classList.add('audio-only');
    const applyAudioOnlyArt = () => {
      const vid = player()?.getVideoData?.()?.video_id;
      const poster = vid ? 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg' : '';
      stageAudioArt.src = poster;
      stageAudioBack.style.backgroundImage = poster ? 'url(' + poster + ')' : '';
      stageAudioTitle.textContent = title.textContent || '';
    };
    const applyAudioOnly = (on) => {
      audioOnly = on;
      setAudioOnlyPref(on);
      stage.classList.toggle('audio-only', on);
      applyAudioOnlyArt();
      const p = player();
      try {
        if (on) {
          audioOnlyPrevQuality = p?.getPlaybackQuality?.() || audioOnlyPrevQuality;
          p?.setPlaybackQualityRange?.('tiny', 'tiny');
        } else {
          const q = lsGet('itube-quality') || audioOnlyPrevQuality || 'auto';
          if (q && q !== 'auto') p?.setPlaybackQualityRange?.(q, q);
        }
      } catch (e) {}
      if (toolsOpen) syncTools();
    };
    let abA = null;
    let abB = null;
    // Same ad-timeline hazard as renderSbMarkers: abA/abB are content times.
    const renderAbMarkers = () => {
      if (!ui || adActive) return;
      ui.seekwrap.querySelectorAll('.itube-ab-marker, .itube-ab-region').forEach((m) => m.remove());
      const video = stage.querySelector('video');
      const dur = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      if (!dur) return;
      const pos = (t) => Math.max(0, Math.min(100, t / dur * 100));
      if (abA != null && abB != null && abB > abA) {
        const region = document.createElement('div');
        region.className = 'itube-ab-region';
        region.style.left = pos(abA) + '%';
        region.style.width = Math.max(0, pos(abB) - pos(abA)) + '%';
        ui.seekwrap.appendChild(region);
      }
      for (const [val, cls] of [[abA, 'a'], [abB, 'b']]) {
        if (val == null) continue;
        const m = document.createElement('div');
        m.className = 'itube-ab-marker itube-ab-' + cls;
        m.style.left = pos(val) + '%';
        ui.seekwrap.appendChild(m);
      }
    };
    const clearAb = () => { abA = null; abB = null; renderAbMarkers(); syncTools(); };
    const cycleAb = () => {
      const video = stage.querySelector('video');
      if (!video) return;
      if (abA == null) {
        abA = video.currentTime;
        showOSD(ICONS.loop, 'Loop start set');
      } else if (abB == null) {
        if (video.currentTime > abA + 0.2) { abB = video.currentTime; showOSD(ICONS.loop, 'A–B loop on'); }
        else { showOSD(ICONS.loop, 'Loop end must be after start'); }
      } else {
        abA = null; abB = null; showOSD(ICONS.loop, 'Loop off');
      }
      renderAbMarkers();
      syncTools();
    };
    let theaterOn = false;
    // Persisted: which of the two the user prefers is a lasting preference,
    // not a per-video one.
    let showRemaining = lsGet('itube-time-remaining') !== '0';
    // Assigned once the player context menu exists; consulted first by
    // closeTopOverlay so Escape dismisses the menu before it exits theater.
    let closeCtxMenu = null;
    let theaterBtn = null;

    const THEATER_ENTER_MS = 180;
    const THEATER_EXIT_MS = 220;
    let theaterScrim = null;
    let theaterWait = null;
    // What the in-flight sequence is heading TOWARDS. While the scrim is up the
    // class has not swapped yet, so `theaterOn` still reads the old value.
    let theaterTarget = null;

    const clearTheaterScrim = () => {
      if (theaterWait) { theaterWait.cancel(); theaterWait = null; }
      theaterTarget = null;
      if (theaterScrim) { theaterScrim.remove(); theaterScrim = null; }
    };

    const applyTheaterInstant = (on) => {
      theaterOn = !!on;
      root.classList.toggle('theater', theaterOn);
      if (theaterBtn) theaterBtn.classList.toggle('active', theaterOn);
      setTheaterPref(theaterOn);
    };

    const applyTheater = (on) => {
      // Theater is a PAGE layout mode, and native fullscreen already fills the
      // screen with the stage — so while fullscreen it changes nothing you can
      // see. Worse than a no-op, in fact: the enter/exit scrim is appended to
      // document.body, i.e. outside the fullscreen element, so it never
      // renders, while the layout swap and the persisted itube-theater pref
      // both still happen. You would then leave fullscreen and land in a mode
      // you never knowingly chose. Ignore it instead; the 't' shortcut and the
      // toolbar button both route through here.
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      const next = !!on;
      // Dedup against the in-flight TARGET, not just the applied state: while
      // the scrim is up `theaterOn` is still the old value, so a second click
      // restarted the whole sequence and could hold the app under an opaque
      // scrim for as long as the user kept clicking.
      if (next === (theaterTarget == null ? theaterOn : theaterTarget)) return;
      if (miniFlying) { pendingTheater = next; return; }
      if (prefersReducedMotion()) { clearTheaterScrim(); applyTheaterInstant(next); return; }
      clearTheaterScrim();
      theaterTarget = next;
      const scrim = document.createElement('div');
      scrim.className = 'itube-theater-scrim';
      document.body.appendChild(scrim);
      theaterScrim = scrim;
      requestAnimationFrame(() => { scrim.style.opacity = '1'; });
      // Swap the layout when the scrim is ACTUALLY opaque. The ordering is
      // load-bearing — .content's overflow has to change behind full cover or
      // a scrollbar flashes — and a timer could fire on either side of that.
      theaterWait = afterTransition(scrim, 'opacity', THEATER_ENTER_MS + 500, () => {
        theaterTarget = null;
        applyTheaterInstant(next);
        scrim.style.transition = `opacity ${THEATER_EXIT_MS}ms ease`;
        scrim.style.opacity = '0';
        theaterWait = afterTransition(scrim, 'opacity', THEATER_EXIT_MS + 500, () => {
          theaterWait = null;
          if (theaterScrim === scrim) { scrim.remove(); theaterScrim = null; }
        });
      });
    };

    const toggleFullscreen = () => {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (stage.requestFullscreen) {
        stage.requestFullscreen({ navigationUI: 'hide' });
      } else {
        stage.webkitRequestFullscreen();
      }
      showOSD(ICONS.fs, active ? 'Exit Fullscreen' : 'Fullscreen');
    };

    const togglePiP = (video) => {
      if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else {
        video.requestPictureInPicture?.();
      }
    };

    let osdTimer = null;
    // Apple's volume slider shows a filled track, not an empty groove — the
    // "broken" look was a bare channel with the thumb parked at one end. Same
    // technique the seek bar already uses: one inline background write, no
    // style reads, so it stays a pure write on the compositor's side.
    const paintVol = () => {
      if (!ui || !ui.vol) return;
      const pct = Math.max(0, Math.min(100, Number(ui.vol.value) || 0));
      ui.vol.style.background = 'linear-gradient(to right, rgba(255,255,255,.92) 0%, rgba(255,255,255,.92) '
        + pct + '%, rgba(255,255,255,.22) ' + pct + '%, rgba(255,255,255,.22) 100%)';
    };

    // Text only, and iconFn is deliberately ignored. The OSD used to render a
    // big glyph over a blurred slab in the middle of the frame — directly on
    // top of the play button once the transport moved to the centre, so every
    // pause covered the control you had just pressed. It is now a quiet line
    // of text at the top; the param stays so the call sites keep reading as
    // "what happened", and announce() still carries it to screen readers.
    const showOSD = (iconFn, label) => {
      if (!ui) return;
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      ui.cue.replaceChildren(labelEl);
      ui.cue.classList.add('show');
      clearTimeout(osdTimer);
      osdTimer = setTimeout(() => ui.cue.classList.remove('show'), 700);
      announce(label);
    };

    let clickTimer = null;
    stage.addEventListener('click', (e) => {
      if (/** @type {Element} */ (e.target).closest(PLAYER_CHROME_SEL)) return;
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
        if (v) {
          const willPlay = v.paused;
          setPlaying(willPlay);
          showOSD(willPlay ? ICONS.play : ICONS.pause, willPlay ? 'Playing' : 'Paused');
        }
      }, 220);
    });
    stage.addEventListener('dblclick', (e) => {
      if (/** @type {Element} */ (e.target).closest(PLAYER_CHROME_SEL)) return;
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleFullscreen();
    });

    // Player context menu.
    //
    // Without this, right-clicking the stage raises SAFARI'S native <video>
    // menu — Show Controls, Enter Viewer, Show Media Statistics — which offers
    // to drive a player Flyt has already taken over, and leaks the fact that
    // there is a raw <video> under the app.
    //
    // It is a child of #itube-stage on purpose: toggleFullscreen() fullscreens
    // the stage, and only the fullscreen element's subtree renders, so a menu
    // parented anywhere else would vanish exactly when it is most wanted. That
    // also means it must clamp itself to the stage box rather than the
    // viewport — the stage clips its own corners.
    //
    // Every entry proxies the button that already implements it. No second
    // code path for PiP/fullscreen/theater/frame-export to drift out of sync.
    // el() assigns an ID; this one is styled and matched by CLASS (it is in
    // PLAYER_CHROME_SEL), so build it directly.
    // What is playing, shown only when the page around the player is gone.
    // In the inline layout the title is right underneath the video, so this
    // would just be a duplicate; in theater and fullscreen there is nothing
    // else on screen telling you what you are watching.
    const stageMeta = document.createElement('div');
    stageMeta.className = 'itube-stage-meta';
    const stageMetaChannel = document.createElement('div');
    stageMetaChannel.className = 'itube-stage-meta-channel';
    const stageMetaTitle = document.createElement('div');
    stageMetaTitle.className = 'itube-stage-meta-title';
    stageMeta.append(stageMetaChannel, stageMetaTitle);
    stage.appendChild(stageMeta);
    const syncStageMeta = () => {
      const t = document.querySelector('#itube .watch-title');
      const c = document.querySelector('#itube .watch-channel-name');
      stageMetaTitle.textContent = t ? t.textContent : '';
      stageMetaChannel.textContent = c ? c.textContent : '';
    };
    stage.addEventListener('mouseenter', syncStageMeta, { passive: true, ...bound });
    document.addEventListener('fullscreenchange', syncStageMeta, bound);
    document.addEventListener('webkitfullscreenchange', syncStageMeta, bound);
    syncStageMeta();

    const ctxMenu = document.createElement('div');
    ctxMenu.className = 'itube-ctx';
    ctxMenu.setAttribute('role', 'menu');
    stage.appendChild(ctxMenu);

    const shortLink = (withTime) => {
      const id = new URLSearchParams(location.search).get('v');
      if (!id) return null;
      // Built here rather than taken from YouTube's share sheet, which appends
      // ?si=<tracking>. A bare youtu.be/<id> is the shortest clean form.
      let url = 'https://youtu.be/' + id;
      if (withTime) {
        const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
        const t = v && isFinite(v.currentTime) ? Math.floor(v.currentTime) : 0;
        if (t > 0) url += '?t=' + t;
      }
      return url;
    };

    const copyText = async (text, label) => {
      try {
        await navigator.clipboard.writeText(text);
        showOSD(ICONS.link, label);
      } catch (e) {
        showOSD(ICONS.link, 'Could not copy');
      }
    };

    const closeCtx = () => ctxMenu.classList.remove('open');
    // Escape is owned by closeTopOverlay's priority stack, which runs on a
    // keydown handler that calls stopImmediatePropagation — a separate
    // listener of our own would be racing it (and losing).
    closeCtxMenu = () => {
      if (!ctxMenu.classList.contains('open')) return false;
      closeCtx();
      return true;
    };

    const ctxItems = () => {
      const fsOn = !!(document.fullscreenElement || document.webkitFullscreenElement);
      return [
        { label: 'Copy link', run: () => { const u = shortLink(false); if (u) copyText(u, 'Link copied'); } },
        { label: 'Copy link at current time', run: () => { const u = shortLink(true); if (u) copyText(u, 'Link copied'); } },
        { sep: true },
        { label: 'Picture in Picture', run: () => ui.pip.click() },
        { label: fsOn ? 'Exit Full Screen' : 'Enter Full Screen', run: () => ui.fs.click() },
        // Omitted, not disabled: a dead entry invites the click that does
        // nothing. See applyTheater for why it cannot work here.
        ...(fsOn ? [] : [{ label: theaterOn ? 'Exit Theater' : 'Enter Theater', run: () => ui.theater.click() }]),
        { sep: true },
        { label: 'Save frame', run: () => ui.shot.click() },
      ];
    };

    const openCtx = (clientX, clientY) => {
      ctxMenu.replaceChildren();
      for (const item of ctxItems()) {
        if (item.sep) {
          const hr = document.createElement('div');
          hr.className = 'itube-ctx-sep';
          ctxMenu.appendChild(hr);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tool-menu-item';
        b.setAttribute('role', 'menuitem');
        b.textContent = item.label;
        b.addEventListener('click', () => { closeCtx(); item.run(); });
        ctxMenu.appendChild(b);
      }
      // Measure once it has content, then clamp inside the stage.
      ctxMenu.classList.add('open');
      const s = stage.getBoundingClientRect();
      const m = ctxMenu.getBoundingClientRect();
      const pad = 6;
      let x = clientX - s.left;
      let y = clientY - s.top;
      x = Math.max(pad, Math.min(x, s.width - m.width - pad));
      y = Math.max(pad, Math.min(y, s.height - m.height - pad));
      ctxMenu.style.left = x + 'px';
      ctxMenu.style.top = y + 'px';
    };

    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY);
    });
    // Capture, so a click on any control still dismisses the menu first.
    document.addEventListener('pointerdown', (e) => {
      if (ctxMenu.classList.contains('open') && !(/** @type {Element} */ (e.target)).closest('.itube-ctx')) closeCtx();
    }, { capture: true, ...bound });
    content.addEventListener('scroll', closeCtx, { passive: true, ...bound });

    const renderTicks = () => {
      if (!ui || adActive) return;
      const video = wired;
      const dur = video?.duration;
      for (const t of ui.seekwrap.querySelectorAll('.itube-tick')) t.remove();
      if (!isFinite(dur) || !dur || chapters.length < 2) return;
      if (chapters[chapters.length - 1].start > dur) return;
      for (const ch of chapters) {
        if (!ch.start || ch.start >= dur) continue;
        const t = document.createElement('div');
        t.className = 'itube-tick';
        t.style.left = (ch.start / dur * 100) + '%';
        ui.seekwrap.appendChild(t);
      }
    };

    const updatePreview = (frac) => {
      const sb = storyboard;
      if (adActive) return;
      if (!sb || !ui || !wired || !isFinite(wired.duration) || !wired.duration) return;
      const t = frac * wired.duration;
      const per = sb.interval > 0 ? sb.interval : (wired.duration * 1000) / sb.count;
      const idx = Math.min(sb.count - 1, Math.floor((t * 1000) / per));
      const perSprite = sb.rows * sb.cols;
      const within = idx % perSprite;
      const src = sb.url.replace('$M', String(Math.floor(idx / perSprite)));
      if (ui.preview.dataset.src !== src) {
        ui.preview.dataset.src = src;
        ui.preview.style.backgroundImage = 'url("' + src + '")';
      }
      ui.preview.style.backgroundPosition =
        (-(within % sb.cols) * sb.w) + 'px ' + (-Math.floor(within / sb.cols) * sb.h) + 'px';
      positionPreview(frac);
      ui.ptime.textContent = fmt(t);
      setChapterLabel(t);
    };

    // The chapter the given time falls in — chapters are ordered, so the last
    // one that starts at or before t wins.
    const chapterAt = (t) => {
      let found = null;
      for (const ch of chapters) {
        if (ch.start <= t + 0.001) found = ch;
        else break;
      }
      return found;
    };

    const setChapterLabel = (t) => {
      if (!ui) return;
      const ch = chapters.length > 1 ? chapterAt(t) : null;
      const title = ch && ch.title ? ch.title : '';
      if (ui.pchapter.textContent !== title) ui.pchapter.textContent = title;
      ui.pchapter.classList.toggle('show', !!title);
    };

    // ui.preview now lives in stageWrap (a sibling of the clipped #itube-stage,
    // see buildBar's `previewLayer` param) instead of inside ui.seekwrap, so it
    // can float above the video's top edge uncropped. That means it can no
    // longer rely on CSS percentages/px offsets that assumed it was a
    // descendant of the seekwrap it tracks — position it in pixels instead,
    // by comparing the seekwrap's rect to its own offset parent's (stageWrap).
    const positionPreview = (frac) => {
      const layerRect = previewRects ? previewRects.layer : stageWrap.getBoundingClientRect();
      const seekRect = previewRects ? previewRects.seek : ui.seekwrap.getBoundingClientRect();
      const x = seekRect.left - layerRect.left + frac * seekRect.width;
      const bottom = layerRect.bottom - seekRect.bottom + 24;
      ui.preview.style.left = x + 'px';
      ui.preview.style.bottom = bottom + 'px';
      // Sits directly on top of the sprite, tracking the same x. Height comes
      // from the storyboard spec rather than a layout read, so this stays
      // write-only per pointermove.
      ui.pchapter.style.left = x + 'px';
      ui.pchapter.style.bottom = (bottom + ((storyboard && storyboard.h) || 90) + 6) + 'px';
    };

    const paintSeek = (video) => {
      if (!ui || adActive || !isFinite(video.duration) || !video.duration) return;
      const played = video.currentTime / video.duration * 100;
      let buffered = 0;
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= video.currentTime && video.currentTime <= b.end(i)) {
          buffered = b.end(i) / video.duration * 100;
          break;
        }
      }
      // The sweep spans the PLAYED region, so its middle stop has to sit at
      // half of `played` rather than at a fixed 50% of the bar.
      const mid = played / 2;
      // backgroundImage, never the `background` shorthand: the shorthand resets
      // background-clip to border-box on every repaint, which silently undid
      // the content-box clip that keeps the rail thin inside its padded hit row
      // and painted the gradient across the whole 26px target instead.
      ui.seek.style.backgroundImage = `linear-gradient(to right, var(--grad-1) 0%, var(--grad-2) ${mid}%, var(--grad-3) ${played}%, rgba(255,255,255,.34) ${played}%, rgba(255,255,255,.34) ${buffered}%, rgba(255,255,255,.14) ${buffered}%)`;
    };

    const savedVolume = () => Math.max(0, Math.min(100, Number(lsGet('itube-volume')) || 100));
    const savedMuted = () => lsGet('itube-muted') === '1';

    const restoreUserVolume = (p) => {
      const vol = savedVolume();
      const muted = savedMuted();
      if (typeof p.setVolume === 'function') p.setVolume(vol);
      if (muted) p.mute?.(); else p.unMute?.();
      const v = stage.querySelector('video');
      if (v) v.muted = muted;
      if (ui) {
        ui.vol.value = muted ? 0 : vol;
        ui.mute.replaceChildren(muted ? ICONS.muted() : ICONS.vol());
      }
    };

    // `v` is the already-located <video> when called from tick(); the
    // MutationObserver path passes mutation records instead, so re-query then.
    const syncAdState = (v) => {
      const p = player();
      if (!p) return;
      const video = (v instanceof HTMLVideoElement && v.isConnected)
        ? v
        : (stage.querySelector('video') || document.querySelector('#itube-mini video') || document.querySelector('#movie_player video'));
      if (adShowing()) {
        if (!adActive) {
          adActive = true;
          adStartedAt = Date.now();
          adFrameSeen = false;
          adFrameFlushed = false;
          adLastTime = -1;
          adEndNudgedAt = 0;
          stage.classList.add('ad');
        }
        p.mute?.();
        if (video && !video.muted) video.muted = true;
        killAd(video);
        // WebKit ad wedge: killAd's seek lands at the ad's duration, but a
        // stream that never buffered (readyState < 2) never fires 'ended'
        // there — so YouTube's ad state machine waits forever and Safari
        // shows a stuck black ad. Nudge it with the event it is waiting for.
        // (Chromium fires the real 'ended' on the same seek, so this never
        // triggers there.)
        if (video && isFinite(video.duration) && video.duration > 0
          && video.currentTime >= video.duration - 0.05 && video.readyState < 2
          && Date.now() - adStartedAt > 1500 && Date.now() - adEndNudgedAt > 1500) {
          adEndNudgedAt = Date.now();
          video.dispatchEvent(new Event('ended'));
        }
        if (video) {
          if (video.readyState >= 2) adFrameSeen = true;
          else if (adFrameSeen) adFrameFlushed = true;
        }
        const paintable = !!video && video.readyState >= 2 && !adFrameFlushed;
        const now = video ? video.currentTime : 0;
        const advancing = !!video && !video.paused && !video.ended && now > adLastTime + 0.05;
        adLastTime = now;
        const stuck = Date.now() - adStartedAt > AD_BLANK_MAX_MS;
        stage.classList.toggle('ad', !adFrameFlushed && !(stuck && (!paintable || advancing)));
        return;
      }
      if (adActive) {
        adActive = false;
        adFrameSeen = false;
        adFrameFlushed = false;
        adRestoring = true;
        adRestoreUntil = Date.now() + AD_RESTORE_MS;
        stage.classList.remove('ad');
        renderTicks();
        if (video) paintSeek(video);
      }
      if (!adRestoring) return;
      if (Date.now() > adRestoreUntil) {
        adRestoring = false;
        return;
      }
      const vol = savedVolume();
      const muted = savedMuted();
      const liveVol = typeof p.getVolume === 'function' ? Math.round(p.getVolume()) : vol;
      const liveMuted = typeof p.isMuted === 'function' ? p.isMuted() : muted;
      const playing = !!video && video.readyState >= 2 && !video.paused;
      if (liveVol === vol && liveMuted === muted && playing) {
        adRestoring = false;
        return;
      }
      restoreUserVolume(p);
    };

    let showBar = () => {};
    const wireBar = (p, video) => {
      ui.live.addEventListener('click', () => {
        const v = wired || video;
        if (p.seekToLiveHead) p.seekToLiveHead();
        else if (isFinite(v.duration)) v.currentTime = v.duration - 2;
      });


      // Rects are read once on pointerenter, not per pointermove — reading
      // them between updatePreview's style writes forced a synchronous layout
      // on every mouse move along the seekbar.
      ui.seekwrap.addEventListener('pointerenter', () => {
        previewRects = null;
        if (storyboard && !ui.isLive) ui.preview.style.display = 'block';
      });
      ui.seekwrap.addEventListener('pointerleave', () => {
        ui.preview.style.display = 'none';
        ui.pchapter.classList.remove('show');
        previewRects = null;
      });
      ui.seekwrap.addEventListener('pointermove', (e) => {
        if (ui.preview.style.display === 'none') return;
        if (!previewRects) {
          previewRects = { seek: ui.seekwrap.getBoundingClientRect(), layer: stageWrap.getBoundingClientRect() };
        }
        const rect = previewRects.seek;
        updatePreview(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      });

      ui.prev.addEventListener('click', () => {
        const { prevId, listId } = resolvePrevId();
        if (prevId) watchNav(prevId, listId);
      });
      ui.next.addEventListener('click', () => {
        const { nextId, listId } = resolveNextId();
        if (nextId) watchNav(nextId, listId);
      });
      ui.play.addEventListener('click', () => togglePlayback());
      ui.seek.addEventListener('pointerdown', () => { ui.scrubbing = true; });
      ui.seek.addEventListener('change', () => {
        const v = wired || video;
        if (isFinite(v.duration)) v.currentTime = v.duration * ui.seek.value / 1000;
        ui.scrubbing = false;
      });
      ui.mute.addEventListener('click', () => { setMuted(!isMuted()); });
      ui.vol.addEventListener('input', () => { setPlayerVolume(Number(ui.vol.value)); });
      ui.pip.addEventListener('click', () => togglePiP(wired || video));
      ui.shot.addEventListener('click', () => captureFrame());
      ui.fs.addEventListener('click', () => toggleFullscreen());
      theaterBtn = ui.theater;
      theaterBtn.addEventListener('click', () => applyTheater(!theaterOn));
      applyTheaterInstant(theaterPref());
      setMediaSessionAvActions();

      const isImmersive = () => theaterOn || !!(document.fullscreenElement || document.webkitFullscreenElement);
      const IDLE_MS = 2800;
      const IDLE_MS_IMMERSIVE = 3000;
      let hideTimer = null;
      showBar = () => {
        stage.classList.add('show');
        watchLeft.classList.remove('itube-cursor-hide');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (wired && !wired.paused && !ui.bar.matches(':hover')) {
            stage.classList.remove('show');
            if (isImmersive()) watchLeft.classList.add('itube-cursor-hide');
          }
        }, isImmersive() ? IDLE_MS_IMMERSIVE : IDLE_MS);
      };
      // Ignore mousemove events that did not actually move the pointer.
      // Hiding the chrome flips the floating capsules to visibility:hidden /
      // pointer-events:none, and dropping an interactive element out of
      // hit-testing under a stationary pointer synthesises a mousemove — which
      // called showBar() straight back, so the bar could never stay hidden
      // (and the cursor never hid in theater/fullscreen). Real movement always
      // changes a coordinate; this synthetic one never does.
      let lastMoveX = -1;
      let lastMoveY = -1;
      stage.addEventListener('mousemove', (e) => {
        if (e.clientX === lastMoveX && e.clientY === lastMoveY) return;
        lastMoveX = e.clientX;
        lastMoveY = e.clientY;
        showBar();
      }, { passive: true });
      stage.addEventListener('mouseleave', () => {
        clearTimeout(hideTimer);
        watchLeft.classList.remove('itube-cursor-hide');
        if (wired && !wired.paused) stage.classList.remove('show');
      }, { passive: true });
    };

    // Bind the transport listeners that live on the <video> ELEMENT (as
    // opposed to the bar's own controls, wired once in wireBar). YouTube can
    // swap in a fresh <video> mid-session — tick() already anticipates that
    // (`wired !== video`) for ratechange/ended/volumechange, but these used to
    // be bound once in wireBar to whatever element existed first, so after a
    // swap the seekbar froze and the play icon desynced while sound played on.
    // Called from the tick rebind branch for EVERY newly adopted element.
    const wireVideoEl = (video) => {
      if (!ui) return;
      // A play we did not ask for (YouTube's hotkey manager, its watchdog, an
      // ad transition) disagrees with the intent and gets undone; a play we
      // DID ask for agrees and passes straight through. One call, both cases.
      video.addEventListener('play', () => {
        reconcilePlayback(video, { suspended: miniHandoffPending });
        if (userWantsPaused() && !adActive) return;
        ui.play.replaceChildren(ICONS.pause());
        showBar();
        updateMediaSessionMetadata();
      }, bound);
      video.addEventListener('loadedmetadata', () => {
        if (watchApi) refreshPublishedTime();
      }, bound);
      // The half that was missing entirely: a pause we did not ask for — the
      // player's controller reasserting its own state a beat after our
      // playVideo() — is put back here, in the same task, rather than being
      // left for a tick that may be up to 500ms away or never come.
      video.addEventListener('pause', () => {
        ui.play.replaceChildren(ICONS.play());
        showBar();
        updateMediaSessionMetadata();
        reconcilePlayback(video, { suspended: miniHandoffPending });
      }, bound);
      // Position -> UI. Bound to `seeking`/`seeked` as well as `timeupdate`,
      // because timeupdate STOPS while a seek re-buffers: jump somewhere
      // unbuffered and the clock and the bar sat at the old position until
      // playback resumed, so a scrub read as "nothing happened" and then
      // lurched. The requested position should show immediately.
      // Apple shows time REMAINING (-42:03), not total length: while you are
      // watching, "how much is left" is the question you actually have. Click
      // the right-hand timecode to switch back to total duration.
      const paintDuration = () => {
        if (!isFinite(video.duration) || video.duration <= 0) return;
        ui.timeDur.textContent = showRemaining
          ? '\u2212' + fmt(Math.max(0, video.duration - video.currentTime))
          : fmt(video.duration);
      };
      const paintPosition = () => {
        if (adActive) { killAd(video); return; }
        if (abA != null && abB != null && video.currentTime >= abB) { video.currentTime = abA; }
        ui.timeCur.textContent = fmt(video.currentTime);
        paintDuration();
        if (!ui.scrubbing && isFinite(video.duration) && video.duration > 0) {
          ui.seek.value = Math.round(video.currentTime / video.duration * 1000);
        }
        if (ui.isLive) {
          ui.live.classList.toggle('behind', video.duration - video.currentTime > 12);
        }
        paintSeek(video);
        if (transcriptExpanded && transcriptSegments.length) {
          const idx = findActiveTranscriptIndex(video.currentTime);
          if (idx !== transcriptActiveIndex) {
            if (transcriptActiveIndex >= 0) transcriptLineEls[transcriptActiveIndex]?.classList.remove('active');
            transcriptActiveIndex = idx;
            if (idx >= 0) transcriptLineEls[idx]?.classList.add('active');
          }
        }
      };
      video.addEventListener('timeupdate', paintPosition, bound);
      video.addEventListener('seeking', paintPosition, bound);
      video.addEventListener('seeked', paintPosition, bound);
      video.addEventListener('durationchange', () => {
        if (adActive) { killAd(video); return; }
        paintDuration();
        renderTicks();
        renderSbMarkers();
        renderAbMarkers();
      }, bound);
      video.addEventListener('progress', () => paintSeek(video), bound);
      ui.play.replaceChildren(video.paused ? ICONS.play() : ICONS.pause());
      if (!ui.timeDur.dataset.wired) {
        ui.timeDur.dataset.wired = '1';
        ui.timeDur.style.cursor = 'pointer';
        ui.timeDur.title = 'Show total duration / time remaining';
        ui.timeDur.addEventListener('click', () => {
          showRemaining = !showRemaining;
          lsSet('itube-time-remaining', showRemaining ? '1' : '0');
          paintDuration();
        }, bound);
      }
      ui.timeCur.textContent = fmt(video.currentTime);
      paintDuration();
      ui.vol.value = video.muted ? 0 : Math.round(video.volume * 100);
    };

    const onNavigateFinish = (e) => {
      const data = e.detail?.response?.response || e.detail?.response || window.ytInitialData;
      const dataId = data?.currentVideoEndpoint?.watchEndpoint?.videoId
        || data?.playerResponse?.videoDetails?.videoId;
      const currentId = resolveVideoId();
      if (dataId && dataId !== currentId) return;
      if (currentId && currentId === lastNavHandledId) return;
      lastNavHandledId = currentId;
      chapters = parseChapters(data);
      renderMeta(data);
      renderTicks();
      resetComments(data);
      resetTranscript();
      updateQueue(currentId, data);
    };
    window.addEventListener('yt-navigate-finish', onNavigateFinish);

    // Read-only diagnostics for the playback state machine — this is how
    // "pause didn't stick" reports get debugged without guessing (the state
    // that matters lives in closures a console can't reach).
    window.__flytWatchState = () => ({
      userPaused: userWantsPaused(),
      intent,
      intentMsLeft: intent === null ? null : Math.max(0, intentUntil - Date.now()),
      intentCorrections,
      wired: !!wired,
      wiredIsStage: !!wired && wired === stage.querySelector('video'),
      adActive,
      desiredRate,
      storedSpeed: lsGet('itube-speed'),
      actionsChannelId,
      miniHandoffPending,
    });

    const tick = () => {
      const video = stage.querySelector('video') || document.querySelector('#itube-mini video') || document.querySelector('#movie_player video');
      const p = player();
      if (!video || !p) return;
      if (video.hasAttribute('controls')) video.removeAttribute('controls');
      if (video.disablePictureInPicture) video.disablePictureInPicture = false;
      if (!miniHandoffPending) {
        adoptVideo(stage);
        adoptCaptions(stage);
      }
      fit(video);
      if (!ui) {
        ui = buildBar(stage, stageWrap);
        wireBar(p, video);
      }

      if (adObserved !== p) {
        adObserver?.disconnect();
        adObserver = new MutationObserver(syncAdState);
        adObserver.observe(p, { attributes: true, attributeFilter: ['class'] });
        adObserved = p;
      }
      syncAdState(video);
      // Backstop for BOTH directions: the event-driven reconcile is bound to a
      // specific <video>, so anything landing on a freshly swapped element
      // slips through until the rebind. WebKit swaps elements often enough to
      // hit that window; this closes it within one tick either way.
      reconcilePlayback(video, { suspended: miniHandoffPending });
      if (toolsOpen) syncTools();
      if (video) sbSkipCheck(video);
      if (video && !adActive && video.playbackRate !== desiredRate) video.playbackRate = desiredRate;

      const vid = p.getVideoData?.()?.video_id;
      if (vid) sbLoad(vid);
      if (vid && vid !== lastVideoId) {
        if (miniFlying && vid !== flyVideoId && miniFlyCancel) miniFlyCancel();
        lastVideoId = vid;
        miniDismissed = false;
        const saved = lsGet('itube-quality');
        if (saved && saved !== 'auto') p.setPlaybackQualityRange?.(saved, saved);
        if (video) video.playbackRate = desiredRate;
        ui.prev.style.display = p.getPlaylist?.()?.length ? '' : 'none';
        ui.isLive = !!p.getVideoData?.()?.isLive;
        ui.live.style.display = ui.isLive ? '' : 'none';
        ui.timeDur.style.display = ui.isLive ? 'none' : '';
        storyboard = null;
        storyboardTries = 0;
        ui.preview.style.display = 'none';
        ui.preview.dataset.src = '';
        ui.pchapter.classList.remove('show');
        renderTicks();
        clearAb();
        if (audioOnly) { applyAudioOnlyArt(); p.setPlaybackQualityRange?.('tiny', 'tiny'); }
        if (toolsOpen) syncTools();
      }

      if (!storyboard && storyboardTries < MAX_STORYBOARD_TRIES) {
        storyboardTries++;
        storyboard = parseStoryboard(p);
        if (storyboard) {
          ui.preview.style.width = storyboard.w + 'px';
          ui.preview.style.height = storyboard.h + 'px';
        }
      }

      if (wired === video) return;
      wired = video;
      wireVideoEl(video);

      video.playbackRate = desiredRate;
      video.addEventListener('ratechange', () => {
        if (adActive) return;
        if (video.playbackRate !== desiredRate) video.playbackRate = desiredRate;
      }, bound);
      video.addEventListener('ended', () => {
        if (!autoplayEnabled) return;
        // Ads share this <video> element with the content, so an ad's own
        // 'ended' — and the synthetic one syncAdState dispatches to unwedge
        // WebKit's stuck ad state machine — both land here. Without this
        // guard a pre-roll navigated straight to the NEXT video: the user
        // clicked A, the ad finished, autoplay-next fired, and B started
        // playing while a second history entry made Back land on A instead
        // of the feed. Every sibling handler on this element (ratechange,
        // timeupdate, durationchange) already bails on adActive; this one
        // was the exception.
        if (adActive) return;
        const curId = p.getVideoData?.()?.video_id;
        let nextId = null;
        let listId = null;
        if (currentPlaylist) {
          const idx = currentPlaylist.items.findIndex((it) => it.id === curId);
          if (idx !== -1 && idx + 1 < currentPlaylist.items.length) {
            nextId = currentPlaylist.items[idx + 1].id;
            listId = currentPlaylist.id;
          }
        } else {
          nextId = firstRelatedId;
        }
        if (nextId) watchNav(nextId, listId);
      }, bound);

      let saveTimer = null;
      const storedMuted = savedMuted();
      const initialVol = savedVolume();

      const applyVolume = () => {
        if (typeof p.setVolume !== 'function') return;
        p.setVolume(initialVol);
        if (storedMuted || adActive) p.mute?.(); else p.unMute?.();
      };
      applyVolume();
      setTimeout(applyVolume, 800);

      if (ui) {
        ui.vol.value = storedMuted ? 0 : initialVol;
        ui.mute.replaceChildren(storedMuted ? ICONS.muted() : ICONS.vol());
      }

      video.addEventListener('volumechange', () => {
        if (adActive || adRestoring) return;
        const pv = typeof p.getVolume === 'function' ? Math.round(p.getVolume()) : Math.round(video.volume * 100);
        const muted = typeof p.isMuted === 'function' ? p.isMuted() : video.muted;
        if (ui) {
          ui.vol.value = muted ? 0 : pv;
          ui.mute.replaceChildren(muted ? ICONS.muted() : ICONS.vol());
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          lsSet('itube-muted', muted ? '1' : '0');
          if (!muted && pv > 0) lsSet('itube-volume', String(pv));
        }, 300);
      }, bound);

      applyBoost(video);
    };
    tick();
    const timer = setInterval(tick, 500);

    const finishMiniHandoff = () => {
      if (!miniFlying) return;
      clearTimeout(miniFlySafety);
      miniFlying = false;
      miniFlyCancel = null;
      mini.style.transition = '';
      mini.style.transform = '';
      mini.style.transformOrigin = '';
      mini.style.pointerEvents = '';
      miniBar.style.opacity = '';
      miniHandoffPending = false;
      adoptVideo(stage);
      adoptCaptions(stage);
      const v = stage.querySelector('video');
      if (v) fit(v);
      deactivateMini();
      if (miniFlyAnim) { const a = miniFlyAnim; miniFlyAnim = null; a.cancel(); }
      if (pendingTheater !== null) {
        const t = pendingTheater;
        pendingTheater = null;
        applyTheater(t);
      }
    };
    if (fromMini) {
      miniFlying = true;
      miniFlyCancel = finishMiniHandoff;
      miniBar.style.opacity = '0';
      mini.style.pointerEvents = 'none';
      const startRect = mini.getBoundingClientRect();
      if (prefersReducedMotion()) {
        finishMiniHandoff();
      } else {
        // The stage can still be laying out on the first frame after mount —
        // WebKit regularly reports a zero rect there, which used to bail to
        // an instant (teleporting) handoff. Give layout a few frames before
        // giving up on the fly.
        let flyTries = 0;
        const tryFly = () => {
          if (!miniFlying) return;
          const stageEl = document.getElementById('itube-stage');
          const target = stageEl ? stageEl.getBoundingClientRect() : null;
          if (!target || target.width < 8 || target.height < 8) {
            if (++flyTries < 15) { requestAnimationFrame(tryFly); return; }
            finishMiniHandoff();
            return;
          }
          const dx = target.left - startRect.left;
          const dy = target.top - startRect.top;
          const sx = target.width / startRect.width;
          const sy = target.height / startRect.height;
          // CSS transition, NOT mini.animate(): YouTube's web-animations
          // polyfill (loaded on Safari) hijacks animate() and completes
          // instantly — the mini teleported into the stage instead of flying.
          mini.style.transformOrigin = 'top left';
          mini.style.transition = 'transform 400ms cubic-bezier(.22, .61, .36, 1)';
          mini.getBoundingClientRect(); // commit start state before transitioning
          mini.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
          mini.addEventListener('transitionend', function onFlyEnd(e) {
            if (e.propertyName !== 'transform') return;
            mini.removeEventListener('transitionend', onFlyEnd);
            finishMiniHandoff();
          });
          miniFlySafety = setTimeout(finishMiniHandoff, 520);
        };
        requestAnimationFrame(tryFly);
      }
    }

    const HANDLED_KEYS = new Set(KEYBOARD_SHORTCUTS.flatMap((s) => s.keys));

    const closeTopOverlay = () => {
      if (closeCtxMenu && closeCtxMenu()) return true;
      if (descPopup.overlay.classList.contains('show')) { descPopupWire.close(); return true; }
      if (transcriptPopup.overlay.classList.contains('show')) { transcriptPopupWire.close(); return true; }
      if (qualityMenu.isOpen()) { qualityMenu.close(); return true; }
      if (audioTrackMenu.isOpen()) { audioTrackMenu.close(); return true; }
      if (speedMenu.isOpen()) { speedMenu.close(); return true; }
      if (acctOpen) { closeAcctMenu(); return true; }
      if (settingsOverlay.classList.contains('open')) { closeSettings(); return true; }
      if (cmdkOverlay.classList.contains('open')) { closeCmdk(); return true; }
      if (toolsOpen) { setToolsOpen(false); return true; }
      if (theaterOn) { applyTheater(false); return true; }
      return false;
    };

    const onKeydown = (e) => {
      if (e.key === 'Escape' && closeTopOverlay()) {
        e.stopImmediatePropagation();
        return;
      }
      // Playback shortcuts are bare keys (shift is fine: '<' '>'), never
      // chords — without this, ⌘K toggled playback underneath the palette.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || (target.tagName === 'BUTTON' && !target.closest(PLAYER_CHROME_SEL)))) {
        // Not ours to handle here — but a bare Space must still never reach
        // YouTube's hotkey manager (it would toggle the parked player under
        // us). stopPropagation only: the default action (button activation,
        // typing the space) is unaffected.
        if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
        return;
      }
      const video = wired;
      if (!video) return;
      showBar();
      if (HANDLED_KEYS.has(e.key)) e.stopImmediatePropagation();
      switch (e.key) {
        case ' ':
        case 'k':
          // preventDefault also cancels native space-activation of a focused
          // bar button — without it one keystroke would toggle twice (the
          // button's click AND this handler). Held-key repeats don't strobe.
          e.preventDefault();
          if (!e.repeat) togglePlayback();
          break;
        case 'j':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          showOSD(ICONS.seekBack, '⟲ 10s');
          break;
        case 'l':
          e.preventDefault();
          if (isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
          showOSD(ICONS.seekFwd, '⟳ 10s');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          showOSD(ICONS.seekBack, '⟲ 5s');
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 5);
          showOSD(ICONS.seekFwd, '⟳ 5s');
          break;
        case 'ArrowUp': {
          e.preventDefault();
          const nv = setPlayerVolume(playerVolume() + 5);
          showOSD(ICONS.vol, nv + '%');
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          const nv = setPlayerVolume(playerVolume() - 5);
          showOSD(ICONS.vol, nv + '%');
          break;
        }
        case 'm': {
          const m = !isMuted();
          setMuted(m);
          showOSD(m ? ICONS.muted : ICONS.vol, m ? 'Muted' : playerVolume() + '%');
          break;
        }
        case 'f':
          toggleFullscreen();
          break;
        case 't':
          e.preventDefault();
          applyTheater(!theaterOn);
          showOSD(ICONS.theater, theaterOn ? 'Theater on' : 'Theater off');
          break;
        case 'c': {
          const p = player();
          p?.toggleSubtitles?.();
          break;
        }
        case 'i':
          togglePiP(video);
          break;
        case '0': case '1': case '2': case '3': case '4':
        case '5': case '6': case '7': case '8': case '9':
          e.preventDefault();
          if (isFinite(video.duration)) {
            video.currentTime = video.duration * (Number(e.key) / 10);
            // Every other seek/volume key confirms itself on the OSD; the
            // digit jumps were the one silent shortcut.
            showOSD(ICONS.seekFwd, Number(e.key) * 10 + '%');
          }
          break;
        case ',':
          if (video.paused) { video.currentTime = Math.max(0, video.currentTime - 1 / 30); showOSD(ICONS.seekBack, 'Frame ◀'); }
          break;
        case '.':
          if (video.paused && isFinite(video.duration)) { video.currentTime = Math.min(video.duration, video.currentTime + 1 / 30); showOSD(ICONS.seekFwd, 'Frame ▶'); }
          break;
        case '[': {
          const v = stage.querySelector('video');
          if (v) { abA = v.currentTime; if (abB != null && abB <= abA) abB = null; renderAbMarkers(); syncTools(); showOSD(ICONS.loop, 'Loop start set'); }
          break;
        }
        case ']': {
          const v = stage.querySelector('video');
          if (v && abA != null && v.currentTime > abA + 0.2) { abB = v.currentTime; renderAbMarkers(); syncTools(); showOSD(ICONS.loop, 'A–B loop on'); }
          break;
        }
        case '\\':
          clearAb();
          showOSD(ICONS.loop, 'Loop off');
          break;
        case '<': {
          const idx = SPEEDS.indexOf(desiredRate);
          const next = SPEEDS[Math.max(0, (idx === -1 ? SPEEDS.indexOf(1) : idx) - 1)];
          applyRate(next);
          showOSD(ICONS.speed, next + '×');
          break;
        }
        case '>': {
          const idx = SPEEDS.indexOf(desiredRate);
          const next = SPEEDS[Math.min(SPEEDS.length - 1, (idx === -1 ? SPEEDS.indexOf(1) : idx) + 1)];
          applyRate(next);
          showOSD(ICONS.speed, next + '×');
          break;
        }
        case '/':
          e.preventDefault();
          search.focus();
          break;
        case 'Escape':
          break;
        default:
          break;
      }
    };
    // WINDOW capture, not document: the capture path visits window first, so
    // this always runs before the parked ytd-app's own hotkey handlers no
    // matter when/where they registered — and stopImmediatePropagation then
    // genuinely suppresses them. On document, YouTube's earlier-registered
    // capture handler ran FIRST: a real (trusted) Space press toggled the
    // player twice — YouTube paused, Flyt saw "paused" and flipped it straight
    // back to playing. (Synthetic test events never showed this: YouTube
    // ignores untrusted events.)
    window.addEventListener('keydown', onKeydown, true);

    const onVisibility = () => {
      if (boostCtx && document.visibilityState === 'visible' && boostCtx.state === 'suspended') boostCtx.resume().catch(() => {});
      if (audioOnly && document.visibilityState === 'hidden') {
        const v = stage.querySelector('video');
        if (v && v.paused && !userWantsPaused()) v.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const renderWatchFor = async (videoId, seedTitle) => {
      const gen = ++renderGeneration;
      lastNavHandledId = videoId;
      descPopupWire.close();
      transcriptPopupWire.close();
      if (seedTitle) {
        title.textContent = seedTitle;
        setTitle(seedTitle);
      }
      showMetaSkeleton();
      // Ask for the playlist panel in the same `next` call when a list is in
      // the URL — updateQueue used to refetch the same 1–2MB endpoint just to
      // get the panel.
      const listId = new URLSearchParams(location.search).get('list');
      const data = await innertube('next', listId ? { videoId, playlistId: listId } : { videoId });
      if (gen !== renderGeneration) return;
      if (!data) { hideMetaSkeletonImmediate(); return; }
      chapters = parseChapters(data);
      renderMeta(data);
      renderTicks();
      resetComments(data);
      resetTranscript();
      updateQueue(videoId, data);
    };
    watchApi = { renderWatchFor };

    if (mountedFromSpa) {
      const mountedId = resolveVideoId();
      if (mountedId) renderWatchFor(mountedId);
    }

    return () => {
      if (stopGuideWait) { stopGuideWait(); stopGuideWait = null; }
      if (miniFlying && miniFlyCancel) miniFlyCancel();
      clearInterval(timer);
      mountAbort.abort();
      if (sbAbort) sbAbort.abort();
      sbSegments = [];
      sbVideoId = null;
      abA = null; abB = null;
      ui?.seekwrap.querySelectorAll('.itube-sb-marker').forEach((m) => m.remove());
      teardownCrossfade(true);
      adObserver?.disconnect();
      adObserver = null;
      adObserved = null;
      adActive = false;
      adRestoring = false;
      wired = null;
      transcriptGeneration++;
      commentsGeneration++;
      transcriptSegments = [];
      transcriptLineEls = [];
      transcriptActiveIndex = -1;
      for (const g of boostGraphs) { try { g.gain.disconnect(); g.src.disconnect(); } catch (e) {} }
      boostGraphs.length = 0;
      if (boostCtx) { try { boostCtx.close(); } catch (e) {} boostCtx = null; }
      const adopted = stage.querySelector('video');
      const moviePlayer = player();
      if (adopted) {
        const vid = player()?.getVideoData?.()?.video_id;
        const stillPlaying = !adopted.paused && !adopted.ended && adopted.currentTime > 0;
        if (stillPlaying && !miniDismissed && vid && location.pathname !== '/watch') {
          activateMini(adopted, vid);
        } else {
          adopted.pause();
          if (moviePlayer) moviePlayer.appendChild(adopted);
        }
      }
      releaseCaptions(stage);
      clearTheaterScrim();
      qualityMenu.destroy();
      speedMenu.destroy();
      // createToolMenu registers signal-less document/window listeners that only
      // destroy() removes — a menu left undestroyed leaks one of each per mount.
      audioTrackMenu.destroy();
      root.classList.remove('theater');
      watchLeft.classList.remove('itube-cursor-hide');
      window.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('yt-navigate-finish', onNavigateFinish);
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.setActionHandler('play', null);
          navigator.mediaSession.setActionHandler('pause', null);
          navigator.mediaSession.setActionHandler('seekbackward', null);
          navigator.mediaSession.setActionHandler('seekforward', null);
          navigator.mediaSession.setActionHandler('seekto', null);
          navigator.mediaSession.setActionHandler('previoustrack', null);
          navigator.mediaSession.setActionHandler('nexttrack', null);
        } catch (e) {}
      }
      watchApi = null;
    };
  };

  const watchHref = (videoId, listId) => (listId
    ? '/watch?v=' + videoId + '&list=' + encodeURIComponent(listId)
    : '/watch?v=' + videoId);

  const playable = () => {
    const pl = player();
    return pl && typeof pl.loadVideoById === 'function' ? pl : null;
  };

  const ytNavigate = (videoId, listId) => {
    const app = document.querySelector('ytd-app');
    if (!app) return false;
    const endpoint = {
      commandMetadata: {
        webCommandMetadata: {
          url: watchHref(videoId, listId),
          webPageType: 'WEB_PAGE_TYPE_WATCH',
          rootVe: 3832,
        },
      },
      watchEndpoint: listId ? { videoId, playlistId: listId } : { videoId },
    };
    app.dispatchEvent(new CustomEvent('yt-navigate', {
      detail: { endpoint },
      bubbles: true,
      composed: true,
    }));
    return true;
  };

  let watchBoot = null;
  const stopWatchBoot = () => {
    if (!watchBoot) return;
    clearInterval(watchBoot);
    watchBoot = null;
  };

  const routedTo = (videoId, listId) => {
    if (location.pathname !== '/watch') return false;
    const params = new URLSearchParams(location.search);
    if (params.get('v') === videoId) return true;
    return !!listId && params.get('list') === listId;
  };

  const bootWatch = (videoId, listId) => {
    if (!ytNavigate(videoId, listId)) return false;
    const href = watchHref(videoId, listId);
    const deadline = Date.now() + WATCH_BOOT_TIMEOUT;
    stopWatchBoot();
    watchBoot = setInterval(() => {
      if (routedTo(videoId, listId)) {
        stopWatchBoot();
        spaRoute();
        return;
      }
      if (Date.now() > deadline) {
        stopWatchBoot();
        console.warn('[itube] the router never navigated, falling back to a page load');
        location.assign(href);
      }
    }, 32);
    return true;
  };

  let requestedVideoId = null;
  let requestedAt = 0;

  // ---- Playback intent ----------------------------------------------------
  // ONE source of truth for what playback should be doing, held against a
  // player that reasserts its own state, and abandoned on a deadline so it can
  // never fight the user or spin forever.
  //
  // This replaces four separate mechanisms that each enforced HALF of it: a
  // `userPausedPlayback` flag, a 'play' handler that undid unwanted plays, a
  // tick() backstop that undid them again after an element swap, and a
  // resumeVideoId/resumeUntil window that was the only thing enforcing "keep
  // playing" — and only for a few seconds after a navigation. Three enforcers
  // for pause, none for play: a user pressing Space got a fire-and-forget
  // playVideo() + play(), so when YouTube's controller paused the element a
  // beat later (it does, and under load it won roughly one run in three)
  // nothing put it back. That asymmetry was the bug, not YouTube.
  //
  // Symmetry is the point. reconcilePlayback() corrects in BOTH directions
  // from the same intent, and is driven by the media element's own play/pause
  // events so a correction lands in the same task rather than up to a tick
  // later; tick() still calls it as the backstop for element swaps.
  const INTENT_HOLD_MS = 4000;
  // Hard stop on ping-pong: if the player and Flyt genuinely disagree (or
  // play() is being refused outright), give up after this many corrections
  // instead of trading commands for the whole window.
  const INTENT_MAX_CORRECTIONS = 8;

  // TWO layers, because they have genuinely different lifetimes — collapsing
  // them into one reintroduced the "jumps back to playing" bug:
  //
  //   userPaused  the user's standing preference. STICKY, no deadline: a
  //               navigation that assumes "playing" must never resurrect a
  //               video the user paused ten seconds ago, so this has to
  //               outlive the enforcement window. Cleared only by an explicit
  //               play or by loading a different video.
  //   intent      what we are currently arguing with the player about, and
  //               BOUNDED by a deadline plus a correction cap so the argument
  //               cannot spin.
  let userPaused = false;
  let intent = null;              // true = play, false = pause, null = no opinion
  let intentUntil = 0;
  let intentVideoId = null;
  let intentCorrections = 0;

  const playerVideoId = () => playable()?.getVideoData?.()?.video_id || null;
  const userWantsPaused = () => userPaused;
  const clearIntent = () => { intent = null; intentVideoId = null; intentCorrections = 0; };

  // videoId scopes the intent so a stale "keep playing" cannot survive into
  // whatever the player loads next. holdMs lets the post-navigation window be
  // longer than a user gesture's. `user` marks an explicit gesture, which is
  // authoritative; an inferred intent (a re-nav assuming playback) must not
  // override a standing user pause on the same video.
  const setIntent = (playing, opts) => {
    const o = opts || {};
    const videoId = o.videoId || playerVideoId();
    if (o.user) {
      userPaused = !playing;
    } else if (playing && userPaused && (!videoId || videoId === playerVideoId())) {
      // Inferred "keep playing" on the video the user deliberately paused:
      // decline it rather than steamroll them.
      return;
    }
    intent = !!playing;
    intentVideoId = videoId;
    intentUntil = Date.now() + (o.holdMs || INTENT_HOLD_MS);
    intentCorrections = 0;
  };

  // Only ever issues a command when actual state disagrees with intent, so it
  // is safe to call from the very events it causes.
  const reconcilePlayback = (video, opts) => {
    if (intent === null) return;
    const pl = playable();
    if (!pl) return;
    if (Date.now() > intentUntil || intentCorrections >= INTENT_MAX_CORRECTIONS) { clearIntent(); return; }
    // Ads must play out or killAd can never seek past them. Read from the
    // player rather than plumbed in, so every caller is guarded identically.
    if (adShowing()) return;
    if (opts && opts.suspended) return;
    const live = playerVideoId();
    if (intentVideoId && live && live !== intentVideoId) { clearIntent(); return; }
    const v = video
      || document.querySelector('#itube-stage video')
      || document.querySelector('#itube-mini video')
      || document.querySelector('#movie_player video');
    if (!v) return;
    // Never re-play a finished video: 'ended' is a legitimate pause, and
    // autoplay-next navigates and sets its own intent for the next id.
    if (intent && v.ended) { clearIntent(); return; }
    if (intent && v.paused) {
      intentCorrections++;
      pl.playVideo?.();
      const started = v.play?.();
      if (started && typeof started.catch === 'function') started.catch(() => {});
    } else if (!intent && !v.paused) {
      intentCorrections++;
      pl.pauseVideo?.();
      v.pause();
    }
  };

  const requestPlayback = (pl, videoId) => {
    beginVideoCrossfade();
    requestedVideoId = videoId;
    requestedAt = Date.now();
    // A different video is being loaded, so the standing pause no longer
    // refers to anything: a fresh video defaults to playing.
    userPaused = false;
    setIntent(true, { videoId, holdMs: WATCH_RESUME_MS });
    pl.loadVideoById(videoId);
  };

  const ensureWatchPlayback = (videoId, listId) => {
    if (!videoId) return;
    const pl = playable();
    if (!pl) {
      if (!watchBoot) bootWatch(videoId, listId);
      return;
    }
    if (pl.getVideoData?.()?.video_id === videoId) {
      requestedVideoId = null;
      // Inferred, not a gesture: setIntent declines this when the user has
      // this video deliberately paused.
      setIntent(true, { videoId, holdMs: WATCH_RESUME_MS });
      reconcilePlayback(null);
      return;
    }
    if (requestedVideoId === videoId && Date.now() - requestedAt < WATCH_LOAD_RETRY) return;
    requestPlayback(pl, videoId);
  };

  const watchNav = (videoId, listId, seedTitle) => {
    const pl = playable();
    if (!pl) return bootWatch(videoId, listId);
    history.pushState({}, '', watchHref(videoId, listId));
    if (pl.getVideoData?.()?.video_id !== videoId) requestPlayback(pl, videoId);
    if (watchApi) {
      setCurrentKey();
      syncNav();
      content.scrollTop = 0;
      watchApi.renderWatchFor(videoId, seedTitle);
    } else {
      spaRoute();
    }
    return true;
  };

  let cleanup = null;
  let currentKey = null;
  let watchApi = null;
  let ownedTitle = 'Flyt';
  let titleGuard = null;
  const applyOwnedTitle = () => {
    if (document.title !== ownedTitle) document.title = ownedTitle;
  };
  // Pre-collapsed: the title getter collapses whitespace, the setter does not.
  const collapseTitle = (t) => t.replace(/\s+/g, ' ').trim();
  const setTitle = (name) => {
    ownedTitle = collapseTitle(name ? name + ' — Flyt' : 'Flyt');
    applyOwnedTitle();
    if (titleGuard || !document.head) return;
    titleGuard = new MutationObserver(applyOwnedTitle);
    titleGuard.observe(document.head, { childList: true, subtree: true, characterData: true });
  };

  const routeInfo = (path, search) => {
    const permalink = path.match(/^\/(?:shorts|live)\/([^/?]+)/);
    if (permalink) return { type: 'shorts', shortsId: permalink[1] };
    if (path === '/watch') return { type: 'watch' };
    if (path === '/') return { type: 'home' };
    if (path === '/results') return { type: 'search' };
    if (CHANNEL_PATH_RE.test(path)) return { type: 'channel' };
    if (path === '/feed/channels') return { type: 'following' };
    if (path === '/feed/playlists') return { type: 'playlists' };
    if (path === '/feed/explore') return { type: 'feed', browseId: ['FEexplore', 'FEtrending'], heading: 'Explore' };
    if (FEED_BROWSE[path]) return { type: 'feed', browseId: FEED_BROWSE[path].browseId, heading: FEED_BROWSE[path].heading, useInitialData: true };
    if (path === '/playlist') {
      const listId = new URLSearchParams(search).get('list');
      if (listId) return { type: 'feed', browseId: 'VL' + listId, heading: 'Playlist', useInitialData: true };
    }
    return { type: 'unhandled' };
  };

  const keyFor = (type, path, search) => (
    (type === 'search' || type === 'feed' || type === 'watch') ? path + search : path
  );
  const setCurrentKey = () => {
    const info = routeInfo(location.pathname, location.search);
    currentKey = keyFor(info.type, location.pathname, location.search);
  };

  const TRACKING_PARAMS = new Set(['si', 'feature', 'pp', 'gclid', 'dclid', 'fbclid', 'ved', 'usg']);
  const stripTrackingParams = () => {
    if (!location.search || location.search === '?') return;
    const params = new URLSearchParams(location.search);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) { params.delete(key); changed = true; }
    }
    if (!changed) return;
    const qs = params.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  };

  const route = () => {
    const isPop = popNav;
    popNav = false;
    if (NATIVE_ROUTE_RE.test(location.pathname)) { location.reload(); return; }
    stripTrackingParams();
    syncYtDormant();
    renderGuideChannels();
    syncAccount();
    const path = location.pathname;
    const info = routeInfo(path, location.search);
    if (info.type === 'shorts') { location.replace('/watch?v=' + encodeURIComponent(info.shortsId)); return; }

    const type = info.type;
    const browseId = info.browseId || null;
    const heading = info.heading || null;
    const useInitialData = !!info.useInitialData;

    if (type !== 'watch') stopWatchBoot();

    const key = keyFor(type, path, location.search);
    if (type === 'watch' && watchApi) {
      const wantId = new URLSearchParams(location.search).get('v');
      const playingId = player()?.getVideoData?.()?.video_id;
      if (wantId && playingId && wantId !== playingId) {
        currentKey = key;
        syncNav();
        content.scrollTop = 0;
        ensureWatchPlayback(wantId, new URLSearchParams(location.search).get('list'));
        watchApi.renderWatchFor(wantId);
        spaNav = false;
        return;
      }
    }
    if (key === currentKey) { syncNav(); spaNav = false; return; }
    if (activeListCache) {
      touchListCache(currentKey, { ...activeListCache.getState(), scrollTop: content.scrollTop });
      activeListCache = null;
    }
    if (cleanup) { cleanup(); cleanup = null; }
    currentKey = key;
    syncNav();
    content.scrollTop = 0;
    setTitle(type === 'search'
      ? new URLSearchParams(location.search).get('search_query')
      : type === 'feed' ? heading
        : type === 'following' ? 'Following'
          : type === 'playlists' ? 'Playlists'
          : type === 'home' ? null
            : type === 'watch' ? null
              : null);
    if (type === 'watch' && spaNav) {
      const params = new URLSearchParams(location.search);
      ensureWatchPlayback(params.get('v'), params.get('list'));
    }
    const cacheEntry = isPop ? takeListCache(key) : null;
    cleanup = type === 'watch' ? mountWatch()
      : type === 'home' ? mountHome(cacheEntry)
      : type === 'search' ? mountSearch(cacheEntry)
      : type === 'channel' ? mountChannel()
      : type === 'feed' ? mountFeed(browseId, heading, { useInitialData, cacheEntry })
      : type === 'following' ? mountFollowing()
      : type === 'playlists' ? mountPlaylists(cacheEntry)
      : mountUnhandled();
    spaNav = false;
  };

  // Dormant only when Flyt is definitely not using YouTube's player.
  //
  // The last clause is the one that matters: an ADOPTED <video> anywhere in
  // Flyt's own DOM means the player is live, whatever the route says and
  // whatever order the callbacks happened to run in. Deciding purely from
  // `pathname !== '/watch' && !miniActive` left a window — leaving a watch page
  // calls route() (which would mark it dormant) BEFORE activateMini() runs (which
  // un-marks it), so for a beat the player's container was un-rendered while its
  // video was mid-reparent. Reading the DOM instead of trusting call ordering
  // costs one querySelector per navigation and cannot race.
  const syncYtDormant = () => {
    try {
      const playerInUse = location.pathname === '/watch'
        || miniActive
        || !!document.querySelector('#itube-stage video, #itube-mini video');
      document.body.classList.toggle('flyt-yt-dormant', !playerInUse);
    } catch (e) {}
  };

  const spaRoute = () => { spaNav = true; hadSpaNav = true; route(); };
  const prefersReducedMotion = () => {
    if (lsGet('itube-reduce-motion') === '1') return true;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  };

  const flyThumbToStage = (flyData) => {
    if (!flyData || prefersReducedMotion()) return;
    const rect = flyData.rect;
    const src = flyData.src;
    if (!src || !rect || rect.width < 8 || rect.height < 8) return;
    const clone = document.createElement('img');
    clone.className = 'itube-fly';
    clone.src = src;
    clone.alt = '';
    clone.setAttribute('decoding', 'async');
    clone.style.top = rect.top + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.width = rect.width + 'px';
    clone.style.height = rect.height + 'px';
    document.body.appendChild(clone);
    let done = false;
    const cleanup = () => { if (done) return; done = true; clone.remove(); };
    const safety = setTimeout(cleanup, 2000);
    requestAnimationFrame(() => {
      const stage = document.getElementById('itube-stage');
      const last = stage ? stage.getBoundingClientRect() : null;
      if (!last || last.width < 8 || last.height < 8) { clearTimeout(safety); cleanup(); return; }
      if (last.bottom < 0 || last.top > innerHeight) { clearTimeout(safety); cleanup(); return; }
      const dx = last.left - rect.left;
      const dy = last.top - rect.top;
      const sx = last.width / rect.width;
      const sy = last.height / rect.height;
      // CSS transitions, NOT element.animate(): on Safari, YouTube loads its
      // web-animations polyfill, which hijacks animate() in the page context
      // and completes instantly — both flies teleported there. Transitions
      // can't be hijacked.
      clone.style.transformOrigin = 'top left';
      clone.style.transition = 'transform 380ms cubic-bezier(.22, .61, .36, 1)';
      clone.getBoundingClientRect(); // commit start state before transitioning
      clone.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')';
      clone.addEventListener('transitionend', function onFly(e) {
        if (e.propertyName !== 'transform') return;
        clone.removeEventListener('transitionend', onFly);
        clone.style.transition = 'opacity 260ms ease-out';
        clone.getBoundingClientRect();
        clone.style.opacity = '0';
        clone.addEventListener('transitionend', () => { clearTimeout(safety); cleanup(); }, { once: true });
      });
    });
  };

  root.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = /** @type {Element} */ (e.target).closest('a');
    if (!a || a.target === '_blank') return;
    if (a.origin !== location.origin) return;
    if (NATIVE_ROUTE_RE.test(a.pathname)) return;
    if (a.hasAttribute('download')) return;
    if (a.pathname === '/watch') {
      const params = new URLSearchParams(a.search);
      const videoId = params.get('v');
      const listId = params.get('list');
      if (videoId) {
        const card = a.closest('.c, .rc, .row');
        const srcImg = /** @type {HTMLImageElement} */ (card && card.querySelector('.c-thumb img, .rc-thumb img, .row-thumb img'));
        const flyData = srcImg && srcImg.getBoundingClientRect
          ? { rect: srcImg.getBoundingClientRect(), src: srcImg.currentSrc || srcImg.src }
          : null;
        const seedTitle = card ? (card.querySelector('.c-title, .rc-title, .row-title')?.textContent || '') : '';
        if (watchNav(videoId, listId, seedTitle)) {
          e.preventDefault();
          flyThumbToStage(flyData);
        }
      }
      return;
    }
    e.preventDefault();
    history.pushState({}, '', a.href);
    spaRoute();
  });
  window.addEventListener('popstate', (e) => {
    e.stopImmediatePropagation();
    stopWatchBoot();
    popNav = true;
    spaRoute();
  }, true);

  window.addEventListener('yt-navigate-finish', () => {
    if (watchBoot) spaRoute(); else route();
  });

  let bootDone = false;
  let bootLabeled = false;
  const finishBoot = () => {
    if (bootDone) return;
    bootDone = true;
    clearInterval(bootPoll);
    clearTimeout(bootFallback);
    bootOverlay.classList.add('itube-boot-hide');
    // Matches the .3s backdrop / .32s contents transitions above, with a beat
    // to spare — removing mid-transition is what makes a fade look like a cut.
    setTimeout(() => bootOverlay.remove(), 380);
  };
  const bootPoll = setInterval(() => {
    if (!bootLabeled && cfg()?.INNERTUBE_API_KEY) {
      bootLabeled = true;
      bootLabel.textContent = BOOT_LABELS[BOOT_TYPE];
    }
    if (BOOT_TYPE === 'watch') {
      const v = /** @type {HTMLVideoElement} */ (document.querySelector('#itube-stage video'));
      if (v && v.readyState >= 2) finishBoot();
    // These are the states a view will not improve on: real content, or a
    // terminal card. `.unhandled` belongs here and was missing, so an
    // unhandled route sat under "Loading…" for the full 8s fallback while its
    // card had been ready since ~860ms. (`.following-table`/`.following-status`
    // were added for the same omission on the Following page — hence
    // checkBootClearsPerRoute, so the next new view fails loudly instead.)
    } else if (view.querySelector('.c, .row, .rc, .empty, .signin-state, .unhandled, .following-table, .following-status')) {
      finishBoot();
    }
  }, 80);
  const bootFallback = setTimeout(finishBoot, 8000);

  route();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncAccount, { once: true });
  }
})();
