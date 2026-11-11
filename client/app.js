/**
 * WebRTC + Coturn Call Simulator Application
 * Mengimplementasikan alur lengkap WhatsApp-like Voice & Video Call,
 * RTCDataChannel chat, dan Observabilitas STUN/TURN Coturn.
 */

// ==========================================
// 1. STATE & VARIABEL GLOBAL
// ==========================================
let currentUserId = null;
let ws = null;
let peerConnection = null;
let dataChannel = null;
let localStream = null;
let remoteStream = null;

// State Panggilan: 'idle' | 'calling' | 'ringing' | 'connecting' | 'in-call' | 'ending'
let appState = 'idle';
let currentCallPeer = null;
let currentCallMode = 'video'; // 'voice' | 'video'
let isCallInitiator = false;
let mySystem = 'A'; // 'A' (Neon US-East) | 'B' (Neon Singapore)

// Queue untuk ICE Candidates sebelum remote description terpasang (FR-23)
let iceCandidateQueue = [];

// Timer durasi panggilan & timeout panggilan tak terjawab (FR-14)
let callTimerInterval = null;
let callDurationSeconds = 0;
let unansweredTimeout = null;
const CALL_TIMEOUT_MS = 30000; // 30 detik

// Polling interval untuk getStats() Coturn
let statsInterval = null;
let prevBytesReceived = 0;
let prevStatsTimestamp = 0;
let currentCallId = null;
let currentIcePath = 'HOST';
let lastRtt = 0;
let lastBitrate = 0;
let lastPacketsLost = 0;
let statsTickCounter = 0;

// Web Audio API untuk efek suara ringtone telepon mandiri (tanpa file eksternal)
let audioCtx = null;
let ringtoneOscillators = [];

