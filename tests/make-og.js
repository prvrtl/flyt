#!/usr/bin/env node
// Generates docs/og.png — the 1200x630 card that Twitter/Slack/Discord/iMessage
// render when the site is shared. Built by rendering real HTML in the same
// engine the app targets and screenshotting it, so the card uses the actual
// aurora tokens and the actual product screenshot rather than a hand-drawn
// approximation that drifts the moment the theme changes.
//
//   cd tests && node make-og.js      # writes docs/og.png
//
// Re-run it whenever the accent tokens or docs/shots/watch-closed.webp change,
// or the card will quietly advertise a theme the app no longer has.
'use strict';

const fs = require('fs');
const path = require('path');
const { webkit } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'og.png');
const SHOT = path.join(ROOT, 'docs', 'shots', 'watch-closed.webp');

const GRAD = 'linear-gradient(135deg, #3ddb8f 0%, #22c3c9 48%, #4a8fe0 100%)';

const html = (shotDataUri) => `<!doctype html><meta charset=utf-8>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;width:1200px;height:630px;overflow:hidden}
  body{
    background:#06070c;
    color:#eef1f6;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
    position:relative;
  }
  /* Aurora bloom, echoing the site's hero glow. */
  .glow{position:absolute;inset:-30% -10% auto -20%;height:820px;
    background:radial-gradient(45% 55% at 22% 30%, rgba(93,242,168,.20), transparent 70%),
               radial-gradient(45% 55% at 52% 20%, rgba(58,223,224,.18), transparent 70%),
               radial-gradient(50% 60% at 82% 35%, rgba(90,169,255,.16), transparent 72%);
    filter:blur(10px)}
  .hair{position:absolute;left:0;right:0;top:0;height:3px;background:${GRAD}}
  .wrap{position:relative;display:flex;height:100%;padding:60px 64px 76px;gap:46px;align-items:center}
  .copy{width:576px;flex:none}
  .brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}
  .tile{width:52px;height:52px;border-radius:15px;background-image:${GRAD};
    display:flex;align-items:center;justify-content:center}
  .tile svg{width:26px;height:26px;display:block}
  .name{font-size:34px;font-weight:700;letter-spacing:-.02em;
    background-image:${GRAD};-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;color:#22c3c9}
  .beta{margin-left:2px;align-self:center;font-size:11px;font-weight:800;letter-spacing:.1em;
    padding:4px 8px;border-radius:7px;background-image:${GRAD};color:#04141c}
  h1{margin:0 0 16px;font-size:58px;line-height:1.02;letter-spacing:-.035em;font-weight:800}
  p{margin:0 0 28px;font-size:20px;line-height:1.45;color:#9aa3b5;max-width:560px}
  .stats{display:flex;gap:38px;align-items:flex-start}
  .stat{min-width:0}
  .stat b{display:block;font-size:34px;line-height:1.1;font-weight:800;letter-spacing:-.02em;
    background-image:${GRAD};-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;color:#22c3c9;white-space:nowrap}
  .stat span{display:block;margin-top:5px;font-size:13px;line-height:1.3;color:#7b8296;white-space:nowrap}
  .url{position:absolute;left:64px;bottom:44px;font-size:15px;color:#6e7688;letter-spacing:.01em}
  .shotwrap{flex:1;border-radius:14px;overflow:hidden;line-height:0;
    border:1px solid rgba(58,223,224,.26);
    box-shadow:0 30px 80px -24px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.06)}
  .shotwrap img{width:100%;height:auto;display:block}
</style>
<div class="glow"></div><div class="hair"></div>
<div class="wrap">
  <div class="copy">
    <div class="brand">
      <div class="tile"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M28 11.6v40.8l28-20.4z" fill="#fff"/><rect x="5.6" y="17.2" width="15.6" height="7.2" rx="3.6" fill="#fff"/><rect x="5.6" y="39.6" width="15.6" height="7.2" rx="3.6" fill="#fff"/></svg></div>
      <span class="name">Flyt</span><span class="beta">BETA</span>
    </div>
    <h1>YouTube,<br>rebuilt.</h1>
    <p>A userscript that throws out YouTube's page and renders its own — from YouTube's own data. No ads, no clutter.</p>
    <div class="stats">
      <div class="stat"><b>70%</b><span>fewer DOM nodes</span></div>
      <div class="stat"><b>1 of 149</b><span>janky frames · stock drops 50</span></div>
      <div class="stat"><b>0</b><span>dependencies</span></div>
    </div>
  </div>
  <div class="shotwrap"><img src="${shotDataUri}" alt=""></div>
</div>
<div class="url">prvrtl.github.io/flyt</div>`;

async function main() {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const dataUri = 'data:image/webp;base64,' + fs.readFileSync(SHOT).toString('base64');
  await page.setContent(html(dataUri), { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT, type: 'png' });
  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log('wrote docs/og.png (1200x630, ' + kb + ' KB)');
}
main().catch((e) => { console.error(e.stack || e); process.exit(1); });
