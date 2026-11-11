require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const urls = [
  { name: 'Neon US-East (Sistem A)', url: process.env.DATABASE_URL_A || process.env.DATABASE_URL },
  { name: 'Neon Singapore (Sistem B)', url: process.env.DATABASE_URL_B }
];

async function migrate() {
  for (const { name, url } of urls) {
    if (!url) continue;
    console.log(`Migrasi skema untuk ${name}...`);
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(`
        ALTER TABLE call_logs 
        ADD COLUMN IF NOT EXISTS caller_system VARCHAR(50) DEFAULT 'APP_A',
        ADD COLUMN IF NOT EXISTS callee_system VARCHAR(50) DEFAULT 'APP_B';
      `);
      console.log(`[OK] Kolom caller_system & callee_system berhasil ditambahkan di ${name}!`);
    } catch (e) {
      console.error(`[ERR] ${name}:`, e.message);
    } finally {
      await pool.end();
    }
  }
}

migrate();
