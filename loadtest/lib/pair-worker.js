/**
 * Pair worker (child process). Simulates N call pairs (User A = caller, User B = callee)
 * exactly following the app's real flow through the signaling gateway and CoTURN:
 *
 *   A,B: WebSocket connect + register
 *   A -> call -> (gateway) -> B: incoming -> B: accept -> A: accept
 *   A,B: TURN Allocate (401 challenge + long-term credential)  [each peer allocates its own relay]
 *   A -> offer -> B -> answer -> A                               [SDP via gateway]
 *   A <-> B: ICE candidate "typ relay" via gateway
 *   A,B: CreatePermission + ChannelBind to the peer's relayed address
 *   A <-> B: two-way media as ChannelData (A -> CoTURN -> relayA -> relayB -> CoTURN -> B)
 *   A: hangup ; A,B: Refresh(lifetime=0) release ; close
 *
 * Every media packet carries pair id, direction, window, seq and a send timestamp, so the
 * receiver (same process => same clock) can compute true one-way latency, jitter and loss.
 */
'use strict';

const path = require('path');
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = require(path.join(__dirname, '..', '..', 'gateway', 'node_modules', 'ws')); }
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { TurnClient } = require('./turn-client');
const { Reservoir } = require('./stats');

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = null;
const pairs = new Map();
let currentWindow = 0; // 0 = ramp/warmup, 1 = measurement window, 2 = after
let tearingDown = false;

const lat = {
  wsOpen: new Reservoir(5000),
  register: new Reservoir(5000),
  callToAccept: new Reservoir(5000),
  allocate: new Reservoir(5000),
  sdpExchange: new Reservoir(5000),
  bind: new Reservoir(5000),
  setup: new Reservoir(5000),
  mediaOneWay: new Reservoir(20000),
};
const counters = {
  started: 0, connected: 0, failed: 0,
  wsDropped: 0, gatewayHangup: 0, turnRetransmits: 0,
  wsBytesUsers: 0, wsMsgsUsers: 0, wsBytesOther: 0, wsMsgsOther: 0,
  teardownErrors: 0,
};
const failures = {}; // "phase: reason" -> count
// media accounting for the measurement window, per direction
const media = { sent: 0, recv: 0, bytesSent: 0, late: 0 };
const jitters = []; // per stream final jitter (ms)
const callDurations = { talk: [], session: [] }; // detik, dicatat saat hangup

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
let cpuStart = process.cpuUsage();
let wallStart = now();

function fail(p, phase, err) {
  if (p.failed) return;
  p.failed = true;
  counters.failed++;
  let reason = (err && (err.message || String(err))) || 'unknown';
  reason = reason.replace(/dr_\S+|pt_\S+/g, '<id>').slice(0, 90);
  const key = `${phase}: ${reason}`;
  failures[key] = (failures[key] || 0) + 1;
  cleanupPair(p, false);
}

// ---------------- WebSocket helpers ----------------
const USERS_PREFIX = Buffer.from('{"type":"users"');

function openConn(p) {
  return new Promise((resolve, reject) => {
    const t = now();
    const ws = new WebSocket(cfg.wsUrl, { perMessageDeflate: false, handshakeTimeout: cfg.phaseTimeoutMs });
    const conn = { ws, inbox: new Map(), waiters: new Map(), closedByUs: false };
    const to = setTimeout(() => { try { ws.terminate(); } catch (_) {} reject(new Error('WS open timeout')); }, cfg.phaseTimeoutMs);
    ws.on('open', () => { clearTimeout(to); lat.wsOpen.add(now() - t); resolve(conn); });
    ws.on('error', (e) => { clearTimeout(to); reject(new Error('WS ' + (e.code || e.message))); });
    ws.on('message', (raw, isBinary) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length >= USERS_PREFIX.length && buf.compare(USERS_PREFIX, 0, USERS_PREFIX.length, 0, USERS_PREFIX.length) === 0) {
        counters.wsBytesUsers += buf.length; counters.wsMsgsUsers++;
        return; // user-list broadcast: counted, not parsed (saves generator CPU)
      }
      counters.wsBytesOther += buf.length; counters.wsMsgsOther++;
      let msg; try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.type === 'hangup' && p.connected && !tearingDown) { counters.gatewayHangup++; }
      const w = conn.waiters.get(msg.type);
      if (w) { conn.waiters.delete(msg.type); w(msg); return; }
      if (msg.type === 'error') { const we = conn.waiters.get('__error'); if (we) { conn.waiters.delete('__error'); we(msg); return; } }
      if (!conn.inbox.has(msg.type)) conn.inbox.set(msg.type, []);
      conn.inbox.get(msg.type).push(msg);
    });
    ws.on('close', () => {
      if (!conn.closedByUs && !tearingDown && !p.cleaned) { counters.wsDropped++; }
    });
  });
}

