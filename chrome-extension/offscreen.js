/**
 * WatchTogether - Offscreen document
 * -----------------------------------
 * This is where the actual live connection lives:
 *   - WebSocket to the local signaling server (party create/join + handshake relay)
 *   - RTCPeerConnection (the real peer-to-peer link between the two browsers)
 *   - RTCDataChannel "sync" (used later to send play/pause/seek events)
 *
 * It never touches the DOM or shows anything to the user. It just talks to
 * background.js via chrome.runtime messages, and background.js forwards
 * things to/from the popup.
 */

const SIGNALING_SERVER_URL = WATCHTOGETHER_SIGNALING_URL;

// Public STUN server, just used to discover each browser's public IP/port
// for the P2P connection. No video/movie/camera data ever goes through this,
// it's only used during connection setup.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let ws = null;
let pc = null;
let dataChannel = null;
let role = null; // 'host' | 'guest'
let roomCode = null;

// Last known state of the local video (if a supported site is open in the
// tab), kept updated from 'video-event' messages sent by the content script.
// Used to answer "what's your current state?" the moment a connection opens.
let lastLocalState = null; // { time, paused }

// URL of the video the HOST currently has open. Only the host's navigation
// propagates to the guest — the guest changing tabs/videos does not affect
// the host, per the "host manages the URL" model.
let lastKnownUrl = null;
let lastAnnouncedUrl = null; // last URL we actually told the guest about (dedupe)

function notifyPopup(message) {
  chrome.runtime.sendMessage({ target: 'popup', ...message }).catch(() => {
    // Popup may not be open right now — that's fine, it's not an error.
  });
}

function connectSignaling() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(SIGNALING_SERVER_URL);

  ws.onopen = () => {
    console.log('[offscreen] connected to signaling server');
  };

  ws.onerror = () => {
    notifyPopup({ type: 'status', status: 'error', message: 'Could not reach signaling server. Is it running?' });
  };

  ws.onclose = () => {
    notifyPopup({ type: 'status', status: 'disconnected', message: 'Disconnected from signaling server.' });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    console.log('[offscreen] signaling message:', msg);

    switch (msg.type) {
      case 'created':
        roomCode = msg.code;
        notifyPopup({ type: 'party-created', code: roomCode });
        break;

      case 'joined':
        roomCode = msg.code;
        notifyPopup({ type: 'party-joined', code: roomCode });
        break;

      case 'peer-joined':
        // We're the host, and a guest just joined. Start the WebRTC offer.
        notifyPopup({ type: 'status', status: 'connecting', message: 'Peer joined, connecting...' });
        await startWebRTCAsHost();
        break;

      case 'signal':
        await handleSignal(msg.data);
        break;

      case 'peer-left':
      case 'peer-disconnected':
        relayToContentScript({ kind: 'force-pause', banner: 'Your partner left the party. Playback paused.' });
        teardownPeerConnection();
        // The room is fully deleted server-side the moment either person
        // leaves — this code can't be rejoined. Reset our state to match,
        // so the UI correctly shows "not in a party" rather than getting
        // stuck looking connected.
        role = null;
        roomCode = null;
        lastLocalState = null;
        lastKnownUrl = null;
        lastAnnouncedUrl = null;
        notifyPopup({ type: 'party-ended', message: 'The other person left. Playback paused.' });
        break;

      case 'error':
        if (!dataChannel) {
          // A create/join attempt failed before any connection was made —
          // reset back to a clean slate rather than leaving the UI looking
          // like we're still "in" a party.
          role = null;
          roomCode = null;
          notifyPopup({ type: 'join-failed', message: msg.message });
        } else {
          notifyPopup({ type: 'status', status: 'error', message: msg.message });
        }
        break;
    }
  };
}

