// Local IP → country lookup. Uses the DB-IP Lite country database (CC-BY 4.0),
// a plain CSV of `start_ip,end_ip,CC` ranges — no account, no API, no native
// deps. Fetch it with tools/fetch-geo.sh; geolocation is a no-op if absent.
//
// IPv4 only for now (the vast majority of web/scanner traffic); IPv6 addresses
// return null and show as "unknown" in the breakdown.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const V4_FILE = process.env.GEO_IPV4_FILE || path.join(DATA_DIR, 'geo-country-ipv4.csv');

function ip4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const p = ip.split('.');
  if (p.length !== 4) return null; // not IPv4 (e.g. IPv6) → caller treats as unknown
  let n = 0;
  for (const o of p) { const x = Number(o); if (!Number.isInteger(x) || x < 0 || x > 255) return null; n = n * 256 + x; }
  return n >>> 0;
}

// Load the CSV into parallel sorted arrays for binary search. DB-IP ships the
// rows in ascending start-ip order, so we keep that order and search it.
function loadV4(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const starts = [], ends = [], cc = [];
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    const line = text.slice(i, j);
    i = j + 1;
    if (!line) continue;
    const a = line.indexOf(','), b = line.indexOf(',', a + 1);
    if (a < 0 || b < 0) continue;
    const s = ip4ToInt(line.slice(0, a));
    const e = ip4ToInt(line.slice(a + 1, b));
    if (s == null || e == null) continue;
    starts.push(s); ends.push(e); cc.push(line.slice(b + 1).trim());
  }
  if (!starts.length) return null;
  return { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), cc };
}

function lookup4(db, n) {
  let lo = 0, hi = db.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < db.starts[mid]) hi = mid - 1;
    else if (n > db.ends[mid]) lo = mid + 1;
    else return db.cc[mid];
  }
  return null;
}

export function createGeo() {
  let v4 = null;
  try { v4 = loadV4(V4_FILE); } catch (e) { console.log('[geo] load failed:', e.message); }
  if (!v4) {
    console.log(`[geo] no country DB at ${V4_FILE} — geolocation disabled (run tools/fetch-geo.sh)`);
    return { country: () => null, enabled: false };
  }
  console.log(`[geo] loaded ${v4.cc.length.toLocaleString()} IPv4 country ranges`);
  function country(ip) {
    const n = ip4ToInt(ip);
    if (n == null) return null;
    return lookup4(v4, n) || null;
  }
  return { country, enabled: true };
}
