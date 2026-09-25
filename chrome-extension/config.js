/**
 * WatchTogether - Shared config
 * --------------------------------
 * Single source of truth for the local signaling server's address, used by
 * both popup.js (for the "is the server reachable?" check) and offscreen.js
 * (for the actual party connection). Change it here if you ever run the
 * server on a different port or host.
 */
const WATCHTOGETHER_SIGNALING_URL = 'ws://localhost:8787';
