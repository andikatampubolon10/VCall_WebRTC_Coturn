# Uji Kapasitas CoTURN + Signaling Gateway

Alat uji beban bertahap yang meniru **User A menelepon User B** persis seperti aplikasi asli,
lalu menghasilkan laporan **PDF** berisi tabel kapasitas per jumlah user (100, 250, 500, …)
sampai titik jenuh server.

## Apa yang diuji (per pasangan panggilan)

```
A,B  WebSocket connect + register                    → gateway
A    call ─► gateway ─► B incoming ─► B accept ─► A   → gateway
A,B  TURN Allocate (401 → kredensial long-term)       → CoTURN  (tiap user punya relay sendiri)
A,B  offer/answer + ICE candidate "typ relay"         → gateway
A,B  CreatePermission + ChannelBind ke relay lawan    → CoTURN
A⇄B  media ChannelData: A → relayA → relayB → B       → CoTURN  (relay media sungguhan)
A    hangup ; A,B Refresh(lifetime=0)                 → gateway, CoTURN
```

Panggilan baru dihitung **berhasil** bila media benar-benar diterima di **kedua arah** lewat relay.
Setiap paket media membawa nomor urut + timestamp → packet loss, jitter (RFC 3550) dan latensi one-way terukur.

Profil `video` (default): audio Opus 172 B + video 2×625 B setiap 20 ms ≈ **574 kbps per arah per user**.
Profil `audio`: ≈ 70 kbps.

## File

| File | Fungsi |
|---|---|
| `run-capacity-test.js` | Orkestrator: tahapan, ramp-up, jendela pengukuran, evaluasi SLA, stop di breaking point |
| `lib/pair-worker.js` | Proses worker yang menjalankan pasangan A/B (dipecah ke beberapa core) |
| `lib/turn-client.js` | Klien TURN RFC 5766 (Allocate, CreatePermission, ChannelBind, ChannelData, Refresh) |
| `server-monitor.js` | Agen telemetri server (tanpa dependensi) — CPU per core & per proses, RAM, jaringan, UDP kernel, port relay |
| `build-report.js` | Membuat `report.html` + `report.pdf` dari `results.json` |

## Menjalankan

```bash
cd loadtest && npm install

# Rekomendasi: generator di VM terpisah (satu region dengan server), monitor lewat SSH
node run-capacity-test.js --target 34.50.75.236 \
  --tiers 100,250,500,750,1000,1500,2000,2500,3000 \
  --profile video --hold 90 --cooldown 30 \
  --monitor ssh --ssh-user joim --ssh-key ~/.ssh/coturn_loadtest \
  --generator-location "GCP VM asia-southeast2 (e2-standard-8)"

# Alternatif: generator dijalankan di server itu sendiri (CPU generator ikut terhitung di CPU total;
# CPU proses CoTURN & gateway tetap terukur terpisah)
ulimit -n 200000
node run-capacity-test.js --target 34.50.75.236 --monitor local-sudo --pdf false \
  --generator-location "Server yang sama"   # lalu build-report.js di mesin yang punya Chrome

# Bangun ulang laporan dari hasil yang sudah ada
node build-report.js results/<run-id>
```

Laporan PDF memuat: ringkasan kapasitas, **skenario stress test Virtual User (VU)** + grafik VU aktif terhadap waktu, tabel kualitas panggilan, **durasi video call** (rata-rata/median/min/maks), sumber daya server (CPU total, CPU tanpa generator, CPU per proses CoTURN/gateway, RAM), jaringan, grafik tren, metodologi & lampiran.

Opsi penting: `--turn-user/--turn-pass` (atau env `TURN_USER`/`TURN_PASS`), `--workers N`,
`--ramp auto|detik`, `--stop-on-fail false` (lanjut walau gagal), `--video-kbps 500`, `--pdf false`.

## Kriteria SLA (bisa diubah di `THRESH` pada run-capacity-test.js)

| Metrik | Waspada | Gagal |
|---|---|---|
| Panggilan berhasil | < 99% | < 95% |
| Packet loss | > 1% | > 3% |
| Jitter p95 | > 20 ms | > 30 ms |
| Latensi one-way p95 | > 100 ms | > 150 ms (ITU-T G.114) |
| Setup panggilan p95 | > 1,5 s | > 3 s |
| CPU server rata-rata | > 70% | > 85% |
| RAM | > 80% | > 90% |
| CPU gateway Node.js (1 core) | > 70% | > 95% |

## Syarat agar hasil valid

1. **Tidak ada beban lain** di server (hentikan benchmark lama: `pkill -f run-live-benchmark.js`).
2. **Generator jangan dari laptop/WiFi rumah**: 500 user × 574 kbps ≈ 290 Mbps naik + turun.
   Laporan mencantumkan kesehatan generator (event loop & CPU); bila generator jenuh, pengujian berhenti otomatis.
3. Firewall GCP membuka UDP 3478 dan seluruh rentang `min-port`–`max-port` CoTURN.
4. Di mesin generator: `ulimit -n 65535`.
