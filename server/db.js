const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[DB] PERINGATAN: DATABASE_URL tidak ditemukan di file .env');
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('[DB] Error tak terduga pada client idle PostgreSQL:', err.message);
});

// Inisialisasi skema tabel jika belum ada
async function initDb() {
  if (!connectionString) return;

  const client = await pool.connect();
  try {
    console.log('[DB] Menginisialisasi skema tabel PostgreSQL Neon...');

    await client.query(`
      -- 1. Tabel Users
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'offline',
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 2. Tabel Riwayat Panggilan (Call Logs)
      CREATE TABLE IF NOT EXISTS call_logs (
        id SERIAL PRIMARY KEY,
        caller VARCHAR(100) NOT NULL,
        callee VARCHAR(100) NOT NULL,
        call_type VARCHAR(20) NOT NULL DEFAULT 'video', -- 'video' | 'voice'
        status VARCHAR(30) NOT NULL DEFAULT 'ongoing',   -- 'ongoing' | 'completed' | 'missed' | 'rejected' | 'failed'
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        duration_seconds INT DEFAULT 0,
        ice_path VARCHAR(50),                          -- 'HOST' | 'SRFLX' | 'RELAY (TURN COTURN)'
        bitrate_kbps NUMERIC(10, 2),
        packets_lost INT DEFAULT 0,
        rtt_ms NUMERIC(10, 2),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 3. Tabel Riwayat Pesan Chat (DataChannel & Lobi)
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        call_id INT REFERENCES call_logs(id) ON DELETE SET NULL,
        sender VARCHAR(100) NOT NULL,
        receiver VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 4. Tabel Metrik Observabilitas Coturn
      CREATE TABLE IF NOT EXISTS coturn_metrics (
        id SERIAL PRIMARY KEY,
        call_id INT REFERENCES call_logs(id) ON DELETE CASCADE,
        username VARCHAR(100) NOT NULL,
        candidate_type VARCHAR(30),                    -- 'HOST' | 'SRFLX' | 'RELAY'
        local_ip VARCHAR(100),
        remote_ip VARCHAR(100),
        protocol VARCHAR(10),                          -- 'udp' | 'tcp'
        rtt_ms NUMERIC(10, 2),
        bitrate_kbps NUMERIC(10, 2),
        packets_lost INT DEFAULT 0,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indeks untuk query performa
      CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller);
      CREATE INDEX IF NOT EXISTS idx_call_logs_callee ON call_logs(callee);
      CREATE INDEX IF NOT EXISTS idx_chat_sender_receiver ON chat_messages(sender, receiver);
    `);

    console.log('✅ [DB] Skema tabel PostgreSQL berhasil siap!');
  } catch (err) {
    console.error('❌ [DB] Gagal menginisialisasi skema tabel PostgreSQL:', err.message);
  } finally {
    client.release();
  }
}

// Fungsi Helper Operasi Database

async function upsertUser(username, status = 'online') {
  try {
    const query = `
      INSERT INTO users (username, status, last_seen)
      VALUES ($1, $2, NOW())
      ON CONFLICT (username)
      DO UPDATE SET status = EXCLUDED.status, last_seen = NOW()
      RETURNING *;
    `;
    const res = await pool.query(query, [username, status]);
    return res.rows[0];
  } catch (err) {
    console.error('[DB] Gagal upsertUser:', err.message);
    return null;
  }
}

async function logCallStart({ caller, callee, callType }) {
  try {
    const query = `
      INSERT INTO call_logs (caller, callee, call_type, status, started_at)
      VALUES ($1, $2, $3, 'ongoing', NOW())
      RETURNING id;
    `;
    const res = await pool.query(query, [caller, callee, callType || 'video']);
    return res.rows[0]?.id;
  } catch (err) {
    console.error('[DB] Gagal logCallStart:', err.message);
    return null;
  }
}

