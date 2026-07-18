// Ad-removal checks.
//
// These exist because the ad plays through the SAME <video> element Flyt
// adopts into #itube-stage, so a pre-roll is fully visible and audible in our
// player unless we kill it — and because YouTube's search payloads carry
// promoted videos (searchPyvRenderer / inFeedAdLayoutRenderer / adSlotRenderer)
// that DO have a real videoId, which extractVideos() would happily render as a
// normal card.
//
// Ads are non-deterministic: on any given run YouTube may serve none at all.
// Both checks therefore report SKIPPED (never a silent pass) when there was no
// ad to assert anything about. A check that can only pass vacuously is worse
// than no check.
//
// Two live findings these checks are built on (verify before "fixing" them):
//   * player.getAdState() returns -1 EVEN DURING A REAL AD — it is useless.
//     The reliable signal is the `ad-showing` / `ad-interrupting` class on
//     #movie_player.
//   * getPlayerResponse().videoDetails.videoId stays the CONTENT id during an
//     ad, so it can be used to assert the real video is loaded, but NOT to
//     detect an ad.
'use strict';

const { newContext, openPage, waitForApp } = require('../lib/harness');

// The user's volume, seeded into localStorage before load. The whole point of
// the mute-during-ad path is that this exact number comes back afterwards.
const USER_VOLUME = 73;

// How long after an ad first appears we still consider it "killed promptly".
// Measured live: the ad stream is seeked to its end on the first sample where
// duration is finite (~150ms); the `ad-showing` class then lingers for several
// more seconds at readyState 0 while the player loads the real stream.
const AD_KILL_DEADLINE_MS = 12000;

const SAMPLE_MS = 100;
const WATCH_OBSERVE_MS = 30000;

// Videos that plausibly carry a pre-roll (monetised, popular). None of them is
// guaranteed to serve one — that is what the SKIP path is for.
const AD_HEAVY_IDS = [
  'kJQP7kiw5Fk',
  'RgKAFK5djSk',
  '9bZkp7q19f0',
  'JGwWNGJdvx8',
];

// Page-side sampler. Records the raw truth every SAMPLE_MS; every assertion is
// computed in Node from these samples so a failure can be printed with numbers.
//
// NOTE the single object argument: page.addInitScript(fn, arg) passes exactly
// ONE arg. Passing two silently drops the second, which is how this check once
// seeded localStorage['itube-volume'] = "undefined" and then "caught" a volume
// bug that did not exist (Number("undefined") -> NaN -> the app's 100 default).
const SAMPLER = ({ sampleMs, userVolume }) => {
  localStorage.setItem('itube-volume', String(userVolume));
  localStorage.setItem('itube-muted', '0');
  window.__adSamples = [];
  const t0 = Date.now();
  // Would this element paint pixels on screen right now? A <video> with decoded
  // data paints its current frame whether or not it is PAUSED — a paused ad
  // frame is still an ad frame the user is looking at — so paused-ness says
  // nothing about visibility. Ask the layout instead: computed display /
  // visibility / opacity of the element AND every ancestor (Flyt blanks the ad
  // with `#itube-stage.ad video { opacity: 0 }`), plus real on-screen geometry.
  const painting = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom <= 0 || r.right <= 0) return false;
    if (r.top >= innerHeight || r.left >= innerWidth) return false;
    return true;
  };
  setInterval(() => {
    const p = document.getElementById('movie_player');
    const v = document.querySelector('#itube-stage video') || document.querySelector('video');
    const stage = document.getElementById('itube-stage');
    if (!p || !v) return;
    let prVid = null;
    try {
      prVid = p.getPlayerResponse && p.getPlayerResponse().videoDetails.videoId;
    } catch (e) { /* player not ready */ }
    window.__adSamples.push({
      t: Date.now() - t0,
      showing: p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'),
      // "blanked" = Flyt is hiding the video surface, so even a decoded ad
      // frame is not on screen. Kept for reporting; `shown` is what the
      // assertions read, because it measures the OUTCOME (does the element
      // paint?) rather than the mechanism (is the class on?).
      blanked: !!stage && stage.classList.contains('ad'),
      shown: painting(v),
      muted: v.muted,
      pMuted: typeof p.isMuted === 'function' ? p.isMuted() : null,
      vol: typeof p.getVolume === 'function' ? Math.round(p.getVolume()) : null,
      rs: v.readyState,
      paused: v.paused,
      ct: v.currentTime,
      dur: v.duration,
      prVid,
      // The user's SAVED preference. If the ad's mute or the player's post-ad
      // volume reset ever lands in here, the damage outlives the session.
      ls: localStorage.getItem('itube-volume'),
      lsMuted: localStorage.getItem('itube-muted'),
    });
  }, sampleMs);
};

