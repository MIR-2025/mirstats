// AI log analysis — summarize a time range's aggregated traffic via the Anthropic
// API. Context = the per-minute history (rolled up hourly) + abuse reports in the
// range + the current cumulative top-N. The API key is read server-side and never
// sent to the browser. Optional: with no ANTHROPIC_API_KEY the panel shows a hint.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collections } from './mongo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.jsonl');
const CACHE_FILE = path.join(DATA_DIR, 'analyses.json');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const CLASSES = ['2xx', '3xx', '4xx', '5xx', 'other'];

// Per-label cache so re-opening a day doesn't re-bill the API (refresh forces).
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(cache)); renameSync(CACHE_FILE + '.tmp', CACHE_FILE); } catch { /* ignore */ }
}

function hourly(bars) {
  const map = new Map();
  for (const b of bars) {
    const h = Math.floor(b.m / 60); // hour epoch
    let e = map.get(h);
    if (!e) { e = { h, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0, total: 0 }; map.set(h, e); }
    for (const k of CLASSES) e[k] += b[k] || 0;
    e.total += b.total || 0;
  }
  return [...map.values()].sort((a, b) => a.h - b.h);
}

function reportsInRange(fromMs, toMs) {
  if (!existsSync(REPORTS_FILE)) return [];
  const out = [];
  try {
    for (const line of readFileSync(REPORTS_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r && r.t >= fromMs && r.t <= toMs) out.push(r);
    }
  } catch { /* ignore */ }
  return out;
}

// Per-source (per-site) breakdown for the range, from the Mongo event log.
async function sourceBreakdown(fromMs, toMs) {
  try {
    const rows = await collections.events().aggregate([
      { $match: { t: { $gte: new Date(fromMs), $lte: new Date(toMs) } } },
      { $group: { _id: '$source', count: { $sum: 1 },
        e4: { $sum: { $cond: [{ $eq: ['$cls', '4xx'] }, 1, 0] } },
        e5: { $sum: { $cond: [{ $eq: ['$cls', '5xx'] }, 1, 0] } },
        attacks: { $sum: { $cond: ['$attack', 1, 0] } } } },
      { $sort: { count: -1 } },
      { $limit: 30 },
    ]).toArray();
    return rows.map((r) => ({ source: r._id || 'unknown', count: r.count, e4: r.e4, e5: r.e5, attacks: r.attacks }));
  } catch {
    return [];
  }
}

function buildPrompt({ label, hours, totals, sources, reports, snap }) {
  const p = (n) => String(n).padStart(2, '0');
  const hourLines = hours.length
    ? hours.map((e) => {
        const d = new Date(e.h * 3600000);
        return `${p(d.getHours())}:00  total=${e.total} 2xx=${e['2xx']} 3xx=${e['3xx']} 4xx=${e['4xx']} 5xx=${e['5xx']} other=${e.other}`;
      }).join('\n')
    : '(no traffic recorded in this range)';
  const repLines = reports.length
    ? reports.map((r) => `- ${new Date(r.t).toISOString()} ${r.ip} (${r.org || r.asn || '?'} / ${r.country || '?'}) ${r.hits} hits, ${r.mode}`).join('\n')
    : '(none)';
  const topN = (arr) => (arr || []).slice(0, 10).map((x) => `${x.key} (${x.count})`).join(', ') || '(n/a)';
  return [
    `You are a web-server log analyst. Analyze the traffic for ${label} and give a concise, useful briefing: overall volume, a PER-SOURCE (per-site) breakdown calling out which sites took the most traffic / errors / attacks, notable spikes or anomalies, error-rate patterns (4xx/5xx), and security / attack activity. Be specific with numbers and hours. Call out anything that warrants attention. Keep it tight — short paragraphs or bullets, no preamble.`,
    ``,
    `TOTALS for ${label}: requests=${totals.total}, 2xx=${totals['2xx']}, 3xx=${totals['3xx']}, 4xx=${totals['4xx']}, 5xx=${totals['5xx']}, error-rate=${totals.errPct}%`,
    ``,
    `TRAFFIC BY SOURCE (site) for ${label}:`,
    sources && sources.length
      ? sources.map((s) => `${s.source}: ${s.count} reqs, ${s.e4} 4xx, ${s.e5} 5xx, ${s.attacks} attacks`).join('\n')
      : '(no per-source data)',
    ``,
    `HOURLY BREAKDOWN (server local time):`,
    hourLines,
    ``,
    `ABUSE REPORTS FILED IN THIS RANGE:`,
    repLines,
    ``,
    `CURRENT CUMULATIVE CONTEXT (all-time, NOT scoped to this range):`,
    `top paths: ${topN(snap.topPaths)}`,
    `top attackers: ${topN(snap.topAttackers)}`,
  ].join('\n');
}

export async function analyzeRange({ fromMin, toMin, label, refresh, logStream }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY is not set — add it to .env to enable AI analysis.' };

  const cacheKey = label || `${fromMin}-${toMin}`;
  const store = loadCache();
  if (!refresh && store[cacheKey]) return { ...store[cacheKey], cached: true };

  const bars = logStream.rpmWindow(fromMin, toMin);
  const totals = bars.reduce((a, b) => {
    for (const k of CLASSES) a[k] += b[k] || 0;
    a.total += b.total || 0;
    return a;
  }, { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0, total: 0 });
  totals.errPct = totals.total ? +(((totals['4xx'] + totals['5xx']) / totals.total) * 100).toFixed(1) : 0;

  const reports = reportsInRange(fromMin * 60000, toMin * 60000 + 59999);
  const sources = await sourceBreakdown(fromMin * 60000, toMin * 60000 + 59999);
  const snap = logStream.snapshot();
  const prompt = buildPrompt({ label: label || `${fromMin}–${toMin}`, hours: hourly(bars), totals, sources, reports, snap });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: `Anthropic API ${res.status}: ${data?.error?.message || 'request failed'}` };
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    const result = { ok: true, analysis: text, model: MODEL, totals, at: Date.now() };
    store[cacheKey] = result;
    saveCache();
    return result;
  } catch (e) {
    return { ok: false, error: `analysis failed: ${String(e.message || e)}` };
  }
}
