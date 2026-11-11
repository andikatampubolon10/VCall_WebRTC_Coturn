const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
require('dotenv').config();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function requestRealTurnAllocation(host = '127.0.0.1', port = 3478, username = 'simulasi', password = 'password123') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let resolved = false;

    const cleanup = (relayPort, err) => {
      if (resolved) return;
      resolved = true;
      try { socket.close(); } catch(e){}
      if (relayPort) {
        resolve({ success: true, relayPort });
      } else {
        resolve({ success: false, error: err || 'Timeout' });
      }
    };

    const timer = setTimeout(() => cleanup(null, 'TURN allocate timeout 3000ms'), 3000);

    const txId = crypto.randomBytes(12);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0003, 0); // Allocate Request
    header.writeUInt16BE(8, 2);
    header.writeUInt32BE(0x2112A442, 4);
    txId.copy(header, 8);
    const attrReqTransport = Buffer.from([0x00, 0x19, 0x00, 0x04, 0x11, 0x00, 0x00, 0x00]);

    socket.on('message', (msg) => {
      if (msg.length < 20) return;
      const type = msg.readUInt16BE(0);

      if (type === 0x0113) {
        let offset = 20;
        let realm = '', nonce = '';
        while (offset < msg.length) {
          const aType = msg.readUInt16BE(offset);
          const aLen = msg.readUInt16BE(offset + 2);
          if (aType === 0x0014) realm = msg.toString('utf8', offset + 4, offset + 4 + aLen);
          if (aType === 0x0015) nonce = msg.toString('utf8', offset + 4, offset + 4 + aLen);
          offset += 4 + aLen + ((4 - (aLen % 4)) % 4);
        }

        const newTx = crypto.randomBytes(12);
        const authHeader = Buffer.alloc(20);
        authHeader.writeUInt16BE(0x0003, 0);
        authHeader.writeUInt32BE(0x2112A442, 4);
        newTx.copy(authHeader, 8);

        const parts = [];
        parts.push(Buffer.from([0x00, 0x19, 0x00, 0x04, 0x11, 0x00, 0x00, 0x00]));

        const uBuf = Buffer.from(username);
        const uAttr = Buffer.alloc(4 + uBuf.length + ((4 - (uBuf.length % 4)) % 4));
        uAttr.writeUInt16BE(0x0006, 0);
        uAttr.writeUInt16BE(uBuf.length, 2);
        uBuf.copy(uAttr, 4);
        parts.push(uAttr);

        const rBuf = Buffer.from(realm);
        const rAttr = Buffer.alloc(4 + rBuf.length + ((4 - (rBuf.length % 4)) % 4));
        rAttr.writeUInt16BE(0x0014, 0);
        rAttr.writeUInt16BE(rBuf.length, 2);
        rBuf.copy(rAttr, 4);
        parts.push(rAttr);

        const nBuf = Buffer.from(nonce);
        const nAttr = Buffer.alloc(4 + nBuf.length + ((4 - (nBuf.length % 4)) % 4));
        nAttr.writeUInt16BE(0x0015, 0);
        nAttr.writeUInt16BE(nBuf.length, 2);
        nBuf.copy(nAttr, 4);
        parts.push(nAttr);

        const bodyBeforeMi = Buffer.concat(parts);
        const totalLenWithMi = bodyBeforeMi.length + 24;
        authHeader.writeUInt16BE(totalLenWithMi, 2);

        const key = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();
        const hmac = crypto.createHmac('sha1', key);
        hmac.update(Buffer.concat([authHeader, bodyBeforeMi]));
        const miHash = hmac.digest();

        const miAttr = Buffer.alloc(24);
        miAttr.writeUInt16BE(0x0008, 0);
        miAttr.writeUInt16BE(20, 2);
        miHash.copy(miAttr, 4);

        const totalLenWithFp = totalLenWithMi + 8;
        authHeader.writeUInt16BE(totalLenWithFp, 2);

        const fullWithoutFp = Buffer.concat([authHeader, bodyBeforeMi, miAttr]);
        const fpCrc = (crc32(fullWithoutFp) ^ 0x5354554e) >>> 0;
        const fpAttr = Buffer.alloc(8);
        fpAttr.writeUInt16BE(0x8028, 0);
        fpAttr.writeUInt16BE(4, 2);
        fpAttr.writeUInt32BE(fpCrc, 4);

        socket.send(Buffer.concat([authHeader, bodyBeforeMi, miAttr, fpAttr]), port, host);
      } else if (type === 0x0103) {
        clearTimeout(timer);
        let offset = 20;
        let relayPort = null;
        while (offset < msg.length) {
          const aType = msg.readUInt16BE(offset);
          const aLen = msg.readUInt16BE(offset + 2);
          if (aType === 0x0016) {
            relayPort = msg.readUInt16BE(offset + 6) ^ 0x2112;
            break;
          }
          offset += 4 + aLen + ((4 - (aLen % 4)) % 4);
        }
        cleanup(relayPort);
      }
    });

    socket.on('error', (e) => cleanup(null, e.message));

    socket.send(Buffer.concat([header, attrReqTransport]), port, host, (err) => {
      if (err) cleanup(null, err.message);
    });
  });
}

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
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API Alokasi Turn Asli via Protokol UDP RFC 5766 ke CoTURN Port 3478
  if (req.url.startsWith('/api/benchmark/allocate')) {
    const coturnHost = process.env.COTURN_HOST || '127.0.0.1';
    const coturnPort = parseInt(process.env.COTURN_PORT || '3478');
    const coturnUser = process.env.COTURN_USER || 'simulasi';
    const coturnPass = process.env.COTURN_PASS || 'password123';

    try {
      const allocResult = await requestRealTurnAllocation(coturnHost, coturnPort, coturnUser, coturnPass);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(allocResult));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
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