// ==========================================
// 2. ELEMEN DOM
// ==========================================
const loginScreen = document.getElementById('loginScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const callScreen = document.getElementById('callScreen');

const usernameInput = document.getElementById('usernameInput');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');

const userBadge = document.getElementById('userBadge');
const currentUserNameEl = document.getElementById('currentUserName');
const logoutBtn = document.getElementById('logoutBtn');

const usersListContainer = document.getElementById('usersListContainer');
const emptyUsersNote = document.getElementById('emptyUsersNote');
const forceRelayCheckbox = document.getElementById('forceRelayCheckbox');

// Video & Audio
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteAudio = document.getElementById('remoteAudio');
const voiceAvatarView = document.getElementById('voiceAvatarView');
const localPreviewWrapper = document.getElementById('localPreviewWrapper');
const remoteAvatarInitial = document.getElementById('remoteAvatarInitial');
const remoteVoiceUserName = document.getElementById('remoteVoiceUserName');
const callPartnerName = document.getElementById('callPartnerName');
const callStatusBadge = document.getElementById('callStatusBadge');
const callTimer = document.getElementById('callTimer');

// Tombol Kontrol Panggilan
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleChatBtn = document.getElementById('toggleChatBtn');
const hangupBtn = document.getElementById('hangupBtn');
const chatUnreadDot = document.getElementById('chatUnreadDot');

// Chat Drawer
const chatDrawer = document.getElementById('chatDrawer');
const closeChatBtn = document.getElementById('closeChatBtn');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

// Modals
const incomingModal = document.getElementById('incomingModal');
const incomingCallerName = document.getElementById('incomingCallerName');
const incomingCallMode = document.getElementById('incomingCallMode');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');

const callingModal = document.getElementById('callingModal');
const outgoingTargetName = document.getElementById('outgoingTargetName');
const outgoingCallMode = document.getElementById('outgoingCallMode');
const cancelCallBtn = document.getElementById('cancelCallBtn');

// Debug Panel Elements
const debugPanel = document.getElementById('debugPanel');
const toggleDebugBtn = document.getElementById('toggleDebugBtn');
const hideDebugBtn = document.getElementById('hideDebugBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const debugLogConsole = document.getElementById('debugLogConsole');

const activeTypeBadge = document.getElementById('activeTypeBadge');
const activeTypeDesc = document.getElementById('activeTypeDesc');
const statIceState = document.getElementById('statIceState');
const statConnState = document.getElementById('statConnState');
const statRtt = document.getElementById('statRtt');
const statBitrate = document.getElementById('statBitrate');
const statPacketsLost = document.getElementById('statPacketsLost');
const statProtocol = document.getElementById('statProtocol');
const statLocalIp = document.getElementById('statLocalIp');
const statRemoteIp = document.getElementById('statRemoteIp');

// ==========================================
// 3. LOGGER & OBSERVABILITAS HELPER
// ==========================================
function logEvent(type, tag, message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  let tagClass = 'tag-sig';
  if (tag === 'ICE') tagClass = 'tag-ice';
  if (tag === 'HOST') tagClass = 'tag-host';
  if (tag === 'SRFLX') tagClass = 'tag-srflx';
  if (tag === 'RELAY') tagClass = 'tag-relay';
  if (tag === 'ERR') tagClass = 'tag-err';

  entry.innerHTML = `<span class="log-time">[${time}]</span><span class="log-tag ${tagClass}">${tag}</span> ${message}`;
  debugLogConsole.appendChild(entry);
  debugLogConsole.scrollTop = debugLogConsole.scrollHeight;
}

clearLogBtn.addEventListener('click', () => {
  debugLogConsole.innerHTML = '';
});

toggleDebugBtn.addEventListener('click', () => {
  debugPanel.classList.toggle('open');
});

hideDebugBtn.addEventListener('click', () => {
  debugPanel.classList.remove('open');
});

// Helper preset login cepat
window.selectPresetUser = function(name, sys = 'A') {
  usernameInput.value = name;
  mySystem = sys;
  const radio = document.getElementById(sys === 'B' ? 'sysRadioB' : 'sysRadioA');
  if (radio) radio.checked = true;
  usernameInput.focus();
};

window.onSystemChange = function(sys) {
  mySystem = sys;
};

// ==========================================
// 4. WEBAUDIO RINGTONE SYNTHESIZER
// ==========================================
function playRingtone(type = 'incoming') {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    stopRingtone();

    if (type === 'incoming') {
      // Nada dering telepon masuk (dua frekuensi harmonik bersahut-sahutan)
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.value = 440;
      osc2.frequency.value = 480;

      // Pulsing gain (berdering 1.5 detik, jeda 1.5 detik)
      const now = audioCtx.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      for (let i = 0; i < 10; i++) {
        const start = now + i * 3.0;
        gainNode.gain.setValueAtTime(0.2, start);
        gainNode.gain.setValueAtTime(0.2, start + 1.2);
        gainNode.gain.setValueAtTime(0, start + 1.25);
      }

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      osc1.start();
      osc2.start();
      ringtoneOscillators.push(osc1, osc2, gainNode);

    } else if (type === 'outgoing') {
      // Nada tunggu tut... tut...
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 425;

      const now = audioCtx.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      for (let i = 0; i < 15; i++) {
        const start = now + i * 2.5;
        gainNode.gain.setValueAtTime(0.15, start);
        gainNode.gain.setValueAtTime(0.15, start + 1.0);
        gainNode.gain.setValueAtTime(0, start + 1.05);
      }

      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      osc.start();
      ringtoneOscillators.push(osc, gainNode);
    }
  } catch (e) {
    console.warn("Gagal memainkan ringtone audio context:", e);
  }
}

function stopRingtone() {
  ringtoneOscillators.forEach(item => {
    try {
      if (item.stop) item.stop();
      if (item.disconnect) item.disconnect();
    } catch (e) {}
  });
  ringtoneOscillators = [];
}

// ==========================================
// 5. KONEKSI SIGNALING SERVER (WEBSOCKET)
// ==========================================
function connectSignalingServer(username) {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;

  logEvent('SIG', 'SIG', `Menghubungkan ke Signaling Server: ${wsUrl}`);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    logEvent('SIG', 'SIG', `Terhubung ke Gateway. Mendaftarkan user: "${username}" [Sistem ${mySystem}]`);
    sendSignalingMessage({
      type: 'register',
      userId: username,
      system: mySystem
    });
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error("Format pesan tidak valid:", event.data);
      return;
    }

    handleSignalingMessage(msg);
  };

  ws.onclose = () => {
    logEvent('ERR', 'SIG', 'Koneksi ke Signaling Server terputus.');
    if (appState !== 'idle') {
      handleCallEnded('Koneksi terputus dari server.');
    }
  };

  ws.onerror = (err) => {
    logEvent('ERR', 'SIG', `WebSocket error: ${err.message || 'Gagal tersambung'}`);
  };
}

function sendSignalingMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    logEvent('ERR', 'SIG', 'Tidak dapat mengirim pesan: WebSocket belum siap.');
  }
}