function waitFor(conn, type, label) {
  const q = conn.inbox.get(type);
  if (q && q.length) return Promise.resolve(q.shift());
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { conn.waiters.delete(type); conn.waiters.delete('__error'); reject(new Error(`timeout menunggu '${label || type}'`)); }, cfg.phaseTimeoutMs);
    conn.waiters.set(type, (m) => { clearTimeout(to); conn.waiters.delete('__error'); resolve(m); });
    conn.waiters.set('__error', (m) => { clearTimeout(to); conn.waiters.delete(type); reject(new Error(`gateway error ${m.code || ''}`.trim())); });
  });
}

function send(conn, obj) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
}

function relayCandidate(r, mapped) {
  return {
    candidate: `candidate:1 1 udp 41885439 ${r.ip} ${r.port} typ relay raddr ${mapped ? mapped.ip : '0.0.0.0'} rport ${mapped ? mapped.port : 0} generation 0`,
    sdpMid: '0', sdpMLineIndex: 0,
  };
}
function parseCandidate(c) {
  const m = /udp \d+ (\d+\.\d+\.\d+\.\d+) (\d+) typ (\w+)/.exec((c && c.candidate) || '');
  if (!m) throw new Error('candidate tidak valid');
  return { ip: m[1], port: Number(m[2]), typ: m[3] };
}
function fakeSdp(kind, r) {
  return { type: kind, sdp: `v=0\r\no=- ${Date.now()} 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio ${r.port} UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 ${r.ip}\r\na=rtpmap:111 opus/48000/2\r\nm=video ${r.port} UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n` };
}

function timed(promise, reservoir) {
  const t = now();
  return promise.then((v) => { reservoir.add(now() - t); return v; });
}

// ---------------- media ----------------
const HDR = 18;
const CHANNEL = 0x4000;

function makeStream() {
  return { seq: 0, sent: 0, recv: 0, jitter: 0, lastTransit: null, firstRecvAt: null };
}

function onMedia(p, dirExpected, payload) {
  if (payload.length < HDR) return;
  const t = now();
  const dir = payload[4] & 1;
  if (dir !== dirExpected) return;
  const win = payload[5];
  const sendTs = payload.readDoubleBE(10);
  const s = dir === 0 ? p.sAB : p.sBA;
  if (s.firstRecvAt === null) { s.firstRecvAt = t; if (p.onFirstMedia) p.onFirstMedia(); }
  if (win !== 1) return;
  const transit = t - sendTs;
  s.recv++;
  media.recv++;
  if (s.lastTransit !== null) {
    const d = Math.abs(transit - s.lastTransit);
    s.jitter += (d - s.jitter) / 16; // RFC 3550
  }
  s.lastTransit = transit;
  if ((s.recv & 3) === 0) lat.mediaOneWay.add(transit); // sample 1/4 packets
}

function buildPacket(p, dir, kind, size, stream) {
  const b = Buffer.alloc(Math.max(size, HDR));
  b.writeUInt32BE(p.idx, 0);
  b[4] = dir | (kind << 1);
  b[5] = currentWindow;
  b.writeUInt32BE(stream.seq++ >>> 0, 6);
  b.writeDoubleBE(now(), 10);
  return b;
}

let tickStart = 0, ticksDone = 0;
function mediaTick() {
  const due = Math.floor((now() - tickStart) / cfg.tickMs) - ticksDone;
  const n = Math.min(Math.max(due, 0), 5); // catch up at most 5 ticks (100 ms)
  ticksDone += Math.max(due, 0);
  for (let k = 0; k < n; k++) {
    for (const p of pairs.values()) {
      if (!p.mediaOn) continue;
      sendBurst(p, 0, p.tA, p.sAB);
      sendBurst(p, 1, p.tB, p.sBA);
    }
  }
}

