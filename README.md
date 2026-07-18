# Flyt

A userscript that replaces YouTube's web interface with a faster, quieter one.

Flyt doesn't restyle YouTube. It reads YouTube's own data and renders its own
interface — feed, watch page, search, channels, comments, and player. YouTube's
real page is kept off-screen and used only as a headless playback engine: the
`<video>` element is moved into Flyt's own layout. It's a single JavaScript
file with no build step and no dependencies, and it talks only to YouTube's
internal API.

Status: 0.0.1, beta.

## Install

You'll need a userscript manager.

**Safari (macOS/iOS)** — install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887),
enable it for `youtube.com` in Safari's extension settings, then add
`flyt.user.js` to its scripts folder.

**Chrome / Edge / Firefox** — install [Tampermonkey](https://www.tampermonkey.net/)
or Violentmonkey, then open the raw script and confirm the install:

```
https://raw.githubusercontent.com/prvrtl/flyt/main/flyt.user.js
```

The script keeps itself up to date through its `@updateURL`.

## Features

- Full watch page: quality up to 4320p, playback speed, caption languages, a
  searchable transcript, chapters, seek-preview thumbnails, playlists and queue,
  autoplay, picture-in-picture, theater mode, and live/DVR scrubbing.
- Comments and replies as a sortable tab in the watch-page rail.
- A mini-player that expands back to the full page without reloading the video.
- Subscriptions sorted by upload time instead of engagement ranking.
- A Following page listing your channels with subscriber counts, video counts,
  and upload cadence, sortable by any column.
- Search filters, channel pages, and a command palette.
- Keyboard shortcuts, media-key and now-playing integration, and accent themes.
- Back and forward restore the previous view without refetching.

## Performance

Because Flyt draws its own interface, YouTube's heavy components never scroll
into view and never lazy-load. On a live watch page, median of three runs, this
measured as 22,107 → 6,865 DOM nodes and a p95 frame time of 20.6 ms → 8.0 ms.
Method and caveats are in [PERF.md](PERF.md).

## Privacy

SponsorBlock skipping and the Return YouTube Dislike estimate are optional
third-party integrations. Turning either off stops its network requests
entirely, not just its display.

## Development

`flyt.user.js` is the whole app. The test suite runs against live youtube.com
with Playwright:

```
cd tests && npm install
cd tests && npm test
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the app is put together and why.
[RECOVERY.md](RECOVERY.md) is the runbook for when YouTube changes a data shape.

## License

[GPL-3.0-or-later](LICENSE).

## Notes

Tested on Chrome and Safari on the desktop site. Not affiliated with YouTube or
Google.
