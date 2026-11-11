# Simulasi Voice/Video Call WebRTC dengan Coturn (STUN/TURN) & PostgreSQL (Neon)

Aplikasi simulasi komunikasi real-time lengkap berbasis **WebRTC** yang mencakup fitur **Video Call**, **Voice Call**, dan **Chat RTCDataChannel**. Dilengkapi **Signaling Server** mandiri (Node.js WebSocket), server **Coturn** (STUN & TURN) di dalam Docker, serta integrasi **Database Cloud Neon PostgreSQL** untuk pencatatan persisten riwayat panggilan dan observabilitas jaringan.

Antarmuka pengguna (*Frontend*) mengadopsi tema gelap modern bergaya **WhatsApp Web Dark Mode**.

---

## 📑 Daftar Isi
- [Fitur Utama](#-fitur-utama)
- [Struktur Proyek](#-struktur-proyek)
- [Teknologi yang Digunakan](#-teknologi-yang-digunakan)
- [Prasyarat Sistem](#-prasyarat-sistem)
- [Panduan Menjalankan Simulasi](#-panduan-menjalankan-simulasi)
- [Panduan Lintas Perangkat (Laptop ke Smartphone)](#-panduan-lintas-perangkat-laptop-ke-smartphone)
- [Metode Pembuktian Cara Kerja Coturn](#-metode-pembuktian-cara-kerja-coturn)
- [Integrasi Database Neon PostgreSQL](#-integrasi-database-neon-postgresql)
- [Observabilitas Real-Time (getStats)](#-observabilitas-real-time-getstats)
- [Konfigurasi Coturn](#-konfigurasi-coturn)

---

## 🌟 Fitur Utama

1. **Komunikasi Real-time WebRTC**:
   - Panggilan Video 720p HD dengan preview lokal *Picture-in-Picture*.
   - Panggilan Suara dengan visualisasi avatar berdenyut.
   - Kontrol Media: Mute/Unmute Mikrofon dan On/Off Kamera secara instan.
   - Chat langsung *Peer-to-Peer* berbasis `RTCDataChannel`.
2. **Observabilitas Coturn Terpadu**:
   - Otomatis mendeteksi kandidat aktif: `HOST` (Lokal), `SRFLX` (STUN), atau `RELAY` (TURN).
   - Saklar **"Paksa Jalur TURN Relay"** untuk mendemonstrasikan bahwa server Coturn benar-benar menyalurkan paket media.
   - Panel Debug statistik: RTT (latensi), Bitrate (kbps), Packet Loss, dan konsol rekaman sinyal ICE.
3. **Penyimpanan Cloud Neon PostgreSQL**:
   - Status user online/offline tersimpan otomatis.
   - Riwayat panggilan (Caller, Callee, durasi, status, serta **Jalur ICE Coturn**) tersimpan permanen.
   - Modal interaktif **"📜 Riwayat DB"** di antarmuka web untuk melihat log panggilan langsung dari database.
4. **Dukungan Multi-Device**:
   - Deteksi IP otomatis (*auto-detect host*) saat diakses dari HP atau laptop lain dalam satu jaringan Wi-Fi.

---

## 📁 Struktur Proyek

```text
VCall_WebRTC_Coturn/
├── docker-compose.yml          # Konfigurasi container Coturn (STUN/TURN)
├── .gitignore                  # Mengabaikan file sensitif (.env & node_modules)
├── README.md                   # Dokumentasi teknis proyek
├── coturn/
│   ├── turnserver.conf         # Konfigurasi port 3478, realm, kredensial Coturn
│   ├── test-trickle-ice.html   # Tool mandiri browser untuk uji Trickle ICE Coturn
│   └── start-coturn.bat        # Skrip sekali klik untuk menyalakan Coturn
├── server/
│   ├── .env                    # Kredensial rahasia DATABASE_URL Neon PostgreSQL
│   ├── package.json            # Dependensi server (ws, pg, dotenv)
│   ├── db.js                   # Modul koneksi pool & skema tabel Neon PostgreSQL
│   ├── index.js                # Signaling Server (WebSocket) + Static Web Server + REST API
│   ├── test-signaling.js       # Skrip pengujian otomatis alur protokol signaling
│   └── start-server.bat        # Skrip sekali klik untuk menyalakan server
├── client/
│   ├── index.html              # Antarmuka WhatsApp-like UI & Modal Riwayat DB
│   ├── app.js                  # Logika WebRTC, State Machine, DataChannel, & DB sync
│   └── style.css               # Styling WhatsApp Dark Mode responsif
└── prd/
    └── PRD Simulasi...pdf      # Dokumen Product Requirement Document (PRD)
```

---

## 🛠️ Teknologi yang Digunakan

- **WebRTC API**: `RTCPeerConnection`, `RTCDataChannel`, `getUserMedia`, `getStats()`.
- **Backend / Signaling**: Node.js, `ws` (WebSocket), `http`, `pg` (PostgreSQL Client), `dotenv`.
- **Coturn Server**: Container Docker `coturn/coturn:latest` (STUN/TURN RFC 5389 / 5766).
- **Database**: **Neon Cloud Serverless PostgreSQL**.
- **Frontend**: HTML5, CSS3 Modern Flexbox/Grid, Vanilla JavaScript (ES6+), Web Audio API Ringtone Synthesizer.

---

## ⚙️ Prasyarat Sistem

1. **Node.js** (versi 18.x atau yang lebih baru).
2. **Docker Desktop** (sudah terinstal dan aktif di komputer host).
3. **Browser Modern**: Google Chrome, Microsoft Edge, Mozilla Firefox, atau Safari.

---

## 🚀 Panduan Menjalankan Simulasi

### Langkah 1: Jalankan Server Coturn (STUN/TURN)
1. Pastikan Docker Desktop sudah aktif.
2. Buka terminal di folder utama proyek, lalu jalankan:
   ```powershell
   docker compose up -d
   ```
   *(Atau klik dua kali file `coturn\start-coturn.bat`)*.
3. Untuk melihat aktivitas Coturn secara live:
   ```powershell
   docker logs -f coturn-simulasi
   ```

### Langkah 2: Jalankan Signaling & Web Server
1. Buka terminal baru:
   ```powershell
   cd server
   npm start
   ```
   *(Atau klik dua kali file `server\start-server.bat`)*.
2. Server akan aktif di port 3000:
   - Antarmuka Utama: `http://localhost:3000`
   - Tool Uji Coturn: `http://localhost:3000/trickle`

### Langkah 3: Buka Klien A dan Klien B di Browser
1. **Tab 1 (Klien A)**: Buka `http://localhost:3000`, pilih chip **User A**, lalu klik **Masuk & Sambungkan**. Berikan izin kamera & mic.
2. **Tab 2 (Klien B)**: Buka jendela baru / Incognito ke `http://localhost:3000`, pilih chip **User B**, lalu klik **Masuk & Sambungkan**. Berikan izin kamera & mic.
3. Di tab User A, klik tombol **📹 Video Call** pada kontak User B.
4. Di tab User B, dialog panggilan masuk akan berdering. Klik **Terima**.
5. Panggilan terhubung! Aliran video, suara, dan chat DataChannel aktif secara bilateral.

---

## 📱 Panduan Lintas Perangkat (Laptop ke Smartphone)

Untuk menguji panggilan antara **Laptop (Server)** dan **HP (Smartphone)** pada satu jaringan Wi-Fi:

### 1. Dapatkan Alamat IP Komputer Anda
Buka PowerShell di laptop dan jalankan:
```powershell
ipconfig
```
Cari **IPv4 Address** pada Wi-Fi adapter Anda (contoh: `192.168.1.15`).

### 2. Atasi Batasan Keamanan Browser (Izin Kamera/Mic HTTP)
> [!IMPORTANT]
> Browser modern memblokir akses Kamera dan Mikrofon pada URL `http://` selain `localhost`. Gunakan salah satu opsi berikut:

- **Opsi A (Paling Mudah - Rekomendasi Semua HP/iOS/Android)**:
  Buka terminal baru di laptop dan jalankan tunneling HTTPS gratis:
  ```powershell
  npx localtunnel --port 3000
  ```
  Buka link `https://...loca.lt` yang dihasilkan di HP Anda. Kamera dan mic langsung diizinkan tanpa konfigurasi browser tambahan!

- **Opsi B (Khusus Chrome di Android via IP Lokal)**:
  1. Di Chrome HP, buka URL: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
  2. Masukkan alamat server Anda: `http://192.168.1.15:3000`
  3. Ubah menjadi **Enabled**, lalu klik **Relaunch**.
  4. Buka `http://192.168.1.15:3000` di HP.

*Catatan: Host Coturn sudah otomatis mengenali alamat IP server saat dibuka dari HP.*

---

## 🧪 Metode Pembuktian Cara Kerja Coturn

Pada lingkungan satu komputer (`localhost`), WebRTC secara otomatis memilih kandidat **`HOST`** karena latensinya paling rendah. Untuk membuktikan server Coturn bekerja:

1. **Uji Kasus 1: Panggilan Langsung P2P (Normal)**
   - Lakukan panggilan tanpa mencentang saklar relay.
   - Buka **⚙️ Panel Debug Coturn**: Tipe Jalur bernilai **`HOST`**.
   - Buka **📜 Riwayat DB**: Tercatat jalur `HOST`.

2. **Uji Kasus 2: Pembuktian Coturn TURN Relay (Paksa Relay)**
   - Aktifkan saklar **"Paksa Jalur TURN Relay (Demo Coturn)"** di lobi.
   - Lakukan panggilan kembali.
   - Perhatikan pembuktian serentak berikut:
     1. **Badge UI**: Berubah menjadi hijau terang **`RELAY (TURN COTURN)`**.
     2. **Log Docker Coturn** (`docker logs -f coturn-simulasi`): Muncul alokasi relay aktif:
        ```text
        IPv4. UDP relay user <simulasi> allocate request...
        allocation created: id=...
        ```
     3. **Modal Riwayat DB**: Tersimpan permanen di database PostgreSQL dengan status jalur **`RELAY (TURN COTURN)`**.

3. **Uji Kasus 3: Uji Negatif (Ketergantungan Coturn)**
   - Matikan container Coturn: `docker compose stop`.
   - Coba lakukan panggilan dengan opsi paksa relay aktif.
   - Panggilan akan langsung gagal (**ICE Failed**), membuktikan panggilan sebelumnya 100% bergantung pada Coturn!

---

## 🗄️ Integrasi Database Neon PostgreSQL

Proyek ini terhubung langsung ke **Neon Cloud Serverless PostgreSQL**.

### Skema Tabel
1. **`users`**: `id`, `username`, `status` (*online/offline*), `last_seen`, `created_at`.
2. **`call_logs`**: `id`, `caller`, `callee`, `call_type`, `status`, `started_at`, `ended_at`, `duration_seconds`, `ice_path`, `bitrate_kbps`, `packets_lost`, `rtt_ms`.
3. **`chat_messages`**: `id`, `call_id`, `sender`, `receiver`, `message`, `sent_at`.
4. **`coturn_metrics`**: `id`, `call_id`, `username`, `candidate_type`, `local_ip`, `remote_ip`, `protocol`, `rtt_ms`, `bitrate_kbps`, `packets_lost`, `logged_at`.

### REST API Endpoint Internal
- `GET /api/call-logs`: Mengembalikan 30 data riwayat panggilan terakhir.
- `GET /api/metrics`: Mengembalikan data metrik observabilitas Coturn.
- `GET /api/db-status`: Cek status koneksi PostgreSQL.

---

## 📊 Observabilitas Real-Time (`getStats()`)

Panel debug membaca API `RTCPeerConnection.getStats()` setiap 1 detik:
- **Active Candidate Pair**: Menampilkan IP dan port lokal vs remote beserta tipenya.
- **RTT (Round Trip Time)**: Latensi bolak-balik dalam milidetik (ms).
- **Bitrate Media**: Kecepatan aliran data dalam satuan kbps.
- **Packet Loss**: Jumlah paket RTP yang hilang selama transmisi.
- **Konsol Log**: Rekaman setiap pertukaran sinyal SDP dan kandidat ICE secara kronologis.

---

## 🛡️ Konfigurasi Coturn

Konfigurasi server terletak pada file [`coturn/turnserver.conf`](file:///d:/SEMESTER%207/VCall_WebRTC_Coturn/coturn/turnserver.conf):
- **Port Utama STUN/TURN**: `3478` (UDP & TCP)
- **Rentang Port Relay UDP**: `49160 - 49200`
- **Realm**: `localhost`
- **Username**: `simulasi`
- **Password**: `password123`

---

## 🚀 Ekosistem 2 Aplikasi Mandiri (React + Shared Gateway + 2 Database Neon)

Sistem ini mendukung simulasi panggilan antar dua aplikasi perangkat lunak yang **terpisah secara fisik & arsitektur**:

```
+------------------------------------+        +------------------------------------+
|     APLIKASI A (Port 3001)         |        |     APLIKASI B (Port 3002)         |
|  - Theme: Hospital / Doctor Portal |        |  - Theme: Mobile Patient App       |
|  - Framework: React 18 UI          |        |  - Framework: React 18 UI          |
|  - Database: Neon DB (US-East)     |        |  - Database: Neon DB (Singapore)   |
|  - User: User A                    |        |  - User: User B                    |
+-----------------+------------------+        +------------------+-----------------+
                  |                                              |
                  +----------------------+-----------------------+
                                         |
                                         v
                         +-------------------------------+
                         |   SHARED WEBRTC GATEWAY       |
                         |   (Port 3000 / WebSocket)     |
                         |   - Room Broker & Signaling   |
                         +---------------+---------------+
                                         |
                                         v
                         +-------------------------------+
                         |       COTURN SERVER           |
                         |   - STUN / TURN (Port 3478)   |
                         +-------------------------------+
```

### Cara Menjalankan Ekosistem 2 Aplikasi:
Cukup jalankan batch file launcher satu-klik:
```cmd
start-ecosystem.bat
```
Script otomatis akan:
1. Menjalankan Docker Coturn (`docker compose up -d`).
2. Menjalankan Shared WebRTC Gateway pada Port 3000 (`gateway/`).
3. Menjalankan Aplikasi A pada Port 3001 (`app-a/`) yang terhubung ke **Neon US-East**.
4. Menjalankan Aplikasi B pada Port 3002 (`app-b/`) yang terhubung ke **Neon Singapore**.
5. Membuka kedua aplikasi secara berdampingan di browser Anda (`http://localhost:3001` dan `http://localhost:3002`).

Untuk menghentikan semua layanan:
```cmd
stop-ecosystem.bat
```

---

## 📊 Pengujian Beban: 100 Concurrent Users (Grafana K6)

Proyek ini telah dilengkapi dengan instrumen pengujian beban resmi berbasis **Grafana K6** untuk menguji kapasitas throughput dan reliabilitas server Signaling & CoTURN pada skenario 100 pengguna virtual aktif bersamaan (50 pasang panggilan simultan).

### 1. Struktur Pengujian K6 (`load-test-k6.js`):
* **Load Profile (Stages):**
  * `0s - 10s`: Ramp-up ke 20 pengguna
  * `10s - 30s`: Ramping ke 50 pengguna
  * `30s - 60s`: **Beban Puncak (100 Concurrent Users)**
  * `60s - 80s`: Mempertahankan 100 pengguna (Steady State)
  * `80s - 90s`: Ramp-down kembali ke 0
* **Metrik & Ambang Kelulusan (Thresholds SLA):**
  * `call_handshake_success_rate > 95%`: Minimal 95% panggilan harus berhasil tersambung.
  * `signaling_msg_latency_ms (p95) < 300ms`: 95% pesan sinyal terkirim di bawah 300 milidetik.
* **Simulasi Alokasi Port CoTURN:** Menguji perputaran kandidat relay pada rentang port `49160-49400`.

### 2. Cara Menjalankan Pengujian:
Cukup jalankan batch file otomatis:
```cmd
run-k6-test.bat
```
*Script otomatis mendeteksi k6 lokal, kontainer Docker resmi `grafana/k6`, atau beralih ke node runner mandiri secara cerdas.*

