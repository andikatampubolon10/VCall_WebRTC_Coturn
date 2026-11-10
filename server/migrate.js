require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigration() {
  const connectionString = process.env.DATABASE_URL;

  console.log('========================================================');
  console.log('📦 Menjalankan Migrasi Skema Database WebRTC PostgreSQL');
  console.log('========================================================');

  if (!connectionString) {
    console.error('❌ Error: Variabel DATABASE_URL tidak ditemukan di file .env');
    process.exit(1);
  }

  // Cek apakah masih placeholder contoh
  if (connectionString.includes('user:password') || connectionString.includes('ep-sample-pooler')) {
    console.error('⚠️  PERHATIAN: DATABASE_URL di file server/.env masih menggunakan format contoh:');
    console.error('    ' + connectionString);
    console.error('\n👉 Silakan buka file server/.env, ganti dengan URL koneksi Neon/Supabase Anda yang asli, lalu simpan (Ctrl+S).');
    process.exit(1);
  }

  const client = new Client({
    connectionString: connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('⏳ Menghubungkan ke database PostgreSQL...');
    await client.connect();
    console.log('✅ Terhubung ke database dengan sukses!');

    const sqlPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('⏳ Mengeksekusi script schema.sql...');
    await client.query(sql);
    console.log('✅ Skema tabel berhasil dibuat!');

    // Verifikasi tabel yang telah dibuat
    const resTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\n📋 Daftar Tabel yang Aktif di Database:');
    resTables.rows.forEach(row => {
      console.log(`   - 📁 ${row.table_name}`);
    });

    // Verifikasi data pengguna
    const resUsers = await client.query(`SELECT username, display_name FROM users ORDER BY username;`);
    console.log('\n👥 Daftar Akun Pengguna Awal:');
    resUsers.rows.forEach(u => {
      console.log(`   - 👤 ${u.username} (${u.display_name})`);
    });

    console.log('\n🎉 MIGRASI DATABASE 100% SUKSES!');

  } catch (err) {
    console.error('❌ Gagal menjalankan migrasi:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();

