// Persistent per-minute request-count history (by status class), retained ~1yr.
//
// Sparse: only minutes that saw traffic are stored. Each completed minute is
// appended to data/rpm-history.jsonl on rollover; the file is loaded on boot
// and pruned to the retention window. This is the durable "permanent log" that
// backs the scrollable historical chart. Override the dir with REPORT_DATA_DIR.

import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const HIST_FILE = path.join(DATA_DIR, 'rpm-history.jsonl');
const RETAIN_MIN = 366 * 24 * 60; // ~1 year of minutes
const MAX_SPAN = 4 * 24 * 60; // largest window a single query may return (4 days)

const nowMin = () => Math.floor(Date.now() / 60000);
const zero = () => ({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 });
function withTotal(m, b) {
  return { m, '2xx': b['2xx'], '3xx': b['3xx'], '4xx': b['4xx'], '5xx': b['5xx'], other: b.other,
    total: b['2xx'] + b['3xx'] + b['4xx'] + b['5xx'] + b.other };
}

export function createHistory() {
  const hist = new Map(); // minuteEpoch -> bucket
  let curMin = nowMin();

  function rewrite() {
    try {
      const lines = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([m, b]) => JSON.stringify({ m, ...b }));
      writeFileSync(HIST_FILE + '.tmp', lines.length ? lines.join('\n') + '\n' : '');
      renameSync(HIST_FILE + '.tmp', HIST_FILE);
    } catch { /* ignore disk errors */ }
  }

  // load + prune on boot
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(HIST_FILE)) {
      const cutoff = nowMin() - RETAIN_MIN;
      let kept = 0, dropped = 0;
      for (const line of readFileSync(HIST_FILE, 'utf8').split('\n')) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r.m !== 'number') continue;
        if (r.m < cutoff) { dropped++; continue; }
        // last write wins for a given minute
        hist.set(r.m, { '2xx': r['2xx'] || 0, '3xx': r['3xx'] || 0, '4xx': r['4xx'] || 0, '5xx': r['5xx'] || 0, other: r.other || 0 });
        kept++;
      }
      if (dropped) rewrite(); // compact away the pruned entries
      console.log(`[history] loaded ${kept} minute(s)${dropped ? `, pruned ${dropped} older than 1yr` : ''}`);
    }
  } catch (e) {
    console.log('[history] load failed:', e.message);
  }

  function finalize(min) {
    const b = hist.get(min);
    if (b) {
      try { appendFileSync(HIST_FILE, JSON.stringify({ m: min, ...b }) + '\n'); } catch { /* ignore */ }
    }
  }

  // Record one request's status class into the current minute.
  function record(statusClass) {
    const m = nowMin();
    if (m !== curMin) {
      finalize(curMin); // persist the minute that just completed
      curMin = m;
    }
    let b = hist.get(m);
    if (!b) { b = zero(); hist.set(m, b); }
    const cls = statusClass || 'other';
    b[cls] = (b[cls] || 0) + 1;
  }

  // Contiguous window [fromMin, toMin], gaps filled with zero buckets.
  function windowFor(fromMin, toMin) {
    let from = Math.floor(fromMin);
    let to = Math.floor(toMin);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
    if (to - from > MAX_SPAN) from = to - MAX_SPAN; // clamp span
    const out = [];
    for (let m = from; m <= to; m++) out.push(withTotal(m, hist.get(m) || zero()));
    return out;
  }

  // The in-progress current minute (for live incremental bar updates).
  function current() {
    return withTotal(curMin, hist.get(curMin) || zero());
  }

  // Earliest / latest minute we have data for (for the date picker bounds).
  function bounds() {
    let min = Infinity, max = -Infinity;
    for (const m of hist.keys()) { if (m < min) min = m; if (m > max) max = m; }
    return { earliest: Number.isFinite(min) ? min : curMin, latest: Math.max(curMin, Number.isFinite(max) ? max : curMin) };
  }

  return { record, windowFor, current, bounds, MAX_SPAN };
}