function sendBurst(p, dir, turn, stream) {
  for (const pk of cfg.packetsPerTick) {
    const b = buildPacket(p, dir, pk.kind, pk.size, stream);
    turn.sendChannelData(CHANNEL, b);
    if (currentWindow === 1) { stream.sent++; media.sent++; media.bytesSent += b.length; }
  }
}

// ---------------- pair lifecycle ----------------
async function runPair(idx) {
  const p = {
    idx, idA: `dr_${cfg.runTag}_${idx}`, idB: `pt_${cfg.runTag}_${idx}`,
    t0: now(), failed: false, connected: false, mediaOn: false, cleaned: false,
    sAB: makeStream(), sBA: makeStream(),
  };
  pairs.set(idx, p);
  counters.started++;
  let phase = 'ws_connect';
  try {
    const conns = await Promise.allSettled([openConn(p), openConn(p)]);
    if (conns[0].status === 'fulfilled') p.A = conns[0].value;
    if (conns[1].status === 'fulfilled') p.B = conns[1].value;
    const bad = conns.find((c) => c.status === 'rejected');
    if (bad) throw bad.reason;

    phase = 'register';
    const t1 = now();
    send(p.A, { type: 'register', userId: p.idA, appName: 'APP_A' });
    send(p.B, { type: 'register', userId: p.idB, appName: 'APP_B' });
    await Promise.all([waitFor(p.A, 'registered'), waitFor(p.B, 'registered')]);
    lat.register.add(now() - t1);

    phase = 'call';
    const t2 = now();
    p.callAt = t2;
    send(p.A, { type: 'call', to: p.idB, mode: 'video' });
    await waitFor(p.B, 'incoming');
    send(p.B, { type: 'accept', to: p.idA });
    await waitFor(p.A, 'accept');
    lat.callToAccept.add(now() - t2);

    phase = 'turn_allocate';
    p.tA = new TurnClient(cfg.turn); p.tB = new TurnClient(cfg.turn);
    await Promise.all([p.tA.bind(), p.tB.bind()]);
    const [rA, rB] = await Promise.all([timed(p.tA.allocate(cfg.allocLifetime), lat.allocate), timed(p.tB.allocate(cfg.allocLifetime), lat.allocate)]);

    phase = 'sdp_ice';
    const t3 = now();
    send(p.A, { type: 'offer', to: p.idB, sdp: fakeSdp('offer', rA) });
    await waitFor(p.B, 'offer');
    send(p.B, { type: 'answer', to: p.idA, sdp: fakeSdp('answer', rB) });
    await waitFor(p.A, 'answer');
    send(p.A, { type: 'candidate', to: p.idB, candidate: relayCandidate(rA, p.tA.mapped) });
    send(p.B, { type: 'candidate', to: p.idA, candidate: relayCandidate(rB, p.tB.mapped) });
    const [cAtB, cBtA] = await Promise.all([waitFor(p.B, 'candidate'), waitFor(p.A, 'candidate')]);
    lat.sdpExchange.add(now() - t3);
    const peerForB = parseCandidate(cAtB.candidate);
    const peerForA = parseCandidate(cBtA.candidate);

    phase = 'turn_bind';
    const t4 = now();
    await Promise.all([
      p.tA.createPermission(peerForA.ip).then(() => p.tA.channelBind(CHANNEL, peerForA.ip, peerForA.port)),
      p.tB.createPermission(peerForB.ip).then(() => p.tB.channelBind(CHANNEL, peerForB.ip, peerForB.port)),
    ]);
    lat.bind.add(now() - t4);

    phase = 'media_start';
    p.tB.on('data', (ch, d) => onMedia(p, 0, d));
    p.tA.on('data', (ch, d) => onMedia(p, 1, d));
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('media tidak mengalir 2 arah')), cfg.phaseTimeoutMs);
      p.onFirstMedia = () => {
        if (p.sAB.firstRecvAt !== null && p.sBA.firstRecvAt !== null) { clearTimeout(to); p.onFirstMedia = null; resolve(); }
      };
      p.mediaOn = true;
    });
    lat.setup.add(now() - p.t0);
    p.connected = true;
    p.connectedAt = now();
    counters.connected++;
  } catch (e) {
    fail(p, phase, e);
  }
}

