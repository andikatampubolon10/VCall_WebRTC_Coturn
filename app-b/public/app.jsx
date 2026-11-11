const { useState, useEffect, useRef } = React;

function AppB() {
  const [config, setConfig] = useState(null);
  const [currentUser, setCurrentUser] = useState('User B');
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

  // 1. Inisialisasi dari Backend Aplikasi B (Port 3002)
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        configRef.current = data;
        connectGateway(data.gatewayUrl, currentUser);
        loadCallLogs();
      })
      .catch(err => console.error("[App B] Gagal load config:", err));

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

  // 2. Koneksi ke Shared WebRTC Gateway (Port 3000)
  const connectGateway = (url, userId) => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[App B] Terhubung ke Gateway:", url);
      setIsRegistered(true);
      ws.send(JSON.stringify({
        type: 'register',
        userId: userId,
        appName: 'APP_B'
      }));
    };

    ws.onmessage = async (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type !== 'pong') {
        console.log("[App B received]:", msg.type);
      }

      switch (msg.type) {
        case 'registered':
          setIsRegistered(true);
          break;

        case 'users':
          setUsers(msg.users || []);
          break;

        case 'incoming':
          // Panggilan masuk dari Aplikasi A (Dokter)
          callPeerRef.current = msg.from;
          setCallPeer(msg.from);
          setPeerApp(msg.fromApp || 'APP_A');
          setCallState('ringing');
          break;

        case 'accept':
          // Lawan menerima panggilan
          if (msg.from) callPeerRef.current = msg.from;
          setCallState('in-call');
          await startCallAsInitiator();
          break;

        case 'reject':
          alert(`Panggilan tidak dijawab atau ditolak: ${msg.reason || 'Sibuk'}`);
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
          alert('Panggilan selesai diakhiri.');
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
      console.warn("[App B] Koneksi Gateway terputus. Mencoba rekoneksi...");
      setIsRegistered(false);
      setTimeout(() => {
        if (configRef.current) {
          connectGateway(configRef.current.gatewayUrl, currentUser);
        }
      }, 2500);
    };

    ws.onerror = (err) => {
      console.error("[App B] Gateway WebSocket error:", err);
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

  // 3. WebRTC PeerConnection
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
      console.log("[App B] Remote track received:", event.track.kind);
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
        console.log(`[App B] Sending ICE candidate to ${target}:`, event.candidate.candidate);
        wsRef.current.send(JSON.stringify({
          type: 'candidate',
          to: target,
          candidate: event.candidate
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[App B ICE]:", pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        startTimer();
      }
    };

    return pc;
  };

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

  // Inisiasi Panggilan
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

  // Terima Panggilan
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
        callerSystem: 'APP_B',
        calleeSystem: peerApp || 'APP_A',
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
      const t = localStreamRef.current.getAudioTracks()[0];
      if (t) {
        t.enabled = !t.enabled;
        setIsMuted(!t.enabled);
      }
    }
  };

  const toggleCam = () => {
    if (localStreamRef.current) {
      const t = localStreamRef.current.getVideoTracks()[0];
      if (t) {
        t.enabled = !t.enabled;
        setIsCamOff(!t.enabled);
      }
    }
  };

  const formatTime = (secs) => {
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="mobile-wrapper">
      {/* Smartphone Notch */}
      <div className="phone-notch">
        <div className="notch-camera"></div>
      </div>

      {/* Top Header */}
      <div className="mobile-header">
        <div className="header-top">
          <div className="patient-badge">
            <div className="avatar-circle">{currentUser.charAt(5) || 'B'}</div>
            <div className="patient-title">
              <h2>Halo, {currentUser}!</h2>
              <span><span className="dot-pulse"></span> {isRegistered ? 'Terhubung ke Gateway' : 'Menghubungkan...'}</span>
            </div>
          </div>
        </div>

        <div className="system-info-pills">
          <span className="pill pill-sg">🇸🇬 Neon DB: Singapore (system_b_db)</span>
          <span className="pill pill-port">📱 Aplikasi B: Port 3002</span>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="mobile-body">
        {/* Konsultasi Dokter Card */}
        <div className="action-card">
          <h3>🩺 Dokter & Rekan Konsultasi</h3>
          <p>
            Daftar pengguna online dari <strong>Aplikasi A (Sistem Rumah Sakit)</strong> yang siap dihubungi:
          </p>

          <div>
            {users.filter(u => u.userId !== currentUser).map(u => (
              <div key={u.userId} className="doctor-item">
                <div className="doctor-avatar">{u.userId.charAt(0)}</div>
                <div className="doctor-details">
                  <div className="name">{u.userId}</div>
                  <div className="role">{u.appName === 'APP_A' ? '🏥 Dokter di Aplikasi A' : '📱 Pasien di Aplikasi B'}</div>
                </div>
                <button 
                  className="btn-start-call"
                  disabled={u.isBusy || callState !== 'idle'}
                  onClick={() => startCall(u.userId, u.appName)}
                >
                  {u.isBusy ? 'Sibuk' : '📹 Hubungi'}
                </button>
              </div>
            ))}

            {users.filter(u => u.userId !== currentUser).length === 0 && (
              <div style={{ textAlign: 'center', padding: '16px', color: '#94a3b8', fontSize: '12px' }}>
                Tidak ada pengguna lain yang online.<br/>
                Pastikan <strong>Aplikasi A (Port 3001)</strong> sedang dibuka di tab lain.
              </div>
            )}
          </div>
        </div>

        {/* Riwayat Konsultasi (Neon Singapore) */}
        <div className="history-card">
          <h4>
            Riwayat Konsultasi Pasien
            <span>DB Singapore (system_b_db)</span>
          </h4>

          <div>
            {callLogs.map(log => (
              <div key={log.id} className="history-item">
                <div>
                  <div className="history-caller">
                    {log.caller} ➔ {log.callee}
                  </div>
                  <div className="history-meta">
                    {log.caller_system} ke {log.callee_system} • {new Date(log.started_at).toLocaleTimeString()}
                  </div>
                </div>
                <div className="history-dur">
                  {log.duration_seconds}s
                </div>
              </div>
            ))}

            {callLogs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '12px', color: '#64748b', fontSize: '11px' }}>
                Belum ada riwayat konsultasi di database Sistem B.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Screen Panggilan Masuk (Incoming Modal) */}
      {callState === 'ringing' && (
        <div className="mobile-incoming-dialog">
          <div>
            <div style={{ fontSize: '13px', color: '#38bdf8', letterSpacing: '1px' }}>PANGGILAN KONSULTASI MASUK</div>
            <div className="caller-avatar-pulse">{callPeer ? callPeer.charAt(0) : 'A'}</div>
            <h2 style={{ fontSize: '22px', fontWeight: '700', marginBottom: '6px' }}>{callPeer}</h2>
            <p style={{ fontSize: '13px', color: '#94a3b8' }}>Memanggil dari {peerApp || 'Aplikasi A (Rumah Sakit)'}</p>
          </div>

          <div className="dialog-actions">
            <button 
              className="action-btn-circle btn-reject"
              onClick={() => {
                wsRef.current.send(JSON.stringify({ type: 'reject', to: callPeer }));
                resetCallState();
              }}
              title="Tolak"
            >
              ✕
            </button>
            <button 
              className="action-btn-circle btn-answer"
              onClick={acceptCall}
              title="Terima"
            >
              📞
            </button>
          </div>
        </div>
      )}

      {/* Screen Calling Dialing */}
      {callState === 'calling' && (
        <div className="mobile-incoming-dialog">
          <div>
            <div style={{ fontSize: '13px', color: '#10b981', letterSpacing: '1px' }}>MEMANGGIL...</div>
            <div className="caller-avatar-pulse" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}>
              {callPeer ? callPeer.charAt(0) : 'A'}
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: '700', marginBottom: '6px' }}>{callPeer}</h2>
            <p style={{ fontSize: '13px', color: '#94a3b8' }}>Menghubungkan ke {peerApp} via Gateway...</p>
          </div>

          <div className="dialog-actions">
            <button 
              className="action-btn-circle btn-reject"
              onClick={hangupCall}
              title="Batalkan"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Screen In-Call Fullscreen */}
      {callState === 'in-call' && (
        <div className="mobile-call-screen">
          <div className="remote-stream-box">
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
              id="patientRemoteVideo"
            ></video>

            {/* Header info */}
            <div className="call-header-overlay">
              <span className="call-title">Konsultasi dengan {callPeer}</span>
              <span className="call-timer">{formatTime(callDuration)}</span>
            </div>

            {/* PiP Local Video */}
            <div className="local-pip-box">
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
                id="patientLocalVideo"
              ></video>
            </div>
          </div>

          {/* Bottom Floating Call Controls */}
          <div className="mobile-call-controls">
            <button 
              className={`btn-circle ${isMuted ? 'active-off' : ''}`}
              onClick={toggleMic}
              title={isMuted ? "Unmute Mic" : "Mute Mic"}
            >
              {isMuted ? '🔇' : '🎙️'}
            </button>

            <button 
              className="btn-circle btn-hangup"
              onClick={hangupCall}
              title="Akhiri Panggilan"
            >
              📞
            </button>

            <button 
              className={`btn-circle ${isCamOff ? 'active-off' : ''}`}
              onClick={toggleCam}
              title={isCamOff ? "Nyalakan Kamera" : "Matikan Kamera"}
            >
              {isCamOff ? '🚫' : '📷'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AppB />);

