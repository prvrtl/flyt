// Ambient declarations for the parts of the page Flyt talks to that no standard
// lib describes. Checked-only — nothing here is emitted or shipped.
//
// The YtPlayer surface below is the contract with the borrowed playback engine.
// ARCHITECTURE.md says the YouTube player stays as a headless engine driven
// through its API; this is that API written down, so calling a method YouTube
// does not have is a type error instead of a runtime one on a live page.
//
// Only members Flyt actually calls are declared. Listing more would be
// guesswork about an undocumented object, and a declaration nothing checks is
// worse than none.

interface YtVideoData {
  video_id?: string;
  title?: string;
  author?: string;
  isLive?: boolean;
}

interface YtPlayer extends HTMLElement {
  getVolume(): number;
  setVolume(volume: number): void;
  isMuted(): boolean;
  mute(): void;
  unMute(): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  loadVideoById(arg: string | { videoId: string; startSeconds?: number }): void;
  getVideoData(): YtVideoData;
  getPlayerResponse(): any;
  getPlaylist(): string[] | null;
  getPlaybackQuality(): string;
  getAvailableQualityLevels(): string[];
  setPlaybackQualityRange(min: string, max?: string): void;
  setPlaybackRate(rate: number): void;
  toggleSubtitles(): void;
  getAudioTrack(): any;
  setAudioTrack(track: any): void;
}

// Safari ships the prefixed Fullscreen API and the primary user runs Safari, so
// these are load-bearing rather than legacy politeness.
interface Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?(): void;
}

interface Element {
  webkitRequestFullscreen?(): void;
}

interface Window {
  // YouTube's own page state, read rather than fetched wherever it is already
  // present — see "Data shapes" in ARCHITECTURE.md.
  ytInitialData?: any;
  ytInitialPlayerResponse?: any;
  ytInitialGuideData?: any;
  ytcfg?: { data_?: Record<string, any> };
  webkitAudioContext?: typeof AudioContext;
  // Flyt's own globals: the single-copy guard and the watch-state handoff.
  // Holds the running copy's VERSION, not a flag — the duplicate-copy warning
  // prints it to end the guessing about which build a browser is running.
  __flytBooted?: string;
  __flytWatchState?: any;
}

// Provided by the userscript manager. Absent when the script is injected
// directly, which is exactly how the test harness runs it.
declare const GM_info: { script?: { version?: string } } | undefined;
