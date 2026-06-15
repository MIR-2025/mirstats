// Attacker auto-reporter.
//
// When a single IP crosses REPORT_THRESHOLD attack hits, optionally report it to
// AbuseIPDB — enriched with an ipinfo lookup and a few sample log lines as
// evidence — and surface it on the dashboard.
//
// Submission is OFF by default: it only POSTs to AbuseIPDB when AUTO_REPORT is
// truthy AND ABUSEIPDB_KEY is set; otherwise it just "flags" (enrich + dashboard
// + log). A reported IP is re-reported only after COOLDOWN_MS, and only if it
// keeps attacking past the threshold. Loopback / private / explicitly-skipped
// IPs are never reported.
//
// Keys (both optional, both free tiers):
//   ABUSEIPDB_KEY  — https://www.abuseipdb.com/account/api  (APIv2 key)
//   IPINFO_KEY     — https://ipinfo.io/account/token        (Lite API token)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxyIp } from './netblocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const THRESHOLD = Math.max(1, +(process.env.REPORT_THRESHOLD || 10));
const COOLDOWN_MS = Math.max(60000, +(process.env.REPORT_COOLDOWN_MS || 6 * 60 * 60 * 1000));
const AUTO_REPORT = /^(1|true|yes|on)$/i.test(process.env.AUTO_REPORT || '');
const IPINFO_KEY = process.env.IPINFO_KEY || '';
const ABUSEIPDB_KEY = process.env.ABUSEIPDB_KEY || '';
const CATEGORIES = process.env.ABUSEIPDB_CATEGORIES || '21'; // 21 = Web App Attack
const SKIP_IPS = new Set(
  (process.env.REPORT_SKIP_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const SAMPLE_LINES = 3; // log lines included as evidence
const MAX_COMMENT = 1024; // AbuseIPDB comment hard limit
const RECENT = 50;
// Behavioral signal: an IP emitting BURST_THRESHOLD 4xx within BURST_WINDOW_MS is
// reported even with no fingerprint match (catches novel scanners).
const BURST_THRESHOLD = Math.max(1, +(process.env.BURST_THRESHOLD || 25));
const BURST_WINDOW_MS = Math.max(1000, +(process.env.BURST_WINDOW_MS || 60000));

function freshState(total = 0, lastReportAt = 0) {
  return { hits: 0, total, lastReportAt, paths: new Set(), lines: [], burst: [], busy: false, reason: 'fingerprint' };
}
const cooledDown = (st) => st.lastReportAt === 0 || Date.now() - st.lastReportAt >= COOLDOWN_MS;

// File-based persistence (no DB). Dedup/cooldown state survives restarts, and
// every report is appended to an audit log. Override the dir with REPORT_DATA_DIR.
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'reporter-state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'reports.jsonl');

function ensureDataDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

// Load persisted per-IP dedup state (lastReportAt + total) into the live map so
// a restart doesn't re-report. Ephemeral fields (window hits, evidence) reset.
function loadState(map) {
  try {
    const obj = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [ip, s] of Object.entries(obj)) {
      map.set(ip, freshState(s.total || 0, s.lastReportAt || 0));
    }
  } catch { /* no state yet / unreadable -> start empty */ }
  return map.size;
}

// Persist only the cross-restart fields, only for IPs actually reported (keeps
// the file small). Atomic-ish write via tmp + rename.
function saveState(map) {
  const obj = {};
  for (const [ip, s] of map) {
    if (s.lastReportAt) obj[ip] = { lastReportAt: s.lastReportAt, total: s.total };
  }
  try {
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(obj));
    renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch { /* ignore disk errors */ }
}

function appendAudit(line) {
  try { appendFileSync(AUDIT_FILE, JSON.stringify(line) + '\n'); } catch { /* ignore */ }
}

// Never report loopback / private / link-local IPs (AbuseIPDB rejects them and
// it would be meaningless), nor any explicitly skipped IP (e.g. your own egress).
function isReportable(ip) {
  if (!ip || SKIP_IPS.has(ip)) return false;
  if (isProxyIp(ip)) return false; // CDN / reverse-proxy edge, not the real client
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('169.254.')) return false;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return false;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return false;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return false;
  return true;
}

