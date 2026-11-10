const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

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

// 1. HTTP Server untuk menyajikan UI Web Client (Aplikasi A & B)
const server = http.createServer((req, res) => {
  let reqUrl = req.url.split('?')[0];

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

  ws.on('message', (data) => {
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
        clients.set(currentUserId, { ws, busyWith: null });
        console.log(`[Signaling] User terdaftar: ${currentUserId}`);

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

        // Tandai status sementara calling
        const myData = clients.get(currentUserId);
        if (myData) myData.busyWith = to;
        target.busyWith = currentUserId;

        console.log(`[Signaling] Panggilan: ${currentUserId} -> ${to} (mode: ${mode})`);
        broadcastUserList();

        sendToUser(to, {
          type: 'incoming',
          from: currentUserId,
          mode: mode || 'video'
        });
        break;
      }

      case 'accept': {
        if (!currentUserId) return;
        console.log(`[Signaling] Panggilan diterima oleh ${currentUserId} untuk ${to}`);
        sendToUser(to, {
          type: 'accept',
          from: currentUserId
        });
        broadcastUserList();
        break;
      }

      case 'reject': {
        if (!currentUserId) return;
        console.log(`[Signaling] Panggilan ditolak oleh ${currentUserId} untuk ${to}`);

        // Bersihkan status sibuk
        const myData = clients.get(currentUserId);
        if (myData) myData.busyWith = null;

        const targetData = clients.get(to);
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
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
        if (myData) myData.busyWith = null;

        const targetData = clients.get(to);
        if (targetData && targetData.busyWith === currentUserId) {
          targetData.busyWith = null;
        }

        sendToUser(to, {
          type: 'hangup',
          from: currentUserId
        });
        broadcastUserList();
        break;
      }

      default:
        console.warn(`[Signaling] Tipe pesan tidak dikenal: ${type}`);
    }
  });

  ws.on('close', () => {
    if (currentUserId && clients.has(currentUserId)) {
      const myData = clients.get(currentUserId);
      if (myData && myData.busyWith) {
        // Lawan bicara diberi tahu bahwa koneksi terputus (FR-05)
        sendToUser(myData.busyWith, {
          type: 'hangup',
          from: currentUserId,
          reason: `Koneksi '${currentUserId}' terputus`
        });
        const peer = clients.get(myData.busyWith);
        if (peer && peer.busyWith === currentUserId) {
          peer.busyWith = null;
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
  console.log(`🌐 Akses Aplikasi A / B: http://localhost:${PORT}`);
  console.log(`🧪 Akses Trickle Test   : http://localhost:${PORT}/trickle`);
  console.log(`=======================================================`);
});

