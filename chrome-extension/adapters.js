/**
 * WatchTogether - Site adapters
 * --------------------------------
 * Each adapter's only job is finding the real <video> element for a given
 * streaming site. Once found, playback control uses the standard
 * HTMLMediaElement API (play(), pause(), currentTime) — that part is the
 * same everywhere, only locating the element differs per site.
 *
 * To add support for a new site: add an entry here with a `matches()`
 * check and a `findVideoElement()` function. Nothing else needs to change.
 */

const WatchTogetherAdapters = [
  {
    id: 'youtube',
    name: 'YouTube',
    matches: (hostname) => /(^|\.)youtube\.com$/.test(hostname),
    findVideoElement: () =>
      document.querySelector('#movie_player video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video'),
  },

  // Netflix gets added here next. Prime Video / Disney+ skipped for now.

  {
    id: 'generic',
    name: 'Generic video player',
    // Fallback for everything else — including sites like hdtoday.one that
    // embed a third-party player inside a cross-origin iframe. Since it
    // always matches, keep this LAST in the array so any more specific
    // adapter above (YouTube, later Netflix) takes priority.
    matches: () => true,
    findVideoElement: () => {
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.length === 0) return null;
      if (videos.length === 1) return videos[0];

      // Multiple <video> tags on one page usually means ads, thumbnail
      // previews, or hidden elements alongside the real player. Guess the
      // real one as the largest currently-visible one.
      let best = null;
      let bestArea = 0;
      for (const v of videos) {
        const rect = v.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      }
      return best || videos[0];
    },
  },
];

function getAdapterForCurrentSite() {
  const hostname = window.location.hostname;
  return WatchTogetherAdapters.find((a) => a.matches(hostname)) || null;
}
