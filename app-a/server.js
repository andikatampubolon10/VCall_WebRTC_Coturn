require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pool Database Khusus Aplikasi A (Neon US-East)
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.on('error', err => console.error('[App A - DB] Error:', err.message));
}

// REST API
app.get('/api/config', (req, res) => {
  const reqHost = req.hostname;
  // Di belakang reverse proxy HTTPS (Caddy/ngrok): halaman https wajib memakai wss:// (mixed content),
  // dan gateway diakses lewat path /gateway-ws pada host yang sama.
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const isHttps = proto === 'https';
  let gwUrl = GATEWAY_URL;
  if (isHttps) {
    gwUrl = `wss://${req.get('host')}/gateway-ws`;
  } else if (gwUrl.includes('localhost') && reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
    gwUrl = gwUrl.replace('localhost', reqHost);
  }

  const turnHost = process.env.COTURN_HOST || reqHost;

  const iceServers = [
    // 0. Coturn Server Sendiri (Port 3478)
    { urls: `stun:${turnHost}:3478` },
    {
      urls: `turn:${turnHost}:3478?transport=udp`,
      username: process.env.COTURN_USER || 'simulasi',
      credential: process.env.COTURN_PASSWORD || 'password123'
    },
    {
      urls: `turn:${turnHost}:3478?transport=tcp`,
      username: process.env.COTURN_USER || 'simulasi',
      credential: process.env.COTURN_PASSWORD || 'password123'
    },
    // 1. STUN Google (Prioritas Cepat untuk P2P langsung)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // 2. STUN Metered Resmi
    { urls: 'stun:stun.relay.metered.ca:80' },
    // 3. TURN Metered Resmi (Standard Free Tier Relay - Port 80 & 443 UDP/TCP/TLS)
    {
      urls: 'turn:standard.relay.metered.ca:80',
      username: '18a1aa3f68d754653458bc9d',
      credential: '/mGt8FrweJKNDdnP'
    },
    {
      urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
      username: '18a1aa3f68d754653458bc9d',
      credential: '/mGt8FrweJKNDdnP'
    },
    {
      urls: 'turn:standard.relay.metered.ca:443',
      username: '18a1aa3f68d754653458bc9d',
      credential: '/mGt8FrweJKNDdnP'
    },
    {
      urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
      username: '18a1aa3f68d754653458bc9d',
      credential: '/mGt8FrweJKNDdnP'
    }
  ];

  res.json({
    appName: process.env.APP_NAME || 'Aplikasi A (Portal Dokter / Hospital)',
    system: 'APP_A',
    gatewayUrl: gwUrl,
    turnHost: process.env.COTURN_HOST || (reqHost === '127.0.0.1' ? 'localhost' : reqHost),
    defaultUser: 'User A',
    dbRegion: 'Neon PostgreSQL (US East)',
    connectedToDb: !!pool,
    iceServers
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
  if (!pool) return res.json({ success: false });
  const { caller, callee, callerSystem, calleeSystem, callType, status, durationSeconds, icePath } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO call_logs (caller, callee, caller_system, callee_system, call_type, status, started_at, ended_at, duration_seconds, ice_path)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() - ($7 || ' seconds')::INTERVAL, NOW(), $7, $8)
      RETURNING id;
    `, [caller, callee, callerSystem || 'APP_A', calleeSystem || 'APP_B', callType || 'video', status || 'completed', durationSeconds || 0, icePath || 'RELAY']);
    res.json({ success: true, id: result.rows[0]?.id });
  } catch (err) {
    console.error('[App A] Gagal simpan call log:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🏥 APLIKASI A BERJALAN! (Portal Dokter / Hospital)`);
  console.log(`🌐 Akses Web : http://localhost:${PORT}`);
  console.log(`🗄️ Database  : Neon US-East`);
  console.log(`📡 Gateway   : ${GATEWAY_URL}`);
  console.log(`=======================================================`);
});

