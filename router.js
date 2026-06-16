// Main application router. Mounts feature routes and page routes.
// Exported as a factory so routes can access shared services (redis, io, logStream).
import express from 'express';
import authRoutes from './routes/auth.js';
import { analyzeRange } from './lib/analyze.js';
import { collections } from './lib/mongo.js';

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRouter({ redis, io, logStream } = {}) {
  const router = express.Router();

  router.use('/auth', authRoutes);

  // Live stats dashboard.
  router.get('/', (req, res) => {
    res.render('index', { pageTitle: 'Dashboard' });
  });

  // JSON snapshot — initial paint + programmatic access.
  router.get('/api/stats', (req, res) => {
    res.json(logStream ? logStream.snapshot() : { error: 'log stream not running' });
  });

  // Per-minute req/min history window for the scrollable chart.
  // ?from=<minuteEpoch>&to=<minuteEpoch>  (minuteEpoch = floor(ms / 60000))
  // Span is clamped server-side; missing minutes come back as zero buckets.
  router.get('/api/rpm', (req, res) => {
    if (!logStream) return res.status(503).json({ error: 'log stream not running' });
    const bounds = logStream.rpmBounds();
    const to = Number.isFinite(+req.query.to) && req.query.to !== '' ? Math.floor(+req.query.to) : bounds.latest;
    const from = Number.isFinite(+req.query.from) && req.query.from !== '' ? Math.floor(+req.query.from) : to - 720; // default last 12h
    res.json({ bars: logStream.rpmWindow(from, to), bounds, maxSpan: logStream.rpmMaxSpan, bucket: logStream.rpmBucket });
  });

  // AI log analysis for a time range (minute epochs). Server-side Anthropic call.
  router.post('/api/analyze', async (req, res) => {
    if (!logStream) return res.status(503).json({ ok: false, error: 'log stream not running' });
    const fromMin = Math.floor(Number(req.body?.from));
    const toMin = Math.floor(Number(req.body?.to));
    if (!Number.isFinite(fromMin) || !Number.isFinite(toMin) || toMin < fromMin) {
      return res.status(400).json({ ok: false, error: 'invalid range' });
    }
    try {
      res.json(await analyzeRange({ fromMin, toMin, label: String(req.body?.label || ''), refresh: !!req.body?.refresh, logStream }));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // IP search typeahead: distinct IPs whose address starts with `q` (so a /24 is
  // just the "1.2.3" prefix), within the date range, ranked by hit count.
  router.get('/api/ips', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const from = new Date(Number(req.query.from) || 0);
      const to = new Date(Number(req.query.to) || Date.now());
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const match = { t: { $gte: from, $lte: to } };
      if (q) match.ip = new RegExp('^' + escapeRx(q));
      const rows = await collections.events().aggregate([
        { $match: match },
        { $group: { _id: '$ip', count: { $sum: 1 }, attacks: { $sum: { $cond: ['$attack', 1, 0] } }, last: { $max: '$t' } } },
        { $sort: { count: -1 } },
        { $limit: limit },
      ]).toArray();
      res.json(rows.map((r) => ({ ip: r._id, count: r.count, attacks: r.attacks, last: r.last })));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Detail for a selected IP (or /24 prefix): status breakdown, top paths, span.
  router.get('/api/ip', async (req, res) => {
    try {
      const ip = String(req.query.ip || '').trim();
      if (!ip) return res.status(400).json({ error: 'ip required' });
      const from = new Date(Number(req.query.from) || 0);
      const to = new Date(Number(req.query.to) || Date.now());
      const match = { ip: new RegExp('^' + escapeRx(ip)), t: { $gte: from, $lte: to } };
      const events = collections.events();
      const [summary] = await events.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, attacks: { $sum: { $cond: ['$attack', 1, 0] } }, first: { $min: '$t' }, last: { $max: '$t' }, ips: { $addToSet: '$ip' } } },
      ]).toArray();
      const byStatus = await events.aggregate([{ $match: match }, { $group: { _id: '$cls', n: { $sum: 1 } } }]).toArray();
      const topPaths = await events.aggregate([{ $match: match }, { $group: { _id: '$path', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray();
      res.json({
        ip,
        count: summary?.count || 0,
        attacks: summary?.attacks || 0,
        first: summary?.first || null,
        last: summary?.last || null,
        distinctIps: (summary?.ips || []).length,
        byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
        topPaths: topPaths.map((p) => ({ path: p._id, count: p.n })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Per-minute req/min for one IP / /24 prefix, from the event log — lets the
  // chart filter to a searched IP. Same bar shape as /api/rpm (zero-filled).
  router.get('/api/rpm-ip', async (req, res) => {
    try {
      const ip = String(req.query.ip || '').trim();
      if (!ip) return res.status(400).json({ error: 'ip required' });
      const rx = new RegExp('^' + escapeRx(ip));
      const events = collections.events();
      const [mm] = await events.aggregate([
        { $match: { ip: rx } },
        { $group: { _id: null, min: { $min: '$t' }, max: { $max: '$t' } } },
      ]).toArray();
      const MAXSPAN = 4 * 24 * 60;
      const bucket = logStream.rpmBucket || 1;
      const ipLatest = mm ? Math.floor(mm.max.getTime() / 60000) : Math.floor(Date.now() / 60000);
      const ipEarliest = mm ? Math.floor(mm.min.getTime() / 60000) : ipLatest;
      const toRaw = (req.query.to !== '' && Number.isFinite(+req.query.to)) ? Math.floor(+req.query.to) : ipLatest;
      const fromRaw = (req.query.from !== '' && Number.isFinite(+req.query.from)) ? Math.floor(+req.query.from) : toRaw - 720;
      const to = Math.floor(toRaw / bucket) * bucket;
      const from = Math.floor(Math.max(fromRaw, toRaw - MAXSPAN) / bucket) * bucket;
      const rows = await events.aggregate([
        { $match: { ip: rx, t: { $gte: new Date(from * 60000), $lte: new Date((to + bucket) * 60000 - 1) } } },
        { $group: { _id: { m: { $multiply: [{ $floor: { $divide: [{ $toLong: '$t' }, 60000 * bucket] } }, bucket] }, cls: '$cls' }, n: { $sum: 1 } } },
      ]).toArray();
      const map = new Map();
      for (const r of rows) {
        const cls = r._id.cls || 'other';
        let b = map.get(r._id.m);
        if (!b) { b = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 }; map.set(r._id.m, b); }
        b[cls] = (b[cls] || 0) + r.n;
      }
      const bars = [];
      for (let m = from; m <= to; m += bucket) {
        const b = map.get(m) || { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
        bars.push({ m, ...b, total: b['2xx'] + b['3xx'] + b['4xx'] + b['5xx'] + b.other });
      }
      res.json({ bars, bounds: { earliest: ipEarliest, latest: ipLatest }, maxSpan: MAXSPAN, bucket });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Health check.
  router.get('/healthz', (req, res) => res.json({ ok: true }));

  return router;
}
