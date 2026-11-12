#!/usr/bin/env bash
# ==============================================================================
# SCRIPT DEPLOYMENT OTOMATIS WEBRTC & COTURN
# Server IP: 34.50.75.236
# ==============================================================================

set -e

PUBLIC_IP="34.50.75.236"
INTERNAL_IP=$(hostname -I | awk '{print $1}')

echo "======================================================================"
echo "🚀 MEMULAI DEPLOYMENT WEBRTC & COTURN PADA SERVER"
echo "Public IP   : $PUBLIC_IP"
echo "Internal IP : $INTERNAL_IP"
echo "======================================================================"

# 1. Update Paket & Install Dependensi Dasar
echo "[1/6] Memperbarui sistem & menginstall dependensi..."
sudo apt update -y
sudo apt install -y curl git ufw coturn

# 2. Install Node.js v20 LTS & PM2
echo "[2/6] Memasang Node.js v20 LTS & PM2..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi
sudo npm install -g pm2

# 3. Konfigurasi Coturn Server (STUN / TURN)
echo "[3/6] Mengonfigurasi Service Coturn..."
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn || true
echo "TURNSERVER_ENABLED=1" | sudo tee -a /etc/default/coturn > /dev/null

sudo tee /etc/turnserver.conf > /dev/null <<EOF
# Konfigurasi Coturn WebRTC Production
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=$PUBLIC_IP/$INTERNAL_IP

fingerprint
lt-cred-mech
realm=$PUBLIC_IP
user=simulasi:password123

min-port=10000
max-port=65535

no-cli
verbose
log-file=/var/log/turnserver.log
EOF

# Naikkan batas File Descriptor (Open Files) untuk Systemd CoTURN & Kernel
sudo mkdir -p /etc/systemd/system/coturn.service.d
cat <<EOF | sudo tee /etc/systemd/system/coturn.service.d/limits.conf > /dev/null
[Service]
LimitNOFILE=1048576
EOF
sudo sysctl -w fs.file-max=2097152 >/dev/null 2>&1 || true
sudo sysctl -w net.core.rmem_max=26214400 >/dev/null 2>&1 || true
sudo sysctl -w net.core.wmem_max=26214400 >/dev/null 2>&1 || true
sudo systemctl daemon-reload

sudo systemctl restart coturn
sudo systemctl enable coturn
echo "Service Coturn berhasil diaktifkan (Port 10000-65535 untuk hingga 100.000+ VUs)!"

# 4. Install Dependensi Node.js untuk Setiap Modul
echo "[4/6] Menginstall package dependencies aplikasi..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

cd "$DIR/gateway" && npm install --production
cd "$DIR/app-a" && npm install --production
cd "$DIR/app-b" && npm install --production
cd "$DIR"

# 5. Konfigurasi Firewall UFW Server
echo "[5/6] Mengonfigurasi Port Firewall..."
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw allow 3000/tcp || true
sudo ufw allow 3001/tcp || true
sudo ufw allow 3002/tcp || true
sudo ufw allow 3478/tcp || true
sudo ufw allow 3478/udp || true
sudo ufw allow 5349/tcp || true
sudo ufw allow 5349/udp || true
sudo ufw allow 10000:65535/udp || true
sudo ufw --force enable || true

# 6. Menjalankan Semua Service dengan PM2
echo "[6/6] Menjalankan Aplikasi dengan PM2 Process Manager..."
pm2 delete all || true
pm2 start ecosystem.config.js
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME || true

echo "======================================================================"
echo "🎉 DEPLOYMENT BERHASIL SELESAI!"
echo "Status Service:"
pm2 status
echo ""
echo "Akses Aplikasi Anda:"
echo "👉 Aplikasi A (Dokter) : http://$PUBLIC_IP:3001"
echo "👉 Aplikasi B (Pasien) : http://$PUBLIC_IP:3002"
echo "👉 Shared Gateway      : ws://$PUBLIC_IP:3000"
echo "👉 Coturn STUN/TURN    : $PUBLIC_IP:3478 (user: simulasi, pass: password123)"
echo "======================================================================"

