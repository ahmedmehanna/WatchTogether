# WatchTogether — Project Summary

## What this is
A Chrome extension + local signaling server that lets two people watch a movie
"together" while each streams it on their own laptop (own Netflix/YouTube/etc.
session, full quality, no screen-share lag). The extension keeps play/pause/
seek in sync between the two browsers over a direct peer-to-peer connection,
lets either person push a link for the other to open, and (not yet built) will
add a picture-in-picture camera call.

**Folder layout:**
```
project-root/
├── server/            → signaling server (Node.js + ws)
│   ├── server.js
│   └── package.json
└── chrome-extension/  → the actual browser extension (Manifest V3)
    ├── manifest.json
    ├── config.js          (shared constants, e.g. signaling server URL)
    ├── background.js      (service worker — routing + offscreen lifecycle)
    ├── offscreen.html/js  (holds the real WebSocket + WebRTC connection)
    ├── popup.html/js       (Start/Join/Leave UI)
    ├── adapters.js         (per-site video-element finders)
    └── content-script.js   (runs on movie pages, hooks the <video> element)
```

## Architecture, in short
- **Signaling server** (`server/server.js`): plain Node.js WebSocket server.
  Only job: hand out a 6-character party code, pair two sockets into a room,
  and relay the WebRTC handshake (SDP/ICE) between them. Once that handshake
  completes, the server is no longer involved — movie sync and (later) camera
  video go directly peer-to-peer.
- **Offscreen document** (`offscreen.js`): MV3 service workers get killed
  after ~30s idle, which would drop a live connection — so the actual
  WebSocket + `RTCPeerConnection` + `RTCDataChannel` live in a hidden
  "offscreen document" instead, which persists properly.
- **Background service worker** (`background.js`): deliberately thin. Only
  responsibilities: (1) make sure the offscreen document exists, (2) relay
  messages to a specific tab/frame via `chrome.tabs.sendMessage` (content
  scripts can't receive the normal extension-wide broadcast, unlike popup/
  offscreen which can talk to each other directly).
- **Content script + adapters** (`content-script.js`, `adapters.js`): finds
  the real `<video>` element on the page (site-specific logic in adapters.js),
  mirrors local play/pause/seek out, applies remote events coming in, and
  runs a periodic heartbeat for drift correction.
- **Popup** (`popup.js`): Start Party / Join Party / Leave Party UI, plus a
  live signaling-server reachability check.

## Data channel message protocol (JSON over the RTCDataChannel)
- `{kind:'play'|'pause'|'seek', time}` — immediate playback events
- `{kind:'heartbeat', time, paused}` — sent every 3s, used for drift
  correction (auto-corrects if >1.5s out of sync)
- `{kind:'state-announce', time, paused}` — sent once by the host right when
  the connection opens, so someone joining mid-movie auto-jumps to match
- `{kind:'navigate', url}` — host-only automatic navigation propagation
- `{kind:'shared-link', url}` — manual "Send Link" button, either person can
  trigger this regardless of host/guest role
- `{kind:'force-pause', banner}` — used when a party ends, pauses the other
  side and shows an on-page banner message
- `{kind:'test', text, time}` — debug message from the popup's test button

## Key design decisions made along the way
- **Control model:** play/pause/seek is fully mutual (either person can
  control it, syncs both ways). **Navigation is host-only** — only the
  person who started the party can auto-navigate the other's browser to a
  new URL. Either person can also manually push a link via "Send Link"
  regardless of role.
- **Joining mid-movie:** the guest auto-jumps to the host's current
  timestamp and URL the moment the connection opens.
- **Leaving a party:** deletes the room entirely, server-side — the code
  cannot be reused. The remaining person gets an on-page banner and their
  video is force-paused. Both sides fully reset to the Start/Join screen.