function cleanupPair(p, graceful) {
  if (p.cleaned) return Promise.resolve();
  p.cleaned = true;
  p.mediaOn = false;
  const jobs = [];
  if (graceful && p.connected && !p.failed) {
    const t = now();
    callDurations.talk.push((t - p.connectedAt) / 1000);   // media mengalir -> hangup
    callDurations.session.push((t - p.callAt) / 1000);     // tombol call -> hangup
  }
  if (graceful && p.A && p.A.ws.readyState === WebSocket.OPEN) send(p.A, { type: 'hangup', to: p.idB, reason: 'selesai' });
  for (const t of [p.tA, p.tB]) {
    if (!t) continue;
    counters.turnRetransmits += t.retransmits;
    jobs.push(graceful ? t.release().catch(() => { counters.teardownErrors++; }) : Promise.resolve(t.close()));
  }
  return Promise.all(jobs).then(() => {
    for (const c of [p.A, p.B]) {
      if (!c) continue;
      c.closedByUs = true;
      try { c.ws.close(); } catch (_) {}
    }
  });
}

async function teardownAll() {
  tearingDown = true;
  const list = [...pairs.values()];
  const conc = 200;
  for (let i = 0; i < list.length; i += conc) {
    await Promise.all(list.slice(i, i + conc).map((p) => cleanupPair(p, true)));
  }
}

function collect() {
  let mediaDeadStreams = 0;
  for (const p of pairs.values()) {
    if (!p.connected || p.failed) continue;
    for (const s of [p.sAB, p.sBA]) {
      if (s.sent > 0 && s.recv === 0) mediaDeadStreams++;
      if (s.recv > 1) jitters.push(s.jitter);
    }
  }
  const cpu = process.cpuUsage(cpuStart);
  const wall = now() - wallStart;
  return {
    counters, failures, media, mediaDeadStreams,
    lat: Object.fromEntries(Object.entries(lat).map(([k, r]) => [k, r.items])),
    jitters,
    gen: {
      eventLoopP99Ms: eld.percentile(99) / 1e6,
      eventLoopMaxMs: eld.max / 1e6,
      cpuPct: ((cpu.user + cpu.system) / 1000 / wall) * 100,
      rssMB: process.memoryUsage().rss / 1048576,
    },
  };
}

// ---------------- control from master ----------------
process.on('message', async (m) => {
  try {
    if (m.cmd === 'start') {
      cfg = m.cfg;
      tickStart = now(); ticksDone = 0;
      setInterval(mediaTick, cfg.tickMs);
      setInterval(() => {
        let inProgress = 0;
        for (const p of pairs.values()) if (!p.connected && !p.failed) inProgress++;
        let active = 0;
        for (const p of pairs.values()) if (p.connected && !p.failed && !p.cleaned) active++;
        process.send({ ev: 'progress', started: counters.started, connected: counters.connected, failed: counters.failed, inProgress, active });
      }, 1000);
      // spread pair starts evenly over the ramp, interleaved with the other workers
      const startAt = now();
      for (const { idx, pos } of m.pairs) {
        const at = startAt + (pos / Math.max(1, m.totalPairs)) * m.rampMs;
        const d = at - now();
        if (d > 0) await sleep(d);
        runPair(idx);
      }
      process.send({ ev: 'allStarted' });
    } else if (m.cmd === 'window') {
      currentWindow = m.w;
      if (m.w === 1) { eld.reset(); cpuStart = process.cpuUsage(); wallStart = now(); }
    } else if (m.cmd === 'collect') {
      process.send({ ev: 'collected', data: collect() });
    } else if (m.cmd === 'teardown') {
      await teardownAll();
      process.send({ ev: 'tornDown', callDurations });
      setTimeout(() => process.exit(0), 200);
    }
  } catch (e) {
    process.send({ ev: 'fatal', error: e.stack || e.message });
  }
});