function sendSignaling(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignaling({ type: 'signal', data: { candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[offscreen] connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      notifyPopup({ type: 'status', status: 'connected', message: 'Connected directly to your partner!' });
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      notifyPopup({ type: 'status', status: 'disconnected', message: 'Peer connection lost.' });
    }
  };

  // Useful for debugging when a connection gets stuck: this fires more often
  // than onconnectionstatechange and tells you exactly which stage ICE is in.
  pc.oniceconnectionstatechange = () => {
    console.log('[offscreen] ICE connection state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'checking') {
      notifyPopup({ type: 'status', status: 'connecting', message: 'Connecting... (ICE checking)' });
    } else if (pc.iceConnectionState === 'failed') {
      notifyPopup({
        type: 'status',
        status: 'error',
        message: 'Connection failed (ICE failed). See chrome://webrtc-internals for details.',
      });
    }
  };

  return pc;
}

function setupDataChannelHandlers(channel) {
  dataChannel = channel;

  dataChannel.onopen = () => {
    console.log('[offscreen] data channel open');
    notifyPopup({ type: 'datachannel-open' });

    // Initial sync when someone joins mid-movie: the host's current URL and
    // playback state win for this one-time announce. After this, playback
    // control (not navigation) is fully mutual.
    if (role === 'host') {
      if (lastKnownUrl) {
        dataChannel.send(JSON.stringify({ kind: 'navigate', url: lastKnownUrl }));
        lastAnnouncedUrl = lastKnownUrl;
      }
      if (lastLocalState) {
        dataChannel.send(JSON.stringify({ kind: 'state-announce', ...lastLocalState }));
      }
    }
  };

  dataChannel.onclose = () => {
    console.log('[offscreen] data channel closed');
  };

  dataChannel.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log('[offscreen] sync message received:', msg);

    if (msg.kind === 'navigate' || msg.kind === 'shared-link') {
      // Only background can change what URL a tab is showing.
      chrome.runtime.sendMessage({ type: 'navigate-tab', url: msg.url }).catch(() => {});
      return;
    }

    // Real playback events (play/pause/seek/heartbeat/state-announce/force-pause) —
    // forward to the content script controlling the actual <video> element.
    relayToContentScript(msg);
  };
}

function relayToContentScript(payload) {
  chrome.runtime.sendMessage({ target: 'content-script', payload: { type: 'remote-sync', payload } }).catch(() => {});
}

async function startWebRTCAsHost() {
  role = 'host';
  createPeerConnection();

  const channel = pc.createDataChannel('sync');
  setupDataChannelHandlers(channel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignaling({ type: 'signal', data: { sdp: offer } });
}

async function startWebRTCAsGuest() {
  role = 'guest';
  createPeerConnection();

  pc.ondatachannel = (event) => {
    setupDataChannelHandlers(event.channel);
  };
}

async function handleSignal(data) {
  if (!pc) {
    // Guest receives the offer before it has a PeerConnection yet.
    await startWebRTCAsGuest();
  }

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignaling({ type: 'signal', data: { sdp: answer } });
    }
  }

  if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn('[offscreen] failed to add ICE candidate', err);
    }
  }
}

function teardownPeerConnection() {
  if (dataChannel) dataChannel.close();
  if (pc) pc.close();
  dataChannel = null;
  pc = null;
}

function leaveParty() {
  sendSignaling({ type: 'leave' });
  teardownPeerConnection();
  if (ws) {
    ws.close();
    ws = null;
  }
  role = null;
  roomCode = null;
  lastLocalState = null;
  lastKnownUrl = null;
  lastAnnouncedUrl = null;
  partyTabId = null;
  partyFrameId = null;
  partyIsTopFrame = false;
  notifyPopup({ type: 'left-party' });
}

function getStatus() {
  return {
    role,
    roomCode,
    wsState: ws ? ws.readyState : null, // 0=connecting,1=open,2=closing,3=closed
    pcConnectionState: pc ? pc.connectionState : null,
    iceConnectionState: pc ? pc.iceConnectionState : null,
    dataChannelState: dataChannel ? dataChannel.readyState : null,
  };
}

