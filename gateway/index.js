const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Logging ganda ke Terminal Console & File gateway.log
const logFilePath = path.join(__dirname, 'gateway.log');
const origLog = console.log;
const origErr = console.error;

function appendToLog(prefix, args) {
  try {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    fs.appendFileSync(logFilePath, `[${time}] ${prefix} ${text}\n`, 'utf8');
  } catch (e) {}
}

console.log = (...args) => {
  origLog(...args);
  appendToLog('', args);
};

console.error = (...args) => {
  origErr(...args);
  appendToLog('[ERROR]', args);
};

// HTTP Status Server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/benchmark' || req.url === '/benchmark.html') {
    const benchPath = path.join(__dirname, '..', 'client', 'benchmark.html');
    if (fs.existsSync(benchPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(benchPath).pipe(res);
    }
  }

  if (req.url === '/api/status' || req.url === '/') {
    const onlineList = Array.from(clients.entries()).map(([userId, d]) => ({
      userId,
      appName: d.appName,
      isBusy: d.busyWith !== null,
      roomId: d.roomId
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      gateway: 'Shared WebRTC Gateway & Room Broker',
      status: 'active',
      benchmarkDashboard: '/benchmark.html',
      onlineCount: clients.size,
      users: onlineList
    }));
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocket Gateway Server
const wss = new WebSocketServer({ server });

// Map userId -> { ws, appName: 'APP_A'|'APP_B', busyWith: null, roomId: null }
const clients = new Map();

function broadcastUserList() {
  const users = Array.from(clients.entries()).map(([userId, data]) => ({
    userId,
    appName: data.appName || 'UNKNOWN',
    isBusy: data.busyWith !== null
  }));

  const msg = JSON.stringify({ type: 'users', users });

  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  });
}

function sendTo(userId, data) {
  const c = clients.get(userId);
  if (c && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

wss.on('connection', (ws) => {
  let currentUserId = null;
  let currentAppName = null;

  console.log('[Gateway] Koneksi WebSocket baru diterima');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return console.error('[Gateway] Pesan JSON tidak valid:', raw.toString());
    }

    const { type, to, mode, sdp, candidate, reason, appName } = msg;

    switch (type) {
      case 'ping':
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        break;

      case 'register': {
        const uid = (msg.userId || '').trim();
        if (!uid) return;

        currentUserId = uid;
        currentAppName = appName || 'APP_UNKNOWN';

        clients.set(currentUserId, {
          ws,
          appName: currentAppName,
          busyWith: null,
          roomId: null
        });

        console.log(`[Gateway] Terdaftar: ${currentUserId} [Aplikasi: ${currentAppName}]`);
        ws.send(JSON.stringify({ type: 'registered', userId: currentUserId, appName: currentAppName }));
        broadcastUserList();
        break;
      }

      case 'call': {
        if (!currentUserId) return;
        const target = clients.get(to);

        if (!target) {
          ws.send(JSON.stringify({ type: 'error', code: 'offline', message: `User '${to}' sedang offline.` }));
          return;
        }

        if (target.busyWith) {
          ws.send(JSON.stringify({ type: 'error', code: 'busy', message: `User '${to}' sedang dalam panggilan lain.` }));
          return;
        }

        const myData = clients.get(currentUserId);
        const roomId = `room_${Date.now()}_${currentUserId}_${to}`;

        if (myData) {
          myData.busyWith = to;
          myData.roomId = roomId;
        }
        target.busyWith = currentUserId;
        target.roomId = roomId;

        console.log(`[Gateway] Panggilan Antar-Aplikasi: ${currentUserId} (${currentAppName}) -> ${to} (${target.appName}) [Room: ${roomId}]`);
        broadcastUserList();

        sendTo(to, {
          type: 'incoming',
          from: currentUserId,
          fromApp: currentAppName,
          mode: mode || 'video',
          roomId
        });

        ws.send(JSON.stringify({
          type: 'calling',
          to,
          targetApp: target.appName,
          roomId
        }));
        break;
      }

      case 'accept': {
        if (!currentUserId) return;
        const myData = clients.get(currentUserId);
        sendTo(to, {
          type: 'accept',
          from: currentUserId,
          fromApp: currentAppName,
          roomId: myData ? myData.roomId : null
        });
        broadcastUserList();
        break;
      }

      case 'reject': {
        if (!currentUserId) return;
        const myData = clients.get(currentUserId);
        const target = clients.get(to);

        if (myData) { myData.busyWith = null; myData.roomId = null; }
        if (target && target.busyWith === currentUserId) { target.busyWith = null; target.roomId = null; }

        sendTo(to, { type: 'reject', from: currentUserId, reason: reason || 'Panggilan ditolak' });
        broadcastUserList();
        break;
      }

      case 'offer': {
        if (!currentUserId) return;
        console.log(`[Gateway] SDP Offer dari ${currentUserId} ➔ ${to}`);
        sendTo(to, { type: 'offer', from: currentUserId, sdp });
        break;
      }

      case 'answer': {
        if (!currentUserId) return;
        console.log(`[Gateway] SDP Answer dari ${currentUserId} ➔ ${to}`);
        sendTo(to, { type: 'answer', from: currentUserId, sdp });
        break;
      }

      case 'candidate': {
        if (!currentUserId) return;
        const candStr = candidate?.candidate || '';
        let candType = '🏠 HOST LAN';
        if (candStr.includes('typ relay')) {
          candType = '⚡ TURN RELAY (Metered Cloud)';
        } else if (candStr.includes('typ srflx')) {
          candType = '🌐 STUN SRFLX (IP Publik)';
        }
        console.log(`[Gateway Candidate ${candType}] dari ${currentUserId} ➔ ${to}: ${candStr}`);
        sendTo(to, { type: 'candidate', from: currentUserId, candidate });
        break;
      }

      case 'hangup': {
        if (!currentUserId) return;
        const myData = clients.get(currentUserId);
        const target = clients.get(to);

        if (myData) { myData.busyWith = null; myData.roomId = null; }
        if (target && target.busyWith === currentUserId) { target.busyWith = null; target.roomId = null; }

        sendTo(to, { type: 'hangup', from: currentUserId, reason: reason || 'Panggilan diakhiri' });
        broadcastUserList();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentUserId && clients.has(currentUserId)) {
      const myData = clients.get(currentUserId);
      if (myData && myData.busyWith) {
        sendTo(myData.busyWith, {
          type: 'hangup',
          from: currentUserId,
          reason: `Koneksi '${currentUserId}' terputus dari Gateway`
        });
        const peer = clients.get(myData.busyWith);
        if (peer && peer.busyWith === currentUserId) {
          peer.busyWith = null;
          peer.roomId = null;
        }
      }
      clients.delete(currentUserId);
      console.log(`[Gateway] Terputus: ${currentUserId}`);
      broadcastUserList();
    }
  });

  ws.on('error', (err) => {
    console.error(`[Gateway] Error WebSocket: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🌐 SHARED WEBRTC GATEWAY & ROOM BROKER`);
  console.log(`📡 Berjalan di Port: http://localhost:${PORT}`);
  console.log(`📡 WebSocket URL   : ws://localhost:${PORT}`);
  console.log(`=======================================================`);
});

