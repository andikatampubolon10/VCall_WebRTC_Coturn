'use strict';
/**
 * Penilaian SLA per tahap, dipisah menjadi dua lingkup:
 *   - server    : kapasitas server/media (CoTURN relay, CPU, RAM, kualitas media, panggilan tersambung)
 *                 -> menentukan status tahap & breaking point server
 *   - signaling : kinerja signaling gateway aplikasi (waktu setup panggilan, CPU gateway)
 *                 -> dilaporkan terpisah; tidak menghentikan uji kapasitas server
 */

const DEFAULT_THRESH = {
  successPct: { warn: 99, fail: 95 },
  lossPct: { warn: 1, fail: 3 },
  jitterP95: { warn: 20, fail: 30 },
  latencyP95: { warn: 100, fail: 150 },
  setupP95: { warn: 1500, fail: 3000 },
  cpuAvg: { warn: 70, fail: 85 },
  memPct: { warn: 80, fail: 90 },
  gatewayCpu: { warn: 70, fail: 95 },
};

function worst(checks) {
  return checks.some((c) => c.level === 'FAIL') ? 'FAIL' : checks.some((c) => c.level === 'WARN') ? 'WARN' : 'PASS';
}

function evaluate(r, TH = DEFAULT_THRESH) {
  const checks = [];
  const add = (scope, name, value, th, higherIsBad, unit) => {
    if (value === null || value === undefined || !th) return;
    const bad = (lim) => (higherIsBad ? value > lim : value < lim);
    const level = bad(th.fail) ? 'FAIL' : bad(th.warn) ? 'WARN' : 'OK';
    checks.push({ scope, name, value, unit, level, warn: th.warn, fail: th.fail });
  };
  const h = r.server.hold;
  const genOnServer = h.loadgenCpu && h.loadgenCpu.avg !== null && h.loadgenCpu.avg > 0;

  add('server', 'Panggilan berhasil tersambung', r.calls.successPct, TH.successPct, false, '%');
  add('server', 'Packet loss media', r.media.lossPct, TH.lossPct, true, '%');
  add('server', 'Jitter p95', r.media.jitter.p95, TH.jitterP95, true, 'ms');
  add('server', 'Latensi one-way p95', r.media.oneWay && r.media.oneWay.p95, TH.latencyP95, true, 'ms');
  add('server', genOnServer ? 'CPU server tanpa generator (rata-rata)' : 'CPU server (rata-rata)', genOnServer && h.cpuExclGen ? h.cpuExclGen.avg : h.cpu.avg, TH.cpuAvg, true, '%');
  add('server', 'RAM server', h.memPct.max, TH.memPct, true, '%');
  add('signaling', 'Waktu setup panggilan p95', r.latency.setup && r.latency.setup.p95, TH.setupP95, true, 'ms');
  add('signaling', 'CPU gateway Node.js', h.gatewayCpu.avg, TH.gatewayCpu, true, '% 1 core');

  return {
    level: worst(checks.filter((c) => c.scope === 'server')),
    signalingLevel: worst(checks.filter((c) => c.scope === 'signaling')),
    checks,
    generatorSaturated: !!(r.generator && r.generator.saturated),
  };
}

module.exports = { evaluate, DEFAULT_THRESH };