// ==========================================
// 6. DISPATCHER PESAN SIGNALING
// ==========================================
async function handleSignalingMessage(msg) {
  const { type, from, to, mode, sdp, candidate, reason, users, code, message } = msg;

  switch (type) {
    case 'registered':
      currentUserId = msg.userId;
      mySystem = msg.system || mySystem;
      currentUserNameEl.innerText = currentUserId;
      const sysBadge = document.getElementById('currentUserSystemBadge');
      if (sysBadge) {
        sysBadge.className = `badge ${mySystem === 'B' ? 'badge-sys-b' : 'badge-sys-a'}`;
        sysBadge.innerText = mySystem === 'B' ? 'Sistem B (Singapore)' : 'Sistem A (US-East)';
      }
      userBadge.style.display = 'flex';
      loginScreen.style.display = 'none';
      lobbyScreen.style.display = 'block';
      logEvent('SIG', 'SIG', `Registrasi terverifikasi: <strong>${currentUserId}</strong> [Sistem ${mySystem}]`);
      break;

    case 'users':
      renderOnlineUsers(users || []);
      break;

    case 'calling':
      if (msg.callId) currentCallId = msg.callId;
      break;

    case 'incoming':
      // FR-11: Notifikasi panggilan masuk
      if (appState !== 'idle') {
        // Otomatis tolak jika sedang dalam panggilan lain (FR-13)
        sendSignalingMessage({ type: 'reject', to: from, reason: 'Sedang sibuk' });
        return;
      }

      currentCallId = msg.callId || null;
      appState = 'ringing';
      currentCallPeer = from;
      currentCallMode = mode || 'video';
      isCallInitiator = false;

      incomingCallerName.innerHTML = `${from} <span class="${msg.fromSystem === 'B' ? 'tag-sys-b' : 'tag-sys-a'}">${msg.fromSystem === 'B' ? 'Sistem B' : 'Sistem A'}</span>`;
      incomingCallMode.innerText = currentCallMode === 'video' ? '📹 Panggilan Video Masuk (Antar-Sistem)...' : '📞 Panggilan Suara Masuk (Antar-Sistem)...';
      incomingModal.style.display = 'flex';
      playRingtone('incoming');
      logEvent('SIG', 'SIG', `Menerima panggilan masuk dari: <strong>${from}</strong> (${currentCallMode})`);
      break;

    case 'accept':
      // Penerima menerima panggilan yang kita lakukan
      if (msg.callId) currentCallId = msg.callId;
      if (appState === 'calling' && isCallInitiator) {
        logEvent('SIG', 'SIG', `Panggilan diterima oleh <strong>${from}</strong>! Memulai inisialisasi media...`);
        stopRingtone();
        clearTimeout(unansweredTimeout);
        callingModal.style.display = 'none';
        
        await initiateWebRTCConnection();
      }
      break;

    case 'reject':
      stopRingtone();
      clearTimeout(unansweredTimeout);
      callingModal.style.display = 'none';
      alert(`Panggilan ditolak: ${reason || 'Lawan bicara menolak panggilan'}`);
      logEvent('SIG', 'SIG', `Panggilan ditolak oleh <strong>${from}</strong> (${reason})`);
      resetToIdle();
      break;

    case 'offer':
      logEvent('SIG', 'SIG', `Menerima SDP Offer dari <strong>${from}</strong>`);
      await handleRemoteOffer(from, sdp);
      break;

    case 'answer':
      logEvent('SIG', 'SIG', `Menerima SDP Answer dari <strong>${from}</strong>`);
      await handleRemoteAnswer(sdp);
      break;

    case 'candidate':
      if (candidate) {
        handleReceivedCandidate(candidate);
      }
      break;

    case 'hangup':
      logEvent('SIG', 'SIG', `Panggilan diakhiri oleh lawan bicara: <strong>${from}</strong>`);
      handleCallEnded(reason || 'Panggilan telah diakhiri oleh lawan bicara.');
      break;

    case 'error':
      logEvent('ERR', 'ERR', `Error dari server: [${code}] ${message}`);
      if (appState === 'calling') {
        stopRingtone();
        clearTimeout(unansweredTimeout);
        callingModal.style.display = 'none';
        resetToIdle();
      }
      alert(`Perhatian: ${message}`);
      break;
  }
}

// ==========================================
// 7. RENDER DAFTAR USER ONLINE
// ==========================================
function renderOnlineUsers(users) {
  usersListContainer.innerHTML = '';
  const otherUsers = users.filter(u => u.userId !== currentUserId);

  if (otherUsers.length === 0) {
    emptyUsersNote.style.display = 'block';
    return;
  }

  emptyUsersNote.style.display = 'none';

  otherUsers.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item';

    const initial = u.userId.charAt(0).toUpperCase();
    const isBusy = u.isBusy;
    const userSys = u.system || 'A';
    const isInterSystem = userSys !== mySystem;

    item.innerHTML = `
      <div class="user-item-left">
        <div class="user-avatar-circle" style="${userSys === 'B' ? 'background:#3c1e5a; color:#bb86fc;' : ''}">${initial}</div>
        <div class="user-meta">
          <div class="user-title">
            ${u.userId}
            <span class="${userSys === 'B' ? 'tag-sys-b' : 'tag-sys-a'}">${userSys === 'B' ? 'Sistem B (Neon SG)' : 'Sistem A (Neon US)'}</span>
            ${isInterSystem ? '<span class="inter-call-badge">🌐 Antar-Sistem</span>' : ''}
          </div>
          <div class="user-status-text">${isBusy ? '🔴 Sedang dalam panggilan' : '🟢 Online dan siap'}</div>
        </div>
      </div>
      <div class="user-actions">
        <button class="btn-call-voice ${isBusy ? 'btn-call-disabled' : ''}" onclick="startCall('${u.userId}', 'voice')">
          📞 Suara
        </button>
        <button class="btn-call-video ${isBusy ? 'btn-call-disabled' : ''}" onclick="startCall('${u.userId}', 'video')">
          📹 Video
        </button>
      </div>
    `;

    usersListContainer.appendChild(item);
  });
}

