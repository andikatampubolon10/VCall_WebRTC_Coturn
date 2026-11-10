# Simulasi Voice/Video Call WebRTC dengan Coturn (STUN/TURN)

Proyek ini adalah simulasi komunikasi real-time (Voice Call, Video Call, dan Chat DataChannel) berbasis **WebRTC**, dilengkapi **Signaling Server** buatan sendiri (Node.js WebSocket) dan **Coturn** sebagai server STUN dan TURN.

Tujuan utama proyek ini adalah **memahami, mendemonstrasikan, dan membuktikan cara kerja Coturn (STUN/TURN)** dalam menembus NAT/Firewall.

---

## 📁 Struktur Proyek

```
VCall_WebRTC_Coturn/
├── docker-compose.yml          # Menjalankan Coturn container (Docker)
├── coturn/
│   ├── turnserver.conf         # Konfigurasi port 3478, realm, akun simulasi
│   ├── test-trickle-ice.html   # Tool mandiri uji WebRTC Trickle ICE di browser
│   └── start-coturn.bat        # Skrip sekali klik untuk menjalankan Coturn
├── server/
│   ├── package.json            # Dependensi server (ws)
│   ├── index.js                # Signaling Server (WebSocket) + Static Web Server
│   ├── test-signaling.js       # Skrip pengujian otomatis protokol signaling
│   └── start-server.bat        # Skrip sekali klik untuk menjalankan server
├── client/
│   ├── index.html              # Antarmuka web Aplikasi A & B (WhatsApp-like UI)
│   ├── app.js                  # Logika WebRTC, State Machine, Chat DataChannel, & getStats()
│   └── style.css               # Styling bertema WhatsApp Web Dark Mode
└── prd/
    └── PRD Simulasi...pdf      # Dokumen PRD spesifikasi lengkap
```

---

## 🚀 Panduan Menjalankan Simulasi

### Langkah 1: Jalankan Coturn Server (STUN/TURN)
1. Pastikan **Docker Desktop** sudah berjalan.
2. Buka terminal atau klik dua kali:
   ```powershell
   docker compose up -d
   ```
   *(Atau jalankan `coturn\start-coturn.bat`)*
3. Pantau log Coturn secara live:
   ```powershell
   docker logs -f coturn-simulasi
   ```

### Langkah 2: Jalankan Signaling & Web Server
1. Buka terminal baru:
   ```powershell
   cd server
   npm start
   ```
   *(Atau jalankan `server\start-server.bat`)*
2. Server akan aktif di `http://localhost:3000`.

### Langkah 3: Buka Klien A dan Klien B di Browser
1. Buka tab browser 1: `http://localhost:3000`
   - Klik chip **Aplikasi A** lalu klik **Masuk & Sambungkan**.
2. Buka tab browser 2 (atau jendela Incognito): `http://localhost:3000`
   - Klik chip **Aplikasi B** lalu klik **Masuk & Sambungkan**.
3. Di tab Aplikasi A, Anda akan melihat Aplikasi B dalam daftar online dengan status siap:
   - Klik tombol **📹 Video** atau **📞 Suara**.
   - Tab Aplikasi B akan berdering dengan dialog panggilan masuk.
   - Klik **Terima** pada Aplikasi B.
4. Panggilan terhubung! Anda dapat saling melihat video, mendengar suara, mengirim pesan chat lewat RTCDataChannel, serta mematikan kamera/mic.

---

## 🧪 Cara Membuktikan Bahwa Coturn Benar-Benar Bekerja

### Tantangan Lingkungan Lokal:
Pada pengujian di satu komputer (`localhost`), WebRTC secara default akan memilih kandidat **`host`** (koneksi langsung internal) karena latensinya paling rendah, sehingga Coturn tidak tersentuh.

### Solusi Pembuktian (FR-43 & FR-40):
1. **Buka Panel Debug**:
   - Klik tombol **⚙️ Panel Debug Coturn** di pojok kanan atas.
2. **Uji Jalur Normal (P2P Langsung)**:
   - Lakukan panggilan tanpa mencentang saklar relay.
   - Pada panel debug, Tipe Jalur Aktif akan bernilai: **`HOST`**.
3. **Uji Pembuktian Coturn (Paksa Jalur TURN Relay)**:
   - Akhiri panggilan.
   - Aktifkan saklar: **"Paksa Jalur TURN Relay (Demo Coturn)"** di lobi.
   - Lakukan panggilan kembali antara A dan B.
   - Perhatikan perubahan berikut:
     1. Tipe Jalur Aktif pada Panel Debug berubah menjadi **`RELAY (TURN COTURN)`** berwarna hijau emerald.
     2. Di terminal log Docker Coturn (`docker logs -f coturn-simulasi`), muncul log alokasi:
        ```text
        IPv4. UDP relay user <simulasi> allocate request...
        allocation created: id=...
        ```
     3. Ini adalah **bukti mutlak** bahwa aliran paket media 100% melewati Coturn!
4. **Uji Negatif (Pembuktian Tambahan)**:
   - Matikan container Coturn (`docker compose stop`).
   - Coba lakukan panggilan dengan opsi "Paksa Jalur TURN Relay".
   - Panggilan akan langsung gagal (**ICE Failed**), membuktikan panggilan sebelumnya benar-benar bergantung pada Coturn.

---

## 📊 Observabilitas & Statistik Real-Time (`getStats()`)

Panel debug membaca API `RTCPeerConnection.getStats()` setiap detik untuk menyajikan:
- **Tipe Kandidat Aktif**: `HOST` (Lokal), `SRFLX` (STUN), atau `RELAY` (TURN).
- **Status ICE & Koneksi**: `checking`, `connected`, `completed`.
- **RTT (Round Trip Time)**: Latensi bolak-balik dalam milidetik (ms).
- **Bitrate Media**: Kecepatan aliran data dalam kbps.
- **Packet Loss**: Jumlah paket yang hilang selama transmisi.
- **Konsol Log**: Rekaman setiap pesan signaling JSON dan ICE candidate yang dikumpulkan.

---

## 🛡️ Otentikasi & Konfigurasi Coturn
- **Port STUN/TURN**: `3478` (UDP & TCP)
- **Rentang Port Relay**: `49160 - 49200` (UDP)
- **Realm**: `localhost`
- **Username**: `simulasi`
- **Password**: `password123`

