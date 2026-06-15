// Main application router. Mounts feature routes and page routes.
// Exported as a factory so routes can access shared services (redis, io, logStream).
import express from 'express';
import authRoutes from './routes/auth.js';
import { analyzeRange } from './lib/analyze.js';

export function createRouter({ redis, io, logStream } = {}) {
  const router = express.Router();

  router.use('/auth', authRoutes);

  // Live stats dashboard.
  router.get('/', (req, res) => {
    res.render('index', { pageTitle: 'Live Stats' });
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
    res.json({ bars: logStream.rpmWindow(from, to), bounds, maxSpan: logStream.rpmMaxSpan });
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

  // Health check.
  router.get('/healthz', (req, res) => res.json({ ok: true }));

  return router;
}
