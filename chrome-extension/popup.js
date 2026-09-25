const startBtn = document.getElementById('start-btn');
const joinBtn = document.getElementById('join-btn');
const joinInput = document.getElementById('join-code');
const codeDisplay = document.getElementById('code-display');
const copyBtn = document.getElementById('copy-btn');
const statusEl = document.getElementById('status');
const leaveBtn = document.getElementById('leave-btn');
const preView = document.getElementById('pre-party-view');
const inPartyView = document.getElementById('in-party-view');
const serverStatusEl = document.getElementById('server-status');
const siteStatusEl = document.getElementById('site-status');
const linkShareView = document.getElementById('link-share-view');
const linkInput = document.getElementById('link-input');
const sendLinkBtn = document.getElementById('send-link-btn');

function normalizeUrl(raw) {
  const url = raw.trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function showInPartyUI(code) {
  preView.style.display = 'none';
  inPartyView.style.display = 'block';
  if (code) codeDisplay.textContent = code;
}

function resetToFreshUI() {
  preView.style.display = 'block';
  inPartyView.style.display = 'none';
  codeDisplay.textContent = '';
  linkShareView.style.display = 'none';
  linkInput.value = '';
  joinInput.value = '';
  setStatus('Not connected.');
  checkServerStatus(); // we're back to a clean slate — is the server still up?
}

// Make sure the offscreen document (which holds the real connection) exists
// before we try to talk to it. Safe to call repeatedly — it's a no-op if
// the document is already there.
function ensureOffscreen() {
  return chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
}

function sendToOffscreen(message) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

// --- Signaling server reachability check ---
// There's no point offering Start/Join if the local server isn't running.
function checkServerStatus() {
  serverStatusEl.textContent = 'Checking signaling server...';
  serverStatusEl.style.color = '#666';
  startBtn.disabled = true;
  joinBtn.disabled = true;

  let settled = false;
  let testWs;
  try {
    testWs = new WebSocket(WATCHTOGETHER_SIGNALING_URL);
  } catch (err) {
    markServerOffline();
    return;
  }

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    markServerOffline();
    try { testWs.close(); } catch (err) {}
  }, 2000);

  function markServerOffline() {
    serverStatusEl.textContent = '⚠ Signaling server not reachable. Run "node server.js" first.';
    serverStatusEl.style.color = '#dc2626';
    startBtn.disabled = true;
    joinBtn.disabled = true;
  }

  testWs.onopen = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    serverStatusEl.textContent = '● Signaling server online';
    serverStatusEl.style.color = '#16a34a';
    startBtn.disabled = false;
    joinBtn.disabled = false;
    testWs.close();
  };

  testWs.onerror = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    markServerOffline();
  };
}

copyBtn.addEventListener('click', () => {
  const code = codeDisplay.textContent;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });
});

async function checkSiteStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'get-tab-video-status', tabId: tab.id });
  } catch (err) {
    return;
  }
  if (response && response.hasVideo) {
    siteStatusEl.textContent = '● Video detected on this tab';
    siteStatusEl.style.color = '#16a34a';
  } else {
    siteStatusEl.textContent = '● No video detected on this tab';
    siteStatusEl.style.color = '#9ca3af';
  }
}

startBtn.addEventListener('click', async () => {
  await ensureOffscreen();
  sendToOffscreen({ type: 'start-party' });
  showInPartyUI();
  setStatus('Creating party...');
});

joinBtn.addEventListener('click', async () => {
  const code = joinInput.value.trim().toUpperCase();
  if (!code) return;
  await ensureOffscreen();
  sendToOffscreen({ type: 'join-party', code });
  showInPartyUI();
  setStatus('Joining party...');
});

leaveBtn.addEventListener('click', () => {
  sendToOffscreen({ type: 'leave-party' });
  resetToFreshUI();
});

sendLinkBtn.addEventListener('click', () => {
  const url = normalizeUrl(linkInput.value);
  if (!url) return;
  sendToOffscreen({ type: 'send-link', url });
  setStatus('Link sent — opening on your partner\'s browser...');
  linkInput.value = '';
});

// --- Restore the real current state whenever the popup is (re)opened ---
// The offscreen document keeps running even while the popup is closed, so
// on open we ask it "what's actually happening right now?" instead of
// always showing a blank Start/Join screen.
async function restoreState() {
  await ensureOffscreen();
  let status;
  try {
    status = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'get-status' });
  } catch (err) {
    resetToFreshUI();
    return false;
  }

  if (!status || (!status.role && !status.roomCode)) {
    resetToFreshUI();
    return false;
  }

  showInPartyUI(status.roomCode);

  if (status.dataChannelState === 'open') {
    setStatus('Connected!');
    linkShareView.style.display = 'block';
  } else if (status.iceConnectionState === 'checking' || status.pcConnectionState === 'connecting') {
    setStatus('Still connecting...');
  } else if (status.role === 'host' && !status.roomCode) {
    setStatus('Creating party...');
  } else if (status.role === 'host') {
    setStatus('Party created. Waiting for your partner to join with the code above.');
  } else if (status.role === 'guest') {
    setStatus('Joined! Connecting to host...');
  } else {
    resetToFreshUI();
    return false;
  }
  return true;
}

async function init() {
  const inParty = await restoreState();
  if (!inParty) checkServerStatus();
  checkSiteStatus();
}
init();

// Listen for live updates forwarded from the offscreen document while the
// popup is open (Chrome delivers these directly, no relay needed).
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'popup') return;

  switch (message.type) {
    case 'party-created':
      showInPartyUI(message.code);
      setStatus('Party created. Send this code to your partner and wait for them to join.');
      break;

    case 'party-joined':
      showInPartyUI(message.code);
      setStatus('Joined! Connecting to host...');
      break;

    case 'status':
      setStatus(message.message);
      break;

    case 'datachannel-open':
      setStatus('Connected!');
      linkShareView.style.display = 'block';
      break;

    case 'left-party':
      resetToFreshUI();
      break;

    case 'party-ended':
      resetToFreshUI();
      setStatus(message.message);
      break;

    case 'join-failed':
      resetToFreshUI();
      setStatus(message.message);
      break;
  }
});
