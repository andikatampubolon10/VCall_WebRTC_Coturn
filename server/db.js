const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

const connA = process.env.DATABASE_URL_A || process.env.DATABASE_URL;
const connB = process.env.DATABASE_URL_B;

// Pool Database Sistem A (Neon US East)
let poolA = null;
if (connA) {
  poolA = new Pool({
    connectionString: connA,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  poolA.on('error', (err) => console.error('[DB-A] Error pada pool Sistem A:', err.message));
}

// Pool Database Sistem B (Neon Singapore)
let poolB = null;
if (connB) {
  poolB = new Pool({
    connectionString: connB,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  poolB.on('error', (err) => console.error('[DB-B] Error pada pool Sistem B:', err.message));
}

function getPool(system = 'A') {
  return (system === 'B' && poolB) ? poolB : poolA;
}

// Inisialisasi skema tabel pada kedua database
async function initDb() {
  const schemas = [
    { name: 'Sistem A (Neon US East)', pool: poolA },
    { name: 'Sistem B (Neon Singapore)', pool: poolB }
  ];

  for (const s of schemas) {
    if (!s.pool) continue;
    try {
      const client = await s.pool.connect();
      try {
        console.log(`[DB] Menginisialisasi skema pada ${s.name}...`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            display_name VARCHAR(100),
            phone_number VARCHAR(20),
            status VARCHAR(20) DEFAULT 'offline',
            last_seen TIMESTAMPTZ DEFAULT NOW(),
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS call_logs (
            id SERIAL PRIMARY KEY,
            caller VARCHAR(100) NOT NULL,
            callee VARCHAR(100) NOT NULL,
            caller_system VARCHAR(20) DEFAULT 'SISTEM_A',
            callee_system VARCHAR(20) DEFAULT 'SISTEM_B',
            call_type VARCHAR(20) NOT NULL DEFAULT 'video',
            status VARCHAR(30) NOT NULL DEFAULT 'ongoing',
            started_at TIMESTAMPTZ DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            duration_seconds INT DEFAULT 0,
            ice_path VARCHAR(50),
            bitrate_kbps NUMERIC(10, 2),
            packets_lost INT DEFAULT 0,
            rtt_ms NUMERIC(10, 2),
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            call_id INT,
            sender VARCHAR(100) NOT NULL,
            receiver VARCHAR(100) NOT NULL,
            message TEXT NOT NULL,
            sent_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS coturn_metrics (
            id SERIAL PRIMARY KEY,
            call_id INT,
            username VARCHAR(100) NOT NULL,
            candidate_type VARCHAR(30),
            local_ip VARCHAR(100),
            remote_ip VARCHAR(100),
            protocol VARCHAR(10),
            rtt_ms NUMERIC(10, 2),
            bitrate_kbps NUMERIC(10, 2),
            packets_lost INT DEFAULT 0,
            logged_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        console.log(`✅ [DB] Skema pada ${s.name} siap digunakan!`);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(`❌ [DB] Gagal init skema pada ${s.name}:`, err.message);
    }
  }
}

// 1. Simpan/Update User di Sistem Masing-masing
async function upsertUser(username, system = 'A', status = 'online') {
  const p = getPool(system);
  if (!p) return null;

  try {
    const query = `
      INSERT INTO users (username, display_name, status, last_seen)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (username)
      DO UPDATE SET status = EXCLUDED.status, last_seen = NOW()
      RETURNING *;
    `;
    const res = await p.query(query, [username, `${username} (${system === 'A' ? 'Sistem A' : 'Sistem B'})`, status]);
    return res.rows[0];
  } catch (err) {
    console.error(`[DB-${system}] Gagal upsertUser:`, err.message);
    return null;
  }
}

// 2. Catat Permulaan Panggilan Antar-Sistem (Tercatat di KEDUA Database!)
async function logCallStart({ caller, callee, callerSystem = 'A', calleeSystem = 'B', callType = 'video' }) {
  const result = { idA: null, idB: null };

  // Catat di Database Sistem A
  if (poolA) {
    try {
      const resA = await poolA.query(`
        INSERT INTO call_logs (caller, callee, caller_system, callee_system, call_type, status, started_at)
        VALUES ($1, $2, $3, $4, $5, 'ongoing', NOW())
        RETURNING id;
      `, [caller, callee, `SISTEM_${callerSystem}`, `SISTEM_${calleeSystem}`, callType]);
      result.idA = resA.rows[0]?.id;
    } catch (e) {
      console.error('[DB-A] Gagal logCallStart:', e.message);
    }
  }

  // Catat di Database Sistem B
  if (poolB) {
    try {
      const resB = await poolB.query(`
        INSERT INTO call_logs (caller, callee, caller_system, callee_system, call_type, status, started_at)
        VALUES ($1, $2, $3, $4, $5, 'ongoing', NOW())
        RETURNING id;
      `, [caller, callee, `SISTEM_${callerSystem}`, `SISTEM_${calleeSystem}`, callType]);
      result.idB = resB.rows[0]?.id;
    } catch (e) {
      console.error('[DB-B] Gagal logCallStart:', e.message);
    }
  }

  return result;
}

// 3. Catat Akhir Panggilan Antar-Sistem (Diupdate di KEDUA Database!)
async function logCallEnd({ callIdA, callIdB, caller, callee, status = 'completed', durationSeconds = 0, icePath, bitrateKbps, packetsLost, rttMs }) {
  const updateParams = [
    status,
    durationSeconds || 0,
    icePath || null,
    bitrateKbps || null,
    packetsLost || 0,
    rttMs || null
  ];

  // Update Database Sistem A
  if (poolA) {
    try {
      if (callIdA) {
        await poolA.query(`
          UPDATE call_logs
          SET status = $1, ended_at = NOW(), duration_seconds = $2, ice_path = $3, bitrate_kbps = $4, packets_lost = $5, rtt_ms = $6
          WHERE id = $7;
        `, [...updateParams, callIdA]);
      } else if (caller && callee) {
        await poolA.query(`
          UPDATE call_logs
          SET status = $1, ended_at = NOW(), duration_seconds = $2
          WHERE id = (SELECT id FROM call_logs WHERE caller = $3 AND callee = $4 AND status = 'ongoing' ORDER BY started_at DESC LIMIT 1);
        `, [status, durationSeconds, caller, callee]);
      }
    } catch (e) {
      console.error('[DB-A] Gagal logCallEnd:', e.message);
    }
  }

  // Update Database Sistem B
  if (poolB) {
    try {
      if (callIdB) {
        await poolB.query(`
          UPDATE call_logs
          SET status = $1, ended_at = NOW(), duration_seconds = $2, ice_path = $3, bitrate_kbps = $4, packets_lost = $5, rtt_ms = $6
          WHERE id = $7;
        `, [...updateParams, callIdB]);
      } else if (caller && callee) {
        await poolB.query(`
          UPDATE call_logs
          SET status = $1, ended_at = NOW(), duration_seconds = $2
          WHERE id = (SELECT id FROM call_logs WHERE caller = $3 AND callee = $4 AND status = 'ongoing' ORDER BY started_at DESC LIMIT 1);
        `, [status, durationSeconds, caller, callee]);
      }
    } catch (e) {
      console.error('[DB-B] Gagal logCallEnd:', e.message);
    }
  }
}

// 4. Catat Pesan Chat
async function logChatMessage({ system = 'A', callId, sender, receiver, message }) {
  const p = getPool(system);
  if (!p) return null;

  try {
    const res = await p.query(`
      INSERT INTO chat_messages (call_id, sender, receiver, message, sent_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *;
    `, [callId || null, sender, receiver, message]);
    return res.rows[0];
  } catch (e) {
    console.error(`[DB-${system}] Gagal logChatMessage:`, e.message);
    return null;
  }
}

// 5. Catat Metrik Observabilitas Coturn
async function logCoturnMetric({ system = 'A', callId, username, candidateType, localIp, remoteIp, protocol, rttMs, bitrateKbps, packetsLost }) {
  const p = getPool(system);
  if (!p) return null;

  try {
    const res = await p.query(`
      INSERT INTO coturn_metrics (call_id, username, candidate_type, local_ip, remote_ip, protocol, rtt_ms, bitrate_kbps, packets_lost, logged_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id;
    `, [callId || null, username, candidateType, localIp, remoteIp, protocol, rttMs || null, bitrateKbps || null, packetsLost || 0]);
    return res.rows[0]?.id;
  } catch (e) {
    console.error(`[DB-${system}] Gagal logCoturnMetric:`, e.message);
    return null;
  }
}

// 6. Ambil Riwayat Panggilan untuk Sistem Spesifik
async function getRecentCallLogs(system = 'A', limit = 20) {
  const p = getPool(system);
  if (!p) return [];

  try {
    const res = await p.query(`
      SELECT id, caller, callee, caller_system, callee_system, call_type, status, started_at, ended_at, duration_seconds, ice_path, bitrate_kbps, packets_lost, rtt_ms
      FROM call_logs
      ORDER BY started_at DESC
      LIMIT $1;
    `, [limit]);
    return res.rows;
  } catch (e) {
    console.error(`[DB-${system}] Gagal getRecentCallLogs:`, e.message);
    return [];
  }
}

module.exports = {
  poolA,
  poolB,
  initDb,
  upsertUser,
  logCallStart,
  logCallEnd,
  logChatMessage,
  logCoturnMetric,
  getRecentCallLogs
};
