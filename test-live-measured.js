const WebSocket = require('./gateway/node_modules/ws');
const http = require('http');
const dgram = require('dgram');

const SERVER_IP = '34.50.75.236';

function httpGetJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: e.message }); }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
}

function runRealPair(i) {
  return new Promise((resolve) => {
    const docId = `Dr_Live_${i}_${Date.now()}`;
    const patId = `Pt_Live_${i}_${Date.now()}`;
    const t0 = Date.now();

    const wsA = new WebSocket(`ws://${SERVER_IP}:3000`);
    const wsB = new WebSocket(`ws://${SERVER_IP}:3000`);

    let docReg = false;
    let patReg = false;
    let turnAlloc = null;
    let handshakeMs = 0;
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { wsA.close(); wsB.close(); } catch(e){}
      resolve({ pair: i, success: false, reason: 'Timeout 5s' });
    }, 6000);

    const tryCall = () => {
      if (docReg && patReg) {
        wsA.send(JSON.stringify({ type: 'call', to: patId, mode: 'video' }));
      }
    };

    wsA.on('open', () => {
      wsA.send(JSON.stringify({ type: 'register', userId: docId, appName: 'APP_A' }));
    });

    wsB.on('open', () => {
      wsB.send(JSON.stringify({ type: 'register', userId: patId, appName: 'APP_B' }));
    });

    wsA.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') {
          docReg = true;
          tryCall();
        } else if (msg.type === 'accept') {
          // Panggilan diterima -> Minta alokasi port CoTURN ke server
          const allocStart = Date.now();
          turnAlloc = await httpGetJson(`http://${SERVER_IP}:3000/api/benchmark/allocate?host=127.0.0.1&port=3478`);
          const coturnRtt = Date.now() - allocStart;
          handshakeMs = Date.now() - t0;

          // Kirim Offer
          wsA.send(JSON.stringify({ type: 'offer', to: patId, sdp: { type: 'offer', sdp: 'v=0...' } }));

          // Kirim hangup dan release port
          if (turnAlloc && turnAlloc.allocId) {
            await httpGetJson(`http://${SERVER_IP}:3000/api/benchmark/deallocate?id=${turnAlloc.allocId}`);
          }
          wsA.send(JSON.stringify({ type: 'hangup', to: patId }));

          finished = true;
          clearTimeout(timer);
          try { wsA.close(); wsB.close(); } catch(e){}

          resolve({
            pair: i,
            success: turnAlloc && turnAlloc.success,
            relayPort: turnAlloc ? turnAlloc.relayPort : null,
            handshakeMs,
            coturnRtt
          });
        }
      } catch (e) {}
    });

    wsB.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') {
          patReg = true;
          tryCall();
        } else if (msg.type === 'incoming') {
          wsB.send(JSON.stringify({ type: 'accept', to: docId }));
        } else if (msg.type === 'offer') {
          wsB.send(JSON.stringify({ type: 'answer', to: docId, sdp: { type: 'answer', sdp: 'v=0...' } }));
        }
      } catch (e) {}
    });

    wsA.on('error', (e) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ pair: i, success: false, reason: e.message });
      }
    });

    wsB.on('error', (e) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ pair: i, success: false, reason: e.message });
      }
    });
  });
}

async function main() {
  console.log('Menjalankan 10 pasang panggilan nyata (20 Virtual Users) ke 34.50.75.236...');
  const promises = [];
  for (let i = 1; i <= 10; i++) {
    promises.push(runRealPair(i));
    await new Promise(r => setTimeout(r, 40));
  }
  const results = await Promise.all(promises);
  console.log('Hasil Pengujian Nyata:');
  console.log(JSON.stringify(results, null, 2));
}

main();

