const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('http');
const net = require('net');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3002;
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;

// Proxy WebSocket otomatis untuk /gateway-ws menuju Port 3000 (Sangat berguna saat pakai Ngrok)
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/gateway-ws')) {
    socket.setTimeout(0);
    socket.setKeepAlive(true, 10000);
    const proxySocket = net.connect(3000, 'localhost', () => {
      proxySocket.setTimeout(0);
      proxySocket.setKeepAlive(true, 10000);
      proxySocket.write(`GET / HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() !== 'host') {
          proxySocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
        } else {
          proxySocket.write(`Host: localhost:3000\r\n`);
        }
      }
      proxySocket.write('\r\n');
      if (head && head.length > 0) proxySocket.write(head);
      socket.pipe(proxySocket).pipe(socket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pool Database Khusus Aplikasi B (Neon Singapore - system_b_db)
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.on('error', err => console.error('[App B - DB] Error:', err.message));
}

// REST API Khusus Aplikasi B
app.get('/api/config', (req, res) => {
  const reqHost = req.hostname;
  const isNgrok = reqHost.includes('ngrok');
  const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  
  let gwUrl;
  if (isNgrok) {
    gwUrl = `${isHttps ? 'wss' : 'ws'}://${req.get('host')}/gateway-ws`;
  } else if (reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
    gwUrl = `ws://${reqHost}:3000`;
  } else {
    gwUrl = GATEWAY_URL;
  }

  res.json({
    appName: process.env.APP_NAME || 'Aplikasi B (Mobile Patient App)',
    system: 'APP_B',
    gatewayUrl: gwUrl,
    turnHost: process.env.COTURN_HOST || (reqHost === '127.0.0.1' ? 'localhost' : reqHost),
    defaultUser: 'User B',
    dbRegion: 'Neon PostgreSQL (Singapore - ap-southeast-1)',
    connectedToDb: !!pool
  });
});

app.get('/api/call-logs', async (req, res) => {
  if (!pool) return res.json({ success: false, data: [] });
  try {
    const result = await pool.query(`
      SELECT id, caller, callee, caller_system, callee_system, call_type, status, started_at, duration_seconds, ice_path
      FROM call_logs 
      ORDER BY started_at DESC 
      LIMIT 20;
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/call-logs', async (req, res) => {
  if (!pool) return res.json({ success: false, error: 'Database belum terhubung' });
  const { caller, callee, callerSystem, calleeSystem, callType, status, durationSeconds, icePath } = req.body;
  const dur = parseInt(durationSeconds, 10) || 0;
  const startedAt = new Date(Date.now() - dur * 1000);
  try {
    const result = await pool.query(`
      INSERT INTO call_logs (caller, callee, caller_system, callee_system, call_type, status, started_at, ended_at, duration_seconds, ice_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
      RETURNING id;
    `, [
      caller, 
      callee, 
      callerSystem || 'APP_B', 
      calleeSystem || 'APP_A', 
      callType || 'video', 
      status || 'completed', 
      startedAt, 
      dur, 
      icePath || 'RELAY'
    ]);
    res.json({ success: true, id: result.rows[0]?.id });
  } catch (err) {
    console.error('[App B] Gagal simpan call log:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`📱 APLIKASI B BERJALAN! (Mobile Patient App)`);
  console.log(`🌐 Akses Web : http://localhost:${PORT}`);
  console.log(`🗄️ Database  : Neon Singapore (ap-southeast-1 / system_b_db)`);
  console.log(`📡 Gateway   : ${GATEWAY_URL}`);
  console.log(`=======================================================`);
});