// --- Messages coming in directly from the popup (Chrome broadcasts
// chrome.runtime.sendMessage to every extension page automatically, so we
// receive these straight from popup.js — no relay needed). ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from the content script (also delivered directly, same reason).
  if (message.source === 'content-script') {
    handleContentScriptMessage(message, sender);
    return;
  }

  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'get-status':
      // Lets the popup restore the correct UI when it's reopened, instead
      // of always showing a fresh "Not connected" screen.
      sendResponse(getStatus());
      break;

    case 'start-party':
      connectSignaling();
      ws.addEventListener('open', () => sendSignaling({ type: 'create' }), { once: true });
      if (ws.readyState === WebSocket.OPEN) sendSignaling({ type: 'create' });
      break;

    case 'join-party':
      connectSignaling();
      const doJoin = () => sendSignaling({ type: 'join', code: message.code });
      if (ws.readyState === WebSocket.OPEN) doJoin();
      else ws.addEventListener('open', doJoin, { once: true });
      break;

    case 'send-link':
      // Either person can push a URL to open on the other's browser —
      // independent of the host-only automatic navigation tracking.
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ kind: 'shared-link', url: message.url }));
      }
      break;

    case 'leave-party':
      leaveParty();
      break;
  }
});

// --- Messages coming in from the content script (running on the movie page) ---
// Now that content scripts run on every site/frame (needed to reach video
// elements inside iframes like hdtoday.one's embeds), YouTube's own ad
// iframes (which often have their own <video> tags) can register too. We
// lock onto one exact frame — preferring the top-level page's frame over
// any iframe once it's found a video, since ads should never win — but
// still allow an iframe to register when the top-level page has no video
// itself (that's the hdtoday.one case, where the real player is an iframe).
let partyTabId = null;
let partyFrameId = null;
let partyIsTopFrame = false;

function handleContentScriptMessage(message, sender) {
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  const senderFrameId = sender && typeof sender.frameId === 'number' ? sender.frameId : null;

  if (message.type === 'register-tab') {
    const isTop = !!message.isTopFrame;

    if (senderTabId === partyTabId && partyIsTopFrame && !isTop) {
      // We already locked onto the top-level frame for this tab — don't
      // let a lower-priority iframe (ads, widgets) steal control.
      return;
    }

    partyTabId = senderTabId;
    partyFrameId = senderFrameId;
    partyIsTopFrame = isTop;
    // Let background know exactly which frame to target when relaying
    // remote sync events back to the content script (not just the tab —
    // chrome.tabs.sendMessage would otherwise broadcast to every frame,
    // including ad iframes with their own unrelated <video> tags).
    chrome.runtime.sendMessage({ type: 'set-party-frame', tabId: partyTabId, frameId: partyFrameId }).catch(() => {});

    console.log(`[offscreen] supported site detected: ${message.site} (tab ${partyTabId}, frame ${partyFrameId}, top=${isTop})`);
    if (message.url) lastKnownUrl = message.url;

    // If we're already connected and we're the host, the peer may have
    // joined (or navigated in) before this page finished loading — send
    // them our URL and state now.
    if (role === 'host' && dataChannel && dataChannel.readyState === 'open') {
      if (lastKnownUrl && lastKnownUrl !== lastAnnouncedUrl) {
        dataChannel.send(JSON.stringify({ kind: 'navigate', url: lastKnownUrl }));
        lastAnnouncedUrl = lastKnownUrl;
      }
      if (lastLocalState) {
        dataChannel.send(JSON.stringify({ kind: 'state-announce', ...lastLocalState }));
      }
    }
    return;
  }

  // Ignore anything not from the exact frame we've locked onto.
  if (senderTabId !== partyTabId || senderFrameId !== partyFrameId) return;

  if (message.type === 'url-changed') {
    lastKnownUrl = message.url;
    if (role === 'host' && dataChannel && dataChannel.readyState === 'open' && lastKnownUrl !== lastAnnouncedUrl) {
      dataChannel.send(JSON.stringify({ kind: 'navigate', url: lastKnownUrl }));
      lastAnnouncedUrl = lastKnownUrl;
    }
    return;
  }

  if (message.type === 'video-event') {
    const paused = message.kind === 'pause' ? true : message.kind === 'play' ? false : message.paused;
    lastLocalState = { time: message.time, paused: paused ?? lastLocalState?.paused ?? false };

    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ kind: message.kind, time: message.time, paused: lastLocalState.paused }));
    }
  }
}