// ==========================================
// 8. LOGIKA MEMULAI & MENERIMA PANGGILAN
// ==========================================
window.startCall = function(targetUser, mode) {
  if (appState !== 'idle') return;

  appState = 'calling';
  currentCallPeer = targetUser;
  currentCallMode = mode;
  isCallInitiator = true;

  outgoingTargetName.innerText = `Memanggil ${targetUser}...`;
  outgoingCallMode.innerText = mode === 'video' ? 'Panggilan Video...' : 'Panggilan Suara...';
  callingModal.style.display = 'flex';

  playRingtone('outgoing');
  logEvent('SIG', 'SIG', `Memanggil <strong>${targetUser}</strong> (${mode})`);

  sendSignalingMessage({
    type: 'call',
    to: targetUser,
    mode: mode
  });

  // FR-14: Timeout 30 detik bila tidak terjawab
  unansweredTimeout = setTimeout(() => {
    if (appState === 'calling') {
      logEvent('SIG', 'SIG', `Panggilan ke ${targetUser} timeout (tidak dijawab).`);
      stopRingtone();
      callingModal.style.display = 'none';
      sendSignalingMessage({ type: 'hangup', to: targetUser });
      alert('Panggilan tidak dijawab.');
      resetToIdle();
    }
  }, CALL_TIMEOUT_MS);
};

cancelCallBtn.addEventListener('click', () => {
  if (appState === 'calling' && currentCallPeer) {
    stopRingtone();
    clearTimeout(unansweredTimeout);
    callingModal.style.display = 'none';
    sendSignalingMessage({ type: 'hangup', to: currentCallPeer });
    logEvent('SIG', 'SIG', `Membatalkan panggilan ke ${currentCallPeer}`);
    resetToIdle();
  }
});

acceptCallBtn.addEventListener('click', async () => {
  stopRingtone();
  incomingModal.style.display = 'none';

  logEvent('SIG', 'SIG', `Menerima panggilan dari: <strong>${currentCallPeer}</strong>`);
  sendSignalingMessage({
    type: 'accept',
    to: currentCallPeer
  });

  appState = 'connecting';
  showCallScreen();
  await setupLocalMedia();
});

rejectCallBtn.addEventListener('click', () => {
  stopRingtone();
  incomingModal.style.display = 'none';

  logEvent('SIG', 'SIG', `Menolak panggilan dari: <strong>${currentCallPeer}</strong>`);
  sendSignalingMessage({
    type: 'reject',
    to: currentCallPeer,
    reason: 'Panggilan ditolak oleh pengguna'
  });
  resetToIdle();
});

// ==========================================
// 9. SETUP MEDIA LOKAL (KAMERA & MIC)
// ==========================================
async function setupLocalMedia() {
  const needVideo = currentCallMode === 'video';
  logEvent('SIG', 'MEDIA', `Mengakses perangkat media (Audio: true, Video: ${needVideo})`);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: needVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    });

    localVideo.srcObject = localStream;
    localPreviewWrapper.style.display = needVideo ? 'block' : 'none';

    // Sesuaikan tombol kontrol
    toggleCamBtn.style.display = needVideo ? 'flex' : 'none';
    toggleCamBtn.classList.remove('active-off');
    toggleMicBtn.classList.remove('active-off');

  } catch (err) {
    // FR-26: Tangani penolakan izin kamera/mikrofon dengan pesan jelas
    logEvent('ERR', 'ERR', `Akses media ditolak: ${err.name} - ${err.message}`);
    alert(`Gagal mengakses Kamera/Mikrofon: ${err.message}\nPastikan izin browser telah diberikan.`);
    hangupCall();
    throw err;
  }
}