- **Frame-locking safeguard:** the content script runs on every site and
  inside every iframe (needed to reach embedded players like hdtoday.one's,
  which lives in a cross-origin iframe). To stop unrelated iframes (e.g.
  YouTube's own ad iframes, which can have their own `<video>` tag) from
  hijacking the sync state, the extension locks onto one exact tab+frame.
  The top-level page's own frame always wins once it has a video; an iframe
  only becomes the source of truth when the top-level page itself has none
  (the hdtoday.one case).
- **"Extension context invalidated" errors:** a known Chrome quirk when the
  extension is reloaded while an old tab is still running the previous
  content script instance. Can't be reliably caught with try/catch — instead
  the content script proactively checks `chrome.runtime.id` before each send
  and shows an on-page banner ("refresh this page") instead of erroring.

## ✅ Done
- Signaling server: party create/join, 6-char codes, WebRTC handshake relay,
  leave handling
- Extension scaffold: Manifest V3, background service worker, offscreen
  document, popup UI
- P2P `RTCDataChannel` established and tested working end-to-end
- Site adapter interface + **YouTube adapter** (tested working)
- **Generic fallback adapter** (any `<video>` tag, picks largest if multiple)
  — confirmed working on **hdtoday.one** (video lives in a cross-origin
  iframe; required `all_frames: true` + broad `<all_urls>` matching)
- Mutual play/pause/seek sync + periodic drift-correction heartbeat
- Host-controlled automatic URL navigation (host's tab changes → guest's
  browser follows)
- Manual "Send Link" feature (either person, any URL, opens on the other's
  browser)
- Leave Party: full graceful cleanup both sides, on-page banner + force-pause
  notification to the remaining person
- Signaling-server reachability check in the popup before allowing Start/Join
- Frame-level party lock (prevents ad iframes / unrelated tabs from
  interfering with sync state)
- Graceful handling of stale "Extension context invalidated" errors

## 🚧 Not yet done
Roughly following the original phase plan, adjusted for what's actually
been prioritized in this project:

1. **Netflix adapter** — next up. Same idea as YouTube (find the `<video>`
   element), but Netflix's DOM/class names are obfuscated and may need a
   more defensive selector. DRM only protects the video pixels, not the
   `play()`/`pause()`/`currentTime` controls, so sync itself shouldn't be
   blocked by it — but this needs to be verified against a real account.
2. **Prime Video / Disney+ adapters** — explicitly deprioritized by the
   user for now (not a current focus).
3. **Site-support badge** — the extension icon/popup doesn't yet show a
   clear "this site is supported" / "not supported" indicator for the
   current tab.
4. **Fullscreen support** — not yet handled. The on-page banner (leave
   notice, context-invalidated notice) will NOT be visible during true
   browser fullscreen playback, since fullscreen content sits in its own
   top rendering layer above the rest of the page. Playback sync itself
   likely still works in fullscreen (untested) since it doesn't depend on
   banner visibility — only the notification banners are the known gap.
5. **Camera (picture-in-picture call)** — not started at all. Planned
   approach: reuse the same P2P connection/signaling already in place to
   also negotiate an audio/video `MediaStream`, with a draggable PiP overlay
   UI, mute/camera-off controls.
6. **Reconnect handling** — network drop, laptop sleep, or tab reload
   currently just ends the party (treated the same as "peer left"). No
   automatic reconnect-to-same-party attempt exists yet.
7. **Party UX polish** — no copy-to-clipboard button for the party code
   (currently manual read/type), no settings UI (signaling server URL is
   hardcoded in `config.js`, no in-popup way to change it).

## How to run it locally
```bash
cd server
npm install
node server.js   # listens on ws://localhost:8787
```
Then in Chrome: `chrome://extensions` → enable Developer mode → Load
unpacked → select the `chrome-extension` folder. Repeat in a second Chrome
profile to test both sides. **After any code change:** remove and re-add the
extension in both profiles (a plain reload has been unreliable in testing),
then refresh any already-open movie tabs.
