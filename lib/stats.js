// In-memory rolling aggregation over parsed log records.
//
// Everything is kept in memory (the dashboard is a live view, not an archive),
// with bounded maps and ring buffers so a long-running scanner flood can't grow
// memory without limit. `snapshot()` returns a compact object for the browser.

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

export function createStats() {
  const startedAt = Date.now();

  const counts = {
    lines: 0,
    requests: 0,
    attacks: 0,
    bots: 0,
    assets: 0,
    alerts: 0,
  };
  const byStatus = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const byMethod = new Map();
  const bySource = new Map();
  const byPath = new Map();
  const byIp = new Map();
  const attackerIp = new Map();

  // requests-per-minute ring: bucket index = minutesSinceEpoch % RPM_BUCKETS
  const rpm = new Array(RPM_BUCKETS).fill(0);
  let rpmMinute = Math.floor(Date.now() / 60000);
  // rolling per-second window for "current rate" (last 60s)
  const perSecond = new Map(); // epochSecond -> count

  const alerts = []; // ring buffer of recent alert lines
  let lastEventAt = startedAt;

  function rollRpm(nowMin) {
    if (nowMin === rpmMinute) return;
    // Zero out buckets for any minutes skipped (quiet gaps) so the chart is honest.
    const gap = Math.min(nowMin - rpmMinute, RPM_BUCKETS);
    for (let i = 1; i <= gap; i++) rpm[(rpmMinute + i) % RPM_BUCKETS] = 0;
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

    bump(bySource, rec.source);

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
      if (rec.isAttack) bump(attackerIp, rec.ip);
    }

    // time series
    const nowMs = Date.now();
    const nowMin = Math.floor(nowMs / 60000);
    rollRpm(nowMin);
    rpm[nowMin % RPM_BUCKETS]++;

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
      out.push(rpm[(rpmMinute - i % RPM_BUCKETS + RPM_BUCKETS * 2) % RPM_BUCKETS]);
    }
    return out;
  }

  function snapshot() {
    const reqs = counts.requests || 1;
    return {
      startedAt,
      lastEventAt,
      uptimeMs: Date.now() - startedAt,
      counts: { ...counts },
      errorRate: +(((byStatus['4xx'] + byStatus['5xx']) / reqs) * 100).toFixed(1),
      attackRate: +((counts.attacks / reqs) * 100).toFixed(1),
      ratePerMin: currentRate(),
      byStatus: { ...byStatus },
      byMethod: topEntries(byMethod, 8),
      bySource: topEntries(bySource, 20),
      topPaths: topEntries(byPath),
      topIps: topEntries(byIp),
      topAttackers: topEntries(attackerIp, 10),
      rpm: rpmSeries(),
      alerts: alerts.slice(-RECENT_ALERTS).reverse(),
    };
  }

  return { record, snapshot };
}