// ==========================================
// 10. PEMBUATAN RTCPeerConnection (COTURN INTEGRATION)
// ==========================================
function createPeerConnection() {
  let coturnHost = document.getElementById('cfgCoturnHost').value.trim();
  if ((!coturnHost || coturnHost === 'localhost') && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    coturnHost = window.location.hostname;
  }
  coturnHost = coturnHost || 'localhost';
  const coturnPort = document.getElementById('cfgCoturnPort').value.trim() || '3478';
  const turnUser = document.getElementById('cfgTurnUser').value.trim() || 'simulasi';
  const turnPass = document.getElementById('cfgTurnPass').value.trim() || 'password123';
  const forceRelay = forceRelayCheckbox.checked;

  logEvent('ICE', 'ICE', `Inisialisasi RTCPeerConnection (Paksa Relay: <strong>${forceRelay ? 'YA' : 'TIDAK'}</strong>)`);

  // Kumpulan ICE Servers: STUN Google + Coturn Lokal + OpenRelay Public TURN (Bypass Firewall 4G)
  const configuration = {
    iceServers: [
      // 1. Google Public STUN
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302'
        ]
      },
      // 2. Coturn Lokal (Docker port 3478)
      {
        urls: `stun:${coturnHost}:${coturnPort}`
      },
      {
        urls: [
          `turn:${coturnHost}:${coturnPort}?transport=udp`,
          `turn:${coturnHost}:${coturnPort}?transport=tcp`
        ],
        username: turnUser,
        credential: turnPass
      }
    ],
    // FR-43: Mode Paksa Relay
    iceTransportPolicy: forceRelay ? 'relay' : 'all'
  };

  peerConnection = new RTCPeerConnection(configuration);
  iceCandidateQueue = [];

  // Pasang local audio & video track ke peer connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Terima remote track
  peerConnection.ontrack = (event) => {
    logEvent('SIG', 'MEDIA', `Menerima remote track: ${event.track.kind}`);
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
      remoteAudio.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);

    // Pastikan autoplay berjalan di browser mobile
    remoteVideo.play().catch(e => console.warn("Remote video play:", e));
    remoteAudio.play().catch(e => console.warn("Remote audio play:", e));

    if (currentCallMode === 'voice') {
      voiceAvatarView.style.display = 'flex';
      remoteVideo.style.display = 'none';
      remoteVoiceUserName.innerText = currentCallPeer;
      remoteAvatarInitial.innerText = currentCallPeer.charAt(0).toUpperCase();
    } else {
      voiceAvatarView.style.display = 'none';
      remoteVideo.style.display = 'block';
    }
  };

  // Pengumpulan ICE Candidate (Trickle ICE)
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate;
      const type = c.type.toUpperCase(); // 'HOST', 'SRFLX', 'RELAY'
      
      logEvent('ICE', type, `Ditemukan candidate: ${type} ${c.protocol.toUpperCase()} ${c.address || c.ip}:${c.port}`);

      // Kirim candidate ke peer via signaling
      sendSignalingMessage({
        type: 'candidate',
        to: currentCallPeer,
        candidate: c
      });
    } else {
      logEvent('ICE', 'ICE', 'Pengumpulan ICE Candidate selesai (End of Candidates).');
    }
  };

  // Status Perubahan Koneksi ICE (FR-41)
  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    statIceState.innerText = state;
    logEvent('ICE', 'ICE', `Status ICE berubah menjadi: <strong>${state}</strong>`);

    if (state === 'connected' || state === 'completed') {
      appState = 'in-call';
      callStatusBadge.className = 'badge badge-connected';
      callStatusBadge.innerText = 'Terhubung';
      startCallTimer();
      startStatsMonitor();
    } else if (state === 'failed') {
      callStatusBadge.className = 'badge badge-failed';
      callStatusBadge.innerText = 'Koneksi Gagal';
      alert('Koneksi WebRTC Gagal. Jika menggunakan Paksa Relay, pastikan Docker Coturn sudah aktif.');
    } else if (state === 'disconnected') {
      callStatusBadge.className = 'badge badge-connecting';
      callStatusBadge.innerText = 'Terputus...';
    }
  };

  peerConnection.onconnectionstatechange = () => {
    statConnState.innerText = peerConnection.connectionState;
  };

  // Callee mendengarkan pembuatan RTCDataChannel dari Caller
  peerConnection.ondatachannel = (event) => {
    logEvent('SIG', 'CHAT', 'DataChannel diterima dari penelepon.');
    dataChannel = event.channel;
    setupDataChannelEvents();
  };

  return peerConnection;
}

// ==========================================
// 11. ALUR PENELPON: OFFER & DATACHANNEL
// ==========================================
async function initiateWebRTCConnection() {
  appState = 'connecting';
  showCallScreen();

  await setupLocalMedia();
  createPeerConnection();

  // FR-30: Caller membuat RTCDataChannel untuk chat
  logEvent('SIG', 'CHAT', 'Membuat RTCDataChannel "chat"');
  dataChannel = peerConnection.createDataChannel('chat');
  setupDataChannelEvents();

  // Buat SDP Offer (FR-22)
  logEvent('SIG', 'SDP', 'Membuat SDP Offer...');
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  sendSignalingMessage({
    type: 'offer',
    to: currentCallPeer,
    sdp: offer
  });
}

// ==========================================
// 12. ALUR PENERIMA: SET REMOTE OFFER & CREATE ANSWER
// ==========================================
async function handleRemoteOffer(fromPeer, sdpOffer) {
  currentCallPeer = fromPeer;
  createPeerConnection();

  logEvent('SIG', 'SDP', 'Memasang Remote Description (SDP Offer)');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpOffer));

  // FR-23: Kuras antrian ICE candidate yang sempat tiba lebih awal
  await flushIceCandidateQueue();

  logEvent('SIG', 'SDP', 'Membuat SDP Answer...');
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  sendSignalingMessage({
    type: 'answer',
    to: currentCallPeer,
    sdp: answer
  });
}

async function handleRemoteAnswer(sdpAnswer) {
  logEvent('SIG', 'SDP', 'Memasang Remote Description (SDP Answer)');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpAnswer));

  // FR-23: Kuras antrian ICE candidate
  await flushIceCandidateQueue();
}

// ==========================================
// 13. PENANGANAN ICE CANDIDATE QUEUE (FR-23)
// ==========================================
async function handleReceivedCandidate(candidate) {
  if (peerConnection && peerConnection.remoteDescription) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      logEvent('ICE', 'ICE', `Candidate remote berhasil dipasang: ${candidate.candidate.substring(0, 35)}...`);
    } catch (err) {
      console.warn("Error memasang candidate:", err);
    }
  } else {
    // Simpan di antrian sampai remote description selesai dipasang
    iceCandidateQueue.push(candidate);
    logEvent('ICE', 'ICE', `Candidate remote diantrikan (Remote description belum siap)`);
  }
}

async function flushIceCandidateQueue() {
  if (iceCandidateQueue.length > 0) {
    logEvent('ICE', 'ICE', `Memproses ${iceCandidateQueue.length} antrian candidate yang tertunda...`);
    for (const cand of iceCandidateQueue) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        console.warn("Gagal menambahkan queued candidate:", e);
      }
    }
    iceCandidateQueue = [];
  }
}