// An ad frame the user could actually SEE: the ad is showing, the media element
// has decoded data (readyState >= 2 == HAVE_CURRENT_DATA, i.e. there IS a frame
// to paint), and the element is actually painting it.
//
// This deliberately does NOT require `!s.paused`: a paused <video> keeps its
// current frame on screen, so the old predicate under-reported — an ad we seek
// to its end and leave paused is still a visible ad frame if the surface is not
// blanked.
const isVisibleAdFrame = (s) => s.showing && s.rs >= 2 && s.shown;
// Ad audio the user could actually HEAR.
const isAudibleAdFrame = (s) => s.showing && s.rs >= 2 && !s.paused && !s.muted && s.pMuted !== true;

// Loads one video, samples it, and reduces the samples to a verdict.
async function probeVideoAd(context, id) {
  const { page } = await openPage(context, 'https://www.youtube.com/watch?v=' + id);
  await waitForApp(page, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(WATCH_OBSERVE_MS);
  const samples = await page.evaluate(() => window.__adSamples || []);
  await page.close();

  const adSamples = samples.filter((s) => s.showing);
  const report = { id, samples: samples.length, adServed: adSamples.length > 0, violations: [] };

  if (!report.adServed) return report;

  const first = adSamples[0];
  const last = adSamples[adSamples.length - 1];
  const after = samples.filter((s) => s.t > last.t && !s.showing);

  report.adOnScreenMs = last.t - first.t + SAMPLE_MS;
  report.visibleAdFrames = adSamples.filter(isVisibleAdFrame).length;
  report.audibleAdFrames = adSamples.filter(isAudibleAdFrame).length;
  report.visibleAdMs = report.visibleAdFrames * SAMPLE_MS;
  report.audibleAdMs = report.audibleAdFrames * SAMPLE_MS;
  report.adEnded = after.length > 0;

  if (report.audibleAdFrames > 0) {
    report.violations.push({
      check: 'ad-never-audible',
      detail: `${id}: ad audio was unmuted for ${report.audibleAdMs}ms (${report.audibleAdFrames} samples with muted=false while the ad was decoding and playing)`,
    });
  }

  if (report.visibleAdFrames > 0) {
    report.violations.push({
      check: 'ad-never-visible',
      detail: `${id}: ad video was on screen for ${report.visibleAdMs}ms (${report.visibleAdFrames} samples where the ad was showing, readyState>=2 and the <video> was actually painting)`,
    });
  }

  if (!report.adEnded) {
    report.violations.push({
      check: 'ad-killed',
      detail: `${id}: ad-showing never cleared within ${WATCH_OBSERVE_MS}ms — the ad was not killed at all`,
    });
    return report;
  }

  if (report.adOnScreenMs > AD_KILL_DEADLINE_MS) {
    report.violations.push({
      check: 'ad-killed',
      detail: `${id}: ad state lasted ${report.adOnScreenMs}ms, over the ${AD_KILL_DEADLINE_MS}ms deadline`,
    });
  }

  // The real video must actually play afterwards, at the user's volume.
  const playing = after.filter((s) => !s.paused && s.rs >= 2);
  const final = after[after.length - 1];
  report.resumedVideoId = final.prVid;
  report.finalVolume = final.vol;
  report.finalMuted = final.muted || final.pMuted === true;

  if (final.prVid !== id) {
    report.violations.push({
      check: 'real-video-resumed',
      detail: `${id}: after the ad, getPlayerResponse().videoDetails.videoId is ${final.prVid}, expected ${id}`,
    });
  }
  if (playing.length === 0) {
    report.violations.push({
      check: 'real-video-resumed',
      detail: `${id}: the real video never played after the ad (no unpaused sample with readyState>=2 in ${after.length} post-ad samples)`,
    });
  }
  if (report.finalMuted) {
    report.violations.push({
      check: 'volume-restored',
      detail: `${id}: player is still MUTED after the ad — the user's audio was never given back`,
    });
  }
  if (report.finalVolume !== USER_VOLUME) {
    report.violations.push({
      check: 'volume-restored',
      detail: `${id}: volume after the ad is ${report.finalVolume}, expected the user's saved ${USER_VOLUME}`,
    });
  }

  // The ad's mute must never reach the user's saved preference — that damage
  // would outlive the session.
  const clobbered = samples.filter((s) => s.ls !== String(USER_VOLUME) || s.lsMuted !== '0');
  if (clobbered.length) {
    const s = clobbered[0];
    report.violations.push({
      check: 'ad-volume-not-persisted',
      detail: `${id}: localStorage was clobbered during the ad — at t=${s.t}ms itube-volume=${s.ls}, itube-muted=${s.lsMuted} (expected ${USER_VOLUME}/0), ${clobbered.length} samples affected`,
    });
  }
  return report;
}

// Runs the video-ad check over AD_HEAVY_IDS, stopping as soon as one video has
// actually served an ad (that is the one we can assert on; the rest would only
// burn minutes). Returns { violations, skipped, detail, reports }.
async function checkVideoAds(browser, ids = AD_HEAVY_IDS) {
  const context = await newContext(browser);
  await context.addInitScript(SAMPLER, { sampleMs: SAMPLE_MS, userVolume: USER_VOLUME });

  const reports = [];
  let violations = [];
  try {
    for (const id of ids) {
      const r = await probeVideoAd(context, id);
      reports.push(r);
      if (r.adServed) {
        violations = violations.concat(r.violations);
        break;
      }
    }
  } finally {
    await context.close();
  }

  const served = reports.filter((r) => r.adServed);
  if (served.length === 0) {
    return {
      violations: [],
      skipped: true,
      detail: `no ad was served on any of ${reports.map((r) => r.id).join(', ')} — nothing to assert`,
      reports,
    };
  }
  const r = served[0];
  return {
    violations,
    skipped: false,
    detail: `${r.id}: ad state ${r.adOnScreenMs}ms, visible ${r.visibleAdMs}ms, audible ${r.audibleAdMs}ms, resumed=${r.resumedVideoId}, volume=${r.finalVolume}, muted=${r.finalMuted}`,
    reports,
  };
}

// Deterministic counterpart to checkVideoAds: it does NOT wait for the ad
// lottery. Flyt keys entirely off the `ad-showing` / `ad-interrupting` class on
// #movie_player, so adding that class by hand drives the exact same state
// machine a real pre-roll does. This is what keeps the ad path covered on the
// (common) runs where YouTube serves no ad at all.
//
// The stomp below (setVolume(100) after the ad clears) models the player
// resetting volume to its own default during ad teardown. Flyt's guarantee is
// bounded and worth stating exactly: from the moment the ad clears until the
// real video is playing at the user's volume (hard cap AD_RESTORE_MS), it keeps
// driving the volume back to localStorage['itube-volume']. A reset inside that
// window is corrected; that is what this asserts.
async function checkAdStateMachine(browser, id = 'aircAruvnKk') {
  const context = await newContext(browser);
  await context.addInitScript((vol) => {
    localStorage.setItem('itube-volume', String(vol));
    localStorage.setItem('itube-muted', '0');
    // The synthetic ad makes Flyt fast-forward the REAL video to its end;
    // without this, the `ended` handler would autoplay away mid-check.
    localStorage.setItem('itube-autoplay', '0');
  }, USER_VOLUME);

  const violations = [];
  try {
    const { page } = await openPage(context, 'https://www.youtube.com/watch?v=' + id);
    await waitForApp(page, { timeout: 30000 });
    await page.waitForFunction(() => {
      const p = document.getElementById('movie_player');
      return p && typeof p.getVolume === 'function' && document.querySelector('#itube-stage video');
    }, { timeout: 20000 });
    await page.waitForTimeout(2000);

    const during = await page.evaluate(async () => {
      const p = document.getElementById('movie_player');
      p.classList.add('ad-showing', 'ad-interrupting');
      await new Promise((r) => setTimeout(r, 1200));
      const v = document.querySelector('#itube-stage video');
      const stage = document.getElementById('itube-stage');
      return {
        muted: p.isMuted(),
        elMuted: v.muted,
        blanked: stage.classList.contains('ad'),
        storedVolume: localStorage.getItem('itube-volume'),
        storedMuted: localStorage.getItem('itube-muted'),
      };
    });

    if (!during.muted || !during.elMuted) {
      violations.push({ check: 'ad-muted', detail: `while ad-showing: player.isMuted()=${during.muted}, video.muted=${during.elMuted} — the ad would have been audible` });
    }
    if (!during.blanked) {
      violations.push({ check: 'ad-blanked', detail: 'while ad-showing: #itube-stage has no .ad class — ad frames would be on screen' });
    }
    if (during.storedVolume !== String(USER_VOLUME) || during.storedMuted !== '0') {
      violations.push({ check: 'ad-volume-not-persisted', detail: `while ad-showing the ad's mute was written to localStorage: itube-volume=${during.storedVolume}, itube-muted=${during.storedMuted} (expected ${USER_VOLUME}/0)` });
    }

    // Clear the ad, then stomp the volume the way YouTube's player does.
    const after = await page.evaluate(async () => {
      const p = document.getElementById('movie_player');
      p.classList.remove('ad-showing', 'ad-interrupting');
      await new Promise((r) => setTimeout(r, 1000));
      p.setVolume(100);
      p.unMute();
      await new Promise((r) => setTimeout(r, 4000));
      const stage = document.getElementById('itube-stage');
      return {
        volume: Math.round(p.getVolume()),
        muted: p.isMuted(),
        blanked: stage.classList.contains('ad'),
        storedVolume: localStorage.getItem('itube-volume'),
      };
    });

    if (after.blanked) {
      violations.push({ check: 'ad-blanked', detail: 'after the ad cleared, #itube-stage still has .ad — the real video stays hidden' });
    }
    if (after.muted) {
      violations.push({ check: 'volume-restored', detail: 'after the ad cleared the player is still muted' });
    }
    if (after.volume !== USER_VOLUME) {
      violations.push({ check: 'volume-restored', detail: `after the ad cleared and the player stomped the volume to 100, volume is ${after.volume}, expected the user's ${USER_VOLUME}` });
    }
    if (after.storedVolume !== String(USER_VOLUME)) {
      violations.push({ check: 'volume-restored', detail: `localStorage['itube-volume'] is ${after.storedVolume}, expected ${USER_VOLUME} — the player's stomp was persisted as if the user chose it` });
    }
    await page.close();
    return {
      violations,
      skipped: false,
      detail: `synthetic ad on ${id}: muted=${during.muted}/blanked=${during.blanked} during; volume=${after.volume} muted=${after.muted} stored=${after.storedVolume} after a 100-volume stomp`,
    };
  } finally {
    await context.close();
  }
}

// Page-side recorder for feed ads: collects every videoId that lives INSIDE an
// ad renderer subtree of an InnerTube payload. Those are the ids that must
// never appear as a card. Also collects the ad renderer key names, so "there
// were ads in the payload but none rendered" can be distinguished from "YouTube
// sent us no ads at all" (which is a SKIP, not a pass).
const AD_RECORDER = () => {
  window.__feedAds = { keys: [], ids: [] };
  const AD_KEY_RE = /^(ads?|promoted)[A-Z]|Ad(Slot|Layout|Break|Placement)|AdRenderer$|PyvRenderer$/;
  const collect = (node, out) => {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
      if (typeof n.videoId === 'string' && /^[\w-]{11}$/.test(n.videoId)) out.push(n.videoId);
      for (const k in n) stack.push(n[k]);
    }
  };
  const scan = (root) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
      for (const k in n) {
        if (AD_KEY_RE.test(k)) {
          if (!window.__feedAds.keys.includes(k)) window.__feedAds.keys.push(k);
          const ids = [];
          collect(n[k], ids);
          for (const id of ids) {
            if (!window.__feedAds.ids.includes(id)) window.__feedAds.ids.push(id);
          }
          continue;
        }
        stack.push(n[k]);
      }
    }
  };
  window.__scanFeedAds = scan;
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0] && args[0].url ? args[0].url : args[0]);
    const res = origFetch.apply(this, args);
    if (/\/youtubei\/v1\/(search|browse|next)/.test(url)) {
      res.then((r) => r.clone().json().then(scan).catch(() => {})).catch(() => {});
    }
    return res;
  };
};

