// Main application router. Mounts feature routes and page routes.
// Exported as a factory so routes can access shared services (redis, io, logStream).
import express from 'express';
import authRoutes from './routes/auth.js';

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

  // Health check.
  router.get('/healthz', (req, res) => res.json({ ok: true }));

  return router;
}