async function ipinfoLookup(ip) {
  if (!IPINFO_KEY) return null;
  try {
    const r = await fetch(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}`, {
      headers: { Authorization: `Bearer ${IPINFO_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function submitAbuseIPDB(ip, comment) {
  const r = await fetch('https://api.abuseipdb.com/api/v2/report', {
    method: 'POST',
    headers: {
      Key: ABUSEIPDB_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ip, categories: CATEGORIES, comment }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Build the AbuseIPDB comment: summary + targeted paths + a few raw log lines as
// evidence, clamped to AbuseIPDB's 1024-char comment limit.
function buildComment(hits, loc, paths, lines) {
  const sample = lines
    .slice(-SAMPLE_LINES)
    .map((l) => (l.length > 200 ? l.slice(0, 199) + '…' : l));
  const parts = [
    `Automated abuse report: ${hits} attack/probe requests` + (loc ? ` from ${loc}` : '') + '.',
    paths ? `Targeted paths: ${paths}.` : '',
    sample.length ? 'Sample log lines:\n' + sample.join('\n') : '',
    'Detected by an automated web-server log monitor.',
  ].filter(Boolean);
  const comment = parts.join('\n');
  return comment.length > MAX_COMMENT ? comment.slice(0, MAX_COMMENT - 1) + '…' : comment;
}

export function createReporter(io) {
  const willSubmit = AUTO_REPORT && !!ABUSEIPDB_KEY;
  const state = new Map(); // ip -> { hits, total, lastReportAt, paths:Set, lines:[], busy }
  const recent = []; // ring of recent report events for the dashboard

  ensureDataDir();
  const loaded = loadState(state);

  console.log(
    `[reporter] threshold=${THRESHOLD} cooldown=${Math.round(COOLDOWN_MS / 3600000)}h ` +
      `mode=${willSubmit ? 'SUBMIT→AbuseIPDB' : 'flag-only'} state=${loaded} reported-IP(s)` +
      (AUTO_REPORT && !ABUSEIPDB_KEY ? ' (AUTO_REPORT set but ABUSEIPDB_KEY missing)' : ''),
  );

  async function fire(ip, st) {
    st.busy = true;
    const hits = st.hits;
    const info = await ipinfoLookup(ip);
    const loc = info ? [info.as_name || info.asn, info.country_code].filter(Boolean).join(' / ') : '';
    const paths = [...st.paths].slice(0, 5).join(', ');
    const comment = buildComment(hits, loc, paths, st.lines);

    let res = null;
    if (willSubmit) {
      try {
        res = await submitAbuseIPDB(ip, comment);
      } catch (e) {
        res = { ok: false, status: 0, data: { error: String(e.message || e) } };
      }
    }

    st.lastReportAt = Date.now();
    st.hits = 0; // reset the window; cooldown + a fresh THRESHOLD gate the next report
    st.burst = [];
    st.busy = false;

    const evt = {
      t: st.lastReportAt,
      ip,
      hits,
      total: st.total,
      asn: info?.asn || null,
      org: info?.as_name || null,
      country: info?.country_code || null,
      mode: willSubmit ? 'submitted' : 'flagged',
      reason: st.reason || 'fingerprint',
      ok: res ? res.ok : null,
      status: res ? res.status : null,
    };
    recent.unshift(evt);
    while (recent.length > RECENT) recent.pop();
    appendAudit({ at: new Date(evt.t).toISOString(), ...evt });
    saveState(state);
    io.to('stats').emit('report', evt);
    console.log(
      `[reporter] ${evt.mode}/${evt.reason} ${ip} hits=${hits}${loc ? ' ' + loc : ''}` +
        (res ? ` → HTTP ${res.status}${res.ok ? '' : ' FAIL'}` : ''),
    );
  }

  function onAttack(rec) {
    const ip = rec.ip;
    if (!isReportable(ip)) return;
    let st = state.get(ip);
    if (!st) { st = freshState(); state.set(ip, st); }
    st.hits++;
    st.total++;
    if (rec.path) st.paths.add(rec.path);
    if (rec.raw) {
      st.lines.push(rec.raw);
      if (st.lines.length > SAMPLE_LINES * 2) st.lines.shift();
    }
    if (st.hits >= THRESHOLD && cooledDown(st) && !st.busy) {
      st.reason = 'fingerprint';
      fire(ip, st).catch(() => { st.busy = false; });
    }
  }

  // Behavioral burst signal: any 4xx; if an IP exceeds BURST_THRESHOLD within
  // BURST_WINDOW_MS, report it even with no fingerprint match.
  function onRequest(rec) {
    if (rec.statusClass !== '4xx') return;
    const ip = rec.ip;
    if (!isReportable(ip)) return;
    let st = state.get(ip);
    if (!st) { st = freshState(); state.set(ip, st); }
    const now = Date.now();
    st.burst.push(now);
    while (st.burst.length && now - st.burst[0] > BURST_WINDOW_MS) st.burst.shift();
    if (st.burst.length >= BURST_THRESHOLD && cooledDown(st) && !st.busy) {
      st.hits = st.burst.length; // report count = burst size
      if (rec.path) st.paths.add(rec.path);
      if (rec.raw) { st.lines.push(rec.raw); if (st.lines.length > SAMPLE_LINES * 2) st.lines.shift(); }
      st.reason = 'burst';
      fire(ip, st).catch(() => { st.busy = false; });
    }
  }

  return {
    onAttack,
    onRequest,
    recent: () => recent.slice(0, 20),
    config: { threshold: THRESHOLD, cooldownMs: COOLDOWN_MS, mode: willSubmit ? 'submitted' : 'flagged' },
  };
}
