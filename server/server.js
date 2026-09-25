/**
 * Watch Party - Signaling Server
 * ---------------------------------
 * This server does NOT touch any movie data, sync data, or camera video.
 * Its only job is:
 *   1. Let one client "create" a party -> generate a short room code.
 *   2. Let another client "join" a party using that code.
 *   3. Relay WebRTC handshake messages (SDP offers/answers + ICE candidates)
 *      between the two peers so they can establish a DIRECT peer-to-peer
 *      connection (RTCDataChannel for sync, MediaStream later for camera).
 *
 * Once the two peers are connected directly, this server is no longer
 * involved at all for that party.
 *
 * Run: node server.js
 * Default port: 8787 (override with PORT env var)
 */

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

// In-memory room storage. A "room" = one party.
// rooms[code] = { host: ws, guest: ws|null }
const rooms = new Map();

function generateRoomCode() {
  // 6-character, easy-to-read code (no ambiguous chars like 0/O, 1/I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code)); // avoid collisions
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  // Track which room + role this specific socket belongs to
  ws._roomCode = null;
  ws._role = null; // 'host' | 'guest'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return send(ws, { type: 'error', message: 'Invalid JSON message' });
    }

    switch (msg.type) {
      // --- Host creates a new party ---
      case 'create': {
        const code = generateRoomCode();
        rooms.set(code, { host: ws, guest: null });
        ws._roomCode = code;
        ws._role = 'host';
        send(ws, { type: 'created', code });
        console.log(`[party] created room ${code}`);
        break;
      }

      // --- Guest joins an existing party ---
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: 'error', message: 'Party code not found.' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'error', message: 'That party already has two people.' });
          return;
        }

        room.guest = ws;
        ws._roomCode = code;
        ws._role = 'guest';

        send(ws, { type: 'joined', code });
        // Tell the host someone joined, so the host can start the
        // WebRTC offer/answer handshake.
        send(room.host, { type: 'peer-joined', code });
        console.log(`[party] guest joined room ${code}`);
        break;
      }

      // --- Relay WebRTC handshake data (SDP offer/answer, ICE candidates) ---
      // We don't inspect this payload at all, just forward it to the other peer.
      case 'signal': {
        const room = rooms.get(ws._roomCode);
        if (!room) return;

        const other = ws._role === 'host' ? room.guest : room.host;
        send(other, { type: 'signal', data: msg.data });
        break;
      }

      // --- Either side can explicitly end the party ---
      case 'leave': {
        closeRoom(ws, 'peer-left');
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    closeRoom(ws, 'peer-disconnected');
  });
});

function closeRoom(ws, notifyType) {
  const code = ws._roomCode;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) return;

  const other = ws._role === 'host' ? room.guest : room.host;
  send(other, { type: notifyType });

  rooms.delete(code);
  console.log(`[party] room ${code} closed (${notifyType})`);
}

console.log(`Watch Party signaling server listening on ws://localhost:${PORT}`);
