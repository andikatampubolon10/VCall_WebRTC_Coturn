# 🎙️ Panduan Presentasi & Demonstrasi Coturn WebRTC

Panduan ini disusun untuk membantu Anda mendemonstrasikan hasil simulasi ini kepada **mentor, penguji, atau tim** dengan percaya diri, sistematis, dan meyakinkan.

---

## 📋 Skenario Alur Demo (5 - 7 Menit)

### Bagian 1: Pengenalan Masalah & Solusi (1 Menit)
* **Poin Bicara**:
  > *"WebRTC secara alami adalah protokol Peer-to-Peer (P2P). Namun di dunia nyata, 90% perangkat berada di balik NAT (Network Address Translation) atau Firewall, seperti di jaringan Wi-Fi rumah, kantor, atau data seluler. Akibatnya, dua perangkat tidak bisa langsung tahu IP publik satu sama lain.*
  >
  > *Untuk mengatasi ini, WebRTC membutuhkan **STUN** untuk mengetahui alamat publik, dan **TURN** sebagai relay cadangan saat koneksi langsung diblokir. Di proyek ini, saya mengimplementasikan **Coturn** sebagai server STUN & TURN lokal beserta signaling server mandiri berbasis Node.js."*

---

### Bagian 2: Demo Alur Panggilan Lengkap (2 Menit)
1. **Buka 2 Jendela Browser**:
   - Jendela 1: Login sebagai **User A**.
   - Jendela 2: Login sebagai **User B**.
2. **Tunjukkan Fitur Presence (Signaling)**:
   - Tunjukkan bahwa saat B login, di layar A langsung muncul kontak B dengan status online berwarna hijau.
3. **Mulai Panggilan Video**:
   - Dari User A, klik tombol **📹 Video** pada kontak B.
   - Perlihatkan di User B muncul dialog panggilan masuk lengkap dengan nada dering.
   - Klik **Terima** di User B.
4. **Tunjukkan Komunikasi Berjalan**:
   - Video dua arah tampil (layar remote besar dan preview kamera lokal kecil di sudut).
   - Tunjukkan tombol **Mute Mic** dan **Matikan Kamera** berfungsi.
   - Buka **Panel Chat** dan kirim pesan teks. Jelaskan bahwa teks ini dikirim lewat **RTCDataChannel** (jalur data terenkripsi langsung antar-peer).

---

### Bagian 3: Pembuktian Coturn Bekerja (Paling Krusial!) (2 Menit)
*Ini adalah bagian terpenting yang akan dinilai oleh mentor.*

1. **Jelaskan Tantangan Localhost**:
   > *"Pada pengujian di satu komputer lokal atau LAN yang sama, browser secara otomatis akan selalu memilih jalur `HOST` (koneksi internal langsung) karena latensinya paling rendah. Akibatnya, server Coturn tidak akan tersentuh."*
2. **Tunjukkan Panel Observabilitas (Koneksi Normal)**:
   - Buka **⚙️ Panel Debug Coturn**.
   - Tunjukkan bahwa Tipe Jalur Aktif bernilai **`HOST`**.
3. **Aktifkan Pembuktian Coturn (Paksa Relay)**:
   - Akhiri panggilan.
   - Centang saklar **"Paksa Jalur TURN Relay (Demo Coturn)"** di lobi.
   - Jelaskan: *"Opsi ini mengatur `iceTransportPolicy: 'relay'`, yang memaksa browser membuang kandidat host dan STUN, dan HANYA mau terhubung jika melalui TURN Coturn."*
   - Lakukan panggilan kembali antara A dan B.
4. **Tunjukkan Hasil Pembuktian**:
   - Di Panel Debug, badge langsung berubah menjadi warna hijau menyala: **`RELAY (TURN COTURN)`**.
   - Tunjukkan terminal Docker Coturn (`docker logs -f coturn-simulasi`):
     ```text
     IPv4. UDP relay user <simulasi> allocate request...
     allocation created: id=...
     ```
   - Jelaskan: *"Bisa dilihat di terminal Docker Coturn, terjadi alokasi port relay secara live. Ini membuktikan 100% bahwa paket video dan audio mengalir melewati Coturn server kita."*

