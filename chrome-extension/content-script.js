/**
 * WatchTogether - Content script
 * ---------------------------------
 * Runs on supported streaming sites (see adapters.js). Finds the real
 * <video> element, mirrors local play/pause/seek to the offscreen document
 * (which relays it over the peer-to-peer data channel), and applies remote
 * play/pause/seek events coming back the other way.
 *
 * Control is mutual: either person's play/pause/seek propagates to the
 * other. A periodic heartbeat also corrects small drift over a long movie.
 */

(function () {
  const adapter = typeof getAdapterForCurrentSite === 'function' ? getAdapterForCurrentSite() : null;
  if (!adapter) return; // unsupported site — do nothing

  const DRIFT_THRESHOLD_SECONDS = 1.5; // how far out of sync before we auto-correct
  const HEARTBEAT_INTERVAL_MS = 3000;
  const SUPPRESS_WINDOW_MS = 400; // ignore our own events right after applying a remote change
  const VIDEO_POLL_MS = 1000; // sites load the <video> element asynchronously

  let video = null;
  let suppressOutgoing = false;
  let registered = false;
  let lastKnownUrl = location.href;
  let contextInvalidated = false;
  let intervalIds = [];

  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (err) {
      return false;
    }
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    intervalIds.forEach((id) => clearInterval(id));
    showBanner('WatchTogether was updated — refresh this page to keep syncing.');
    console.log('[WatchTogether] extension context invalidated; stopped trying to sync. Refresh this page.');
  }

  function send(payload) {
    // If the extension was reloaded/updated while this page's content
    // script is still the old instance, chrome.runtime.sendMessage can
    // throw "Extension context invalidated" — and that specific error can
    // slip past try/catch and .catch() because it comes from the browser's
    // internal message port, not normal JS. So check proactively instead
    // of relying on catching it after the fact.
    if (!isContextValid()) {
      handleContextInvalidated();
      return;
    }
    try {
      chrome.runtime.sendMessage({ source: 'content-script', ...payload }).catch(() => {
        handleContextInvalidated();
      });
    } catch (err) {
      handleContextInvalidated();
    }
  }

  function getBannerContainer() {
    const fs = document.fullscreenElement;
    if (!fs) return document.body;
    // Video elements can't host children visibly — use the parent wrapper instead.
    return fs.tagName === 'VIDEO' ? (fs.parentElement || document.body) : fs;
  }

  function showBanner(text) {
    const container = getBannerContainer();
    let el = document.getElementById('watchtogether-banner');
    // Move to the correct layer if fullscreen state changed since last show.
    if (el && el.parentElement !== container) {
      el.remove();
      el = null;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'watchtogether-banner';
      el.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
        'background:rgba(20,20,20,0.92);color:#fff;padding:10px 18px;' +
        'border-radius:8px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;' +
        'z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:none;';
      container.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 6000);
  }

  // Keep the banner in the correct rendering layer when the user toggles fullscreen.
  document.addEventListener('fullscreenchange', () => {
    const el = document.getElementById('watchtogether-banner');
    if (!el || el.style.display === 'none') return;
    const container = getBannerContainer();
    if (el.parentElement !== container) container.appendChild(el);
  });

  function registerTab() {
    if (registered) return;
    registered = true;
    send({ type: 'register-tab', site: adapter.id, url: location.href, isTopFrame: window.top === window.self });
    console.log(`[WatchTogether] ${adapter.name} detected, video controls hooked up.`);
  }

  function attachVideoListeners(v) {
    video = v;
    send({ type: 'video-detected' });
    registerTab();

    video.addEventListener('play', () => {
      if (suppressOutgoing) return;
      send({ type: 'video-event', kind: 'play', time: video.currentTime });
    });

    video.addEventListener('pause', () => {
      if (suppressOutgoing) return;
      send({ type: 'video-event', kind: 'pause', time: video.currentTime });
    });

    video.addEventListener('seeked', () => {
      if (suppressOutgoing) return;
      send({ type: 'video-event', kind: 'seek', time: video.currentTime });
    });
  }

  function applyRemote(payload) {
    if (payload.banner) showBanner(payload.banner);

    if (payload.kind === 'force-pause') {
      if (video) {
        suppressOutgoing = true;
        video.pause();
        setTimeout(() => {
          suppressOutgoing = false;
        }, SUPPRESS_WINDOW_MS);
      }
      return;
    }

    if (!video) return;
    const { kind, time, paused } = payload;

    suppressOutgoing = true;

    const isInitialSync = kind === 'state-announce';
    const diff = Math.abs(video.currentTime - time);
    if (diff > (isInitialSync ? 0.5 : DRIFT_THRESHOLD_SECONDS)) {
      video.currentTime = time;
    }

    if (kind === 'play') {
      video.play().catch(() => {});
    } else if (kind === 'pause') {
      video.pause();
    } else if ((kind === 'heartbeat' || kind === 'state-announce') && typeof paused === 'boolean') {
      if (paused && !video.paused) video.pause();
      if (!paused && video.paused) video.play().catch(() => {});
    }
    // kind === 'seek' just needed the currentTime jump above, nothing else to do.

    setTimeout(() => {
      suppressOutgoing = false;
    }, SUPPRESS_WINDOW_MS);
  }

  // Remote sync events arrive here via chrome.tabs.sendMessage from
  // background.js (content scripts can't receive the plain runtime broadcast).
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'remote-sync') return;
    applyRemote(message.payload);
  });

  // Find the video element (and re-find it if the page swaps it, e.g.
  // navigating to a new YouTube video in the same tab).
  intervalIds.push(setInterval(() => {
    const found = adapter.findVideoElement();
    if (found && found !== video) attachVideoListeners(found);
  }, VIDEO_POLL_MS));

  // Periodic drift-correction heartbeat.
  intervalIds.push(setInterval(() => {
    if (!video || suppressOutgoing) return;
    send({ type: 'video-event', kind: 'heartbeat', time: video.currentTime, paused: video.paused });
  }, HEARTBEAT_INTERVAL_MS));

  // YouTube is a single-page app — navigating to a different video usually
  // doesn't reload the page, so watch for URL changes directly. Only
  // matters if we're the host (offscreen.js decides whether to propagate).
  intervalIds.push(setInterval(() => {
    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      send({ type: 'url-changed', url: lastKnownUrl });
    }
  }, 1000));
})();