// ==========================================
// 14. RTCDATACHANNEL CHAT (FR-30 & FR-31)
// ==========================================
function setupDataChannelEvents() {
  if (!dataChannel) return;

  dataChannel.onopen = () => {
    logEvent('SIG', 'CHAT', 'RTCDataChannel siap untuk bertukar pesan.');
    chatInput.disabled = false;
  };

  dataChannel.onclose = () => {
    logEvent('SIG', 'CHAT', 'RTCDataChannel ditutup.');
    chatInput.disabled = true;
  };

  dataChannel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      appendChatMessage(data.sender, data.text, false, data.time);
      
      // Tampilkan indikator dot merah bila chat drawer sedang tertutup
      if (!chatDrawer.classList.contains('open')) {
        chatUnreadDot.style.display = 'block';
      }
    } catch (err) {
      console.error("Gagal parse pesan chat DataChannel:", event.data);
    }
  };
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const payload = {
    sender: currentUserId,
    text: text,
    time: timeStr
  };

  dataChannel.send(JSON.stringify(payload));
  appendChatMessage(currentUserId, text, true, timeStr);
  chatInput.value = '';

  // Simpan pesan chat ke database PostgreSQL Neon
  sendSignalingMessage({
    type: 'chat_log',
    to: currentCallPeer,
    callId: currentCallId,
    message: text
  });
});

