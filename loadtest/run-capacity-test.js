#!/usr/bin/env node
/**
 * CoTURN + Signaling Gateway capacity test (tiered, real protocol, A-calls-B flow).
 *
 *   node run-capacity-test.js --target 34.50.75.236 --tiers 100,250,500,750,1000 \
 *        --profile video --monitor ssh --ssh-user joim --ssh-key ~/.ssh/coturn_loadtest
 *
 * Output: results/<run-id>/{results.json, samples.jsonl, report.html, report.pdf}
 * See README.md in this folder for the full methodology.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork, spawn } = require('child_process');
const { summarize, round } = require('./lib/stats');
const { evaluate: evaluateStage } = require('./lib/evaluate');

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const target = opt('target', process.env.TARGET_HOST || '127.0.0.1');
const CFG = {
  target,
  wsUrl: opt('ws-url', `ws://${target}:${opt('ws-port', 3000)}`),
  httpBase: `http://${target}:${opt('ws-port', 3000)}`,
  turnHost: opt('turn-host', target),
  turnPort: Number(opt('turn-port', 3478)),
  turnUser: opt('turn-user', process.env.TURN_USER || 'simulasi'),
  turnPass: opt('turn-pass', process.env.TURN_PASS || 'password123'),
  tiers: String(opt('tiers', '100,250,500,750,1000,1500,2000,2500,3000,4000,5000')).split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 2),
  holdSec: Number(opt('hold', 90)),
  rampSec: opt('ramp', 'auto'),
  cooldownSec: Number(opt('cooldown', 30)),
  profile: opt('profile', 'video'),
  videoKbps: Number(opt('video-kbps', 500)),
  maxWorkers: Number(opt('workers', Math.max(1, os.cpus().length - 1))),
  phaseTimeoutMs: Number(opt('phase-timeout', 15000)),
  monitor: opt('monitor', 'ssh'),
  sshHost: opt('ssh-host', target),
  sshUser: opt('ssh-user', process.env.SSH_USER || 'joim'),
  sshKey: expandHome(opt('ssh-key', process.env.SSH_KEY || '~/.ssh/coturn_loadtest')),
  stopOnFail: opt('stop-on-fail', 'true') !== 'false',
  stopOnSaturation: opt('stop-on-saturation', 'true') !== 'false',
  outDir: opt('out', path.join(__dirname, 'results')),
  generatorLocation: opt('generator-location', 'unknown'),
  label: opt('label', ''),
  pdf: opt('pdf', 'true') !== 'false',
};

const THRESH = {
  successPct: { warn: 99, fail: 95 },      // call established (two-way media) / attempted
  lossPct: { warn: 1, fail: 3 },           // media packet loss in measurement window
  jitterP95: { warn: 20, fail: 30 },       // ms, RFC 3550
  latencyP95: { warn: 100, fail: 150 },    // ms, one-way (ITU-T G.114 recommends <150 ms)
  setupP95: { warn: 1500, fail: 3000 },    // ms, register -> two-way media
  cpuAvg: { warn: 70, fail: 85 },          // % whole server during steady state
  memPct: { warn: 80, fail: 90 },
  gatewayCpu: { warn: 70, fail: 95 },      // % of ONE core (Node.js is single-threaded)
};

function mediaProfile() {
  const tickMs = 20;
  const pk = [{ kind: 0, size: 172 }]; // Opus 64 kbps @20 ms + RTP header
  if (CFG.profile === 'video') {
    const bytesPerTick = (CFG.videoKbps * 1000) / 8 * (tickMs / 1000);
    // WebRTC memaketkan video mendekati MTU (~1200 B payload RTP); 500 kbps @20 ms = 1 paket ±1250 B
    const n = Math.max(1, Math.ceil(bytesPerTick / 1300));
    for (let i = 0; i < n; i++) pk.push({ kind: 1, size: Math.round(bytesPerTick / n) });
  }
  const kbpsPerDir = (pk.reduce((a, b) => a + b.size + 4, 0) * 8) / tickMs; // +4 ChannelData header
  return { tickMs, packetsPerTick: pk, kbpsPerDir, ppsPerDir: (pk.length * 1000) / tickMs };
}
const PROFILE = mediaProfile();

const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const RUN_DIR = path.join(CFG.outDir, runId);
fs.mkdirSync(RUN_DIR, { recursive: true });
const samplesFile = fs.createWriteStream(path.join(RUN_DIR, 'samples.jsonl'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('id-ID', { hour12: false })}]`, ...a);

// ---------------- server monitor ----------------
const monitor = { info: null, samples: [], stage: null, kind: CFG.monitor, stop: () => {} };

function onMonitorLine(line) {
  let o; try { o = JSON.parse(line); } catch (_) { return; }
  if (o.kind === 'info') { monitor.info = o; return; }
  if (o.kind === 'sample') {
    o.stage = monitor.stage;
    monitor.samples.push(o);
    samplesFile.write(JSON.stringify(o) + '\n');
  }
}

function lineSplitter(fn) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i)); buf = buf.slice(i + 1); }
  };
}

async function startMonitor() {
  const script = fs.readFileSync(path.join(__dirname, 'server-monitor.js'));
  if (CFG.monitor === 'local' || CFG.monitor === 'local-sudo') {
    // local-sudo: agar monitor bisa membaca /etc/turnserver.conf & file descriptor proses CoTURN
    const ch = CFG.monitor === 'local-sudo'
      ? spawn('sudo', ['-n', process.execPath, path.join(__dirname, 'server-monitor.js')], { stdio: ['ignore', 'pipe', 'inherit'] })
      : spawn(process.execPath, [path.join(__dirname, 'server-monitor.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    ch.stdout.on('data', lineSplitter(onMonitorLine));
    monitor.stop = () => { try { ch.stdout.destroy(); } catch (_) {} try { ch.kill(); } catch (_) {} };
  } else if (CFG.monitor === 'ssh') {
    const { Client } = require('ssh2');
    const conn = new Client();
    await new Promise((resolve, reject) => {
      conn.on('ready', resolve).on('error', reject).connect({
        host: CFG.sshHost, port: 22, username: CFG.sshUser,
        privateKey: fs.readFileSync(CFG.sshKey), readyTimeout: 20000, keepaliveInterval: 10000,
      });
    });
    await new Promise((resolve, reject) => {
      conn.exec('node -', (err, stream) => {
        if (err) return reject(err);
        stream.on('data', lineSplitter(onMonitorLine));
        stream.stderr.on('data', (d) => process.stderr.write('[monitor] ' + d));
        stream.end(script);
        monitor.stop = () => { try { stream.signal('KILL'); stream.close(); } catch (_) {} conn.end(); };
        resolve();
      });
    });
  } else if (CFG.monitor === 'http') {
    // Fallback: gateway /api/metrics (limited: load-based CPU, no CoTURN process / network data)
    let prevT = null;
    const iv = setInterval(() => {
      http.get(`${CFG.httpBase}/api/metrics`, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          try {
            const m = JSON.parse(d);
            if (!monitor.info) monitor.info = { kind: 'info', hostname: CFG.target, cpuModel: m.cpu.model, cores: m.cpu.cores, memTotalMB: m.ram.totalMB, limited: true, turnConf: {}, processes: [] };
            onMonitorLine(JSON.stringify({ kind: 'sample', ts: Date.now(), limited: true, cpu: { total: m.cpu.cpuPercent }, load1: m.cpu.load1m, mem: { usedMB: m.ram.usedMB, usedPct: m.ram.usedPercent, totalMB: m.ram.totalMB }, procs: { gateway: { rssMB: m.process.rssMB } }, gatewayWs: m.network.activeWsClients }));
            prevT = Date.now();
          } catch (_) {}
        });
      }).on('error', () => {});
    }, 1000);
    monitor.stop = () => clearInterval(iv);
  }
  // wait for first data
  for (let i = 0; i < 50 && (!monitor.info || monitor.samples.length < 2); i++) await sleep(200);
  if (CFG.monitor !== 'none' && !monitor.info) throw new Error(`Monitor '${CFG.monitor}' tidak mengirim data`);
}

function sampleWindow(t0, t1) {
  return monitor.samples.filter((s) => s.ts >= t0 && s.ts <= t1);
}

function aggServer(samples) {
  const pick = (fn) => samples.map((s) => { try { return fn(s); } catch (_) { return null; } }).filter((v) => typeof v === 'number' && isFinite(v));
  const s = (fn) => { const v = pick(fn); return v.length ? { avg: round(v.reduce((a, b) => a + b, 0) / v.length), max: round(Math.max(...v)) } : { avg: null, max: null }; };
  const cores = (monitor.info && monitor.info.cores) || 1;
  return {
    n: samples.length,
    cpu: s((x) => x.cpu.total),
    // CPU server tanpa proses load generator (generator berjalan di mesin yang sama)
    cpuExclGen: s((x) => Math.max(0, x.cpu.total - ((x.procs.loadgen && x.procs.loadgen.cpuPct) || 0) / cores)), cpuMaxCore: s((x) => x.cpu.maxCore), cpuSoftirq: s((x) => x.cpu.softirq), cpuSteal: s((x) => x.cpu.steal),
    load1: s((x) => x.load1),
    memUsedMB: s((x) => x.mem.usedMB), memPct: s((x) => x.mem.usedPct),
    rxMbps: s((x) => x.net.rxMbps), txMbps: s((x) => x.net.txMbps), rxPps: s((x) => x.net.rxPps), txPps: s((x) => x.net.txPps),
    nicDropPs: s((x) => x.net.rxDropPs + x.net.txDropPs),
    udpInPs: s((x) => x.udp.inPs), udpOutPs: s((x) => x.udp.outPs),
    udpErrPs: s((x) => x.udp.inErrPs + x.udp.sndbufErrPs), udpRcvbufErrPs: s((x) => x.udp.rcvbufErrPs),
    relayPorts: s((x) => x.relayPorts), tcpInuse: s((x) => x.sock.tcpInuse), udpInuse: s((x) => x.sock.udpInuse),
    conntrack: s((x) => x.conntrack.count),
    coturnCpu: s((x) => x.procs.coturn.cpuPct), coturnRss: s((x) => x.procs.coturn.rssMB), coturnThreads: s((x) => x.procs.coturn.threads), coturnFds: s((x) => x.procs.coturn.fds),
    gatewayCpu: s((x) => x.procs.gateway.cpuPct), gatewayRss: s((x) => x.procs.gateway.rssMB), gatewayFds: s((x) => x.procs.gateway.fds),
    loadgenCpu: s((x) => x.procs.loadgen.cpuPct),
  };
}

// ---------------- stage runner ----------------
async function runStage(stageNo, users) {
  const pairsN = Math.floor(users / 2);
  const rampMs = (CFG.rampSec === 'auto' ? Math.min(60, Math.max(10, pairsN / 12.5)) : Number(CFG.rampSec)) * 1000;
  const perWorker = CFG.profile === 'video' ? 100 : 250;
  const nWorkers = Math.max(1, Math.min(CFG.maxWorkers, Math.ceil(pairsN / perWorker)));
  monitor.stage = stageNo;
  log(`▶ Tahap ${stageNo}: ${users} user (${pairsN} pasang panggilan) | ramp ${rampMs / 1000}s, hold ${CFG.holdSec}s, ${nWorkers} worker, profil ${CFG.profile} (~${Math.round(PROFILE.kbpsPerDir)} kbps/arah/user)`);

  const runTag = `${runId.slice(11).replace(/-/g, '')}s${stageNo}`;
  const workers = [];
  const progress = [];
  const series = []; // per-second connected pairs, for charts
  for (let w = 0; w < nWorkers; w++) {
    const ch = fork(path.join(__dirname, 'lib', 'pair-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=2048'] });
    const wk = { ch, progress: { started: 0, connected: 0, failed: 0, inProgress: 0, active: 0 }, allStarted: false, collected: null, tornDown: false };
    ch.on('message', (m) => {
      if (m.ev === 'progress') wk.progress = m;
      else if (m.ev === 'allStarted') wk.allStarted = true;
      else if (m.ev === 'collected') wk.collected = m.data;
      else if (m.ev === 'tornDown') { wk.tornDown = true; wk.callDurations = m.callDurations; }
      else if (m.ev === 'fatal') log('worker fatal:', m.error);
    });
    ch.on('exit', () => { wk.exited = true; });
    workers.push(wk);
  }
  const workerCfg = {
    wsUrl: CFG.wsUrl, runTag, phaseTimeoutMs: CFG.phaseTimeoutMs, allocLifetime: 600,
    turn: { host: CFG.turnHost, port: CFG.turnPort, username: CFG.turnUser, password: CFG.turnPass },
    tickMs: PROFILE.tickMs, packetsPerTick: PROFILE.packetsPerTick,
  };
  const assign = workers.map(() => []);
  for (let i = 0; i < pairsN; i++) assign[i % nWorkers].push({ idx: i, pos: i });

  const tStage = Date.now();
  workers.forEach((wk, i) => wk.ch.send({ cmd: 'start', cfg: workerCfg, pairs: assign[i], totalPairs: pairsN, rampMs }));

  const sum = () => workers.reduce((a, w) => { for (const k in w.progress) a[k] = (a[k] || 0) + (w.progress[k] || 0); return a; }, {});
  // ramp + wait for all pairs to settle (connected or failed)
  const settleDeadline = tStage + rampMs + CFG.phaseTimeoutMs * 4 + 10000;
  while (Date.now() < settleDeadline) {
    await sleep(1000);
    const p = sum();
    series.push({ ts: Date.now(), active: p.active || 0, failed: p.failed || 0 });
    process.stdout.write(`\r   ramp: dimulai ${p.started}/${pairsN} | tersambung ${p.connected} | gagal ${p.failed} | proses ${p.inProgress}     `);
    if (workers.every((w) => w.allStarted) && p.started >= pairsN && p.inProgress === 0) break;
  }
  process.stdout.write('\n');
  const tRampEnd = Date.now();
  await sleep(3000);

  // measurement window
  const tHold0 = Date.now();
  workers.forEach((w) => w.ch.send({ cmd: 'window', w: 1 }));
  const holdEnd = tHold0 + CFG.holdSec * 1000;
  while (Date.now() < holdEnd) {
    await sleep(1000);
    const p = sum();
    series.push({ ts: Date.now(), active: p.active || 0, failed: p.failed || 0 });
    const last = monitor.samples[monitor.samples.length - 1];
    const srv = last && last.cpu ? ` | server CPU ${Math.round(last.cpu.total)}% RAM ${Math.round(last.mem.usedMB)}MB${last.net ? ` net ↓${Math.round(last.net.rxMbps)}/↑${Math.round(last.net.txMbps)} Mbps` : ''}` : '';
    process.stdout.write(`\r   hold: ${Math.round((holdEnd - Date.now()) / 1000)}s tersisa | panggilan aktif ${p.active}${srv}      `);
  }
  process.stdout.write('\n');
  const tHold1 = Date.now();
  workers.forEach((w) => w.ch.send({ cmd: 'window', w: 2 }));
  await sleep(1500); // drain in-flight packets

  workers.forEach((w) => w.ch.send({ cmd: 'collect' }));
  for (let i = 0; i < 100 && !workers.every((w) => w.collected); i++) await sleep(100);
  workers.forEach((w) => w.ch.send({ cmd: 'teardown' }));
  for (let i = 0; i < 600 && !workers.every((w) => w.tornDown || w.exited); i++) await sleep(100);
  workers.forEach((w) => { if (!w.exited) try { w.ch.kill(); } catch (_) {} });
  const tEnd = Date.now();
  series.push({ ts: tEnd, active: 0, failed: 0 });
  const durations = { talk: [], session: [] };
  for (const w of workers) if (w.callDurations) { durations.talk.push(...w.callDurations.talk); durations.session.push(...w.callDurations.session); }

  const r = aggregateStage(stageNo, users, pairsN, rampMs, nWorkers, workers.map((w) => w.collected).filter(Boolean), { tStage, tRampEnd, tHold0, tHold1, tEnd }, series);
  r.callDuration = { talkSec: summarize(durations.talk), sessionSec: summarize(durations.session) };
  r.vu = {
    target: users, pairs: pairsN,
    rampSec: rampMs / 1000, arrivalVuPerSec: round(users / (rampMs / 1000), 1),
    peakActiveVu: Math.max(0, ...series.map((x) => x.active)) * 2,
    holdSec: round((tHold1 - tHold0) / 1000, 1), stageSec: round((tEnd - tStage) / 1000, 1),
    workers: nWorkers,
  };
  return r;
}

function aggregateStage(stageNo, users, pairsN, rampMs, nWorkers, parts, t, series) {
  const lat = {}; const failures = {}; const c = {}; const media = { sent: 0, recv: 0, bytesSent: 0 };
  let jitters = []; let mediaDead = 0; const gen = [];
  for (const p of parts) {
    for (const [k, arr] of Object.entries(p.lat)) (lat[k] = lat[k] || []).push(...arr);
    for (const [k, v] of Object.entries(p.failures)) failures[k] = (failures[k] || 0) + v;
    for (const [k, v] of Object.entries(p.counters)) c[k] = (c[k] || 0) + v;
    media.sent += p.media.sent; media.recv += p.media.recv; media.bytesSent += p.media.bytesSent;
    jitters = jitters.concat(p.jitters);
    mediaDead += p.mediaDeadStreams;
    gen.push(p.gen);
  }
  const L = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, summarize(v)]));
  const holdSec = (t.tHold1 - t.tHold0) / 1000;
  const established = c.connected || 0;
  const res = {
    stage: stageNo, users, pairs: pairsN, rampSec: rampMs / 1000, holdSec: round(holdSec, 1), workers: nWorkers,
    calls: {
      attempted: pairsN, established, failed: c.failed || 0,
      successPct: round((established / Math.max(1, pairsN)) * 100),
      droppedDuringHold: (c.gatewayHangup || 0) + (c.wsDropped || 0), mediaDeadStreams: mediaDead,
    },
    latency: L,
    media: {
      sentPkts: media.sent, recvPkts: media.recv,
      lossPct: media.sent ? round(Math.max(0, (1 - media.recv / media.sent) * 100), 3) : null,
      jitter: summarize(jitters),
      oneWay: L.mediaOneWay,
      generatorTxMbps: round((media.bytesSent * 8) / 1e6 / Math.max(1, holdSec)),
    },
    turn: { retransmits: c.turnRetransmits || 0 },
    signaling: {
      usersBroadcastMB: round((c.wsBytesUsers || 0) / 1048576), usersBroadcastMsgs: c.wsMsgsUsers || 0,
      otherMsgs: c.wsMsgsOther || 0,
    },
    failures: Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 10),
    generator: {
      eventLoopP99Ms: round(Math.max(0, ...gen.map((g) => g.eventLoopP99Ms))),
      cpuPctMax: round(Math.max(0, ...gen.map((g) => g.cpuPct))),
      rssMBTotal: round(gen.reduce((a, g) => a + g.rssMB, 0)),
    },
    server: {
      hold: aggServer(sampleWindow(t.tHold0, t.tHold1)),
      wholeStage: aggServer(sampleWindow(t.tStage, t.tEnd)),
    },
    times: t,
    series,
  };
  res.generator.saturated = res.generator.eventLoopP99Ms > 100 || res.generator.cpuPctMax > 90;
  res.evaluation = evaluate(res);
  return res;
}

function evaluate(r) {
  return evaluateStage(r, THRESH);
}

async function waitServerQuiet(baselinePorts) {
  // Wait until CoTURN released the previous stage's relay ports (or 90 s max)
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const last = monitor.samples[monitor.samples.length - 1];
    if (!last || last.relayPorts === undefined || last.relayPorts <= baselinePorts + 10) return;
    await sleep(2000);
  }
}

function printRow(r) {
  const s = r.server.hold;
  const e = r.evaluation.level === 'PASS' ? '✅' : r.evaluation.level === 'WARN' ? '⚠️ ' : '❌';
  console.log(`   ${e} SERVER ${r.evaluation.level} / SIGNALING ${r.evaluation.signalingLevel} | sukses ${r.calls.successPct}% | setup p95 ${r.latency.setup ? r.latency.setup.p95 : '-'} ms | loss ${r.media.lossPct}% | jitter p95 ${r.media.jitter.p95} ms | one-way p95 ${r.media.oneWay ? r.media.oneWay.p95 : '-'} ms`);
  console.log(`      durasi call rata-rata ${r.callDuration ? r.callDuration.talkSec.avg : '-'} s | server CPU avg ${s.cpu.avg}% (tanpa generator ${s.cpuExclGen.avg}%, max ${s.cpu.max}%) | coturn ${s.coturnCpu.avg}% | gateway ${s.gatewayCpu.avg}% | RAM ${s.memUsedMB.max} MB (${s.memPct.max}%) | net ↓${s.rxMbps.avg} ↑${s.txMbps.avg} Mbps | relay ports ${s.relayPorts.max}`);
  if (r.failures.length) console.log('      penyebab gagal teratas:', r.failures.slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(' ; '));
  if (r.generator.saturated) console.log('      ⚠️  load generator jenuh (event loop p99', r.generator.eventLoopP99Ms, 'ms) — hasil tahap ini bisa dibatasi oleh generator, bukan server.');
}

// ---------------- main ----------------
async function main() {
  console.log('='.repeat(78));
  console.log(' UJI KAPASITAS COTURN + SIGNALING GATEWAY (alur panggilan A → B nyata)');
  console.log(` Target WS ${CFG.wsUrl} | TURN udp://${CFG.turnHost}:${CFG.turnPort} | profil ${CFG.profile}`);
  console.log(` Tahapan: ${CFG.tiers.join(', ')} user | output: ${RUN_DIR}`);
  console.log('='.repeat(78));

  if (CFG.monitor !== 'none') {
    log(`Menyalakan monitor server (${CFG.monitor})...`);
    await startMonitor();
    const i = monitor.info;
    log(`Server: ${i.hostname} | ${i.cores} vCPU ${i.cpuModel} | RAM ${Math.round(i.memTotalMB)} MB | ${i.os || ''}`);
    const lg = (i.processes || []).filter((p) => p.role === 'loadgen' && !String(p.cmd).includes('run-capacity-test') && !String(p.cmd).includes('pair-worker'));
    if (lg.length) log(`⚠️  PERINGATAN: proses benchmark lain sedang berjalan di server: ${lg.map((p) => p.pid + ' ' + p.cmd.slice(0, 60)).join(' | ')}`);
  }

  // idle baseline
  monitor.stage = 0;
  await sleep(5000);
  const idle = aggServer(monitor.samples.filter((s) => s.stage === 0));
  const baselinePorts = idle.relayPorts.max || 0;

  const results = {
    runId, label: CFG.label, startedAt: new Date().toISOString(),
    config: { ...CFG, turnPass: '<redacted>', sshKey: CFG.sshKey ? '<set>' : null, thresholds: THRESH, profile: PROFILE },
    generator: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cores: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, memMB: Math.round(os.totalmem() / 1048576), node: process.version, location: CFG.generatorLocation },
    serverInfo: monitor.info, idle, stages: [], timeline: [],
  };
  const save = () => fs.writeFileSync(path.join(RUN_DIR, 'results.json'), JSON.stringify(results, null, 2));
  save();

  for (let i = 0; i < CFG.tiers.length; i++) {
    const r = await runStage(i + 1, CFG.tiers[i]);
    results.stages.push(r);
    results.timeline.push(...r.series.map((x) => ({ ts: x.ts, active: x.active * 2 })));
    save();
    printRow(r);
    if (r.evaluation.level === 'FAIL' && CFG.stopOnFail) {
      log(`🛑 Breaking point server tercapai pada ${r.users} user. Pengujian dihentikan.`);
      break;
    }
    if (r.generator.saturated && r.evaluation.level !== 'FAIL' && CFG.stopOnSaturation) {
      log('⚠️  Generator jenuh: tambah --workers atau jalankan dari mesin generator yang lebih besar. Pengujian dihentikan agar data tetap valid.');
      results.stoppedBecause = 'generator_saturated';
      break;
    }
    if (i < CFG.tiers.length - 1) {
      results.timeline.push({ ts: Date.now(), active: 0 });
      monitor.stage = `cooldown${i + 1}`;
      log(`Cooldown ${CFG.cooldownSec}s...`);
      await sleep(CFG.cooldownSec * 1000);
      await waitServerQuiet(baselinePorts);
    }
  }
  results.finishedAt = new Date().toISOString();
  save();
  monitor.stop();
  samplesFile.end();

  log('Membangun laporan...');
  const { buildReport } = require('./build-report');
  const out = await buildReport(RUN_DIR, { pdf: CFG.pdf });
  log(`Selesai. Laporan: ${out.html}${out.pdf ? `\n           PDF    : ${out.pdf}` : ''}`);
  process.exit(0);
}

process.on('SIGINT', () => { log('Dihentikan (Ctrl+C). Data yang sudah terkumpul tersimpan di', RUN_DIR); try { monitor.stop(); } catch (_) {} process.exit(130); });
main().catch((e) => { console.error('FATAL:', e.stack || e.message); try { monitor.stop(); } catch (_) {} process.exit(1); });
