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

import { isProxyIp } from './netblocks.js';

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

  console.log(
    `[reporter] threshold=${THRESHOLD} cooldown=${Math.round(COOLDOWN_MS / 3600000)}h ` +
      `mode=${willSubmit ? 'SUBMIT→AbuseIPDB' : 'flag-only'}` +
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
      ok: res ? res.ok : null,
      status: res ? res.status : null,
    };
    recent.unshift(evt);
    while (recent.length > RECENT) recent.pop();
    io.to('stats').emit('report', evt);
    console.log(
      `[reporter] ${evt.mode} ${ip} hits=${hits}${loc ? ' ' + loc : ''}` +
        (res ? ` → HTTP ${res.status}${res.ok ? '' : ' FAIL'}` : ''),
    );
  }

  function onAttack(rec) {
    const ip = rec.ip;
    if (!isReportable(ip)) return;
    let st = state.get(ip);
    if (!st) {
      st = { hits: 0, total: 0, lastReportAt: 0, paths: new Set(), lines: [], busy: false };
      state.set(ip, st);
    }
    st.hits++;
    st.total++;
    if (rec.path) st.paths.add(rec.path);
    if (rec.raw) {
      st.lines.push(rec.raw);
      if (st.lines.length > SAMPLE_LINES * 2) st.lines.shift();
    }

    const cooledDown = st.lastReportAt === 0 || Date.now() - st.lastReportAt >= COOLDOWN_MS;
    if (st.hits >= THRESHOLD && cooledDown && !st.busy) {
      fire(ip, st).catch(() => {
        st.busy = false;
      });
    }
  }

  return {
    onAttack,
    recent: () => recent.slice(0, 20),
    config: { threshold: THRESHOLD, cooldownMs: COOLDOWN_MS, mode: willSubmit ? 'submitted' : 'flagged' },
  };
}