async function logCallEnd({ callId, caller, callee, status, durationSeconds, icePath, bitrateKbps, packetsLost, rttMs }) {
  try {
    if (callId) {
      const query = `
        UPDATE call_logs
        SET status = $1,
            ended_at = NOW(),
            duration_seconds = COALESCE($2, duration_seconds),
            ice_path = COALESCE($3, ice_path),
            bitrate_kbps = COALESCE($4, bitrate_kbps),
            packets_lost = COALESCE($5, packets_lost),
            rtt_ms = COALESCE($6, rtt_ms)
        WHERE id = $7
        RETURNING *;
      `;
      const res = await pool.query(query, [
        status || 'completed',
        durationSeconds || 0,
        icePath || null,
        bitrateKbps || null,
        packetsLost || 0,
        rttMs || null,
        callId
      ]);
      return res.rows[0];
    } else if (caller && callee) {
      // Jika callId tidak ada, update panggilan ongoing terakhir antara mereka
      const query = `
        UPDATE call_logs
        SET status = $1,
            ended_at = NOW(),
            duration_seconds = COALESCE($2, duration_seconds)
        WHERE id = (
          SELECT id FROM call_logs
          WHERE caller = $3 AND callee = $4 AND status = 'ongoing'
          ORDER BY started_at DESC
          LIMIT 1
        )
        RETURNING *;
      `;
      const res = await pool.query(query, [status || 'completed', durationSeconds || 0, caller, callee]);
      return res.rows[0];
    }
  } catch (err) {
    console.error('[DB] Gagal logCallEnd:', err.message);
    return null;
  }
}

async function logChatMessage({ callId, sender, receiver, message }) {
  try {
    const query = `
      INSERT INTO chat_messages (call_id, sender, receiver, message, sent_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *;
    `;
    const res = await pool.query(query, [callId || null, sender, receiver, message]);
    return res.rows[0];
  } catch (err) {
    console.error('[DB] Gagal logChatMessage:', err.message);
    return null;
  }
}

async function logCoturnMetric({ callId, username, candidateType, localIp, remoteIp, protocol, rttMs, bitrateKbps, packetsLost }) {
  try {
    const query = `
      INSERT INTO coturn_metrics (call_id, username, candidate_type, local_ip, remote_ip, protocol, rtt_ms, bitrate_kbps, packets_lost, logged_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id;
    `;
    const res = await pool.query(query, [
      callId || null,
      username,
      candidateType,
      localIp,
      remoteIp,
      protocol,
      rttMs || null,
      bitrateKbps || null,
      packetsLost || 0
    ]);
    return res.rows[0]?.id;
  } catch (err) {
    console.error('[DB] Gagal logCoturnMetric:', err.message);
    return null;
  }
}

async function getRecentCallLogs(limit = 20) {
  try {
    const query = `
      SELECT id, caller, callee, call_type, status, started_at, ended_at, duration_seconds, ice_path, bitrate_kbps, packets_lost, rtt_ms
      FROM call_logs
      ORDER BY started_at DESC
      LIMIT $1;
    `;
    const res = await pool.query(query, [limit]);
    return res.rows;
  } catch (err) {
    console.error('[DB] Gagal getRecentCallLogs:', err.message);
    return [];
  }
}

async function getRecentMetrics(limit = 30) {
  try {
    const query = `
      SELECT id, call_id, username, candidate_type, local_ip, remote_ip, protocol, rtt_ms, bitrate_kbps, packets_lost, logged_at
      FROM coturn_metrics
      ORDER BY logged_at DESC
      LIMIT $1;
    `;
    const res = await pool.query(query, [limit]);
    return res.rows;
  } catch (err) {
    console.error('[DB] Gagal getRecentMetrics:', err.message);
    return [];
  }
}

module.exports = {
  pool,
  initDb,
  upsertUser,
  logCallStart,
  logCallEnd,
  logChatMessage,
  logCoturnMetric,
  getRecentCallLogs,
  getRecentMetrics
};
