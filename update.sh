#!/usr/bin/env bash
# ==============================================================================
# SCRIPT UPDATE OTOMATIS WEBRTC & COTURN DARI GITHUB
# ==============================================================================

set -e

echo "======================================================================"
echo "🔄 MENGAMBIL PEMBARUAN TERBARU DARI GITHUB..."
echo "======================================================================"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 1. Pull update terbaru dari GitHub
git pull origin main

# 2. Update dependensi jika ada package baru
echo "📦 Memeriksa & menginstall dependensi npm..."
cd "$DIR/gateway" && npm install --production
cd "$DIR/app-a" && npm install --production
cd "$DIR/app-b" && npm install --production
cd "$DIR"

# 3. Restart semua aplikasi PM2 (Gateway, App A, App B)
echo "🚀 Me-restart semua service dengan PM2..."
pm2 restart all

echo "======================================================================"
echo "🎉 PEMBARUAN BERHASIL DITERAPKAN DI SERVER!"
echo "Status Service Terkini:"
pm2 status
echo "======================================================================"
