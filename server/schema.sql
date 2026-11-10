-- ========================================================
-- SKEMA DATABASE WEBRTC VIDEO/VOICE CALL
-- Kompatibel dengan PostgreSQL Neon
-- ========================================================

-- 1. Update Tabel USERS (menambahkan kolom pendukung jika belum ada)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'offline',
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 2. TABEL DAFTAR KONTAK / PERTEMANAN (CONTACTS)
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'accepted', -- 'accepted', 'pending', 'blocked'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, contact_user_id)
);

-- 3. TABEL TOKEN NOTIFIKASI PERANGKAT (DEVICE TOKENS)
-- Digunakan untuk membangunkan HP penerima (VoIP Push Notification) saat layar mati
CREATE TABLE IF NOT EXISTS device_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(100) NOT NULL,
    platform VARCHAR(20) NOT NULL, -- 'web', 'android', 'ios'
    push_token TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, device_id)
);

-- 4. TABEL RIWAYAT PANGGILAN (CALL LOGS)
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    caller VARCHAR(100) NOT NULL,
    callee VARCHAR(100) NOT NULL,
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

-- 5. TABEL RIWAYAT PESAN CHAT (CHAT MESSAGES)
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    call_id INT REFERENCES call_logs(id) ON DELETE SET NULL,
    sender VARCHAR(100) NOT NULL,
    receiver VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. TABEL METRIK OBSERVABILITAS COTURN (COTURN METRICS)
CREATE TABLE IF NOT EXISTS coturn_metrics (
    id SERIAL PRIMARY KEY,
    call_id INT REFERENCES call_logs(id) ON DELETE CASCADE,
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

-- Indeks untuk performa query
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller);
CREATE INDEX IF NOT EXISTS idx_call_logs_callee ON call_logs(callee);
CREATE INDEX IF NOT EXISTS idx_chat_sender_receiver ON chat_messages(sender, receiver);

-- ========================================================
-- DATA AWAL / SEED DATA
-- ========================================================
INSERT INTO users (username, display_name, phone_number, status)
VALUES 
    ('User A', 'User Penelepon (A)', '+628111111111', 'offline'),
    ('User B', 'User Penerima (B)', '+628222222222', 'offline'),
    ('User C', 'User Cadangan (C)', '+628333333333', 'offline')
ON CONFLICT (username) DO UPDATE 
SET display_name = EXCLUDED.display_name,
    phone_number = EXCLUDED.phone_number;

-- Buat relasi kontak pertemanan timbal balik antara A dan B
INSERT INTO contacts (user_id, contact_user_id, status)
SELECT u1.id, u2.id, 'accepted'
FROM users u1, users u2
WHERE u1.username = 'User A' AND u2.username = 'User B'
ON CONFLICT (user_id, contact_user_id) DO NOTHING;

INSERT INTO contacts (user_id, contact_user_id, status)
SELECT u1.id, u2.id, 'accepted'
FROM users u1, users u2
WHERE u1.username = 'User B' AND u2.username = 'User A'
ON CONFLICT (user_id, contact_user_id) DO NOTHING;
