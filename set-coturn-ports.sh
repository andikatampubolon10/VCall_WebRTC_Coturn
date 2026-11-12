#!/usr/bin/env bash
# ==============================================================================
# SKRIP DINAMIS PENGATUR RENTANG PORT COTURN SESUAI JUMLAH VIRTUAL USERS (VUs)
# Penggunaan di VPS: sudo ./set-coturn-ports.sh <JUMLAH_VUs>
# Contoh: sudo ./set-coturn-ports.sh 100000
# ==============================================================================

set -e

VUS=${1:-1000}
if ! [[ "$VUS" =~ ^[0-9]+$ ]] || [ "$VUS" -lt 2 ]; then
  echo "❌ Error: Masukkan jumlah VUs berupa angka >= 2. Contoh: sudo ./set-coturn-ports.sh 10000"
  exit 1
fi

PAIRS=$(( (VUS + 1) / 2 ))
# Tambahkan buffer 10% agar aman dari jeda pelepasan socket
NEEDED_PORTS=$(( PAIRS + (PAIRS / 10) + 10 ))

MAX_PORT=65535
# Standar IANA dimulai dari 49152 (16.384 port). Jika butuh lebih, turunkan min-port hingga batas aman 10000.
if [ "$NEEDED_PORTS" -le 16384 ]; then
  MIN_PORT=49152
  CALC_MAX=$(( MIN_PORT + NEEDED_PORTS - 1 ))
  if [ "$CALC_MAX" -gt "$MAX_PORT" ]; then
    CALC_MAX=$MAX_PORT
  fi
  MAX_PORT=$CALC_MAX
else
  MIN_PORT=$(( MAX_PORT - NEEDED_PORTS + 1 ))
  if [ "$MIN_PORT" -lt 10000 ]; then
    echo "⚠️ Peringatan: $VUS VUs ($PAIRS pasang) melebihi kapasitas maksimal port 1 IP tunggal (55.536 port aman)."
    echo "   Menyetel ke kapasitas maksimal fisik server: Port 10000 s/d 65535 (55.536 port)."
    MIN_PORT=10000
  fi
fi

TOTAL_PORTS=$(( MAX_PORT - MIN_PORT + 1 ))
CONF_FILE="/etc/turnserver.conf"

echo "======================================================================"
echo "⚙️  KONFIGURASI RENTANG PORT COTURN DINAMIS"
echo "👥 Target Beban   : $VUS VUs ($PAIRS Pasang Panggilan)"
echo "🔌 Rentang Port   : $MIN_PORT s/d $MAX_PORT ($TOTAL_PORTS Port UDP)"
echo "======================================================================"

if [ ! -f "$CONF_FILE" ]; then
  echo "❌ File $CONF_FILE tidak ditemukan!"
  exit 1
fi

# Update min-port dan max-port di /etc/turnserver.conf
sudo sed -i "s/^min-port=.*/min-port=$MIN_PORT/" "$CONF_FILE"
sudo sed -i "s/^max-port=.*/max-port=$MAX_PORT/" "$CONF_FILE"

# Buka Firewall UFW sesuai rentang dinamis baru
echo "🛡️ Membuka UFW Firewall untuk UDP $MIN_PORT:$MAX_PORT..."
sudo ufw allow ${MIN_PORT}:${MAX_PORT}/udp || true

# Naikkan batas File Descriptor (Open Files) untuk Systemd CoTURN & Kernel
echo "🚀 Mengoptimalkan batas File Descriptor OS (LimitNOFILE=1048576)..."
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

echo ""
echo "✅ SELESAI! CoTURN aktif dengan rentang port $MIN_PORT - $MAX_PORT ($TOTAL_PORTS port)."
echo "⚠️  PENTING (Cloud/GCP): Pastikan di VPC Firewall Console Anda juga membuka UDP $MIN_PORT-$MAX_PORT!"
echo "======================================================================"

