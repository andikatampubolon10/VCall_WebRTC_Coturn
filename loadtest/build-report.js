#!/usr/bin/env node
/**
 * Build the capacity-test report (HTML + PDF) from a results directory.
 *   node build-report.js results/<run-id> [--pdf false]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluate } = require('./lib/evaluate');

const esc = (s) => String(s === null || s === undefined ? '–' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '–' : Number(v).toLocaleString('id-ID', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const pctCore = (v, cores) => (v === null || v === undefined ? null : v / cores); // process % of one core -> % of whole server

const C = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', grid: '#e4e3df', axis: '#8a8984', text: '#0b0b0b', text2: '#52514e' };
const STATUS = {
  PASS: { icon: '✔', label: 'LULUS', color: C.good },
  WARN: { icon: '▲', label: 'WASPADA', color: C.warning },
  FAIL: { icon: '✖', label: 'GAGAL', color: C.critical },
};
const badge = (lvl) => { const s = STATUS[lvl] || STATUS.PASS; return `<span class="badge" style="--c:${s.color}">${s.icon} ${s.label}</span>`; };

// ---------------- SVG line chart (linear x = users) ----------------
function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function lineChart({ title, subtitle, unit, xs, series, refLines = [], yMax, yMin = 0, w = 520, h = 250, xLabel = 'Jumlah user bersamaan', markers = true }) {
  const m = { l: 52, r: 96, t: 14, b: 38 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const allY = series.flatMap((s) => s.values).filter((v) => v !== null && isFinite(v));
  const top = yMax !== undefined ? yMax : niceMax(Math.max(...allY, ...refLines.map((r) => r.y), 0) * 1.1);
  const xMax = niceMax(Math.max(...xs) * 1.05);
  const X = (x) => m.l + (x / xMax) * pw;
  const Y = (y) => m.t + ph - ((y - yMin) / (top - yMin)) * ph;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((top - yMin) * i) / 4;
    g += `<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}" stroke-width="1"/>`;
    g += `<text x="${m.l - 6}" y="${Y(v) + 3.5}" text-anchor="end" class="tick">${fmt(v, top < 10 ? 1 : 0)}</text>`;
  }
  for (let i = 0; i <= 5; i++) {
    const v = (xMax * i) / 5;
    g += `<text x="${X(v)}" y="${m.t + ph + 16}" text-anchor="middle" class="tick">${fmt(v, 0)}</text>`;
  }
  g += `<line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="${C.axis}" stroke-width="1"/>`;
  g += `<text x="${m.l + pw / 2}" y="${h - 4}" text-anchor="middle" class="axlabel">${esc(xLabel)}</text>`;
  for (const r of refLines) {
    if (r.y > top) continue;
    g += `<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(r.y)}" y2="${Y(r.y)}" stroke="${C.critical}" stroke-width="1" stroke-dasharray="4 3"/>`;
    g += `<text x="${m.l + pw + 4}" y="${Y(r.y) + 3.5}" class="ref">${esc(r.label)}</text>`;
  }
  const labelYs = [];
  series.forEach((s) => {
    const pts = xs.map((x, i) => [x, s.values[i]]).filter(([, y]) => y !== null && isFinite(y));
    if (!pts.length) return;
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(Math.min(y, top)).toFixed(1)}`).join(' ')}"/>`;
    if (markers) for (const [x, y] of pts) g += `<circle cx="${X(x).toFixed(1)}" cy="${Y(Math.min(y, top)).toFixed(1)}" r="4" fill="${s.color}" stroke="#fcfcfb" stroke-width="2"/>`;
    // direct label at last point (avoid collisions)
    const [lx, ly] = pts[pts.length - 1];
    let yy = Y(Math.min(ly, top)) + 3.5;
    for (const o of labelYs) if (Math.abs(o - yy) < 12) yy = o + 12;
    labelYs.push(yy);
    if (series.length > 1) g += `<text x="${X(lx) + 8}" y="${yy}" class="dlabel">${esc(s.name)}</text>`;
  });
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<figure class="chart"><figcaption><b>${esc(title)}</b>${unit ? ` <span class="unit">(${esc(unit)})</span>` : ''}${subtitle ? `<br><span class="sub">${esc(subtitle)}</span>` : ''}</figcaption>${legend}
<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}">${g}</svg></figure>`;
}

// ---------------- analysis ----------------
const SETUP_PHASES = [
  ['wsOpen', 'Koneksi WebSocket', 'signaling gateway'],
  ['register', 'Register user', 'signaling gateway'],
  ['callToAccept', 'Call → Incoming → Accept', 'signaling gateway'],
  ['allocate', 'TURN Allocate', 'CoTURN'],
  ['sdpExchange', 'Offer/Answer + ICE candidate', 'signaling gateway'],
  ['bind', 'CreatePermission + ChannelBind', 'CoTURN'],
];
function analyze(R) {
  const st = R.stages;
  const cores = (R.serverInfo && R.serverInfo.cores) || 1;
  // Status SERVER (CoTURN/media/CPU/RAM) menentukan kapasitas & breaking point server
  const firstFail = st.find((s) => s.evaluation.level === 'FAIL');
  const beforeFail = firstFail ? st.filter((s) => s.users < firstFail.users) : st;
  const okAll = beforeFail.filter((s) => s.evaluation.level !== 'FAIL');
  const okClean = okAll.filter((s) => !s.generator.saturated);
  const best = okAll.length ? okAll[okAll.length - 1] : null;
  const bestClean = okClean.length ? okClean[okClean.length - 1] : null;
  // Status SIGNALING (gateway aplikasi) dilaporkan terpisah
  const sigFirstFail = st.find((s) => s.evaluation.signalingLevel === 'FAIL');
  const sigOk = st.filter((s) => !sigFirstFail || s.users < sigFirstFail.users);
  const sigBest = sigOk.length ? sigOk[sigOk.length - 1] : null;
  const findings = [];
  const recs = [];

  const failText = (s, scope) => s.evaluation.checks.filter((c) => c.level === 'FAIL' && c.scope === scope)
    .map((c) => `${esc(c.name)} = <b>${fmt(c.value, 2)} ${esc(c.unit)}</b> (batas ${fmt(c.fail, 2)})`).join('; ');
  if (firstFail) findings.push(`<b>Server/media</b>: pada <b>${fmt(firstFail.users, 0)} user</b> kriteria server terlampaui: ${failText(firstFail, 'server')}.`);
  else if (st.length) findings.push(`<b>Server/media</b>: sampai <b>${fmt(st[st.length - 1].users, 0)} user</b> tidak ada kriteria server (panggilan tersambung, loss, jitter, latensi, CPU, RAM) yang dilanggar.`);
  const satStages = st.filter((s) => s.generator.saturated);
  if (satStages.length) findings.push(`Load generator mulai jenuh pada <b>${fmt(satStages[0].users, 0)} user</b> (event loop p99 ${fmt(satStages[0].generator.eventLoopP99Ms, 0)} ms). Karena generator berbagi 4 vCPU dengan CoTURN, penurunan kualitas di tahap ini bisa disebabkan oleh generator yang tidak sempat mengirim/membaca paket, bukan semata-mata oleh server.`);

  const sigRef = sigFirstFail;
  let gatewayBottleneck = false;
  if (sigRef) {
    findings.push(`<b>Signaling gateway</b>: kriteria signaling mulai dilanggar pada <b>${fmt(sigRef.users, 0)} user</b>: ${failText(sigRef, 'signaling')}. Ini batas aplikasi gateway saat ini, bukan batas CoTURN.`);
    const phases = SETUP_PHASES.map(([k, label, owner]) => ({ k, label, owner, p95: sigRef.latency[k] && sigRef.latency[k].p95 })).filter((p) => p.p95 !== null && p.p95 !== undefined);
    phases.sort((a, b) => b.p95 - a.p95);
    const top = phases[0];
    const w = sigRef.server.wholeStage;
    if (top) {
      findings.push(`Waktu setup panggilan melambat terutama di fase <b>${esc(top.label)}</b> (p95 <b>${fmt(top.p95, 0)} ms</b>), yang ditangani oleh <b>${esc(top.owner)}</b>. Saat ramp-up tahap ini CPU server memuncak <b>${fmt(w.cpu.max)}%</b> dan CPU gateway <b>${fmt(w.gatewayCpu.max)}%</b> dari satu core, sedangkan setelah panggilan tersambung kualitas media ${sigRef.evaluation.level === 'FAIL' ? 'juga menurun' : 'tetap baik'} (loss ${fmt(sigRef.media.lossPct, 2)}%). Panggilan yang sudah berjalan tidak terganggu karena media mengalir langsung lewat CoTURN.`);
      if (top.owner.startsWith('signaling gateway')) gatewayBottleneck = true;
    }
  }
  const ref = firstFail || sigRef || st[st.length - 1];
  if (ref) {
    const s = ref.server.hold;
    const gw = s.gatewayCpu.avg, ct = s.coturnCpu.avg;
    if (gatewayBottleneck || (gw !== null && gw >= 70)) {
      if (gw !== null && gw >= 70) findings.push(`Proses <b>signaling gateway (Node.js)</b> memakai rata-rata <b>${fmt(gw)}%</b> dari satu core (puncak ${fmt(s.gatewayCpu.max)}%). Node.js hanya berjalan di satu thread, sehingga gateway jenuh lebih dulu walaupun CPU server total masih ${fmt(s.cpu.avg)}%.`);
      else findings.push(`Beban gateway bersifat <b>lonjakan saat banyak user masuk/memanggil</b>: setiap register/call/accept/hangup memicu pengiriman daftar seluruh user ke semua client, sehingga antrean pesan signaling (offer/answer/ICE) tertahan di belakang broadcast tersebut. Saat panggilan sudah berjalan, CPU gateway kembali rendah (${fmt(gw)}%).`);
      recs.push('Hentikan <code>broadcastUserList()</code> ke <i>semua</i> client pada setiap register/call/accept/hangup (biaya O(N²)); kirim hanya perubahan (delta) atau hanya ke pihak terkait.');
      recs.push('Ganti <code>fs.appendFileSync</code> di setiap log dengan logger asinkron (mis. stream/pino) atau matikan log per-pesan di produksi.');
      recs.push('Jalankan gateway dalam mode cluster PM2 (mis. 4 instance) dengan sticky session atau broker (Redis pub/sub) agar memakai semua core.');
    }
    if (ref.signaling && ref.signaling.usersBroadcastMB > 50) {
      findings.push(`Selama tahap ${fmt(ref.users, 0)} user, gateway mengirim <b>${fmt(ref.signaling.usersBroadcastMB)} MB</b> pesan daftar user (<code>type:"users"</code>) dalam ${fmt(ref.signaling.usersBroadcastMsgs, 0)} pesan. Lalu lintas ini tumbuh kuadratik terhadap jumlah user.`);
    }
    if (ct !== null && ct / cores >= 60) findings.push(`Proses <b>CoTURN</b> memakai ${fmt(ct)}% CPU (≈${fmt(ct / cores)}% kapasitas server); relay media menjadi pembatas CPU.`);
    if (s.cpuSoftirq.avg !== null && s.cpuSoftirq.avg > 15) {
      findings.push(`Porsi CPU untuk <b>softirq (pemrosesan paket jaringan di kernel)</b> mencapai ${fmt(s.cpuSoftirq.avg)}%; beban paket UDP (pps) menjadi faktor dominan.`);
      recs.push('Aktifkan multi-queue NIC / RPS, dan naikkan <code>net.core.netdev_max_backlog</code>.');
    }
    if ((s.udpRcvbufErrPs.max || 0) > 0 || (s.udpErrPs.max || 0) > 0) {
      const genHere = s.loadgenCpu.avg !== null && s.loadgenCpu.avg > 0;
      findings.push(`Kernel membuang datagram UDP karena buffer socket penuh (<b>${fmt(s.udpRcvbufErrPs.max, 0)} /detik</b> RcvbufErrors pada puncak)${genHere ? ' — karena generator berjalan di server yang sama dan sedang jenuh, sebagian besar drop ini kemungkinan terjadi di socket <i>generator</i> yang tidak sempat dibaca, bukan hanya di CoTURN' : ''}.`);
      const sc = (R.serverInfo && R.serverInfo.sysctl) || {};
      recs.push((sc.rmem_max && sc.rmem_max >= 8 * 1048576
        ? `rmem_max server sudah ${fmt(sc.rmem_max / 1048576, 0)} MB; naikkan juga <code>net.core.rmem_default</code> karena socket yang tidak meminta ukuran buffer khusus memakai nilai default ini`
        : 'Naikkan <code>net.core.rmem_max</code>/<code>rmem_default</code> (mis. 25 MB)') + ', dan pertimbangkan <code>relay-threads</code> sama dengan jumlah vCPU di CoTURN.');
    }
    if (s.cpuSteal.avg !== null && s.cpuSteal.avg > 5) findings.push(`CPU steal ${fmt(s.cpuSteal.avg)}%: VM kekurangan jatah CPU dari hypervisor (tipe mesin shared-core/burst).`);
    const range = R.serverInfo && R.serverInfo.relayPortRange;
    if (range && s.relayPorts.max) {
      const size = range[1] - range[0] + 1;
      if (s.relayPorts.max > size * 0.8) {
        findings.push(`Port relay terpakai ${fmt(s.relayPorts.max, 0)} dari ${fmt(size, 0)} port yang tersedia (${range[0]}–${range[1]}).`);
        recs.push('Perlebar <code>min-port</code>/<code>max-port</code> di turnserver.conf dan buka rentang UDP yang sama di firewall GCP.');
      }
    }
    if (s.memPct.max !== null && s.memPct.max >= 80) recs.push('Tambah RAM atau batasi <code>total-quota</code> CoTURN agar alokasi tidak melebihi memori.');
  }

  const conf = (R.serverInfo && R.serverInfo.turnConf) || {};
  if (conf.verbose) recs.push('CoTURN berjalan dengan opsi <code>verbose</code> dan menulis log ke file; di produksi matikan <code>verbose</code> agar CPU dan disk tidak terbebani log per-paket/per-alokasi.');
  if (st.some((s) => s.server.hold.loadgenCpu.avg)) findings.push('Load generator dijalankan <b>di server yang sama</b>. CPU yang dipakai generator dicatat terpisah dan <b>dikeluarkan</b> dari penilaian SLA CPU (kolom “CPU tanpa generator”); kebutuhan CPU CoTURN dan gateway diukur per proses sehingga tidak tercampur.');

  // Per-user resource cost (linear fit over passing stages, from idle baseline)
  let perUser = null;
  const fit = (xs, ys) => {
    const n = xs.length; if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0); if (!sxx) return null;
    const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
    return { slope: b, intercept: my - b * mx };
  };
  const src = (okClean.length >= 2 ? okClean : st).filter((s) => s.server.hold.cpu.avg !== null);
  if (src.length >= 2) {
    const xs = src.map((s) => s.users);
    const cpuF = fit(xs, src.map((s) => (s.server.hold.cpuExclGen && s.server.hold.cpuExclGen.avg !== null ? s.server.hold.cpuExclGen.avg : s.server.hold.cpu.avg)));
    const memF = fit(xs, src.map((s) => s.server.hold.memUsedMB.avg));
    const tx = src.map((s) => s.server.hold.txMbps.avg);
    const netF = tx.every((v) => v !== null) ? fit(xs, tx) : null;
    perUser = {
      cpuPct: cpuF ? cpuF.slope : null,
      memMB: memF ? memF.slope : null,
      txMbps: netF ? netF.slope : null,
      usersAtCpu85: cpuF && cpuF.slope > 0 ? Math.floor((85 - cpuF.intercept) / cpuF.slope) : null,
    };
  }
  const genCo = st.some((s) => s.server.hold.loadgenCpu.avg);
  if (genCo && perUser && perUser.usersAtCpu85) {
    findings.push(`<b>Estimasi kapasitas bila server hanya menjalankan CoTURN + gateway</b> (tanpa generator): dari regresi CPU tanpa generator (≈${fmt(perUser.cpuPct, 3)}% CPU per user), batas 85% CPU tercapai pada sekitar <b>${fmt(perUser.usersAtCpu85, 0)} user</b>. Ini ekstrapolasi; untuk membuktikannya jalankan generator dari mesin terpisah.`);
    recs.push('Untuk angka kapasitas murni CoTURN, ulangi uji dengan load generator di VM terpisah dalam region yang sama (opsi <code>--monitor ssh</code>).');
  }
  if (!recs.length) recs.push('Belum ada pembatas yang terlampaui; lanjutkan ke tahap user yang lebih tinggi atau naikkan profil media.');
  return { best, bestClean, firstFail, sigBest, sigFirstFail, satStages, findings, recs, perUser, cores };
}

// ---------------- HTML ----------------
function buildHtml(R) {
  const A = analyze(R);
  const st = R.stages;
  const si = R.serverInfo || {};
  const cores = A.cores;
  const xs = st.map((s) => s.users);
  const conf = si.turnConf || {};
  const P = R.config.profile;
  const prof = R.config.profile && R.config.profile.kbpsPerDir;
  const d = new Date(R.startedAt);
  const tanggal = d.toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
  const maxTested = st.length ? st[st.length - 1].users : 0;

  const genCoHero = st.some((x) => x.server.hold.loadgenCpu.avg);
  const heroCap = A.best ? `${fmt(A.best.users, 0)} user` : '–';
  const heroCapSub = A.best ? `${fmt(A.best.pairs, 0)} video call simultan; kualitas media, CPU &amp; RAM memenuhi SLA${A.best.evaluation.level === 'WARN' ? ' (dengan catatan waspada)' : ''}${A.best.generator.saturated ? '; generator sudah jenuh di tahap ini' : ''}${genCoHero ? '; generator di server yang sama' : ''}` : 'tidak ada tahap yang memenuhi SLA server';
  const heroBreak = A.firstFail ? `${fmt(A.firstFail.users, 0)} user` : `> ${fmt(maxTested, 0)} user`;
  const heroBreakSub = A.firstFail ? 'SLA server/media mulai dilanggar' : 'belum tercapai pada tahap tertinggi yang diuji';
  const heroSig = A.sigBest ? `${fmt(A.sigBest.users, 0)} user` : '–';
  const heroSigSub = A.sigFirstFail ? `setup panggilan p95 &gt; ${fmt(R.config.thresholds.setupP95.fail, 0)} ms mulai ${fmt(A.sigFirstFail.users, 0)} user (batas desain gateway, bukan CoTURN)` : 'signaling memenuhi SLA di semua tahap';
  const stopNote = R.stoppedBecause === 'generator_saturated' ? '<p class="note">⚠ Pengujian dihentikan karena mesin load generator jenuh — kapasitas server sebenarnya bisa lebih tinggi dari angka di atas.</p>' : '';

  // rata-rata durasi video call (dibobot jumlah panggilan) dari seluruh tahap
  const dur = st.filter((x) => x.callDuration && x.callDuration.talkSec.n);
  const durN = dur.reduce((a, x) => a + x.callDuration.talkSec.n, 0);
  const durAvg = durN ? dur.reduce((a, x) => a + x.callDuration.talkSec.avg * x.callDuration.talkSec.n, 0) / durN : null;
  const durMin = dur.length ? Math.min(...dur.map((x) => x.callDuration.talkSec.min)) : null;
  const durMax = dur.length ? Math.max(...dur.map((x) => x.callDuration.talkSec.max)) : null;
  const fmtDur = (sec) => (sec === null || sec === undefined ? '–' : sec >= 60 ? `${Math.floor(sec / 60)} mnt ${String(Math.round(sec % 60)).padStart(2, '0')} dtk` : `${fmt(sec, 0)} dtk`);
  const vuOf = (x) => x.vu || { target: x.users, pairs: x.pairs, rampSec: x.rampSec, arrivalVuPerSec: x.rampSec ? x.users / x.rampSec : null, peakActiveVu: null, holdSec: x.holdSec, stageSec: null, workers: x.workers };
  const genOnServer = st.some((x) => x.server.hold.loadgenCpu.avg);
  const totalTestMin = R.finishedAt ? (new Date(R.finishedAt) - new Date(R.startedAt)) / 60000 : null;

  const statusCell = (s) => `<span class="sub">Server</span> ${badge(s.evaluation.level)}<br><span class="sub">Signaling</span> ${badge(s.evaluation.signalingLevel || 'PASS')}${s.generator.saturated ? '<br><span class="sub">⚠ generator jenuh</span>' : ''}`;

  const rowsQ = st.map((s) => `<tr>
    <td class="num b">${fmt(s.users, 0)}</td><td class="num">${fmt(s.calls.established, 0)} / ${fmt(s.calls.attempted, 0)}</td>
    <td class="num">${fmt(s.calls.successPct, 2)}%</td>
    <td class="num">${fmt(s.latency.setup && s.latency.setup.p50, 0)} / ${fmt(s.latency.setup && s.latency.setup.p95, 0)}</td>
    <td class="num">${fmt(s.latency.callToAccept && s.latency.callToAccept.p95, 0)}</td>
    <td class="num">${fmt(s.latency.allocate && s.latency.allocate.p50, 0)} / ${fmt(s.latency.allocate && s.latency.allocate.p95, 0)}</td>
    <td class="num">${fmt(s.media.lossPct, 2)}%</td>
    <td class="num">${fmt(s.media.jitter.p95, 1)}</td>
    <td class="num">${fmt(s.media.oneWay && s.media.oneWay.p50, 0)} / ${fmt(s.media.oneWay && s.media.oneWay.p95, 0)}</td>
    <td class="num">${fmt(s.callDuration && s.callDuration.talkSec.avg, 0)}</td>
    <td class="num">${fmt(s.calls.droppedDuringHold, 0)}</td>
    <td>${statusCell(s)}</td></tr>`).join('');

  const rowsR = st.map((s) => { const h = s.server.hold; return `<tr>
    <td class="num b">${fmt(s.users, 0)}</td>
    <td class="num">${fmt(h.cpu.avg)}% / ${fmt(h.cpu.max)}%</td>
    ${genOnServer ? `<td class="num b">${fmt(h.cpuExclGen && h.cpuExclGen.avg)}%</td><td class="num">${fmt(h.loadgenCpu.avg)}%</td>` : ''}
    <td class="num">${fmt(h.cpuMaxCore.max)}%</td>
    <td class="num">${fmt(h.load1.max, 2)}</td>
    <td class="num">${fmt(h.coturnCpu.avg)}%</td>
    <td class="num">${fmt(h.gatewayCpu.avg)}% / ${fmt(h.gatewayCpu.max)}%</td>
    <td class="num">${fmt(h.memUsedMB.max, 0)} MB (${fmt(h.memPct.max)}%)</td>
    <td class="num">${fmt(h.coturnRss.max, 0)} MB</td>
    <td class="num">${fmt(h.gatewayRss.max, 0)} MB</td>
    <td class="num">${fmt(h.cpuSoftirq.avg)}% / ${fmt(h.cpuSteal.avg)}%</td>
    <td>${statusCell(s)}</td></tr>`; }).join('');

  const rowsN = st.map((s) => { const h = s.server.hold; return `<tr>
    <td class="num b">${fmt(s.users, 0)}</td>
    <td class="num">${fmt(h.rxMbps.avg)} / ${fmt(h.txMbps.avg)}</td>
    <td class="num">${fmt(h.rxPps.avg, 0)} / ${fmt(h.txPps.avg, 0)}</td>
    <td class="num">${fmt(h.udpRcvbufErrPs.max, 0)} / ${fmt(h.udpErrPs.max, 0)}</td>
    <td class="num">${fmt(h.nicDropPs.max, 0)}</td>
    <td class="num">${fmt(h.relayPorts.max, 0)}</td>
    <td class="num">${fmt(h.coturnFds.max, 0)}</td>
    <td class="num">${fmt(h.tcpInuse.max, 0)}</td>
    <td class="num">${fmt(s.signaling.usersBroadcastMB)} MB</td>
    <td class="num">${fmt(s.turn.retransmits, 0)}</td></tr>`; }).join('');

  const charts = [
    lineChart({ title: 'CPU terpakai', unit: '% kapasitas seluruh server', xs, refLines: [{ y: R.config.thresholds.cpuAvg.fail, label: `batas ${R.config.thresholds.cpuAvg.fail}%` }], yMax: 100,
      series: [
        { name: genOnServer ? 'Server tanpa generator' : 'Server total', color: C.s1, values: st.map((s) => (genOnServer && s.server.hold.cpuExclGen ? s.server.hold.cpuExclGen.avg : s.server.hold.cpu.avg)) },
        { name: 'CoTURN', color: C.s2, values: st.map((s) => pctCore(s.server.hold.coturnCpu.avg, cores)) },
        { name: 'Gateway', color: C.s3, values: st.map((s) => pctCore(s.server.hold.gatewayCpu.avg, cores)) },
        ...(genOnServer ? [{ name: 'Generator', color: C.s4, values: st.map((s) => pctCore(s.server.hold.loadgenCpu.avg, cores)) }] : []),
      ] }),
    lineChart({ title: 'CPU gateway Node.js', unit: '% dari 1 core', subtitle: 'Node.js satu thread: 100% = jenuh', xs, yMax: 100, refLines: [{ y: R.config.thresholds.gatewayCpu.fail, label: `batas ${R.config.thresholds.gatewayCpu.fail}%` }],
      series: [{ name: 'Gateway', color: C.s3, values: st.map((s) => s.server.hold.gatewayCpu.avg) }] }),
    lineChart({ title: 'RAM terpakai', unit: 'MB', subtitle: `Total RAM ${fmt(si.memTotalMB, 0)} MB`, xs,
      series: [{ name: 'RAM', color: C.s1, values: st.map((s) => s.server.hold.memUsedMB.max) }] }),
    lineChart({ title: 'Throughput jaringan server', unit: 'Mbps', xs,
      series: [
        { name: 'Masuk', color: C.s1, values: st.map((s) => s.server.hold.rxMbps.avg) },
        { name: 'Keluar', color: C.s2, values: st.map((s) => s.server.hold.txMbps.avg) },
      ] }),
    lineChart({ title: 'Panggilan berhasil tersambung', unit: '%', xs, yMax: 100, refLines: [{ y: R.config.thresholds.successPct.fail, label: `SLA ${R.config.thresholds.successPct.fail}%` }],
      series: [{ name: 'Sukses', color: C.s1, values: st.map((s) => s.calls.successPct) }] }),
    lineChart({ title: 'Packet loss media', unit: '%', xs, refLines: [{ y: R.config.thresholds.lossPct.fail, label: `SLA ${R.config.thresholds.lossPct.fail}%` }],
      series: [{ name: 'Loss', color: C.s1, values: st.map((s) => s.media.lossPct) }] }),
    lineChart({ title: 'Waktu setup panggilan p95', unit: 'ms', subtitle: 'register → media dua arah mengalir', xs, refLines: [{ y: R.config.thresholds.setupP95.fail, label: `SLA ${R.config.thresholds.setupP95.fail} ms` }],
      series: [{ name: 'Setup p95', color: C.s1, values: st.map((s) => s.latency.setup && s.latency.setup.p95) }] }),
    lineChart({ title: 'Latensi media one-way & jitter', unit: 'ms, p95', xs, refLines: [{ y: R.config.thresholds.latencyP95.fail, label: `SLA ${R.config.thresholds.latencyP95.fail} ms` }],
      series: [
        { name: 'Latensi', color: C.s1, values: st.map((s) => s.media.oneWay && s.media.oneWay.p95) },
        { name: 'Jitter', color: C.s2, values: st.map((s) => s.media.jitter.p95) },
      ] }),
    lineChart({ title: 'Durasi video call rata-rata', unit: 'detik', subtitle: 'media mengalir → hangup', xs,
      series: [{ name: 'Durasi', color: C.s1, values: st.map((s) => s.callDuration && s.callDuration.talkSec.avg) }] }),
  ].join('');

  // ---------- VU stress test ----------
  const tl = (R.timeline || []).filter((p) => p.ts);
  const t0 = tl.length ? tl[0].ts : 0;
  const vuChart = tl.length > 2 ? lineChart({ title: 'Profil beban: Virtual User (VU) aktif selama pengujian', unit: 'VU dalam panggilan aktif', subtitle: 'tangga naik per tahap: ramp-up → tahan (pengukuran) → hangup → cooldown',
    xs: tl.map((p) => (p.ts - t0) / 60000), xLabel: 'Menit sejak pengujian dimulai', markers: false, w: 1040, h: 230,
    series: [{ name: 'VU aktif', color: C.s1, values: tl.map((p) => p.active) }] }) : '';
  const rowsVU = st.map((s) => { const v = vuOf(s); return `<tr>
    <td class="num b">${s.stage}</td><td class="num b">${fmt(v.target, 0)}</td><td class="num">${fmt(v.pairs, 0)}</td>
    <td class="num">${fmt(v.rampSec, 0)} dtk</td><td class="num">${fmt(v.arrivalVuPerSec, 1)}</td>
    <td class="num">${fmt(v.holdSec, 0)} dtk</td><td class="num">${fmt(v.peakActiveVu, 0)}</td>
    <td class="num">${fmtDur(s.callDuration && s.callDuration.talkSec.avg)}</td>
    <td class="num">${fmt(v.stageSec, 0)} dtk</td><td class="num">${fmt(v.workers, 0)}</td><td>${statusCell(s)}</td></tr>`; }).join('');
  const rowsDur = st.map((s) => { const d = s.callDuration; if (!d) return ''; return `<tr>
    <td class="num b">${fmt(s.users, 0)}</td><td class="num">${fmt(d.talkSec.n, 0)}</td>
    <td class="num b">${fmtDur(d.talkSec.avg)}</td><td class="num">${fmtDur(d.talkSec.p50)}</td>
    <td class="num">${fmtDur(d.talkSec.min)}</td><td class="num">${fmtDur(d.talkSec.max)}</td>
    <td class="num">${fmtDur(d.sessionSec.avg)}</td></tr>`; }).join('');

  const confKeys = ['listening-port', 'listening-ip', 'external-ip', 'relay-ip', 'min-port', 'max-port', 'relay-threads', 'total-quota', 'user-quota', 'max-bps', 'bps-capacity', 'realm', 'lt-cred-mech', 'use-auth-secret', 'fingerprint', 'no-tcp-relay', 'no-tls', 'no-dtls', 'verbose', 'log-file'];
  const confRows = confKeys.filter((k) => k in conf).map((k) => `<tr><td><code>${esc(k)}</code></td><td>${esc(conf[k] === true ? 'aktif' : conf[k])}</td></tr>`).join('') || '<tr><td colspan="2">Konfigurasi tidak terbaca (monitor tidak memiliki akses ke turnserver.conf).</td></tr>';

  const th = R.config.thresholds;
  const slaRows = [
    ['Server', 'Panggilan berhasil tersambung (media 2 arah)', `≥ ${th.successPct.warn}%`, `< ${th.successPct.fail}%`],
    ['Server', 'Packet loss media', `≤ ${th.lossPct.warn}%`, `> ${th.lossPct.fail}%`],
    ['Server', 'Jitter p95 (RFC 3550)', `≤ ${th.jitterP95.warn} ms`, `> ${th.jitterP95.fail} ms`],
    ['Server', 'Latensi one-way p95 (ITU-T G.114)', `≤ ${th.latencyP95.warn} ms`, `> ${th.latencyP95.fail} ms`],
    ['Server', 'CPU server rata-rata (tanpa generator)', `≤ ${th.cpuAvg.warn}%`, `> ${th.cpuAvg.fail}%`],
    ['Server', 'RAM server', `≤ ${th.memPct.warn}%`, `> ${th.memPct.fail}%`],
    ['Signaling', 'Waktu setup panggilan p95', `≤ ${th.setupP95.warn} ms`, `> ${th.setupP95.fail} ms`],
    ['Signaling', 'CPU gateway Node.js (1 core)', `≤ ${th.gatewayCpu.warn}%`, `> ${th.gatewayCpu.fail}%`],
  ].map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td></tr>`).join('');

  const failRows = st.filter((s) => s.failures.length).map((s) => `<tr><td class="num b">${fmt(s.users, 0)}</td><td>${s.failures.map(([k, v]) => `${esc(k)} <b>×${v}</b>`).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="2">Tidak ada kegagalan panggilan.</td></tr>';
  const genRows = st.map((s) => `<tr><td class="num b">${fmt(s.users, 0)}</td><td class="num">${s.workers}</td><td class="num">${fmt(s.generator.eventLoopP99Ms)} ms</td><td class="num">${fmt(s.generator.cpuPctMax)}%</td><td class="num">${fmt(s.media.generatorTxMbps)} Mbps</td><td>${s.generator.saturated ? '⚠ jenuh' : 'normal'}</td></tr>`).join('');

  const pu = A.perUser;
  const perUserHtml = pu ? `<table class="kv"><tr><td>CPU server per user</td><td class="num">≈ ${fmt(pu.cpuPct, 3)}%</td></tr>
    <tr><td>RAM per user</td><td class="num">≈ ${fmt(pu.memMB, 2)} MB</td></tr>
    <tr><td>Bandwidth keluar per user</td><td class="num">≈ ${fmt(pu.txMbps, 3)} Mbps</td></tr>
    ${pu.usersAtCpu85 ? `<tr><td>Estimasi user saat CPU 85% (ekstrapolasi linear)</td><td class="num">≈ ${fmt(pu.usersAtCpu85, 0)}</td></tr>` : ''}</table>
    <p class="sub">Dihitung dengan regresi linear dari tahap-tahap yang memenuhi SLA. Ekstrapolasi hanya perkiraan; pembatas non-CPU (gateway, jaringan) bisa muncul lebih dulu.</p>` : '';

  const gen = R.generator || {};
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Laporan Uji Kapasitas CoTURN</title>
<style>
@page { size: A4 landscape; margin: 11mm 12mm; }
:root { --surface:#fcfcfb; --text:#0b0b0b; --text2:#52514e; --muted:#7a7974; --line:#e4e3df; --head:#f3f2ef; --accent:#2a78d6; }
* { box-sizing: border-box; }
body { margin:0; background:var(--surface); color:var(--text); font: 10.5pt/1.45 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: -0.01em; }
h2 { font-size: 13.5pt; margin: 7mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 2px solid var(--accent); break-after: avoid; }
h3 { font-size: 11pt; margin: 4mm 0 2mm; break-after: avoid; }
p { margin: 0 0 2.5mm; }
.sub { color: var(--text2); font-size: 8.5pt; }
.note { background:#fff6e0; border-left: 3px solid #fab219; padding: 2mm 3mm; font-size: 9pt; }
code { font: 8.8pt Consolas, monospace; background:#f0efec; padding: 0 3px; border-radius: 3px; }
.cover { border-bottom: 1px solid var(--line); padding-bottom: 4mm; margin-bottom: 4mm; }
.meta { color: var(--text2); font-size: 9pt; }
.heroes { display:grid; grid-template-columns: repeat(3, 1fr); gap: 3mm 4mm; margin: 4mm 0; }
.hero { border:1px solid var(--line); border-radius: 6px; padding: 3mm 4mm; }
.hero .k { font-size: 8.5pt; color: var(--text2); text-transform: uppercase; letter-spacing: .04em; }
.hero .v { font-size: 17pt; font-weight: 700; margin: 1mm 0; white-space: nowrap; }
.hero .s { font-size: 8.5pt; color: var(--text2); }
table { width:100%; border-collapse: collapse; font-size: 7.9pt; margin-bottom: 3mm; break-inside: auto; }
th { background: var(--head); text-align: left; font-weight: 600; padding: 1.4mm 1.4mm; border-bottom: 1px solid #cfcdc7; vertical-align: bottom; font-size: 7.6pt; line-height: 1.25; }
th.num { white-space: normal; }
td { padding: 1.2mm 1.4mm; border-bottom: 1px solid var(--line); vertical-align: top; }
tr { break-inside: avoid; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: normal; }
td.b { font-weight: 700; }
table.kv { width: auto; min-width: 50%; }
.badge { display:inline-block; font-weight: 700; font-size: 8pt; padding: 0.4mm 2mm; border-radius: 10px; color: var(--text); background: color-mix(in srgb, var(--c) 18%, white); border: 1px solid var(--c); white-space: nowrap; }
.grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; }
.charts { display:grid; grid-template-columns: 1fr 1fr; gap: 4mm 8mm; }
.chart { margin:0; break-inside: avoid; }
.chart figcaption { font-size: 9.5pt; margin-bottom: 1mm; }
.chart .unit { color: var(--text2); font-weight: 400; }
.legend { display:flex; gap: 4mm; font-size: 8.5pt; color: var(--text2); margin-bottom: 1mm; }
.legend i { display:inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 1.5mm; vertical-align: -1px; }
svg .tick { font-size: 9px; fill: #6b6a65; }
svg .axlabel { font-size: 9.5px; fill: #52514e; }
svg .ref { font-size: 9px; fill: #b0302f; }
svg .dlabel { font-size: 9.5px; fill: #0b0b0b; font-weight: 600; }
ol.flow { margin: 0 0 2mm 5mm; padding: 0; font-size: 9.5pt; }
ol.flow li { margin-bottom: 0.8mm; }
ul { margin: 0 0 2mm 5mm; padding: 0; }
li { margin-bottom: 1mm; }
.pb { break-before: page; }
.legendrow { font-size: 8.5pt; color: var(--text2); margin-bottom: 2mm; }
</style></head><body>

<div class="cover">
  <h1>Laporan Uji Kapasitas Server CoTURN &amp; Signaling Gateway</h1>
  <div class="meta">Video Call WebRTC — pengujian beban bertahap dengan alur panggilan User A → User B yang nyata<br>
  Tanggal uji: <b>${esc(tanggal)}</b> · ID run: <code>${esc(R.runId)}</code> · Target: <code>${esc(R.config.target)}</code> (WS :${esc(R.config.wsUrl.split(':').pop())}, TURN UDP :${esc(R.config.turnPort)})${R.label ? ` · ${esc(R.label)}` : ''}
  ${R.mergedFrom ? `<br>Laporan gabungan dari ${R.mergedFrom.length} sesi uji dengan konfigurasi identik: ${R.mergedFrom.map((m) => `${esc(m.tiers.join('/'))} VU (${esc(new Date(m.startedAt).toLocaleTimeString('id-ID', { hour12: false }))})`).join(' + ')}` : ''}</div>
</div>

<h2>1. Ringkasan Eksekutif</h2>
<div class="heroes">
  <div class="hero"><div class="k">Kapasitas server (CoTURN/media)</div><div class="v">${heroCap}</div><div class="s">${heroCapSub}</div></div>
  <div class="hero"><div class="k">Titik jenuh server</div><div class="v">${heroBreak}</div><div class="s">${heroBreakSub}</div></div>
  <div class="hero"><div class="k">Batas signaling gateway</div><div class="v">${heroSig}</div><div class="s">${heroSigSub}</div></div>
  <div class="hero"><div class="k">Spesifikasi server</div><div class="v">${esc(si.cores)} vCPU · ${fmt((si.memTotalMB || 0) / 1024, 0)} GB</div><div class="s">${esc(si.gcpMachineType || si.cpuModel || '')}</div></div>
  <div class="hero"><div class="k">Rata-rata durasi video call</div><div class="v">${fmtDur(durAvg)}</div><div class="s">${fmt(durN, 0)} panggilan selesai normal · min ${fmtDur(durMin)}, maks ${fmtDur(durMax)}</div></div>
  <div class="hero"><div class="k">Profil media per user</div><div class="v">${fmt(prof, 0)} kbps</div><div class="s">per arah (${R.config.profile && R.config.profile.packetsPerTick && R.config.profile.packetsPerTick.length > 1 ? 'audio Opus + video' : 'audio Opus'}), lewat relay TURN</div></div>
</div>
${stopNote}
${A.findings.length ? `<h3>Temuan utama</h3><ul>${A.findings.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
<h3>Rekomendasi</h3><ul>${A.recs.map((r) => `<li>${r}</li>`).join('')}</ul>

<h2 class="pb">2. Skenario Stress Test Virtual User (VU)</h2>
<div class="grid2">
<div>
<h3>Apa itu Virtual User (VU)?</h3>
<p>Satu <b>VU</b> adalah satu pengguna aplikasi yang disimulasikan secara penuh oleh program uji, bukan sekadar request HTTP. Setiap VU memiliki:</p>
<ul>
<li>koneksi <b>WebSocket</b> sendiri ke signaling gateway (seperti browser yang membuka aplikasi),</li>
<li><b>socket UDP</b> dan <b>alokasi relay TURN</b> sendiri di CoTURN (seperti ICE agent WebRTC),</li>
<li>aliran media <b>dua arah</b> ±${fmt(prof, 0)} kbps per arah (audio Opus + video) yang benar-benar diteruskan oleh CoTURN.</li>
</ul>
<p>VU selalu berpasangan: <b>User A (dokter, APP_A)</b> yang menekan tombol panggil dan <b>User B (pasien, APP_B)</b> yang menerima. Jadi <i>N</i> VU = <i>N</i>/2 video call yang berlangsung <b>bersamaan</b>.</p>
<h3>Siklus hidup satu pasangan VU</h3>
<ol class="flow">
<li><b>Masuk aplikasi</b> — A &amp; B connect WebSocket + <code>register</code>.</li>
<li><b>Panggil</b> — A <code>call</code> → B <code>incoming</code> → B <code>accept</code>.</li>
<li><b>Siapkan jalur media</b> — A &amp; B TURN Allocate, tukar <code>offer/answer</code> + kandidat <code>relay</code>, CreatePermission + ChannelBind.</li>
<li><b>Bicara</b> — media video/audio mengalir dua arah lewat CoTURN selama sisa ramp-up + seluruh jendela pengukuran.</li>
<li><b>Tutup</b> — A <code>hangup</code>, kedua VU melepas relay (Refresh lifetime 0) dan menutup koneksi.</li>
</ol>
</div>
<div>
<h3>Pola beban: step-load (tangga) sampai titik jenuh</h3>
<ul>
<li><b>Bertahap</b>: rencana ${R.config.tiers.map((x) => fmt(x, 0)).join(' → ')} VU; dijalankan sampai <b>${st.length ? fmt(st[st.length - 1].users, 0) : '–'} VU</b>. Tiap tahap dimulai dari nol agar hasil antar tahap tidak saling memengaruhi.</li>
<li><b>Ramp-up</b>: panggilan dimulai merata sepanjang durasi ramp (kolom <i>laju kedatangan</i> = VU baru per detik), meniru pengguna yang masuk tidak serentak.</li>
<li><b>Tahan (hold)</b>: setelah semua panggilan tersambung, beban ditahan ${fmt(R.config.holdSec, 0)} detik. Semua metrik kualitas dan sumber daya server di laporan ini diambil dari jendela ini (kondisi stabil/<i>steady-state</i>).</li>
<li><b>Hangup &amp; cooldown</b> ${fmt(R.config.cooldownSec, 0)} detik, menunggu CoTURN melepas semua port relay sebelum tahap berikutnya.</li>
<li><b>Dua penilaian per tahap</b>: <b>Server</b> (panggilan tersambung, kualitas media, CPU, RAM) menentukan kapasitas dan titik jenuh server; <b>Signaling</b> (waktu setup panggilan, CPU gateway) menilai gateway aplikasi secara terpisah.</li>
<li>Kapasitas server = tahap tertinggi sebelum kriteria <b>Server</b> pertama kali dilanggar.</li>
<li>VU dijalankan oleh beberapa proses <i>worker</i> paralel di ${genOnServer ? '<b>server yang sama</b> (CPU generator dipisahkan dari penilaian)' : 'mesin generator'}; total durasi pengujian ${totalTestMin ? fmt(totalTestMin, 0) + ' menit' : '–'}.</li>
</ul>
</div></div>
${vuChart}
<h3>Jadwal &amp; realisasi beban per tahap</h3>
<table><thead><tr><th class="num">Tahap</th><th class="num">Target VU</th><th class="num">Video call bersamaan</th><th class="num">Durasi ramp-up</th><th class="num">Laju kedatangan (VU/dtk)</th><th class="num">Durasi tahan</th><th class="num">Puncak VU aktif</th><th class="num">Durasi call rata-rata</th><th class="num">Lama tahap</th><th class="num">Worker</th><th>Hasil</th></tr></thead><tbody>${rowsVU}</tbody></table>

<h2 class="pb">3. Hasil Pengujian per Tahap</h2>
<p class="legendrow">Setiap tahap punya dua status: <b>Server</b> (CoTURN, kualitas media, CPU, RAM) dan <b>Signaling</b> (waktu setup panggilan &amp; CPU gateway). ${badge('PASS')} semua kriteria terpenuhi · ${badge('WARN')} ada metrik melewati batas waspada · ${badge('FAIL')} minimal satu kriteria dilanggar. Nilai server adalah rata-rata/puncak selama <b>jendela pengukuran ${fmt(R.config.holdSec, 0)} detik</b> saat semua panggilan aktif (fase steady-state).</p>

<h3>3a. Kualitas Layanan Panggilan</h3>
<table><thead><tr><th class="num">User</th><th class="num">Panggilan tersambung</th><th class="num">Sukses</th><th class="num">Setup p50 / p95 (ms)</th><th class="num">Call→Accept p95 (ms)</th><th class="num">TURN Allocate p50 / p95 (ms)</th><th class="num">Packet loss</th><th class="num">Jitter p95 (ms)</th><th class="num">Latensi one-way p50 / p95 (ms)</th><th class="num">Durasi call rata-rata (dtk)</th><th class="num">Putus saat aktif</th><th>Status</th></tr></thead><tbody>${rowsQ}</tbody></table>

<h3>3b. Sumber Daya Server</h3>
<table><thead><tr><th class="num">User</th><th class="num">CPU total avg / max</th>${genOnServer ? '<th class="num">CPU tanpa generator (avg)</th><th class="num">CPU generator (% 1 core)</th>' : ''}<th class="num">Core tersibuk</th><th class="num">Load avg (1m)</th><th class="num">CPU CoTURN (% 1 core)</th><th class="num">CPU Gateway avg / max (% 1 core)</th><th class="num">RAM terpakai</th><th class="num">RAM CoTURN</th><th class="num">RAM Gateway</th><th class="num">softirq / steal</th><th>Status</th></tr></thead><tbody>${rowsR}</tbody></table>

<h3>3c. Jaringan &amp; Sumber Daya Socket</h3>
<table><thead><tr><th class="num">User</th><th class="num">Bandwidth masuk / keluar (Mbps)</th><th class="num">Paket/detik masuk / keluar</th><th class="num">UDP drop kernel: buffer penuh / total error (/s)</th><th class="num">NIC drop (/s)</th><th class="num">Port relay aktif</th><th class="num">File descriptor CoTURN</th><th class="num">Koneksi TCP (WS)</th><th class="num">Broadcast daftar user</th><th class="num">Retransmisi TURN</th></tr></thead><tbody>${rowsN}</tbody></table>

<h3>3d. Durasi Video Call</h3>
<p class="sub">Durasi bicara = sejak media dua arah mulai mengalir sampai hangup. Durasi sesi = sejak User A menekan panggil sampai hangup. Panggilan yang dimulai di awal ramp-up berlangsung lebih lama daripada yang dimulai di akhir.</p>
<table><thead><tr><th class="num">User</th><th class="num">Panggilan selesai normal</th><th class="num">Durasi bicara rata-rata</th><th class="num">Median</th><th class="num">Terpendek</th><th class="num">Terlama</th><th class="num">Durasi sesi rata-rata</th></tr></thead><tbody>${rowsDur}</tbody></table>

<h3>3e. Rincian Waktu Setup Panggilan per Fase (p95, ms)</h3>
<p class="sub">Menunjukkan komponen mana (signaling gateway atau CoTURN) yang memperlambat proses tersambungnya panggilan ketika jumlah user naik.</p>
<table><thead><tr><th class="num">User</th>${SETUP_PHASES.map(([, label, owner]) => `<th class="num">${esc(label)}<br><span class="sub">${esc(owner)}</span></th>`).join('')}<th class="num">Total setup p95</th></tr></thead><tbody>${st.map((s) => `<tr><td class="num b">${fmt(s.users, 0)}</td>${SETUP_PHASES.map(([k]) => `<td class="num">${fmt(s.latency[k] && s.latency[k].p95, 0)}</td>`).join('')}<td class="num b">${fmt(s.latency.setup && s.latency.setup.p95, 0)}</td></tr>`).join('')}</tbody></table>

<h2 class="pb">4. Grafik Tren terhadap Jumlah User</h2>
<div class="charts">${charts}</div>

<h2 class="pb">5. Lingkungan Pengujian</h2>
<div class="grid2">
<div><h3>Server yang diuji</h3><table class="kv">
<tr><td>Host</td><td>${esc(si.hostname)} ${si.gcpZone ? `(${esc(si.gcpZone)})` : ''}</td></tr>
<tr><td>Tipe mesin</td><td>${esc(si.gcpMachineType || '–')}</td></tr>
<tr><td>CPU</td><td>${esc(si.cores)} vCPU — ${esc(si.cpuModel)}</td></tr>
<tr><td>RAM</td><td>${fmt(si.memTotalMB, 0)} MB</td></tr>
<tr><td>OS / kernel</td><td>${esc(si.os)} / ${esc(si.kernel)}</td></tr>
<tr><td>Interface</td><td>${esc(si.iface)}</td></tr>
<tr><td>CoTURN</td><td>${esc(si.coturnVersion || '–')}</td></tr>
<tr><td>Rentang port relay</td><td>${si.relayPortRange ? `${si.relayPortRange[0]}–${si.relayPortRange[1]} (${fmt(si.relayPortRange[1] - si.relayPortRange[0] + 1, 0)} port)` : '–'}</td></tr>
<tr><td>Sysctl rmem_max / backlog</td><td>${si.sysctl ? `${fmt(si.sysctl.rmem_max, 0)} B / ${fmt(si.sysctl.netdev_max_backlog, 0)}` : '–'}</td></tr>
<tr><td>Kondisi idle (sebelum uji)</td><td>CPU ${fmt(R.idle && R.idle.cpu.avg)}%, RAM ${fmt(R.idle && R.idle.memUsedMB.avg, 0)} MB</td></tr>
</table></div>
<div><h3>Konfigurasi CoTURN (turnserver.conf)</h3><table class="kv">${confRows}</table>
<h3>Mesin load generator</h3><table class="kv">
<tr><td>Lokasi</td><td>${esc(gen.location)}</td></tr>
<tr><td>Host</td><td>${esc(gen.hostname)} — ${esc(gen.platform)}</td></tr>
<tr><td>CPU / RAM</td><td>${esc(gen.cores)} core ${esc(gen.cpuModel)} / ${fmt(gen.memMB, 0)} MB</td></tr>
<tr><td>Node.js</td><td>${esc(gen.node)}</td></tr></table></div>
</div>

<h2>6. Metodologi &amp; Kriteria</h2>
<div class="grid2">
<div>
<h3>Skenario per pasangan panggilan</h3>
<p>Setiap tahap membuat <i>N</i>/2 pasangan. User A (aplikasi dokter) memanggil User B (aplikasi pasien) dengan protokol yang sama seperti aplikasi asli:</p>
<ol class="flow">
<li>A dan B membuka WebSocket ke gateway lalu mengirim <code>register</code>.</li>
<li>A mengirim <code>call</code> (mode video), B menerima <code>incoming</code> lalu mengirim <code>accept</code>.</li>
<li>A dan B masing-masing melakukan <b>TURN Allocate</b> ke CoTURN (tantangan 401 → kredensial long-term, RFC 5766).</li>
<li>Pertukaran SDP <code>offer</code>/<code>answer</code> dan ICE <code>candidate</code> bertipe <code>relay</code> lewat gateway.</li>
<li>A dan B melakukan <b>CreatePermission</b> + <b>ChannelBind</b> ke alamat relay lawan.</li>
<li>Media dua arah mengalir sebagai <b>ChannelData</b>: A → CoTURN → relay A → relay B → CoTURN → B (dan sebaliknya).</li>
<li>Setelah jendela pengukuran: A mengirim <code>hangup</code>, keduanya melepas alokasi (Refresh lifetime 0).</li>
</ol>
<p class="sub">Panggilan dihitung <b>berhasil</b> hanya jika media benar-benar diterima di kedua arah melalui relay CoTURN.</p>
</div>
<div>
<h3>Profil beban &amp; tahapan</h3>
<ul>
<li>Profil media: paket setiap ${P.tickMs} ms — ${P.packetsPerTick.map((p) => `${p.kind ? 'video' : 'audio'} ${p.size} B`).join(' + ')} ≈ <b>${fmt(P.kbpsPerDir, 0)} kbps</b> dan ${fmt(P.ppsPerDir, 0)} paket/detik per arah per user.</li>
<li>Tahapan: ${st.map((s) => fmt(s.users, 0)).join(' → ')} user (rencana: ${R.config.tiers.join(', ')}).</li>
<li>Setiap tahap: <i>ramp-up</i> bertahap (panggilan dimulai merata), lalu <b>${fmt(R.config.holdSec, 0)} detik jendela pengukuran</b> dengan semua panggilan aktif, kemudian teardown dan cooldown ${fmt(R.config.cooldownSec, 0)} detik sampai port relay CoTURN kembali dilepas.</li>
<li>Pengujian otomatis berhenti pada tahap pertama yang melanggar SLA (breaking point).</li>
<li>Telemetri server dicatat setiap 1 detik oleh agen di server (/proc): CPU per core &amp; per proses, RAM, jaringan, statistik UDP kernel, port relay, file descriptor.</li>
<li>Latensi one-way dan jitter diukur dari timestamp di setiap paket; pengirim dan penerima berada di proses yang sama sehingga jamnya identik.</li>
</ul>
<h3>Kriteria SLA</h3>
<table class="kv"><thead><tr><th>Lingkup</th><th>Metrik</th><th class="num">Lulus</th><th class="num">Gagal bila</th></tr></thead><tbody>${slaRows}</tbody></table>
<p class="sub"><b>Server</b> = kapasitas server &amp; relay media CoTURN; menentukan kapasitas dan titik jenuh server. <b>Signaling</b> = kinerja gateway aplikasi saat panggilan dibuat; dilaporkan terpisah dan tidak menghentikan uji kapasitas server.</p>
</div></div>

<h2 class="pb">7. Lampiran</h2>
${perUserHtml ? `<h3>Biaya sumber daya per user</h3>${perUserHtml}` : ''}
<h3>Rincian penyebab kegagalan panggilan</h3>
<table><thead><tr><th class="num" style="width:12%">User</th><th>Fase: penyebab ×jumlah</th></tr></thead><tbody>${failRows}</tbody></table>
<h3>Kesehatan load generator (validitas data)</h3>
<p class="sub">Jika event-loop generator &gt; 100 ms atau CPU-nya &gt; 90%, angka di tahap tersebut bisa dibatasi oleh generator, bukan oleh server.</p>
<table><thead><tr><th class="num">User</th><th class="num">Worker</th><th class="num">Event loop p99</th><th class="num">CPU worker maks</th><th class="num">Media dikirim</th><th>Kondisi</th></tr></thead><tbody>${genRows}</tbody></table>
</body></html>`;
}

function findBrowser() {
  const c = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return c.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

async function buildReport(runDir, { pdf = true } = {}) {
  const R = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
  // Nilai ulang setiap tahap dengan aturan terbaru (Server vs Signaling) agar hasil lama konsisten
  for (const s of R.stages) s.evaluation = evaluate(s, R.config.thresholds);
  const html = path.resolve(runDir, 'report.html');
  fs.writeFileSync(html, buildHtml(R), 'utf8');
  let pdfPath = null;
  if (pdf) {
    const br = findBrowser();
    if (!br) { console.warn('Chrome/Edge tidak ditemukan: PDF dilewati (set CHROME_PATH).'); }
    else {
      pdfPath = path.resolve(runDir, 'report.pdf');
      execFileSync(br, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, 'file:///' + html.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 120000 });
    }
  }
  return { html, pdf: pdfPath };
}

module.exports = { buildReport };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('Pakai: node build-report.js results/<run-id> [--pdf false]'); process.exit(1); }
  const pdf = !(process.argv.includes('--pdf') && process.argv[process.argv.indexOf('--pdf') + 1] === 'false');
  buildReport(dir, { pdf }).then((o) => console.log('HTML:', o.html, o.pdf ? `\nPDF : ${o.pdf}` : ''));
}
