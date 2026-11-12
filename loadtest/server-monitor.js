/**
 * Server telemetry agent (Linux, zero dependencies).
 * Prints one JSON line per second to stdout:
 *   first line  : {"kind":"info", ...static server & CoTURN configuration...}
 *   then        : {"kind":"sample", ...cpu/mem/net/udp/process metrics...}
 *
 * Run on the CoTURN server:   node server-monitor.js
 * or streamed over SSH:       ssh host 'node -' < server-monitor.js
 * Exits by itself when stdout is closed or after MAX_RUNTIME (default 6h).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const INTERVAL = Number(process.env.MON_INTERVAL_MS || 1000);
const MAX_RUNTIME = Number(process.env.MON_MAX_RUNTIME_MS || 6 * 3600 * 1000);
const CLK_TCK = 100;

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const sh = (c) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); } catch (_) { return null; } };

function out(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) { process.exit(0); }
}
process.stdout.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), MAX_RUNTIME).unref();

// ---------- discovery ----------
function findTurnConf() {
  for (const f of ['/etc/turnserver.conf', '/etc/coturn/turnserver.conf', '/usr/local/etc/turnserver.conf']) {
    const t = read(f);
    if (t) return { file: f, text: t };
  }
  return null;
}
function parseConf(text) {
  const conf = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([\w-]+)\s*(?:=\s*(.*))?$/.exec(line);
    if (!m) continue;
    let v = m[2] === undefined ? true : m[2].trim();
    if (m[1] === 'user' || m[1].includes('secret') || m[1].includes('password')) v = '<redacted>';
    conf[m[1]] = v;
  }
  return conf;
}

function listProcs() {
  const res = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const cmd = read(`/proc/${pid}/cmdline`);
    if (!cmd) continue;
    res.push({ pid: Number(pid), cmd: cmd.replace(/\0/g, ' ').trim() });
  }
  return res;
}

const ROLES = [
  { role: 'coturn', test: (c) => /(^|\/)turnserver(\s|$)/.test(c) },
  { role: 'gateway', test: (c) => /node/.test(c) && /gateway/.test(c) && !/server-monitor/.test(c) },
  { role: 'app', test: (c) => /node/.test(c) && /(app-a|app-b|server\/index\.js)/.test(c) },
  { role: 'loadgen', test: (c) => /node/.test(c) && /(run-capacity-test|pair-worker|run-live-benchmark|test-live-measured)/.test(c) },
];

function discoverProcs() {
  const found = [];
  for (const p of listProcs()) {
    for (const r of ROLES) if (r.test(p.cmd)) { found.push({ ...p, role: r.role }); break; }
  }
  return found;
}

function primaryIface() {
  const dev = read('/proc/net/dev') || '';
  let best = null;
  for (const line of dev.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(\d+)/.exec(line);
    if (!m || m[1] === 'lo' || m[1].startsWith('docker') || m[1].startsWith('veth') || m[1].startsWith('br-')) continue;
    if (!best || Number(m[2]) > best.bytes) best = { name: m[1], bytes: Number(m[2]) };
  }
  return best ? best.name : null;
}

// ---------- samplers ----------
function cpuStat() {
  const lines = (read('/proc/stat') || '').split('\n').filter((l) => l.startsWith('cpu'));
  return lines.map((l) => {
    const p = l.trim().split(/\s+/);
    const v = p.slice(1).map(Number); // user nice system idle iowait irq softirq steal
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return { name: p[0], user: v[0] + v[1], system: v[2], idle: v[3], iowait: v[4], irq: v[5], softirq: v[6], steal: v[7] || 0, total };
  });
}
function cpuDiff(a, b) {
  const dt = b.total - a.total || 1;
  const pct = (k) => ((b[k] - a[k]) / dt) * 100;
  return { busy: 100 - pct('idle') - pct('iowait'), user: pct('user'), system: pct('system'), iowait: pct('iowait'), softirq: pct('softirq') + pct('irq'), steal: pct('steal') };
}

function memInfo() {
  const t = read('/proc/meminfo') || '';
  const g = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t); return m ? Number(m[1]) / 1024 : 0; };
  const total = g('MemTotal'), avail = g('MemAvailable');
  return { totalMB: total, usedMB: total - avail, usedPct: ((total - avail) / total) * 100, swapUsedMB: g('SwapTotal') - g('SwapFree') };
}

function netDev(iface) {
  const t = read('/proc/net/dev') || '';
  const line = t.split('\n').find((l) => l.trim().startsWith(iface + ':'));
  if (!line) return null;
  const v = line.split(':')[1].trim().split(/\s+/).map(Number);
  return { rxBytes: v[0], rxPkts: v[1], rxErrs: v[2], rxDrop: v[3], txBytes: v[8], txPkts: v[9], txErrs: v[10], txDrop: v[11] };
}

function snmpUdp() {
  const t = read('/proc/net/snmp') || '';
  const lines = t.split('\n').filter((l) => l.startsWith('Udp:'));
  if (lines.length < 2) return null;
  const k = lines[0].split(/\s+/).slice(1), v = lines[1].split(/\s+/).slice(1).map(Number);
  return Object.fromEntries(k.map((x, i) => [x, v[i]]));
}

function sockstat() {
  const t = read('/proc/net/sockstat') || '';
  const g = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  return { tcpInuse: g(/TCP: inuse (\d+)/), tcpTw: g(/TCP:.*tw (\d+)/), udpInuse: g(/UDP: inuse (\d+)/), udpMemPages: g(/UDP:.*mem (\d+)/) };
}

function relayPortsInUse(minP, maxP, uid) {
  let n = 0;
  for (const f of ['/proc/net/udp', '/proc/net/udp6']) {
    const t = read(f);
    if (!t) continue;
    const lines = t.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 2) continue;
      const port = parseInt(parts[1].split(':')[1], 16);
      // hanya socket milik user CoTURN (generator di mesin yang sama juga memakai port di rentang ini)
      if (uid !== null && Number(parts[7]) !== uid) continue;
      if (port >= minP && port <= maxP) n++;
    }
  }
  return n;
}

function procStat(pid) {
  const s = read(`/proc/${pid}/stat`);
  if (!s) return null;
  const after = s.slice(s.lastIndexOf(')') + 2).split(' ');
  const utime = Number(after[11]), stime = Number(after[12]), threads = Number(after[17]);
  const status = read(`/proc/${pid}/status`) || '';
  const rss = /VmRSS:\s+(\d+)/.exec(status);
  let fds = null;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`).length; } catch (_) {}
  return { ticks: utime + stime, threads, rssMB: rss ? Number(rss[1]) / 1024 : null, fds };
}

function conntrack() {
  const c = read('/proc/sys/net/netfilter/nf_conntrack_count');
  const m = read('/proc/sys/net/netfilter/nf_conntrack_max');
  return c ? { count: Number(c), max: Number(m) } : null;
}

// ---------- info ----------
const iface = primaryIface();
const confFile = findTurnConf();
const conf = confFile ? parseConf(confFile.text) : {};
const MIN_PORT = Number(conf['min-port'] || 49152);
const MAX_PORT = Number(conf['max-port'] || 65535);
let procs = discoverProcs();
function coturnUid() {
  const p = procs.find((x) => x.role === 'coturn');
  const m = p ? /^Uid:\s+(\d+)/m.exec(read('/proc/' + p.pid + '/status') || '') : null;
  return m ? Number(m[1]) : null;
}
const COTURN_UID = coturnUid();

function limitsOf(pid) {
  const t = read(`/proc/${pid}/limits`) || '';
  const m = /Max open files\s+(\S+)\s+(\S+)/.exec(t);
  return m ? { soft: m[1], hard: m[2] } : null;
}

out({
  kind: 'info',
  ts: Date.now(),
  hostname: os.hostname(),
  kernel: os.release(),
  os: (/(?:^|\n)PRETTY_NAME="?([^"\n]+)/.exec(read('/etc/os-release') || '') || [])[1] || os.type(),
  cpuModel: (os.cpus()[0] || {}).model,
  cores: os.cpus().length,
  memTotalMB: os.totalmem() / 1048576,
  iface,
  ifaceSpeedMbps: Number(read(`/sys/class/net/${iface}/speed`)) || null,
  gcpMachineType: sh("curl -s -m 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/machine-type | awk -F/ '{print $NF}'"),
  gcpZone: sh("curl -s -m 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}'"),
  nodeVersion: process.version,
  coturnVersion: sh("dpkg-query -W -f='coturn ${Version}' coturn 2>/dev/null") || sh("turnserver --version 2>&1 | head -1"),
  turnConfFile: confFile ? confFile.file : null,
  turnConf: conf,
  relayPortRange: [MIN_PORT, MAX_PORT],
  sysctl: {
    rmem_max: Number(read('/proc/sys/net/core/rmem_max')),
    wmem_max: Number(read('/proc/sys/net/core/wmem_max')),
    netdev_max_backlog: Number(read('/proc/sys/net/core/netdev_max_backlog')),
    file_max: Number(read('/proc/sys/fs/file-max')),
    conntrack_max: Number(read('/proc/sys/net/netfilter/nf_conntrack_max')) || null,
  },
  processes: procs.map((p) => ({ pid: p.pid, role: p.role, cmd: p.cmd.slice(0, 160), maxOpenFiles: limitsOf(p.pid) })),
});

// ---------- loop ----------
let prev = { cpu: cpuStat(), net: iface ? netDev(iface) : null, udp: snmpUdp(), t: Date.now(), proc: new Map() };
for (const p of procs) prev.proc.set(p.pid, procStat(p.pid));
let tick = 0;

setInterval(() => {
  tick++;
  if (tick % 10 === 0) { // re-discover (pm2 restarts, etc.)
    procs = discoverProcs();
  }
  const t = Date.now();
  const dt = (t - prev.t) / 1000 || 1;
  const cpu = cpuStat();
  const total = cpuDiff(prev.cpu[0], cpu[0]);
  const perCore = cpu.slice(1).map((c, i) => (prev.cpu[i + 1] ? cpuDiff(prev.cpu[i + 1], c).busy : 0));
  const net = iface ? netDev(iface) : null;
  const udp = snmpUdp();
  const rate = (a, b, k) => (a && b ? Math.max(0, (b[k] - a[k]) / dt) : null);

  const roles = {};
  const procMap = new Map();
  for (const p of procs) {
    const s = procStat(p.pid);
    if (!s) continue;
    procMap.set(p.pid, s);
    const ps = prev.proc.get(p.pid);
    const cpuPct = ps ? ((s.ticks - ps.ticks) / CLK_TCK / dt) * 100 : 0;
    const r = roles[p.role] || (roles[p.role] = { cpuPct: 0, rssMB: 0, threads: 0, fds: 0, count: 0 });
    r.cpuPct += cpuPct; r.rssMB += s.rssMB || 0; r.threads += s.threads || 0; r.fds += s.fds || 0; r.count++;
  }

  const load = os.loadavg();
  out({
    kind: 'sample',
    ts: t,
    cpu: { total: total.busy, user: total.user, system: total.system, iowait: total.iowait, softirq: total.softirq, steal: total.steal, maxCore: Math.max(...perCore, 0), perCore },
    load1: load[0], load5: load[1],
    mem: memInfo(),
    net: net && prev.net ? {
      rxMbps: (rate(prev.net, net, 'rxBytes') * 8) / 1e6,
      txMbps: (rate(prev.net, net, 'txBytes') * 8) / 1e6,
      rxPps: rate(prev.net, net, 'rxPkts'), txPps: rate(prev.net, net, 'txPkts'),
      rxDropPs: rate(prev.net, net, 'rxDrop'), txDropPs: rate(prev.net, net, 'txDrop'),
      errPs: rate(prev.net, net, 'rxErrs') + rate(prev.net, net, 'txErrs'),
    } : null,
    udp: udp && prev.udp ? {
      inPs: rate(prev.udp, udp, 'InDatagrams'), outPs: rate(prev.udp, udp, 'OutDatagrams'),
      inErrPs: rate(prev.udp, udp, 'InErrors'), rcvbufErrPs: rate(prev.udp, udp, 'RcvbufErrors'),
      sndbufErrPs: rate(prev.udp, udp, 'SndbufErrors'), noPortsPs: rate(prev.udp, udp, 'NoPorts'),
    } : null,
    sock: sockstat(),
    relayPorts: relayPortsInUse(MIN_PORT, MAX_PORT, COTURN_UID),
    conntrack: conntrack(),
    procs: roles,
  });
  prev = { cpu, net, udp, t, proc: procMap };
}, INTERVAL);
