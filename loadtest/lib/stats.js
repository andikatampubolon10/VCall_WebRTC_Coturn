'use strict';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  const arr = values.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return { n: 0, avg: null, p50: null, p95: null, p99: null, max: null, min: null };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    min: round(arr[0]),
    avg: round(sum / arr.length),
    p50: round(percentile(arr, 50)),
    p95: round(percentile(arr, 95)),
    p99: round(percentile(arr, 99)),
    max: round(arr[arr.length - 1]),
  };
}

function round(v, d = 2) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** Reservoir sampler so memory stays bounded at any scale. */
class Reservoir {
  constructor(size = 20000) {
    this.size = size;
    this.items = [];
    this.seen = 0;
  }
  add(v) {
    this.seen++;
    if (this.items.length < this.size) this.items.push(v);
    else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.size) this.items[j] = v;
    }
  }
  merge(arr) { for (const v of arr) this.add(v); }
}

module.exports = { percentile, summarize, round, Reservoir };
