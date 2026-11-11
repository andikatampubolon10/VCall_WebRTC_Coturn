const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db');

// Inisialisasi koneksi ke KEDUA database PostgreSQL (Neon US East & Neon Singapore)
db.initDb().catch(err => console.error('[DB] Gagal start db:', err));

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const COTURN_DIR = path.join(__dirname, '..', 'coturn');

// Map tipe konten MIME untuk static file server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

// 1. HTTP Server untuk Web Client & REST API Dual-System
const server = http.createServer(async (req, res) => {
  let reqUrl = req.url.split('?')[0];

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API: Status koneksi kedua database (Sistem A & Sistem B)
  if (reqUrl === '/api/db-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'connected',
      gateway: 'Shared WebRTC Gateway / Room Broker',
      systems: {
        systemA: {
          name: 'Sistem A',
          provider: 'Neon PostgreSQL (US East)',
          connected: !!db.poolA
        },
        systemB: {
          name: 'Sistem B',
          provider: 'Neon PostgreSQL (Singapore)',
          connected: !!db.poolB
        }
      }
    }));
  }

  // API: Ambil riwayat panggilan Sistem A
  if (reqUrl === '/api/system-a/call-logs') {
    try {
      const logs = await db.getRecentCallLogs('A', 30);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, system: 'A', data: logs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // API: Ambil riwayat panggilan Sistem B
  if (reqUrl === '/api/system-b/call-logs') {
    try {
      const logs = await db.getRecentCallLogs('B', 30);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, system: 'B', data: logs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // Route bantuan untuk Trickle ICE test
  if (reqUrl === '/trickle' || reqUrl === '/test-trickle-ice.html') {
    const tricklePath = path.join(COTURN_DIR, 'test-trickle-ice.html');
    if (fs.existsSync(tricklePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(tricklePath).pipe(res);
    }
  }

  // Default ke index.html
  if (reqUrl === '/' || reqUrl === '') {
    reqUrl = '/index.html';
  }

  const filePath = path.join(CLIENT_DIR, reqUrl);

  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// 2. WebSocket Signaling Server & Room Broker
const wss = new WebSocketServer({ server });

// Map userId -> { ws, system: 'A'|'B', busyWith: null, callIds: { idA, idB }, roomId: null }
const clients = new Map();

function broadcastUserList() {
  const userList = Array.from(clients.entries()).map(([userId, data]) => ({
    userId,
    system: data.system || 'A',
    isBusy: data.busyWith !== null
  }));

  const message = JSON.stringify({
    type: 'users',
    users: userList
  });

  clients.forEach((clientData) => {
    if (clientData.ws.readyState === WebSocket.OPEN) {
      clientData.ws.send(message);
    }
  });
}

function sendToUser(toUserId, messageObj) {
  const recipient = clients.get(toUserId);
  if (recipient && recipient.ws.readyState === WebSocket.OPEN) {
    recipient.ws.send(JSON.stringify(messageObj));
    return true;
  }
  return false;
}

wss.on('connection', (ws) => {
  let currentUserId = null;
  let currentSystem = 'A';

  console.log('[Gateway Broker] Klien baru terhubung via WebSocket');

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('[Gateway] Format JSON tidak valid:', data.toString());
      return;
    }

    const { type, to, mode, sdp, candidate, reason, system } = msg;

    switch (type) {
      case 'register': {
        const requestedId = (msg.userId || '').trim();
        if (!requestedId) {
          ws.send(JSON.stringify({ type: 'error', code: 'invalid_id', message: 'User ID tidak boleh kosong' }));
          return;
        }

        // Tentukan sistem: Jika tidak dikirim, infer dari username atau default
        currentSystem = (system === 'B' || requestedId.includes('B')) ? 'B' : 'A';
        currentUserId = requestedId;

        // Jika ID sudah dipakai oleh koneksi aktif lain
        if (clients.has(currentUserId) && clients.get(currentUserId).ws !== ws) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'duplicate_user',
            message: `User '${currentUserId}' sudah aktif di perangkat/tab lain.`
          }));
          return;
        }

        clients.set(currentUserId, {
          ws,
          system: currentSystem,
          busyWith: null,
          callIds: { idA: null, idB: null },
          roomId: null
        });

        console.log(`[Gateway Broker] User terdaftar: ${currentUserId} [SISTEM ${currentSystem}]`);

        // Catat status user ke database sistem masing-masing
        db.upsertUser(currentUserId, currentSystem, 'online').catch(() => {});

        // Konfirmasi registrasi berhasil
        ws.send(JSON.stringify({
          type: 'registered',
          userId: currentUserId,
          system: currentSystem
        }));

        // Siarkan daftar user online
        broadcastUserList();
        break;
      }

      case 'call': {
        if (!currentUserId) return;
        const target = clients.get(to);

        if (!target) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'offline',
            message: `User '${to}' sedang offline.`
          }));
          return;
        }

        if (target.busyWith) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'busy',
            message: `User '${to}' sedang dalam panggilan lain.`
          }));
          return;
        }

        const myData = clients.get(currentUserId);
        const callerSys = myData ? myData.system : 'A';
        const calleeSys = target.system || 'B';

        // Buat Room ID unik untuk panggilan antar-sistem ini
        const roomId = `room_${Date.now()}_${callerSys}_${calleeSys}`;

        // Catat panggilan baru ke KEDUA Database (Sistem A dan Sistem B)
        let callIds = { idA: null, idB: null };
        try {
          callIds = await db.logCallStart({
            caller: currentUserId,
            callee: to,
            callerSystem: callerSys,
            calleeSystem: calleeSys,
            callType: mode || 'video'
          });
        } catch (e) {
          console.error('[DB] Gagal mencatat logCallStart:', e.message);
        }

        if (myData) {
          myData.busyWith = to;
          myData.callIds = callIds;
          myData.roomId = roomId;
        }
        target.busyWith = currentUserId;
        target.callIds = callIds;
        target.roomId = roomId;

        console.log(`[Gateway Broker] Panggilan Antar-Sistem: ${currentUserId} (Sistem ${callerSys}) -> ${to} (Sistem ${calleeSys}) [Room: ${roomId}]`);
        broadcastUserList();

        sendToUser(to, {
          type: 'incoming',
          from: currentUserId,
          fromSystem: callerSys,
          mode: mode || 'video',
          roomId,
          callId: target.system === 'B' ? callIds.idB : callIds.idA
        });

        ws.send(JSON.stringify({
          type: 'calling',
          to,
          targetSystem: calleeSys,
          roomId,
          callId: myData.system === 'A' ? callIds.idA : callIds.idB
        }));
        break;
      }

      case 'accept': {
        if (!currentUserId) return;
        console.log(`[Gateway Broker] Panggilan diterima oleh ${currentUserId} untuk ${to}`);
        const myData = clients.get(currentUserId);
        sendToUser(to, {
          type: 'accept',
          from: currentUserId,
          roomId: myData ? myData.roomId : null,
          callId: myData && myData.callIds ? (myData.system === 'A' ? myData.callIds.idA : myData.callIds.idB) : null
        });
        broadcastUserList();
        break;
      }

      case 'reject': {
        if (!currentUserId) return;
        console.log(`[Gateway Broker] Panggilan ditolak oleh ${currentUserId} untuk ${to}`);

        const myData = clients.get(currentUserId);
        const targetData = clients.get(to);
        const activeCallIds = (myData && myData.callIds) || (targetData && targetData.callIds) || {};

        // Catat penolakan panggilan ke kedua database
        db.logCallEnd({
          callIdA: activeCallIds.idA,
          callIdB: activeCallIds.idB,
          caller: to,
          callee: currentUserId,
          status: 'rejected'
        }).catch(() => {});

        // Bersihkan status
        if (myData) {
          myData.busyWith = null;
          myData.callIds = { idA: null, idB: null };
          myData.roomId = null;
        }
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
          targetData.callIds = { idA: null, idB: null };
          targetData.roomId = null;
        }

        sendToUser(to, {
          type: 'reject',
          from: currentUserId,
          reason: reason || 'Panggilan ditolak'
        });
        broadcastUserList();
        break;
      }

      case 'offer': {
        if (!currentUserId) return;
        sendToUser(to, {
          type: 'offer',
          from: currentUserId,
          sdp
        });
        break;
      }

      case 'answer': {
        if (!currentUserId) return;
        sendToUser(to, {
          type: 'answer',
          from: currentUserId,
          sdp
        });
        break;
      }

      case 'candidate': {
        if (!currentUserId) return;
        sendToUser(to, {
          type: 'candidate',
          from: currentUserId,
          candidate
        });
        break;
      }

      case 'chat': {
        if (!currentUserId) return;
        const myData = clients.get(currentUserId);
        const sys = myData ? myData.system : 'A';
        // Catat chat ke database sistem pengirim
        db.logChatMessage({
          system: sys,
          callId: myData && myData.callIds ? (sys === 'A' ? myData.callIds.idA : myData.callIds.idB) : null,
          sender: currentUserId,
          receiver: to,
          message: msg.text || ''
        }).catch(() => {});
        break;
      }

      case 'stats': {
        if (!currentUserId) return;
        const myData = clients.get(currentUserId);
        const sys = myData ? myData.system : 'A';
        db.logCoturnMetric({
          system: sys,
          callId: myData && myData.callIds ? (sys === 'A' ? myData.callIds.idA : myData.callIds.idB) : null,
          username: currentUserId,
          candidateType: msg.candidateType,
          localIp: msg.localIp,
          remoteIp: msg.remoteIp,
          protocol: msg.protocol,
          rttMs: msg.rtt,
          bitrateKbps: msg.bitrate,
          packetsLost: msg.packetsLost
        }).catch(() => {});
        break;
      }

      case 'hangup': {
        if (!currentUserId) return;
        console.log(`[Gateway Broker] Panggilan diakhiri oleh ${currentUserId} untuk ${to}`);

        const myData = clients.get(currentUserId);
        const targetData = clients.get(to);
        const activeCallIds = (myData && myData.callIds) || (targetData && targetData.callIds) || {};

        // Catat panggilan selesai di KEDUA Database!
        db.logCallEnd({
          callIdA: activeCallIds.idA,
          callIdB: activeCallIds.idB,
          caller: currentUserId,
          callee: to,
          status: 'completed',
          durationSeconds: msg.duration || 0,
          icePath: msg.icePath || null,
          bitrateKbps: msg.bitrate || null,
          packetsLost: msg.packetsLost || 0,
          rttMs: msg.rtt || null
        }).catch(() => {});

        if (myData) {
          myData.busyWith = null;
          myData.callIds = { idA: null, idB: null };
          myData.roomId = null;
        }
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
          targetData.callIds = { idA: null, idB: null };
          targetData.roomId = null;
        }

        sendToUser(to, {
          type: 'hangup',
          from: currentUserId,
          reason: msg.reason || 'Panggilan diakhiri'
        });
        broadcastUserList();
        break;
      }

      default:
        console.warn(`[Gateway Broker] Tipe pesan tidak dikenal: ${type}`);
    }
  });

  ws.on('close', () => {
    if (currentUserId && clients.has(currentUserId)) {
      const myData = clients.get(currentUserId);
      if (myData && myData.busyWith) {
        sendToUser(myData.busyWith, {
          type: 'hangup',
          from: currentUserId,
          reason: `Koneksi '${currentUserId}' terputus dari Gateway`
        });
        const peer = clients.get(myData.busyWith);
        if (peer && peer.busyWith === currentUserId) {
          peer.busyWith = null;
          peer.callIds = { idA: null, idB: null };
          peer.roomId = null;
        }
      }

      // Catat status offline di database sistem yang sesuai
      db.upsertUser(currentUserId, currentSystem, 'offline').catch(() => {});

      clients.delete(currentUserId);
      console.log(`[Gateway Broker] User terputus: ${currentUserId} [SISTEM ${currentSystem}]`);
      broadcastUserList();
    }
  });

  ws.on('error', (err) => {
    console.error(`[Gateway Broker] WebSocket error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🌐 SHARED WEBRTC GATEWAY & ROOM BROKER BERJALAN!`);
  console.log(`📡 Port Gateway  : http://localhost:${PORT}`);
  console.log(`🏥 Database A    : Neon PostgreSQL (US East)`);
  console.log(`📱 Database B    : Neon PostgreSQL (Singapore)`);
  console.log(`🧪 Trickle Test  : http://localhost:${PORT}/trickle`);
  console.log(`=======================================================`);
});
