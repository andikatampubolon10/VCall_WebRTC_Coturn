require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connB = process.env.DATABASE_URL_B || 'postgresql://neondb_owner:npg_P56lfQFpaCws@ep-patient-sea-aoprz9x3-pooler.c-2.ap-southeast-1.aws.neon.tech/system_b_db?sslmode=require';

async function migrateSystemB() {
  console.log('========================================================');
  console.log('📦 Migrasi Skema Database Sistem B (Neon Singapore)');
  console.log('========================================================');

  const client = new Client({
    connectionString: connB,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Terhubung ke Database Sistem B: system_b_db');

    const sqlPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await client.query(sql);
    console.log('✅ Skema tabel berhasil dibuat di Sistem B!');

    // Cek daftar tabel
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\n📋 Tabel di Sistem B:');
    tables.rows.forEach(r => console.log(`   - 📁 ${r.table_name}`));

    // Masukkan data user spesifik sistem B jika belum ada
    await client.query(`
      INSERT INTO users (username, display_name, phone_number, status)
      VALUES 
        ('User B', 'Pengguna Sistem B (Utama)', '+628222222222', 'offline'),
        ('User B2', 'Pengguna Sistem B (Cadangan)', '+628222222223', 'offline')
      ON CONFLICT (username) DO UPDATE
      SET display_name = EXCLUDED.display_name;
    `);

    const users = await client.query(`SELECT username, display_name FROM users ORDER BY username;`);
    console.log('\n👥 Pengguna Terdaftar di Sistem B:');
    users.rows.forEach(u => console.log(`   - 👤 ${u.username} (${u.display_name})`));

    console.log('\n🎉 MIGRASI SISTEM B SELESAI DENGAN SUKSES!');
  } catch (err) {
    console.error('❌ Error migrasi Sistem B:', err.message);
  } finally {
    await client.end();
  }
}

migrateSystemB();

