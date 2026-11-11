const { useState, useEffect, useRef } = React;

function AppA() {
  const [config, setConfig] = useState(null);
  const [currentUser, setCurrentUser] = useState('User A');
  const [isRegistered, setIsRegistered] = useState(false);
  const [users, setUsers] = useState([]);
  const [callState, setCallState] = useState('idle'); // 'idle' | 'calling' | 'ringing' | 'in-call'
  const [callPeer, setCallPeer] = useState(null);
  const [peerApp, setPeerApp] = useState(null);
  const [callDuration, setCallDuration] = useState(0);
  const [callLogs, setCallLogs] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);

  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const timerRef = useRef(null);
  const candidateQueueRef = useRef([]);
  const configRef = useRef(null);
  const callPeerRef = useRef(null);
  const remoteStreamRef = useRef(null);

  // Load config dari Backend Aplikasi A (Port 3001)
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        configRef.current = data;
        connectGateway(data.gatewayUrl, currentUser);
        loadCallLogs();
      })
      .catch(err => console.error("Gagal load config:", err));

    return () => {
      if (wsRef.current) wsRef.current.close();
      cleanupMedia();
    };
  }, []);

  const loadCallLogs = () => {
    fetch('/api/call-logs')
      .then(res => res.json())
      .then(res => { if (res.success) setCallLogs(res.data); })
      .catch(() => {});
  };

  // Koneksi ke Shared WebRTC Gateway (Port 3000)
  const connectGateway = (url, userId) => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[App A] Terhubung ke Shared Gateway:", url);
      setIsRegistered(true);
      ws.send(JSON.stringify({
        type: 'register',
        userId: userId,
        appName: 'APP_A'
      }));
    };

    ws.onmessage = async (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type !== 'pong') {
        console.log("[App A received]:", msg.type);
      }

      switch (msg.type) {
        case 'registered':
          setIsRegistered(true);
          break;

        case 'users':
          setUsers(msg.users || []);
          break;

        case 'incoming':
          // Menerima panggilan dari Aplikasi B
          callPeerRef.current = msg.from;
          setCallPeer(msg.from);
          setPeerApp(msg.fromApp || 'APP_B');
          setCallState('ringing');
          break;

        case 'accept':
          // Panggilan diterima oleh pihak lawan
          if (msg.from) callPeerRef.current = msg.from;
          setCallState('in-call');
          await startCallAsInitiator();
          break;

        case 'reject':
          alert(`Panggilan ditolak: ${msg.reason || 'User sibuk'}`);
          resetCallState();
          break;

        case 'offer':
          await handleOffer(msg.from, msg.sdp);
          break;

        case 'answer':
          await handleAnswer(msg.sdp);
          break;

        case 'candidate':
          handleCandidate(msg.candidate);
          break;

        case 'hangup':
          alert('Panggilan diakhiri oleh lawan bicara.');
          saveCallLog('completed', callDuration);
          resetCallState();
          break;

        case 'error':
          alert(`Gateway Error: ${msg.message}`);
          resetCallState();
          break;
      }
    };

    ws.onclose = () => {
      console.warn("[App A] Koneksi Gateway terputus. Mencoba rekoneksi...");
      setIsRegistered(false);
      setTimeout(() => {
        if (configRef.current) {
          connectGateway(configRef.current.gatewayUrl, currentUser);
        }
      }, 2500);
    };

    ws.onerror = (err) => {
      console.error("[App A] Gateway WebSocket error:", err);
    };
  };

  // Heartbeat Ping
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 8000);
    return () => clearInterval(pingInterval);
  }, []);

  // WebRTC Setup
  const createPeerConnection = (targetUser) => {
    const turnHost = configRef.current?.turnHost || window.location.hostname || 'localhost';
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: `stun:${turnHost}:3478` },
        {
          urls: [
            `turn:${turnHost}:3478?transport=udp`,
            `turn:${turnHost}:3478?transport=tcp`
          ],
          username: 'simulasi',
          credential: 'password123'
        }
      ]
    });

    pcRef.current = pc;
    candidateQueueRef.current = [];

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.ontrack = (event) => {
      console.log("[App A] Remote track received:", event.track.kind);
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
      }
      remoteStreamRef.current.addTrack(event.track);

      if (remoteVideoRef.current) {
        if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
          remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }
        remoteVideoRef.current.play().catch(e => console.warn("Video play error:", e));
      }
    };

    pc.onicecandidate = (event) => {
      const target = targetUser || callPeerRef.current || callPeer;
      if (event.candidate && wsRef.current && target) {
        console.log(`[App A] Sending ICE candidate to ${target}:`, event.candidate.candidate);
        wsRef.current.send(JSON.stringify({
          type: 'candidate',
          to: target,
          candidate: event.candidate
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[App A ICE State]:", pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        startTimer();
      }
    };

    return pc;
  };

  // Setup Kamera Lokal
  const setupMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 640 }, height: { ideal: 480 } }, 
        audio: true 
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(() => {});
      }
      return stream;
    } catch (err) {
      alert("Gagal mengakses kamera/mikrofon: " + err.message);
      throw err;
    }
  };

  // 1. Inisiasi Panggilan ke User B di Aplikasi B
  const startCall = (targetUser, targetApp) => {
    callPeerRef.current = targetUser;
    setCallPeer(targetUser);
    setPeerApp(targetApp);
    setCallState('calling');

    wsRef.current.send(JSON.stringify({
      type: 'call',
      to: targetUser,
      mode: 'video'
    }));
  };

  const startCallAsInitiator = async () => {
    await setupMedia();
    const pc = createPeerConnection(callPeerRef.current);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    wsRef.current.send(JSON.stringify({
      type: 'offer',
      to: callPeerRef.current,
      sdp: offer
    }));
  };

  // 2. Terima Panggilan Masuk dari Aplikasi B
  const acceptCall = async () => {
    setCallState('in-call');
    await setupMedia();

    wsRef.current.send(JSON.stringify({
      type: 'accept',
      to: callPeerRef.current
    }));
  };

  const handleOffer = async (fromPeer, sdpOffer) => {
    callPeerRef.current = fromPeer;
    setCallPeer(fromPeer);
    setCallState('in-call');
    await setupMedia();

    const pc = createPeerConnection(fromPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

    // Flush queued candidates
    for (const c of candidateQueueRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    candidateQueueRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    wsRef.current.send(JSON.stringify({
      type: 'answer',
      to: fromPeer,
      sdp: answer
    }));
  };

  const handleAnswer = async (sdpAnswer) => {
    if (pcRef.current) {
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
      for (const c of candidateQueueRef.current) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
      }
      candidateQueueRef.current = [];
    }
  };

  const handleCandidate = async (candidate) => {
    if (pcRef.current && pcRef.current.remoteDescription) {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      candidateQueueRef.current.push(candidate);
    }
  };

  // Akhiri Panggilan
  const hangupCall = () => {
    if (wsRef.current && callPeer) {
      wsRef.current.send(JSON.stringify({
        type: 'hangup',
        to: callPeer
      }));
    }
    saveCallLog('completed', callDuration);
    resetCallState();
  };

  const saveCallLog = (status, duration) => {
    if (!callPeer) return;
    fetch('/api/call-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caller: currentUser,
        callee: callPeer,
        callerSystem: 'APP_A',
        calleeSystem: peerApp || 'APP_B',
        callType: 'video',
        status: status,
        durationSeconds: duration,
        icePath: 'COTURN / P2P'
      })
    }).then(() => loadCallLogs()).catch(() => {});
  };

  const resetCallState = () => {
    setCallState('idle');
    setCallPeer(null);
    setPeerApp(null);
    setCallDuration(0);
    if (timerRef.current) clearInterval(timerRef.current);
    cleanupMedia();
  };

  const cleanupMedia = () => {
    callPeerRef.current = null;
    remoteStreamRef.current = null;
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
  };

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCallDuration(0);
    timerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleCam = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCamOff(!videoTrack.enabled);
      }
    }
  };

  const formatTime = (secs) => {
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="app-container">
      {/* Navbar Pro Dashboard */}
      <header className="navbar">
        <div className="brand">
          <div className="brand-logo">🏥</div>
          <div>
            <h1>MEDI-CONNECT PORTAL</h1>
            <span>Aplikasi A (Sistem Rumah Sakit / Dokter)</span>
          </div>
        </div>

        <div className="nav-badges">
          <span className="badge badge-db">🗄️ Database: Neon US-East</span>
          <span className="badge badge-app">🚀 Port: 3001</span>
          <span className="badge badge-online">🟢 {currentUser}</span>
        </div>
      </header>

      {/* Main Layout */}
      <div className="main-layout">
        {/* Sidebar Kontak */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Daftar Pengguna Online ({users.length})</h2>
          </div>

          <div className="contact-list">
            {users.filter(u => u.userId !== currentUser).map(u => (
              <div key={u.userId} className="contact-card">
                <div className="contact-info">
                  <div className="contact-avatar">{u.userId.charAt(0)}</div>
                  <div className="contact-meta">
                    <div className="name">{u.userId}</div>
                    <span className={`system-tag ${u.appName === 'APP_B' ? 'tag-app-b' : 'tag-app-a'}`}>
                      {u.appName === 'APP_B' ? '📱 Pasien di Aplikasi B' : '🏥 Dokter di Aplikasi A'}
                    </span>
                  </div>
                </div>

                <button 
                  className="btn-call"
                  disabled={u.isBusy || callState !== 'idle'}
                  onClick={() => startCall(u.userId, u.appName)}
                >
                  {u.isBusy ? 'Sibuk' : '📹 Panggil'}
                </button>
              </div>
            ))}

            {users.filter(u => u.userId !== currentUser).length === 0 && (
              <p style={{ padding: '20px', color: '#8ea3b7', fontSize: '13px', textAlign: 'center' }}>
                Belum ada pengguna lain. Buka <strong>Aplikasi B (Port 3002)</strong> untuk mulai panggilan antar-aplikasi!
              </p>
            )}
          </div>
        </aside>

        {/* Workspace Utama */}
        <main className="workspace">
          {callState === 'idle' && (
            <div>
              <div className="welcome-card">
                <h2>Selamat Datang di Portal Aplikasi A</h2>
                <p>
                  Aplikasi ini berjalan mandiri di <strong>Port 3001</strong> dengan database khusus <strong>Neon US-East</strong>.
                  Anda dapat memanggil pengguna di <strong>Aplikasi B (Port 3002)</strong> melalui Shared WebRTC Gateway.
                </p>
              </div>

              {/* Tabel Riwayat Khusus Aplikasi A */}
              <div className="history-section">
                <h3>📜 Audit Log Panggilan (Tersimpan di Database Neon US-East)</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Penelepon</th>
                      <th>Penerima</th>
                      <th>Asal Sistem</th>
                      <th>Durasi</th>
                      <th>Status</th>
                      <th>Waktu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {callLogs.map(log => (
                      <tr key={log.id}>
                        <td><strong>{log.caller}</strong></td>
                        <td>{log.callee}</td>
                        <td><span className="badge badge-db">{log.caller_system} ➔ {log.callee_system}</span></td>
                        <td>{log.duration_seconds} detik</td>
                        <td><span style={{ color: '#2ec4b6' }}>{log.status}</span></td>
                        <td>{new Date(log.started_at).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                    {callLogs.length === 0 && (
                      <tr><td colSpan="6" style={{ textAlign: 'center', color: '#8ea3b7' }}>Belum ada log panggilan di database Sistem A.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Layar Panggilan Aktif */}
          {callState === 'in-call' && (
            <div className="call-stage">
              <div className="call-overlay-info">
                <div>
                  <strong>{currentUser} (Aplikasi A)</strong> ➔ <span>{callPeer} ({peerApp})</span>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '16px', color: '#48cae4' }}>
                  ⏱️ {formatTime(callDuration)}
                </div>
              </div>

              <div className="remote-video-container">
                <video 
                  ref={(el) => {
                    remoteVideoRef.current = el;
                    if (el && remoteStreamRef.current && el.srcObject !== remoteStreamRef.current) {
                      el.srcObject = remoteStreamRef.current;
                      el.play().catch(() => {});
                    }
                  }} 
                  autoPlay 
                  playsInline 
                  id="remoteVideo"
                ></video>
                <div className="local-pip">
                  <video 
                    ref={(el) => {
                      localVideoRef.current = el;
                      if (el && localStreamRef.current && el.srcObject !== localStreamRef.current) {
                        el.srcObject = localStreamRef.current;
                        el.play().catch(() => {});
                      }
                    }} 
                    autoPlay 
                    playsInline 
                    muted 
                    id="localVideo"
                  ></video>
                </div>
              </div>

              <div className="call-controls">
                <button className={`control-btn ${isMuted ? 'btn-danger' : ''}`} onClick={toggleMic}>
                  {isMuted ? 'Unmute Mic' : 'Mute Mic'}
                </button>
                <button className={`control-btn ${isCamOff ? 'btn-danger' : ''}`} onClick={toggleCam}>
                  {isCamOff ? 'Nyalakan Kamera' : 'Matikan Kamera'}
                </button>
                <button className="control-btn btn-danger" onClick={hangupCall}>
                  📞 Akhiri Panggilan
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Modal Calling */}
      {callState === 'calling' && (
        <div className="modal-overlay">
          <div className="modal-box">
            <h3>Memanggil {callPeer}...</h3>
            <p>Menghubungkan ke {peerApp} melalui Shared WebRTC Gateway...</p>
            <button className="btn-danger-action" onClick={hangupCall}>Batalkan Panggilan</button>
          </div>
        </div>
      )}

      {/* Modal Incoming Call */}
      {callState === 'ringing' && (
        <div className="modal-overlay">
          <div className="modal-box">
            <h3>Panggilan Masuk!</h3>
            <p><strong>{callPeer}</strong> dari <strong>{peerApp}</strong> memanggil Anda...</p>
            <div className="modal-actions">
              <button className="btn-danger-action" onClick={() => {
                wsRef.current.send(JSON.stringify({ type: 'reject', to: callPeer }));
                resetCallState();
              }}>Tolak</button>
              <button className="btn-success" onClick={acceptCall}>Terima Panggilan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AppA />);

