// In-memory rolling aggregation over parsed log records.
//
// A global bucket aggregates every line; a per-source bucket mirrors the same
// shape for each source, so the dashboard can show stats across ALL sources or
// drill into just one. Everything is kept in memory (the dashboard is a live
// view, not an archive), with bounded maps and ring buffers so a long-running
// scanner flood can't grow memory without limit. `snapshot(source)` returns a
// compact object for the browser — the global view when `source` is falsy, or
// that single source's view otherwise.

const TOP_N = 15;
const RPM_BUCKETS = 60; // last 60 minutes
const MAX_KEYS = 4000; // prune unique-path / unique-ip maps past this
const RECENT_ALERTS = 25;

function topEntries(map, n = TOP_N) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

// Drop the lowest-count half of a map when it grows too large. Keeps hot keys
// (real top paths/IPs) while shedding the long tail of one-off scanner noise.
function pruneMap(map) {
  if (map.size <= MAX_KEYS) return;
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  map.clear();
  for (const [k, v] of sorted.slice(0, Math.floor(MAX_KEYS / 2))) map.set(k, v);
}

// One aggregation bucket: the global view, or one scoped to a single source.
// Holds everything except the cross-source index (bySource), which only the
// top-level aggregator keeps.
function makeBucket() {
  const counts = { lines: 0, requests: 0, attacks: 0, bots: 0, assets: 0, alerts: 0 };
  const byStatus = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const byMethod = new Map();
  const byPath = new Map();
  const byIp = new Map();
  const attackerIp = new Map();

  // requests-per-minute ring: each bucket holds per-status-class counts so the
  // chart can stack them. Bucket index = minutesSinceEpoch % RPM_BUCKETS.
  const zeroBucket = () => ({ '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 });
  const rpm = Array.from({ length: RPM_BUCKETS }, zeroBucket);
  let rpmMinute = Math.floor(Date.now() / 60000);
  // rolling per-second window for "current rate" (last 60s)
  const perSecond = new Map(); // epochSecond -> count

  const alerts = []; // ring buffer of recent alert lines
  let lastEventAt = Date.now();

  function rollRpm(nowMin) {
    if (nowMin === rpmMinute) return;
    // Zero out buckets for any minutes skipped (quiet gaps) so the chart is honest.
    const gap = Math.min(nowMin - rpmMinute, RPM_BUCKETS);
    for (let i = 1; i <= gap; i++) rpm[(rpmMinute + i) % RPM_BUCKETS] = zeroBucket();
    rpmMinute = nowMin;
  }

  function record(rec) {
    counts.lines++;
    lastEventAt = Date.now();

    if (rec.isAlert) {
      counts.alerts++;
      alerts.push({ t: lastEventAt, line: rec.raw });
      while (alerts.length > RECENT_ALERTS) alerts.shift();
    }

    if (!rec.isRequest) return; // heartbeats / app-debug dumps: counted as a line only

    counts.requests++;
    if (rec.isAttack) counts.attacks++;
    if (rec.isBot) counts.bots++;
    if (rec.isAsset) counts.assets++;

    byStatus[rec.statusClass] = (byStatus[rec.statusClass] || 0) + 1;
    bump(byMethod, rec.method);
    if (rec.path && !rec.isAsset) bump(byPath, rec.path);
    if (rec.ip) {
      bump(byIp, rec.ip);
      // Don't list CDN/proxy edges as attackers — they're not the real client.
      if (rec.isAttack && !rec.isProxy) bump(attackerIp, rec.ip);
    }

    // time series
    const nowMs = Date.now();
    const nowMin = Math.floor(nowMs / 60000);
    rollRpm(nowMin);
    const rpmBucket = rpm[nowMin % RPM_BUCKETS];
    const rpmCls = rec.statusClass || 'other';
    rpmBucket[rpmCls] = (rpmBucket[rpmCls] || 0) + 1;

    const sec = Math.floor(nowMs / 1000);
    perSecond.set(sec, (perSecond.get(sec) || 0) + 1);

    if (counts.requests % 500 === 0) {
      pruneMap(byPath);
      pruneMap(byIp);
      pruneMap(attackerIp);
    }
  }

  function currentRate() {
    const cutoff = Math.floor(Date.now() / 1000) - 60;
    let total = 0;
    for (const [sec, c] of perSecond) {
      if (sec <= cutoff) perSecond.delete(sec);
      else total += c;
    }
    return total; // requests in the last 60s
  }

  // Order rpm oldest→newest for the chart.
  function rpmSeries() {
    const out = [];
    for (let i = RPM_BUCKETS - 1; i >= 0; i--) {
      const b = rpm[(rpmMinute - (i % RPM_BUCKETS) + RPM_BUCKETS * 2) % RPM_BUCKETS];
      const other = b['1xx'] + b.other;
      out.push({
        '2xx': b['2xx'], '3xx': b['3xx'], '4xx': b['4xx'], '5xx': b['5xx'], other,
        total: b['2xx'] + b['3xx'] + b['4xx'] + b['5xx'] + other,
      });
    }
    return out;
  }

  function snapshot() {
    const reqs = counts.requests || 1;
    return {
      lastEventAt,
      counts: { ...counts },
      errorRate: +(((byStatus['4xx'] + byStatus['5xx']) / reqs) * 100).toFixed(1),
      attackRate: +((counts.attacks / reqs) * 100).toFixed(1),
      ratePerMin: currentRate(),
      byStatus: { ...byStatus },
      byMethod: topEntries(byMethod, 8),
      topPaths: topEntries(byPath),
      topIps: topEntries(byIp),
      topAttackers: topEntries(attackerIp, 10),
      rpm: rpmSeries(),
      alerts: alerts.slice(-RECENT_ALERTS).reverse(),
    };
  }

  // Persist/restore the cumulative state so a restart keeps the cards & tables.
  // (The rpm 60-min ring and per-second window aren't persisted — the chart uses
  // the separate history store, and the rate window rebuilds in seconds.)
  function serialize() {
    return {
      counts: { ...counts },
      byStatus: { ...byStatus },
      byMethod: [...byMethod],
      byPath: [...byPath],
      byIp: [...byIp],
      attackerIp: [...attackerIp],
      alerts: alerts.slice(-RECENT_ALERTS),
      lastEventAt,
    };
  }
  function restore(s) {
    if (!s) return;
    Object.assign(counts, s.counts || {});
    Object.assign(byStatus, s.byStatus || {});
    for (const [k, v] of s.byMethod || []) byMethod.set(k, v);
    for (const [k, v] of s.byPath || []) byPath.set(k, v);
    for (const [k, v] of s.byIp || []) byIp.set(k, v);
    for (const [k, v] of s.attackerIp || []) attackerIp.set(k, v);
    if (Array.isArray(s.alerts)) {
      for (const a of s.alerts) alerts.push(a);
      while (alerts.length > RECENT_ALERTS) alerts.shift();
    }
    if (s.lastEventAt) lastEventAt = s.lastEventAt;
  }

  return { record, snapshot, serialize, restore };
}

export function createStats() {
  let startedAt = Date.now();
  const bySource = new Map(); // cross-source index: source -> total line count
  const global = makeBucket();
  const perSource = new Map(); // source -> its own bucket

  function record(rec) {
    bump(bySource, rec.source);
    global.record(rec);
    const src = rec.source || 'unknown';
    let bucket = perSource.get(src);
    if (!bucket) {
      bucket = makeBucket();
      perSource.set(src, bucket);
    }
    bucket.record(rec);
  }

  // snapshot()        → the global view across every source.
  // snapshot('curio') → just that source. `bySource` is always the full source
  // list (so the chips stay complete), and `source` echoes the active filter.
  function snapshot(source) {
    const scoped = source ? perSource.get(source) : null;
    const snap = (scoped || global).snapshot();
    snap.startedAt = startedAt;
    snap.uptimeMs = Date.now() - startedAt;
    snap.bySource = topEntries(bySource, 60); // show all sources (60 = safety ceiling)
    snap.source = scoped ? source : null;
    return snap;
  }

  // Cumulative state for cross-restart persistence: the global view plus every
  // per-source bucket, so a restart keeps both the all-sources cards and any
  // single-source filtered view intact.
  function serialize() {
    const sources = {};
    for (const [src, bucket] of perSource) sources[src] = bucket.serialize();
    return { startedAt, bySource: [...bySource], global: global.serialize(), perSource: sources };
  }
  function restore(s) {
    if (!s) return;
    if (s.startedAt) startedAt = s.startedAt;
    for (const [k, v] of s.bySource || []) bySource.set(k, v);
    global.restore(s.global);
    for (const [src, snap] of Object.entries(s.perSource || {})) {
      let bucket = perSource.get(src);
      if (!bucket) { bucket = makeBucket(); perSource.set(src, bucket); }
      bucket.restore(snap);
    }
  }

  return { record, snapshot, serialize, restore };
}
