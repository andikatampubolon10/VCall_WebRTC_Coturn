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

  // Observabilitas & Telemetri Real-Time Mobile
  const [logs, setLogs] = useState([]);
  const [isObsCollapsed, setIsObsCollapsed] = useState(false);
  const [showCallObs, setShowCallObs] = useState(true);
  const [stats, setStats] = useState({
    activePath: 'IDLE',
    protocol: '-',
    localCandidate: '-',
    remoteCandidate: '-',
    rtt: 0,
    bitrate: 0,
    packetsLost: 0,
    iceConnectionState: 'idle',
    connectionState: 'idle'
  });

  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const timerRef = useRef(null);
  const statsIntervalRef = useRef(null);
  const candidateQueueRef = useRef([]);
  const configRef = useRef(null);
  const callPeerRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const logEndRef = useRef(null);

  const addLog = (tag, message, type = 'info') => {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    console.log(`[App B][${tag}] ${message}`);
    setLogs(prev => [
      ...prev.slice(-60),
      { id: Date.now() + Math.random(), time: timeStr, tag, message, type }
    ]);
  };

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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

  // Polling getStats() untuk Observabilitas STUN/TURN Real-Time di Ponsel
  const startStatsPolling = (pc) => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    let prevBytes = 0;
    let prevTimestamp = 0;

    statsIntervalRef.current = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed') return;
      try {
        const reports = await pc.getStats();
        let selectedPair = null;

        reports.forEach(report => {
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = reports.get(report.selectedCandidatePairId);
          }
        });

        if (!selectedPair) {
          reports.forEach(report => {
            if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
              selectedPair = report;
            }
          });
        }

        let activePath = 'IDLE';
        let rtt = 0;
        let protocol = '-';
        let localStr = '-';
        let remoteStr = '-';

        if (selectedPair) {
          const localCand = reports.get(selectedPair.localCandidateId);
          const remoteCand = reports.get(selectedPair.remoteCandidateId);

          if (localCand && remoteCand) {
            const lType = (localCand.candidateType || '').toLowerCase();
            const rType = (remoteCand.candidateType || '').toLowerCase();
            protocol = (localCand.protocol || 'udp').toUpperCase();

            if (lType === 'relay' || rType === 'relay') {
              activePath = 'RELAY';
            } else if (lType === 'srflx' || rType === 'srflx') {
              activePath = 'SRFLX';
            } else {
              activePath = 'HOST';
            }

            localStr = `${localCand.address || localCand.ip}:${localCand.port} (${lType.toUpperCase()})`;
            remoteStr = `${remoteCand.address || remoteCand.ip}:${remoteCand.port} (${rType.toUpperCase()})`;

            if (selectedPair.currentRoundTripTime !== undefined) {
              rtt = Math.round(selectedPair.currentRoundTripTime * 1000);
            }
          }
        }

        let bitrate = 0;
        let packetsLost = 0;

        reports.forEach(report => {
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.kind === 'audio')) {
            if (report.packetsLost !== undefined) {
              packetsLost = report.packetsLost;
            }
            if (report.bytesReceived !== undefined && prevBytes > 0) {
              const dt = (report.timestamp - prevTimestamp) / 1000;
              if (dt > 0) {
                bitrate = Math.round(((report.bytesReceived - prevBytes) * 8) / dt / 1000);
              }
            }
            prevBytes = report.bytesReceived;
            prevTimestamp = report.timestamp;
          }
        });

        setStats(prev => ({
          ...prev,
          activePath: activePath !== 'IDLE' ? activePath : prev.activePath,
          protocol: protocol !== '-' ? protocol : prev.protocol,
          localCandidate: localStr !== '-' ? localStr : prev.localCandidate,
          remoteCandidate: remoteStr !== '-' ? remoteStr : prev.remoteCandidate,
          rtt: rtt > 0 ? rtt : prev.rtt,
          bitrate: bitrate > 0 ? bitrate : prev.bitrate,
          packetsLost,
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState
        }));

      } catch (err) {
        console.warn("getStats error:", err);
      }
    }, 1000);
  };

  // 3. WebRTC PeerConnection
  const createPeerConnection = (targetUser) => {
    addLog('WEBRTC', `Membuat RTCPeerConnection untuk target: ${targetUser}`, 'webrtc');
    const iceServers = configRef.current?.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turn:standard.relay.metered.ca:80',
        username: '18a1aa3f68d754653458bc9d',
        credential: '/mGt8FrweJKNDdnP'
      },
      {
        urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
        username: '18a1aa3f68d754653458bc9d',
        credential: '/mGt8FrweJKNDdnP'
      },
      {
        urls: 'turn:standard.relay.metered.ca:443',
        username: '18a1aa3f68d754653458bc9d',
        credential: '/mGt8FrweJKNDdnP'
      },
      {
        urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
        username: '18a1aa3f68d754653458bc9d',
        credential: '/mGt8FrweJKNDdnP'
      }
    ];

    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    candidateQueueRef.current = [];

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
      addLog('MEDIA', 'Kamera & Audio lokal siap ditransmisikan.', 'media');
    }

    pc.ontrack = (event) => {
      addLog('MEDIA', `Menerima stream dokter remote (${event.track.kind})`, 'media');
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
        const cStr = event.candidate.candidate;
        if (cStr.includes('typ relay')) {
          addLog('TURN', `⚡ KANDIDAT TURN RELAY TERBENTUK: standard.relay.metered.ca (Port Relay OK)`, 'turn');
        } else if (cStr.includes('typ srflx')) {
          addLog('STUN', `🌐 KANDIDAT STUN PUBLIK TERBENTUK: IP Publik terdeteksi (${event.candidate.address || 'Public'})`, 'stun');
        } else if (cStr.includes('typ host')) {
          addLog('HOST', `🏠 Kandidat Host IP Lokal Ponsel (${event.candidate.address})`, 'ice');
        }

        wsRef.current.send(JSON.stringify({
          type: 'candidate',
          to: target,
          candidate: event.candidate
        }));
      } else if (!event.candidate) {
        addLog('ICE', 'Semua ICE Candidate lokal selesai dikumpulkan.', 'ice');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      const tagType = (state === 'connected' || state === 'completed') ? 'turn' : state === 'failed' ? 'error' : 'ice';
      addLog('ICE', `Status Jalur ICE Ponsel: ${state.toUpperCase()}`, tagType);
      setStats(prev => ({ ...prev, iceConnectionState: state }));
      if (state === 'connected' || state === 'completed') {
        startTimer();
        startStatsPolling(pc);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const tagType = state === 'connected' ? 'webrtc' : state === 'failed' ? 'error' : 'ice';
      addLog('WEBRTC', `Status Koneksi Peer: ${state.toUpperCase()}`, tagType);
      setStats(prev => ({ ...prev, connectionState: state }));
      if (state === 'connected') {
        startTimer();
        startStatsPolling(pc);
      }
    };

    return pc;
  };

  const setupMedia = async () => {
    try {
      addLog('MEDIA', 'Mengaktifkan kamera & mic ponsel...', 'media');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, 
        audio: true 
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(() => {});
      }
      return stream;
    } catch (err) {
      addLog('ERROR', `Gagal akses kamera/mic: ${err.message}`, 'error');
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
    addLog('CALL', `Memanggil ${targetUser} (${targetApp}) via Gateway...`, 'webrtc');

    wsRef.current.send(JSON.stringify({
      type: 'call',
      to: targetUser,
      mode: 'video'
    }));
  };

  const startCallAsInitiator = async () => {
    addLog('WEBRTC', 'Panggilan diterima dokter. Menyiapkan media & SDP Offer...', 'webrtc');
    await setupMedia();
    const pc = createPeerConnection(callPeerRef.current);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    addLog('SDP', 'SDP Offer siap, mengirim ke dokter...', 'webrtc');
    wsRef.current.send(JSON.stringify({
      type: 'offer',
      to: callPeerRef.current,
      sdp: offer
    }));
  };

  // Terima Panggilan
  const acceptCall = async () => {
    setCallState('in-call');
    addLog('CALL', `Menerima panggilan dari ${callPeerRef.current}...`, 'webrtc');
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
    addLog('SDP', `Menerima SDP Offer dari dokter. Memasang remote description...`, 'webrtc');
    await setupMedia();

    const pc = createPeerConnection(fromPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

    for (const c of candidateQueueRef.current) {
      try {
        await pc.addIceCandidate(c);
        addLog('ICE', `Candidate antrian dipasang: ${c.candidate.substring(0, 45)}...`, 'ice');
      } catch (e) {
        console.warn("Candidate queue error:", e);
      }
    }
    candidateQueueRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    addLog('SDP', 'SDP Answer siap, mengirim kembali ke dokter...', 'webrtc');

    wsRef.current.send(JSON.stringify({
      type: 'answer',
      to: fromPeer,
      sdp: answer
    }));
  };

  const handleAnswer = async (sdpAnswer) => {
    if (pcRef.current) {
      addLog('SDP', 'Menerima SDP Answer dari dokter. Memasang remote description...', 'webrtc');
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
      for (const c of candidateQueueRef.current) {
        try {
          await pcRef.current.addIceCandidate(c);
          addLog('ICE', `Candidate antrian dipasang: ${c.candidate.substring(0, 45)}...`, 'ice');
        } catch (e) {
          console.warn("Candidate queue error:", e);
        }
      }
      candidateQueueRef.current = [];
    }
  };

  const handleCandidate = async (candidate) => {
    if (!candidate) return;
    const cStr = candidate.candidate || '';
    const tag = cStr.includes('typ relay') ? 'TURN' : cStr.includes('typ srflx') ? 'STUN' : 'HOST';
    const logType = tag === 'TURN' ? 'turn' : tag === 'STUN' ? 'stun' : 'ice';

    try {
      const iceCand = new RTCIceCandidate(candidate);
      if (pcRef.current && pcRef.current.remoteDescription && pcRef.current.remoteDescription.type) {
        await pcRef.current.addIceCandidate(iceCand);
        addLog(tag, `Menerima kandidat [${tag}] dari lawan bicara dan dipasang`, logType);
      } else {
        candidateQueueRef.current.push(iceCand);
        addLog(tag, `Menerima kandidat [${tag}] dari lawan bicara (diantrikan)`, logType);
      }
    } catch (err) {
      console.warn("Gagal addIceCandidate:", err);
    }
  };

  const hangupCall = () => {
    if (wsRef.current && callPeer) {
      wsRef.current.send(JSON.stringify({
        type: 'hangup',
        to: callPeer
      }));
    }
    addLog('CALL', 'Panggilan ditutup.', 'warn');
    saveCallLog('completed', callDuration);
    resetCallState();
  };

  const saveCallLog = (status, duration) => {
    if (!callPeer) return;
    const recordedPath = stats.activePath === 'RELAY' ? 'TURN (Metered Cloud)' :
                         stats.activePath === 'SRFLX' ? 'STUN (P2P Reflexive)' :
                         stats.activePath === 'HOST' ? 'HOST (Lokal LAN)' : 'COTURN / P2P';

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
        icePath: recordedPath
      })
    }).then(() => loadCallLogs()).catch(() => {});
  };

  const resetCallState = () => {
    setCallState('idle');
    setCallPeer(null);
    setPeerApp(null);
    setCallDuration(0);
    if (timerRef.current) clearInterval(timerRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    cleanupMedia();
  };

  const cleanupMedia = () => {
    callPeerRef.current = null;
    remoteStreamRef.current = null;
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
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
          <span className={`pill ${isRegistered ? 'pill-port' : 'pill-danger'}`}>
            {isRegistered ? '🟢 Terhubung ke Gateway' : '🔴 Gateway Terputus'}
          </span>
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
              <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px' }}>
                {!isRegistered ? (
                  <div style={{ color: '#ef4444', background: 'rgba(239, 68, 68, 0.15)', padding: '10px', borderRadius: '8px' }}>
                    ⚠️ Belum terhubung ke Gateway (Port 3000).<br/>
                    Menghubungkan ulang...
                  </div>
                ) : (
                  <div style={{ color: '#94a3b8' }}>
                    Dokter belum online.<br/>
                    Pastikan <strong>Aplikasi A (Port 3001)</strong> sedang dibuka di Laptop.
                  </div>
                )}
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

        {/* Observabilitas Real-Time STUN/TURN Mobile */}
        <div className="mobile-observability">
          <div className="mobile-obs-header">
            <div className="mobile-obs-title">
              <div className="obs-pulse"></div>
              <span>Observabilitas STUN/TURN Real-Time</span>
            </div>
            <div className="mobile-obs-actions">
              <button className="mobile-obs-btn" onClick={() => setLogs([])}>🧹 Log</button>
              <button className="mobile-obs-btn" onClick={() => setIsObsCollapsed(!isObsCollapsed)}>
                {isObsCollapsed ? '▲ Buka' : '▼ Tutup'}
              </button>
            </div>
          </div>

          {!isObsCollapsed && (
            <React.Fragment>
              <div className="mobile-telemetry-grid">
                <div className="mobile-telemetry-card">
                  <span className="telemetry-label">Jalur Aktif</span>
                  <div>
                    {stats.activePath === 'RELAY' && (
                      <span className="badge-path badge-relay">⚡ RELAY (TURN Metered)</span>
                    )}
                    {stats.activePath === 'SRFLX' && (
                      <span className="badge-path badge-srflx">🌐 SRFLX (STUN P2P)</span>
                    )}
                    {stats.activePath === 'HOST' && (
                      <span className="badge-path badge-host">🏠 HOST (Lokal)</span>
                    )}
                    {stats.activePath === 'IDLE' && (
                      <span style={{ fontSize: '10px', color: '#64748b' }}>⏳ Menunggu...</span>
                    )}
                  </div>
                </div>

                <div className="mobile-telemetry-card">
                  <span className="telemetry-label">Protokol</span>
                  <span className="telemetry-val">{stats.protocol || 'UDP'}</span>
                </div>

                <div className="mobile-telemetry-card">
                  <span className="telemetry-label">Latensi (RTT)</span>
                  <span className="telemetry-val" style={{ color: stats.rtt < 120 ? '#34d399' : '#fbbf24' }}>
                    {stats.rtt ? `${stats.rtt} ms` : '-'}
                  </span>
                </div>

                <div className="mobile-telemetry-card">
                  <span className="telemetry-label">Bitrate Video</span>
                  <span className="telemetry-val" style={{ color: '#38bdf8' }}>
                    {stats.bitrate ? `${stats.bitrate} kbps` : '-'}
                  </span>
                </div>
              </div>

              <div className="mobile-log-console">
                {logs.map(l => (
                  <div key={l.id} className="log-row">
                    <span className="log-time">{l.time}</span>
                    <span className={`log-tag tag-${l.type}`}>{l.tag}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div style={{ color: '#475569', fontStyle: 'italic', padding: '4px 0' }}>
                    Siap memantau STUN & TURN Metered saat panggilan berlangsung.
                  </div>
                )}
                <div ref={logEndRef} />
              </div>
            </React.Fragment>
          )}
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
            <div className="call-header-overlay" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <span className="call-title">Konsultasi dengan {callPeer}</span>
                <span className="call-timer">{formatTime(callDuration)}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
                {stats.activePath === 'RELAY' && (
                  <span className="badge-path badge-relay" style={{ fontSize: '9px', padding: '2px 6px' }}>⚡ RELAY (TURN Metered)</span>
                )}
                {stats.activePath === 'SRFLX' && (
                  <span className="badge-path badge-srflx" style={{ fontSize: '9px', padding: '2px 6px' }}>🌐 SRFLX (STUN P2P)</span>
                )}
                {stats.activePath === 'HOST' && (
                  <span className="badge-path badge-host" style={{ fontSize: '9px', padding: '2px 6px' }}>🏠 HOST (Lokal)</span>
                )}
                {stats.rtt > 0 && (
                  <span style={{ fontSize: '9px', color: '#94a3b8', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>
                    ⏱️ {stats.rtt}ms {stats.bitrate > 0 ? `• 🚀 ${stats.bitrate}kbps` : ''}
                  </span>
                )}
              </div>
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

