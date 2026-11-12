#!/usr/bin/env node
/**
 * Gabungkan beberapa run (mis. 100-350 VU dan 400-600 VU) menjadi satu laporan.
 *   node merge-results.js results/<gabungan> results/<run-a> results/<run-b> [...]
 * Tahap diurutkan menurut jumlah user (tahap dengan user sama: run terakhir yang dipakai).
 * Timeline VU disambung berurutan agar grafik profil beban tetap kontinu.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [outDir, ...inDirs] = process.argv.slice(2);
if (!outDir || inDirs.length < 2) {
  console.error('Pakai: node merge-results.js <dir-output> <run-a> <run-b> [...]');
  process.exit(1);
}

const runs = inDirs.map((d) => ({ dir: d, R: JSON.parse(fs.readFileSync(path.join(d, 'results.json'), 'utf8')) }))
  .sort((a, b) => new Date(a.R.startedAt) - new Date(b.R.startedAt));
const first = runs[0].R;

const byUsers = new Map();
for (const { R } of runs) for (const s of R.stages) byUsers.set(s.users, { ...s, sourceRun: R.runId });
const stages = [...byUsers.values()].sort((a, b) => a.users - b.users).map((s, i) => ({ ...s, stage: i + 1 }));

// timeline: sambung run berikutnya tepat setelah run sebelumnya (+ jeda cooldown)
const timeline = [];
let offset = 0;
for (const { R } of runs) {
  const tl = (R.timeline || []).filter((p) => p.ts);
  if (!tl.length) continue;
  const start = tl[0].ts;
  const base = timeline.length ? timeline[timeline.length - 1].ts + (first.config.cooldownSec || 30) * 1000 : start;
  offset = base - start;
  if (timeline.length) timeline.push({ ts: base - 1, active: 0 });
  for (const p of tl) timeline.push({ ts: p.ts + offset, active: p.active });
}

const durMs = runs.reduce((a, { R }) => a + (R.finishedAt ? new Date(R.finishedAt) - new Date(R.startedAt) : 0), 0);
const merged = {
  ...first,
  runId: runs.map(({ R }) => R.runId).join(' + '),
  label: `Gabungan ${runs.length} run: ${runs.map(({ R }) => R.stages.map((s) => s.users).join('/')).join(' + ')} VU`,
  startedAt: first.startedAt,
  finishedAt: new Date(new Date(first.startedAt).getTime() + durMs).toISOString(),
  config: { ...first.config, tiers: stages.map((s) => s.users) },
  stages,
  timeline,
  stoppedBecause: runs[runs.length - 1].R.stoppedBecause,
  mergedFrom: runs.map(({ R }) => ({ runId: R.runId, label: R.label, tiers: R.stages.map((s) => s.users), startedAt: R.startedAt })),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(merged, null, 2));
console.log(`Digabung: ${stages.map((s) => s.users).join(', ')} VU -> ${path.join(outDir, 'results.json')}`);
