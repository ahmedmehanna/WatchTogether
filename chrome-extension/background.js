/**
 * WatchTogether - Background service worker
 * --------------------------------------------
 * IMPORTANT: chrome.runtime.sendMessage() already broadcasts to every
 * extension page (popup, offscreen document, background) automatically.
 * This service worker must NOT re-forward those messages itself, or every
 * command gets processed twice (that was the bug causing the connection
 * to stall — the host ended up creating two different room codes).
 *
 * So this file has exactly one job: make sure the offscreen document
 * exists before the popup tries to talk to it.
 */

let creatingOffscreenPromise = null;
let contentScriptTabId = null; // the tab currently running our content script on a supported site
let contentScriptFrameId = null; // the exact frame within that tab (see offscreen.js for why this matters)

const videoTabs = new Set(); // tab IDs where a video element has been found by the content script

chrome.tabs.onRemoved.addListener((tabId) => {
  videoTabs.delete(tabId);
});

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WEB_RTC'],
    justification: 'Maintain a persistent peer-to-peer connection with the other viewer for playback sync and camera.',
  });

  await creatingOffscreenPromise;
  creatingOffscreenPromise = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle the one message type meant for background. Everything else
  // (target: 'offscreen', target: 'popup') is already delivered directly
  // by Chrome's built-in broadcast — do not re-send it.
  if (message.type === 'ensure-offscreen') {
    ensureOffscreenDocument().then(() => sendResponse({ ready: true }));
    return true; // keep the message channel open for the async response
  }

  // Content script found a video element — track the tab for the site-support badge.
  if (message.source === 'content-script' && message.type === 'video-detected' && sender.tab) {
    videoTabs.add(sender.tab.id);
    return;
  }

  // Popup asking whether the active tab has a video (drives the site-support badge).
  if (message.type === 'get-tab-video-status') {
    sendResponse({ hasVideo: videoTabs.has(message.tabId) });
    return true;
  }

  // offscreen.js decides which exact tab+frame is "the party frame" (it
  // applies the top-frame-preference logic to avoid ad iframes hijacking
  // control) and tells us here, so we know exactly where to relay to.
  if (message.type === 'set-party-frame') {
    contentScriptTabId = message.tabId;
    contentScriptFrameId = message.frameId;
    console.log('[background] party frame set to tab', contentScriptTabId, 'frame', contentScriptFrameId);
    return;
  }

  if (message.target === 'content-script') {
    if (contentScriptTabId != null) {
      const options = contentScriptFrameId != null ? { frameId: contentScriptFrameId } : undefined;
      chrome.tabs.sendMessage(contentScriptTabId, message.payload, options).catch(() => {
        // Tab/frame may have navigated away or closed — ignore.
      });
    }
    return;
  }

  // Host navigated to a different video — open/update the same URL on our
  // side (we're the guest receiving this). If we don't have a known party
  // tab yet, open a new one and remember it.
  if (message.type === 'navigate-tab') {
    contentScriptFrameId = null; // the frame is about to change; wait for a fresh registration
    if (contentScriptTabId != null) {
      chrome.tabs.update(contentScriptTabId, { url: message.url }).catch(() => {
        chrome.tabs.create({ url: message.url }).then((tab) => {
          contentScriptTabId = tab.id;
        });
      });
    } else {
      chrome.tabs.create({ url: message.url }).then((tab) => {
        contentScriptTabId = tab.id;
      });
    }
    return;
  }
});

// Keep the offscreen document alive as soon as the extension starts up,
// so it's ready the moment the user opens the popup.
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
});
