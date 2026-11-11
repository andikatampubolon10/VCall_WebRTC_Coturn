import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ========================================================
// METRIK CUSTOM UNTUK ANALISIS LAPORAN SEMESTER 7
// ========================================================
const callSuccessRate = new Rate('call_handshake_success_rate');
const messageLatency = new Trend('signaling_msg_latency_ms');
const totalCallsInitiated = new Counter('total_calls_initiated');
const totalCallsConnected = new Counter('total_calls_connected');

// ========================================================
// KONFIGURASI TAHAPAN BEBAN (LOAD STAGES - 100 USERS)
// ========================================================
export const options = {
  stages: [
    { duration: '10s', target: 20 },  // Pemanasan: Naik ke 20 pengguna dalam 10 detik
    { duration: '20s', target: 50 },  // Beban Menengah: 50 pengguna
    { duration: '30s', target: 100 }, // PUNCAK: 100 Pengguna Berbarengan (Concurrent)
    { duration: '20s', target: 100 }, // Pertahankan 100 Pengguna selama 20 detik
    { duration: '10s', target: 0 },   // Pendinginan: Turun kembali ke 0
  ],
  thresholds: {
    // Kriteria Kelulusan Pengujian (SLA)
    'call_handshake_success_rate': ['rate>0.95'], // Minimal 95% panggilan harus sukses
    'signaling_msg_latency_ms': ['p(95)<300'],    // 95% pesan signaling harus terkirim di bawah 300ms
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'ws://localhost:3000';

export default function () {
  // Setiap VU (Virtual User) dibagi menjadi 2 kubu:
  // - VU Ganjil: Bertindak sebagai Pemanggil (Aplikasi A / Dokter)
  // - VU Genap: Bertindak sebagai Penerima (Aplikasi B / Pasien)
  const isCaller = __VU % 2 === 1;
  const pairId = isCaller ? (__VU + 1) / 2 : __VU / 2;
  
  const myUserId = isCaller ? `Doctor_VU_${pairId}` : `Patient_VU_${pairId}`;
  const targetUserId = isCaller ? `Patient_VU_${pairId}` : `Doctor_VU_${pairId}`;
  const myApp = isCaller ? 'APP_A' : 'APP_B';

  const res = ws.connect(GATEWAY_URL, {}, function (socket) {
    let callState = 'init';
    let startTime = 0;

    socket.on('open', function () {
      // 1. Registrasi ke Gateway
      socket.send(JSON.stringify({
        type: 'register',
        userId: myUserId,
        appName: myApp
      }));
    });

    socket.on('message', function (message) {
      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        return;
      }

      const now = Date.now();
      if (startTime > 0) {
        messageLatency.add(now - startTime);
      }

      switch (data.type) {
        case 'registered':
          callState = 'registered';
          // Tunggu sebentar agar kedua pasang siap online
          socket.setTimeout(() => {
            if (isCaller) {
              // Pemanggil memicu panggilan (Trigger Call)
              totalCallsInitiated.add(1);
              startTime = Date.now();
              socket.send(JSON.stringify({
                type: 'call',
                to: targetUserId,
                mode: 'video'
              }));
            }
          }, 1500);
          break;

        case 'incoming':
          // Penerima (Pasien) menerima panggilan masuk -> Langsung TERIMA (Accept)
          socket.setTimeout(() => {
            socket.send(JSON.stringify({
              type: 'accept',
              to: data.from
            }));
          }, 500);
          break;

        case 'accept':
          // Panggilan diterima -> Kirim SDP Offer & ICE Candidate simulasi
          totalCallsConnected.add(1);
          callSuccessRate.add(1);

          // Simulasi pertukaran SDP Offer
          socket.send(JSON.stringify({
            type: 'offer',
            to: targetUserId,
            sdp: { type: 'offer', sdp: 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }
          }));

          // Simulasi kandidat Coturn Relay (Port 49160+)
          socket.send(JSON.stringify({
            type: 'candidate',
            to: targetUserId,
            candidate: {
              candidate: `candidate:1 1 UDP 2130706431 127.0.0.1 ${49160 + (__VU % 40)} typ relay raddr 127.0.0.1 rport 3478`
            }
          }));
          break;

        case 'offer':
          // Balas dengan SDP Answer
          socket.send(JSON.stringify({
            type: 'answer',
            to: data.from,
            sdp: { type: 'answer', sdp: 'v=0\r\no=- 654321 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }
          }));
          break;

        case 'answer':
          // Panggilan stabil, simulasikan obrolan selama 5 detik
          socket.setTimeout(() => {
            // Selesai panggilan -> Hangup
            socket.send(JSON.stringify({
              type: 'hangup',
              to: targetUserId,
              duration: 5,
              icePath: 'COTURN-RELAY'
            }));
            socket.close();
          }, 5000);
          break;

        case 'hangup':
          socket.close();
          break;
      }
    });

    socket.on('error', function (e) {
      callSuccessRate.add(0);
      console.error(`[VU ${__VU}] WS Error:`, e.error());
    });

    socket.setTimeout(function () {
      socket.close();
    }, 25000); // Batas aman durasi per VU
  });

  check(res, { 'Koneksi WebSocket Terhubung (Status 101)': (r) => r && r.status === 101 });
  sleep(1);
}