// Search queries chosen because advertisers actually bid on them — a generic
// query often returns a feed with no ads at all, which would make this check
// skip on every run.
const AD_FEED_PAGES = [
  'https://www.youtube.com/results?search_query=best+vpn',
  'https://www.youtube.com/results?search_query=best+laptop+2026',
];

async function checkFeedAds(browser, urls = AD_FEED_PAGES) {
  const context = await newContext(browser);
  await context.addInitScript(AD_RECORDER);

  const violations = [];
  let totalAdIds = 0;
  let totalAdKeys = 0;
  const notes = [];

  try {
    for (const url of urls) {
      const { page } = await openPage(context, url);
      await waitForApp(page, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      // Continuations are where most feed ads live, so scroll for a couple of
      // pages before reading the payloads back.
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 5000);
        await page.waitForTimeout(2000);
      }
      await page.evaluate(() => window.__scanFeedAds(window.ytInitialData));

      const { keys, ids } = await page.evaluate(() => window.__feedAds);
      const hrefs = await page.evaluate(
        () => [...document.querySelectorAll('#itube .c, #itube .row, #itube .rc')]
          .map((n) => n.getAttribute('href'))
          .filter((h) => typeof h === 'string')
      );

      totalAdIds += ids.length;
      totalAdKeys += keys.length;
      notes.push(`${url.split('search_query=')[1]}: ${keys.length} ad renderer keys, ${ids.length} ad videoIds in payload, ${hrefs.length} cards rendered`);

      const rendered = new Set(
        hrefs.map((h) => {
          const m = /[?&]v=([\w-]{11})/.exec(h);
          return m ? m[1] : null;
        }).filter(Boolean)
      );

      for (const id of ids) {
        if (rendered.has(id)) {
          violations.push({
            check: 'no-promoted-cards',
            detail: `${url}: videoId ${id} came from an ad renderer (${keys.join(',')}) and IS rendered as a card`,
          });
        }
      }

      // A card must always point at a real watch page. An ad click-through URL
      // occupying a card slot is the other way this can go wrong.
      for (const h of hrefs) {
        if (!/^\/(watch\?v=[\w-]{11}|playlist\?list=)/.test(h)) {
          violations.push({
            check: 'no-promoted-cards',
            detail: `${url}: a card renders a non-watch href: ${h}`,
          });
        }
      }
      await page.close();
    }
  } finally {
    await context.close();
  }

  if (totalAdIds === 0) {
    return {
      violations,
      skipped: true,
      detail: `YouTube served no promoted videoIds in these feeds (${totalAdKeys} ad renderer keys seen, none carrying a videoId) — nothing to assert. ${notes.join(' | ')}`,
    };
  }
  return {
    violations,
    skipped: false,
    detail: `${totalAdIds} promoted videoId(s) in the payloads, 0 rendered. ${notes.join(' | ')}`,
  };
}

module.exports = {
  checkVideoAds,
  checkFeedAds,
  checkAdStateMachine,
  probeVideoAd,
  SAMPLER,
  SAMPLE_MS,
  AD_HEAVY_IDS,
  AD_FEED_PAGES,
  USER_VOLUME,
};
