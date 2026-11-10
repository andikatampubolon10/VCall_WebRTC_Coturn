const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db');

// Inisialisasi koneksi PostgreSQL Neon
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

// 1. HTTP Server untuk menyajikan UI Web Client & REST API Riwayat
const server = http.createServer(async (req, res) => {
  let reqUrl = req.url.split('?')[0];

  // CORS Headers untuk API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API: Cek status koneksi DB Neon
  if (reqUrl === '/api/db-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'connected', provider: 'Neon PostgreSQL' }));
  }

  // API: Ambil riwayat panggilan terbaru
  if (reqUrl === '/api/call-logs') {
    try {
      const logs = await db.getRecentCallLogs(30);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: logs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // API: Ambil metrik Coturn terbaru
  if (reqUrl === '/api/metrics') {
    try {
      const metrics = await db.getRecentMetrics(50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: metrics }));
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

  // Mencegah directory traversal security issue
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

// 2. WebSocket Signaling Server
const wss = new WebSocketServer({ server });

// Map userId -> { ws, busyWith: null | string }
const clients = new Map();

function broadcastUserList() {
  const userList = Array.from(clients.entries()).map(([userId, data]) => ({
    userId,
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

  console.log('[Signaling] Klien baru terhubung via WebSocket');

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('[Signaling] Format JSON tidak valid:', data.toString());
      return;
    }

    const { type, to, mode, sdp, candidate, reason } = msg;

    switch (type) {
      case 'register': {
        const requestedId = (msg.userId || '').trim();
        if (!requestedId) {
          ws.send(JSON.stringify({ type: 'error', code: 'invalid_id', message: 'User ID tidak boleh kosong' }));
          return;
        }

        // Jika ID sudah dipakai oleh koneksi aktif lain
        if (clients.has(requestedId) && clients.get(requestedId).ws !== ws) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'duplicate_user',
            message: `User '${requestedId}' sudah aktif di perangkat/tab lain.`
          }));
          return;
        }

        currentUserId = requestedId;
        clients.set(currentUserId, { ws, busyWith: null, callId: null });
        console.log(`[Signaling] User terdaftar: ${currentUserId}`);

        // Catat user online ke PostgreSQL Neon
        db.upsertUser(currentUserId, 'online').catch(() => {});

        // Konfirmasi registrasi berhasil
        ws.send(JSON.stringify({ type: 'registered', userId: currentUserId }));

        // Siarkan daftar user online terbaru ke semua klien
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

        // Catat panggilan baru ke PostgreSQL Neon
        let callId = null;
        try {
          callId = await db.logCallStart({ caller: currentUserId, callee: to, callType: mode || 'video' });
        } catch (e) {
          console.error('[DB] Gagal mencatat logCallStart:', e.message);
        }

        // Tandai status sementara calling
        const myData = clients.get(currentUserId);
        if (myData) {
          myData.busyWith = to;
          myData.callId = callId;
        }
        target.busyWith = currentUserId;
        target.callId = callId;

        console.log(`[Signaling] Panggilan: ${currentUserId} -> ${to} (mode: ${mode}, callId: ${callId})`);
        broadcastUserList();

        sendToUser(to, {
          type: 'incoming',
          from: currentUserId,
          mode: mode || 'video',
          callId
        });

        ws.send(JSON.stringify({
          type: 'calling',
          to,
          callId
        }));
        break;
      }

      case 'accept': {
        if (!currentUserId) return;
        console.log(`[Signaling] Panggilan diterima oleh ${currentUserId} untuk ${to}`);
        const myData = clients.get(currentUserId);
        sendToUser(to, {
          type: 'accept',
          from: currentUserId,
          callId: myData ? myData.callId : null
        });
        broadcastUserList();
        break;
      }

      case 'reject': {
        if (!currentUserId) return;
        console.log(`[Signaling] Panggilan ditolak oleh ${currentUserId} untuk ${to}`);

        const myData = clients.get(currentUserId);
        const targetData = clients.get(to);
        const activeCallId = (myData && myData.callId) || (targetData && targetData.callId);

        // Catat penolakan panggilan ke PostgreSQL Neon
        db.logCallEnd({
          callId: activeCallId,
          caller: to,
          callee: currentUserId,
          status: 'rejected'
        }).catch(() => {});

        // Bersihkan status sibuk
        if (myData) {
          myData.busyWith = null;
          myData.callId = null;
        }
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
          targetData.callId = null;
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
        console.log(`[Signaling] Meneruskan Offer SDP dari ${currentUserId} ke ${to}`);
        sendToUser(to, {
          type: 'offer',
          from: currentUserId,
          sdp
        });
        break;
      }

      case 'answer': {
        if (!currentUserId) return;
        console.log(`[Signaling] Meneruskan Answer SDP dari ${currentUserId} ke ${to}`);
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

      case 'hangup': {
        if (!currentUserId) return;
        console.log(`[Signaling] Panggilan diakhiri oleh ${currentUserId} untuk ${to}`);

        const myData = clients.get(currentUserId);
        const targetData = clients.get(to);
        const activeCallId = msg.callId || (myData && myData.callId) || (targetData && targetData.callId);

        // Simpan riwayat panggilan dan metrik akhir ke PostgreSQL Neon
        db.logCallEnd({
          callId: activeCallId,
          caller: currentUserId,
          callee: to,
          status: 'completed',
          durationSeconds: msg.duration || 0,
          icePath: msg.icePath || null,
          bitrateKbps: msg.bitrate || null,
          packetsLost: msg.packetsLost || 0,
          rttMs: msg.rtt || null
        }).catch(err => console.error('[DB] Gagal logCallEnd di hangup:', err.message));

        if (myData) {
          myData.busyWith = null;
          myData.callId = null;
        }
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
          targetData.callId = null;
        }

        sendToUser(to, {
          type: 'hangup',
          from: currentUserId,
          callId: activeCallId
        });
        broadcastUserList();
        break;
      }

      case 'stats': {
        // Menerima metrik periodik dari browser klien
        const myData = clients.get(currentUserId);
        const activeCallId = msg.callId || (myData && myData.callId);
        db.logCoturnMetric({
          callId: activeCallId,
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

      case 'chat_log': {
        // Catat pesan chat ke database
        const myData = clients.get(currentUserId);
        const activeCallId = msg.callId || (myData && myData.callId);
        db.logChatMessage({
          callId: activeCallId,
          sender: currentUserId,
          receiver: to,
          message: msg.message
        }).catch(() => {});
        break;
      }

      default:
        console.warn(`[Signaling] Tipe pesan tidak dikenal: ${type}`);
    }
  });

  ws.on('close', () => {
    if (currentUserId) {
      db.upsertUser(currentUserId, 'offline').catch(() => {});
    }

    if (currentUserId && clients.has(currentUserId)) {
      const myData = clients.get(currentUserId);
      if (myData && myData.busyWith) {
        // Catat berakhirnya panggilan ke database
        db.logCallEnd({
          callId: myData.callId,
          caller: currentUserId,
          callee: myData.busyWith,
          status: 'completed'
        }).catch(() => {});

        // Lawan bicara diberi tahu bahwa koneksi terputus (FR-05)
        sendToUser(myData.busyWith, {
          type: 'hangup',
          from: currentUserId,
          reason: `Koneksi '${currentUserId}' terputus`
        });
        const peer = clients.get(myData.busyWith);
        if (peer && peer.busyWith === currentUserId) {
          peer.busyWith = null;
          peer.callId = null;
        }
      }

      clients.delete(currentUserId);
      console.log(`[Signaling] User terputus: ${currentUserId}`);
      broadcastUserList();
    }
  });

  ws.on('error', (err) => {
    console.error(`[Signaling] WebSocket error pada user ${currentUserId}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 WebRTC Signaling & Web Server berjalan!`);
  console.log(`🌐 Akses User A / B: http://localhost:${PORT}`);
  console.log(`🧪 Akses Trickle Test: http://localhost:${PORT}/trickle`);
  console.log(`=======================================================`);
});