function appendChatMessage(sender, text, isMine, time) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isMine ? 'mine' : 'theirs'}`;
  bubble.innerHTML = `
    <div class="bubble-sender">${isMine ? 'Anda' : sender}</div>
    <div class="bubble-text">${escapeHtml(text)}</div>
    <div class="bubble-time">${time}</div>
  `;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

toggleChatBtn.addEventListener('click', () => {
  chatDrawer.classList.toggle('open');
  chatUnreadDot.style.display = 'none';
});

closeChatBtn.addEventListener('click', () => {
  chatDrawer.classList.remove('open');
});

// ==========================================
// 15. OBSERVABILITAS REAL-TIME & getStats() (FR-40, FR-44)
// ==========================================
function startStatsMonitor() {
  if (statsInterval) clearInterval(statsInterval);

  statsInterval = setInterval(async () => {
    if (!peerConnection) return;

    try {
      const stats = await peerConnection.getStats();
      let selectedPair = null;

      stats.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPair = stats.get(report.selectedCandidatePairId);
        }
      });

      if (!selectedPair) {
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
            selectedPair = report;
          }
        });
      }

      if (selectedPair) {
        const localCand = stats.get(selectedPair.localCandidateId);
        const remoteCand = stats.get(selectedPair.remoteCandidateId);

        if (localCand && remoteCand) {
          const type = (localCand.candidateType || '').toLowerCase(); // 'host', 'srflx', 'relay'
          const protocol = (localCand.protocol || 'udp').toUpperCase();

          statProtocol.innerText = protocol;
          statLocalIp.innerText = `${localCand.address || localCand.ip}:${localCand.port} (${type})`;
          statRemoteIp.innerText = `${remoteCand.address || remoteCand.ip}:${remoteCand.port} (${remoteCand.candidateType})`;

          // Update Tipe Jalur Coturn
          updateActiveCandidateBadge(type);
          currentIcePath = type.toUpperCase();

          // RTT (Round Trip Time)
          if (selectedPair.currentRoundTripTime !== undefined) {
            lastRtt = Math.round(selectedPair.currentRoundTripTime * 1000);
            statRtt.innerText = `${lastRtt} ms`;
          }
        }
      }

      // Hitung Bitrate dan Packet Loss dari Inbound RTP
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.kind === 'audio')) {
          if (report.packetsLost !== undefined) {
            lastPacketsLost = report.packetsLost;
            statPacketsLost.innerText = report.packetsLost;
          }

          if (report.bytesReceived !== undefined && prevBytesReceived > 0) {
            const timeDiff = (report.timestamp - prevStatsTimestamp) / 1000;
            if (timeDiff > 0) {
              const bitrate = ((report.bytesReceived - prevBytesReceived) * 8) / timeDiff / 1000;
              lastBitrate = Math.round(bitrate);
              statBitrate.innerText = `${lastBitrate} kbps`;
            }
          }
          prevBytesReceived = report.bytesReceived;
          prevStatsTimestamp = report.timestamp;
        }
      });

      // Simpan metrik secara periodik (setiap 5 detik) ke PostgreSQL Neon
      statsTickCounter++;
      if (statsTickCounter % 5 === 0 && currentCallPeer && appState === 'in-call') {
        sendSignalingMessage({
          type: 'stats',
          callId: currentCallId,
          candidateType: currentIcePath,
          localIp: statLocalIp.innerText,
          remoteIp: statRemoteIp.innerText,
          protocol: statProtocol.innerText,
          rtt: lastRtt,
          bitrate: lastBitrate,
          packetsLost: lastPacketsLost
        });
      }

    } catch (err) {
      console.warn("Gagal mengambil getStats():", err);
    }
  }, 1000);
}

function updateActiveCandidateBadge(type) {
  activeTypeBadge.className = `badge badge-${type}`;

  if (type === 'relay') {
    activeTypeBadge.innerText = 'RELAY (TURN COTURN)';
    activeTypeDesc.innerHTML = '🟢 <strong>BERHASIL:</strong> Panggilan dialirkan melewati server Coturn TURN! Bukti bahwa relay bekerja sempurna.';
  } else if (type === 'srflx') {
    activeTypeBadge.innerText = 'SRFLX (STUN COTURN)';
    activeTypeDesc.innerHTML = '🔵 <strong>STUN:</strong> Koneksi P2P langsung menggunakan IP publik hasil refleksi dari STUN Coturn.';
  } else if (type === 'host') {
    activeTypeBadge.innerText = 'HOST (LOKAL LAN/P2P)';
    activeTypeDesc.innerHTML = '⚪ <strong>Lokal:</strong> Menggunakan IP internal perangkat. Untuk memaksa melewati Coturn, aktifkan toggle <strong>Paksa Jalur TURN Relay</strong>.';
  } else {
    activeTypeBadge.innerText = type.toUpperCase();
  }
}

// ==========================================
// 16. KONTROL PANGGILAN & CLEANUP (FR-15, FR-25)
// ==========================================
toggleMicBtn.addEventListener('click', () => {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      toggleMicBtn.classList.toggle('active-off', !audioTrack.enabled);
      toggleMicBtn.querySelector('.label').innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
      logEvent('SIG', 'MEDIA', `Mikrofon: ${audioTrack.enabled ? 'ON' : 'MUTED'}`);
    }
  }
});

toggleCamBtn.addEventListener('click', () => {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      toggleCamBtn.classList.toggle('active-off', !videoTrack.enabled);
      toggleCamBtn.querySelector('.label').innerText = videoTrack.enabled ? 'Kamera' : 'Nyalakan';
      logEvent('SIG', 'MEDIA', `Kamera: ${videoTrack.enabled ? 'ON' : 'OFF'}`);
    }
  }
});

hangupBtn.addEventListener('click', () => {
  hangupCall();
});

function hangupCall() {
  if (currentCallPeer) {
    logEvent('SIG', 'SIG', `Mengirim sinyal hangup ke ${currentCallPeer}`);
    sendSignalingMessage({
      type: 'hangup',
      to: currentCallPeer,
      callId: currentCallId,
      duration: callDurationSeconds,
      icePath: currentIcePath,
      rtt: lastRtt,
      bitrate: lastBitrate,
      packetsLost: lastPacketsLost
    });
  }
  handleCallEnded('Anda telah mengakhiri panggilan.');
}

function handleCallEnded(msg) {
  stopRingtone();
  clearTimeout(unansweredTimeout);

  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  // Bersihkan DataChannel
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  // Tutup PeerConnection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Hentikan semua track media lokal (agar lampu webcam mati)
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  remoteStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;

  resetToIdle();
  if (msg) {
    logEvent('SIG', 'SIG', msg);
  }
}

function resetToIdle() {
  appState = 'idle';
  currentCallPeer = null;
  isCallInitiator = false;
  iceCandidateQueue = [];

  incomingModal.style.display = 'none';
  callingModal.style.display = 'none';
  callScreen.style.display = 'none';
  lobbyScreen.style.display = 'block';

  callDurationSeconds = 0;
  callTimer.innerText = '00:00';
  chatMessages.innerHTML = '<div class="chat-system-msg">Pesan chat dikirim peer-to-peer melalui WebRTC RTCDataChannel</div>';

  activeTypeBadge.className = 'badge badge-none';
  activeTypeBadge.innerText = '- Belum Terhubung -';
  activeTypeDesc.innerText = 'Lakukan panggilan untuk memverifikasi jalur yang dipilih oleh ICE.';
  statIceState.innerText = '-';
  statConnState.innerText = '-';
  statRtt.innerText = '- ms';
  statBitrate.innerText = '- kbps';
  statPacketsLost.innerText = '0';
  statProtocol.innerText = '-';
  statLocalIp.innerText = '-';
  statRemoteIp.innerText = '-';
}

function showCallScreen() {
  lobbyScreen.style.display = 'none';
  callScreen.style.display = 'flex';
  callPartnerName.innerHTML = `${currentCallPeer} <span class="badge ${mySystem === 'A' ? 'badge-sys-b' : 'badge-sys-a'}">${mySystem === 'A' ? 'Sistem B' : 'Sistem A'}</span>`;
  callStatusBadge.className = 'badge badge-connecting';
  callStatusBadge.innerText = 'Menghubungkan...';
}

function startCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callDurationSeconds = 0;
  callTimerInterval = setInterval(() => {
    callDurationSeconds++;
    const m = String(Math.floor(callDurationSeconds / 60)).padStart(2, '0');
    const s = String(callDurationSeconds % 60).padStart(2, '0');
    callTimer.innerText = `${m}:${s}`;
  }, 1000);
}

// Auto-sesuaikan host Coturn dengan hostname browser jika diakses lintas device via IP
const cfgCoturnHostEl = document.getElementById('cfgCoturnHost');
if (cfgCoturnHostEl && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  cfgCoturnHostEl.value = window.location.hostname;
}

// ==========================================
// 17. EVENT LISTENER FORM LOGIN
// ==========================================
loginBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  if (!username) {
    loginError.style.display = 'block';
    loginError.innerText = 'Silakan masukkan nama pengguna terlebih dahulu!';
    return;
  }
  loginError.style.display = 'none';
  connectSignalingServer(username);
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    loginBtn.click();
  }
});

logoutBtn.addEventListener('click', () => {
  if (ws) ws.close();
  userBadge.style.display = 'none';
  lobbyScreen.style.display = 'none';
  callScreen.style.display = 'none';
  loginScreen.style.display = 'block';
  usernameInput.value = '';
  logEvent('SIG', 'SIG', 'User telah keluar (logout).');
});

// ==========================================
// 18. RIWAYAT PANGGILAN DATABASE (NEON POSTGRESQL)
// ==========================================
let cachedCallLogs = [];
const historyModal = document.getElementById('historyModal');
const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
const closeHistoryBtn = document.getElementById('closeHistoryBtn');
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
const downloadCsvBtn = document.getElementById('downloadCsvBtn');
const historyTableContainer = document.getElementById('historyTableContainer');

if (toggleHistoryBtn) {
  toggleHistoryBtn.addEventListener('click', () => {
    historyModal.style.display = 'flex';
    fetchCallHistory();
  });
}

if (closeHistoryBtn) {
  closeHistoryBtn.addEventListener('click', () => {
    historyModal.style.display = 'none';
  });
}

if (refreshHistoryBtn) {
  refreshHistoryBtn.addEventListener('click', () => {
    fetchCallHistory();
  });
}

if (downloadCsvBtn) {
  downloadCsvBtn.addEventListener('click', () => {
    if (!cachedCallLogs || cachedCallLogs.length === 0) {
      alert('Tidak ada data riwayat untuk diunduh.');
      return;
    }

    const headers = ['ID', 'Waktu_Mulai', 'Caller', 'Callee', 'Mode', 'Status', 'Durasi_Detik', 'Jalur_ICE', 'RTT_ms', 'Packet_Loss', 'Bitrate_kbps'];
    const rows = cachedCallLogs.map(item => [
      item.id,
      `"${item.started_at || ''}"`,
      `"${item.caller || ''}"`,
      `"${item.callee || ''}"`,
      `"${item.call_type || ''}"`,
      `"${item.status || ''}"`,
      item.duration_seconds || 0,
      `"${item.ice_path || 'HOST'}"`,
      item.rtt_ms || 0,
      item.packets_lost || 0,
      item.bitrate_kbps || 0
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `riwayat_webrtc_coturn_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function fetchCallHistory() {
  historyTableContainer.innerHTML = '<p style="color: #8696a0; text-align: center; padding: 20px;">Memuat data dari Neon PostgreSQL...</p>';
  try {
    const res = await fetch('/api/call-logs');
    const json = await res.json();
    cachedCallLogs = json.data || [];
    if (!json.success || !json.data || json.data.length === 0) {
      historyTableContainer.innerHTML = '<p style="color: #8696a0; text-align: center; padding: 24px;">Belum ada riwayat panggilan tersimpan di database.</p>';
      return;
    }

    let html = `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #e9edef;">
        <thead>
          <tr style="border-bottom: 2px solid #2a3942; color: #8696a0; text-align: left;">
            <th style="padding: 8px;">Waktu</th>
            <th style="padding: 8px;">Panggilan</th>
            <th style="padding: 8px;">Mode</th>
            <th style="padding: 8px;">Status</th>
            <th style="padding: 8px;">Durasi</th>
            <th style="padding: 8px;">Jalur ICE Coturn</th>
            <th style="padding: 8px;">Metrik (RTT/Loss)</th>
          </tr>
        </thead>
        <tbody>
    `;

    json.data.forEach(item => {
      const time = new Date(item.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const date = new Date(item.started_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const iceColor = (item.ice_path && item.ice_path.includes('RELAY')) ? '#25d366' : ((item.ice_path && item.ice_path.includes('SRFLX')) ? '#34b7f1' : '#8696a0');
      const statusColor = item.status === 'completed' ? '#25d366' : (item.status === 'rejected' ? '#f15c6d' : '#e9edef');

      html += `
        <tr style="border-bottom: 1px solid #202c33;">
          <td style="padding: 8px;"><span style="color: #8696a0;">${date}</span> ${time}</td>
          <td style="padding: 8px;"><strong>${item.caller}</strong> → ${item.callee}</td>
          <td style="padding: 8px;">${item.call_type === 'video' ? '📹 Video' : '📞 Voice'}</td>
          <td style="padding: 8px; color: ${statusColor}; font-weight: 600;">${item.status}</td>
          <td style="padding: 8px;">${item.duration_seconds || 0}s</td>
          <td style="padding: 8px;"><span style="color: ${iceColor}; font-weight: 600;">${item.ice_path || 'HOST'}</span></td>
          <td style="padding: 8px; color: #8696a0;">${item.rtt_ms ? item.rtt_ms + ' ms' : '-'} / ${item.packets_lost || 0} loss</td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    historyTableContainer.innerHTML = html;
  } catch (err) {
    historyTableContainer.innerHTML = `<p style="color: #f15c6d; text-align: center; padding: 20px;">Gagal memuat riwayat: ${err.message}</p>`;
  }
}

