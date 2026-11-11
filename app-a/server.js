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
  let gwUrl = GATEWAY_URL;
  if (gwUrl.includes('localhost') && reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
    gwUrl = gwUrl.replace('localhost', reqHost);
  }
  res.json({
    appName: process.env.APP_NAME || 'Aplikasi A (Portal Dokter / Hospital)',
    system: 'APP_A',
    gatewayUrl: gwUrl,
    turnHost: process.env.COTURN_HOST || (reqHost === '127.0.0.1' ? 'localhost' : reqHost),
    defaultUser: 'User A',
    dbRegion: 'Neon PostgreSQL (US East)',
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

