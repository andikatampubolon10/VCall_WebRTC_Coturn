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

  // Observabilitas & Telemetri Real-Time
  const [logs, setLogs] = useState([]);
  const [isObsCollapsed, setIsObsCollapsed] = useState(false);
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
    console.log(`[App A][${tag}] ${message}`);
    setLogs(prev => [
      ...prev.slice(-70),
      { id: Date.now() + Math.random(), time: timeStr, tag, message, type }
    ]);
  };

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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

  // Polling getStats() untuk Memantau STUN vs TURN Real-Time
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

  // WebRTC Setup
  const createPeerConnection = (targetUser) => {
    addLog('WEBRTC', `Memulai RTCPeerConnection baru untuk target: ${targetUser}`, 'webrtc');
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
      addLog('MEDIA', 'Kamera & Audio lokal dilampirkan ke koneksi peer.', 'media');
    }

    pc.ontrack = (event) => {
      addLog('MEDIA', `Menerima track remote: ${event.track.kind} (${event.track.label || 'Aktif'})`, 'media');
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
          addLog('HOST', `🏠 Kandidat Host IP Lokal terdeteksi (${event.candidate.address})`, 'ice');
        }

        wsRef.current.send(JSON.stringify({
          type: 'candidate',
          to: target,
          candidate: event.candidate
        }));
      } else if (!event.candidate) {
        addLog('ICE', 'Semua ICE Candidate lokal selesai dikumpulkan (Gathering Complete).', 'ice');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      const tagType = (state === 'connected' || state === 'completed') ? 'turn' : state === 'failed' ? 'error' : 'ice';
      addLog('ICE', `Status Jalur ICE: ${state.toUpperCase()}`, tagType);
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

  // Setup Kamera Lokal
  const setupMedia = async () => {
    try {
      addLog('MEDIA', 'Mengakses kamera & mikrofon lokal...', 'media');
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
      addLog('ERROR', `Gagal akses kamera/mikrofon: ${err.message}`, 'error');
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
    addLog('CALL', `Memanggil ${targetUser} (${targetApp}) melalui Shared Gateway...`, 'webrtc');

    wsRef.current.send(JSON.stringify({
      type: 'call',
      to: targetUser,
      mode: 'video'
    }));
  };

  const startCallAsInitiator = async () => {
    addLog('WEBRTC', 'Pihak lawan menerima panggilan. Membuat SDP Offer...', 'webrtc');
    await setupMedia();
    const pc = createPeerConnection(callPeerRef.current);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    addLog('SDP', 'SDP Offer lokal siap. Mengirim ke Gateway...', 'webrtc');
    wsRef.current.send(JSON.stringify({
      type: 'offer',
      to: callPeerRef.current,
      sdp: offer
    }));
  };

  // 2. Terima Panggilan Masuk dari Aplikasi B
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
    addLog('SDP', `Menerima SDP Offer dari ${fromPeer}. Memasang remote description...`, 'webrtc');
    await setupMedia();

    const pc = createPeerConnection(fromPeer);
    await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

    // Flush queued candidates
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
    addLog('SDP', 'SDP Answer lokal siap. Mengirim kembali ke lawan bicara...', 'webrtc');

    wsRef.current.send(JSON.stringify({
      type: 'answer',
      to: fromPeer,
      sdp: answer
    }));
  };

  const handleAnswer = async (sdpAnswer) => {
    if (pcRef.current) {
      addLog('SDP', 'Menerima SDP Answer dari lawan bicara. Memasang remote description...', 'webrtc');
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
        addLog(tag, `Menerima kandidat [${tag}] dari lawan bicara dan dipasang langsung`, logType);
      } else {
        candidateQueueRef.current.push(iceCand);
        addLog(tag, `Menerima kandidat [${tag}] dari lawan bicara (diantrikan)`, logType);
      }
    } catch (err) {
      console.warn("Gagal addIceCandidate:", err);
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
    addLog('CALL', 'Panggilan diakhiri.', 'warn');
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
        callerSystem: 'APP_A',
        calleeSystem: peerApp || 'APP_B',
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
          <span className={`badge ${isRegistered ? 'badge-online' : 'badge-danger'}`}>
            {isRegistered ? `🟢 ${currentUser} (Online)` : '🔴 Gateway Terputus (Port 3000)'}
          </span>
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
              <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: '13px', lineHeight: '1.6' }}>
                {!isRegistered ? (
                  <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', padding: '14px', color: '#fca5a5' }}>
                    <div style={{ fontSize: '18px', marginBottom: '4px' }}>⚠️</div>
                    <strong style={{ color: '#ef4444' }}>Gateway Port 3000 Terputus!</strong>
                    <p style={{ marginTop: '6px', fontSize: '12px', color: '#cbd5e1' }}>
                      Aplikasi A tidak dapat terhubung ke <code>ws://localhost:3000</code>.
                      Pastikan jendela terminal <strong>Gateway-Port-3000</strong> sedang berjalan.
                    </p>
                  </div>
                ) : (
                  <p style={{ color: '#8ea3b7' }}>
                    Belum ada pengguna lain online.<br/>
                    Buka <strong>Aplikasi B (Port 3002 / Ngrok)</strong> di HP Anda untuk mulai panggilan antar-aplikasi!
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Panel Observabilitas Real-Time (STUN / Metered TURN) di Bawah Daftar Pengguna */}
          <div className="sidebar-observability">
            <div className="sidebar-obs-header">
              <div className="sidebar-obs-title">
                <div className="obs-pulse"></div>
                <span>Telemetri STUN / TURN</span>
              </div>
              <div className="obs-actions">
                <button className="obs-btn" onClick={() => setLogs([])}>🧹 Log</button>
                <button className="obs-btn" onClick={() => setIsObsCollapsed(!isObsCollapsed)}>
                  {isObsCollapsed ? '▲ Buka' : '▼ Tutup'}
                </button>
              </div>
            </div>

            {!isObsCollapsed && (
              <React.Fragment>
                <div className="sidebar-obs-metrics">
                  <div className="metric-row">
                    <span className="metric-name">Jalur Aktif</span>
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

                  <div className="metric-row">
                    <span className="metric-name">Protokol & Latensi</span>
                    <span className="metric-value">
                      {stats.protocol || 'UDP'} • <span style={{ color: stats.rtt < 150 ? '#34d399' : '#fbbf24' }}>{stats.rtt ? `${stats.rtt} ms` : '-'}</span>
                    </span>
                  </div>

                  <div className="metric-row">
                    <span className="metric-name">Bitrate Masuk</span>
                    <span className="metric-value" style={{ color: '#38bdf8' }}>
                      {stats.bitrate ? `${stats.bitrate} kbps` : '-'}
                    </span>
                  </div>

                  <div className="metric-row" title={`Lokal: ${stats.localCandidate}`}>
                    <span className="metric-name">Lokal</span>
                    <span className="metric-value" style={{ fontSize: '10px', maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {stats.localCandidate}
                    </span>
                  </div>

                  <div className="metric-row" title={`Remote: ${stats.remoteCandidate}`}>
                    <span className="metric-name">Remote</span>
                    <span className="metric-value" style={{ fontSize: '10px', maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {stats.remoteCandidate}
                    </span>
                  </div>
                </div>

                <div className="sidebar-log-console">
                  {logs.map(l => (
                    <div key={l.id} className="log-row">
                      <span className="log-time">{l.time}</span>
                      <span className={`log-tag tag-${l.type}`}>{l.tag}</span>
                      <span className="log-msg">{l.message}</span>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div style={{ color: '#475569', fontStyle: 'italic', padding: '4px 0' }}>
                      Menunggu event STUN/TURN...
                    </div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </React.Fragment>
            )}
          </div>
        </aside>

        {/* Workspace Utama */}
        <main className="workspace">
          {callState === 'idle' && (
            <div>
              <div className="welcome-card" style={{ padding: '24px 32px', margin: '20px auto' }}>
                <h2>Selamat Datang di Portal Aplikasi A</h2>
                <p>
                  Aplikasi ini berjalan mandiri di <strong>Port 3001</strong> dengan database khusus <strong>Neon US-East</strong>.
                  Klik tombol <strong>📹 Panggil</strong> pada kontak di sebelah kiri untuk memulai panggilan konsultasi video.
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