---

### Bagian 4: Uji Negatif (Stress Test) (1 Menit)
* **Langkah**: Matikan container Coturn di terminal:
  ```powershell
  docker compose stop
  ```
* Coba lakukan panggilan kembali dengan kondisi "Paksa Jalur TURN Relay" masih aktif.
* **Hasil**: Panggilan langsung berstatus **Koneksi Gagal (ICE Failed)**.
* **Kesimpulan**: *"Ketika server Coturn dimatikan, panggilan relay tidak bisa terhubung. Ini membuktikan bahwa keberhasilan panggilan sebelumnya memang murni berkat Coturn."*

---

## ❓ Daftar Pertanyaan Umum dari Mentor & Cara Menjawabnya

### Q1: Apa perbedaan utama antara STUN dan TURN?
* **Jawaban**:
  - **STUN (Session Traversal Utilities for NAT)** bertindak seperti **cermin**. Klien bertanya *"Berapa IP publik dan port saya dari luar?"*. Setelah tahu IP publiknya, kedua klien mencoba saling tembak langsung (P2P). STUN **tidak menyentuh paket video/suara sama sekali**.
  - **TURN (Traversal Using Relays around NAT)** bertindak seperti **kurir relay**. Jika koneksi langsung P2P gagal (misal karena Symmetric NAT atau Firewall kantor), kedua klien mengirimkan seluruh paket media ke server TURN untuk diteruskan ke lawan bicara. TURN **menghabiskan bandwidth besar** karena merelay seluruh data.

### Q2: Apakah Coturn bisa mengintip / merekam isi video call kita saat mode Relay?
* **Jawaban**:
  - **Tidak bisa.** WebRTC menggunakan enkripsi bawaan wajib yaitu **DTLS-SRTP** (*Datagram Transport Layer Security - Secure Real-time Transport Protocol*). Kunci enkripsinya hanya dinegosiasikan langsung antara browser A dan browser B (*End-to-End Encryption*).
  - Server Coturn hanya melihat paket data sebagai aliran ciphertext terenkripsi dan hanya bertugas mem-forward UDP payload tanpa bisa mendekripsinya.

### Q3: Mengapa kita butuh Signaling Server jika sudah ada Coturn?
* **Jawaban**:
  - WebRTC sengaja **tidak menetapkan standar signaling** dalam spesifikasinya. Coturn hanya mengurusi NAT traversal (STUN/TURN), Coturn tidak tahu siapa yang mau menelepon siapa.
  - Kita butuh Signaling Server (di sini memakai Node.js WebSocket) untuk pertukaran sinyal awal: autentikasi, status online (*presence*), penawaran panggilan (*offer/answer SDP*), dan pertukaran *ICE Candidates*.

### Q4: Apa itu Trickle ICE?
* **Jawaban**:
  - Pada WebRTC versi lama, koneksi baru dimulai setelah browser selesai mengumpulkan seluruh kandidat IP (bisa makan waktu 2-4 detik).
  - **Trickle ICE** adalah teknik di mana begitu satu kandidat IP (misal `host` atau `srflx`) ditemukan, kandidat tersebut langsung dikirimkan seketika ke peer melalui signaling server tanpa menunggu yang lain. Hal ini membuat waktu setup panggilan jauh lebih cepat (< 1 detik).

### Q5: Bagaimana jika kita ingin menguji simulasi ini antara Laptop dan HP di Wi-Fi yang sama?
* **Jawaban**:
  1. Cari IP lokal laptop Anda (misal `192.168.1.10`) via `ipconfig`.
  2. Di pengaturan login web client, ganti *Host Coturn* menjadi `192.168.1.10`.
  3. Buka browser HP dan akses `http://192.168.1.10:3000`.
  4. Aplikasi A di laptop dan Aplikasi B di HP bisa saling video call langsung melalui LAN dan Coturn!

