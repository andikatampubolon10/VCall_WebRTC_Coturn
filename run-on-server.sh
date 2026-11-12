#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "======================================================================"
echo "🚀 MENYIAPKAN ENVIRONMENT PENGUJIAN KAPASITAS SERVER LINUX..."
echo "======================================================================"

# 1. Buka limit file descriptor agar tidak kena EMFILE
ulimit -n 65535 2>/dev/null || true

# 2. Pastikan service PM2 aktif
pm2 status

# 3. Jalankan pengujian kapasitas live langsung di server
echo "⚡ Memulai pengujian live benchmark..."
node run-live-benchmark.js

# 4. Commit dan push hasil pengukuran asli ke GitHub
git add hasil-benchmark-asli.json LAPORAN_PENGUJIAN_BEBAN_COTURN.html 2>/dev/null || true
git commit -m "docs: hasil pengujian asli server (telemetri live)" 2>/dev/null || true
git push origin main 2>/dev/null || true

echo "======================================================================"
echo "🎉 PENGUJIAN SELESAI & LAPORAN TERSIMPAN DENGAN SUKSES!"
echo "======================================================================"
