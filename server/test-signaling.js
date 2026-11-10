// Skrip Pengujian Otomatis Protokol Signaling (Simulasi Klien A dan Klien B)
const { WebSocket } = require('ws');

const SIGNALING_URL = 'ws://localhost:3000';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  console.log('🧪 Memulai Pengujian Otomatis Signaling Server...\n');

  const wsA = new WebSocket(SIGNALING_URL);
  const wsB = new WebSocket(SIGNALING_URL);

  let userListReceivedA = false;
  let incomingReceivedB = false;
  let acceptReceivedA = false;
  let offerReceivedB = false;
  let answerReceivedA = false;
  let candidateReceivedB = false;
  let hangupReceivedB = false;

  await Promise.all([
    new Promise(res => wsA.on('open', res)),
    new Promise(res => wsB.on('open', res))
  ]);
  console.log('✅ 1. Kedua WebSocket (A & B) berhasil terhubung ke server');

  // Listener Klien A
  wsA.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    // console.log('[Klien A received]:', msg.type);
    if (msg.type === 'registered') {
      console.log('✅ 2. Klien A berhasil terdaftar');
    } else if (msg.type === 'users') {
      userListReceivedA = true;
    } else if (msg.type === 'accept') {
      acceptReceivedA = true;
      console.log('✅ 5. Klien A menerima pesan "accept" dari B');
    } else if (msg.type === 'answer') {
      answerReceivedA = true;
      console.log('✅ 7. Klien A menerima pesan "answer" SDP dari B');
    }
  });

  // Listener Klien B
  wsB.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    // console.log('[Klien B received]:', msg.type);
    if (msg.type === 'registered') {
      console.log('✅ 3. Klien B berhasil terdaftar');
    } else if (msg.type === 'incoming') {
      incomingReceivedB = true;
      console.log('✅ 4. Klien B menerima notifikasi "incoming" call dari A');
      // B menerima panggilan
      wsB.send(JSON.stringify({ type: 'accept', to: 'userA' }));
    } else if (msg.type === 'offer') {
      offerReceivedB = true;
      console.log('✅ 6. Klien B menerima pesan "offer" SDP dari A');
      // B mengirim answer
      wsB.send(JSON.stringify({ type: 'answer', to: 'userA', sdp: { type: 'answer', sdp: 'fake-sdp-answer' } }));
    } else if (msg.type === 'candidate') {
      candidateReceivedB = true;
      console.log('✅ 8. Klien B menerima ICE "candidate" dari A');
    } else if (msg.type === 'hangup') {
      hangupReceivedB = true;
      console.log('✅ 9. Klien B menerima notifikasi "hangup" dari A');
    }
  });

  // Registrasi A dan B
  wsA.send(JSON.stringify({ type: 'register', userId: 'userA' }));
  await wait(100);
  wsB.send(JSON.stringify({ type: 'register', userId: 'userB' }));
  await wait(200);

  // A memicu panggilan ke B
  wsA.send(JSON.stringify({ type: 'call', to: 'userB', mode: 'video' }));
  await wait(200);

  // A mengirim offer SDP ke B
  wsA.send(JSON.stringify({ type: 'offer', to: 'userB', sdp: { type: 'offer', sdp: 'fake-sdp-offer' } }));
  await wait(200);

  // A mengirim ICE candidate ke B
  wsA.send(JSON.stringify({ type: 'candidate', to: 'userB', candidate: { candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host' } }));
  await wait(200);

  // A mengakhiri panggilan
  wsA.send(JSON.stringify({ type: 'hangup', to: 'userB' }));
  await wait(200);

  wsA.close();
  wsB.close();

  const allPassed = userListReceivedA && incomingReceivedB && acceptReceivedA && offerReceivedB && answerReceivedA && candidateReceivedB && hangupReceivedB;

  if (allPassed) {
    console.log('\n🎉 SEMUA PENGUJIAN PROTOKOL SIGNALING BERHASIL 100%!');
    process.exit(0);
  } else {
    console.error('\n❌ Beberapa pengujian gagal diverifikasi');
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('Pengujian error:', err);
  process.exit(1);
});

