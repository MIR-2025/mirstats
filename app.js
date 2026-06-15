// ── Entry point ────────────────────────────────────────────────────────────
// Node.js (ESM) + Express + Socket.io + Redis sessions + MongoDB.
import './lib/env.js'; // must be first: loads local + shared ../.env before others read process.env
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { connectMongo, closeMongo } from './lib/mongo.js';
import { connectRedis, redis, sessionMiddleware } from './lib/redis.js';
import { accessLogger } from './middleware/logger.js';
import { createRouter } from './router.js';
import { startLogStream } from './lib/logStream.js';
import { basicAuth, checkBasicAuth, basicAuthEnabled } from './middleware/basicAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function start() {
  // External services first so nothing serves traffic before they're ready.
  await connectMongo();
  await connectRedis();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // ── Auth gate FIRST: nothing (page, /api/stats, static) serves without creds ──
  app.use(basicAuth);

  // ── Middleware order matters ──
  app.use(accessLogger);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const sessions = sessionMiddleware();
  app.use(sessions);

  // Share the session with Socket.io connections.
  io.engine.use(sessions);

  app.use(express.static(path.join(__dirname, 'public')));

  // Make common values available to every view.
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.siteName = process.env.SITE_NAME || 'My Site';
    res.locals.currentPath = req.path;
    next();
  });

  // ── Live log stream → stats aggregator → "stats" room ──
  // Connects to mir.org's /logs Socket.io feed and folds every line into
  // rolling in-memory stats that we push to dashboards.
  const logStream = startLogStream(io);

  // ── Routes ──
  app.use('/', createRouter({ redis, io, logStream }));

  // 404 fallback.
  app.use((req, res) => {
    res.status(404).render('errors/404', { pageTitle: 'Not found' });
  });

  // ── Socket.io ── gate the handshake with the same credentials.
  io.use((socket, next) => {
    if (checkBasicAuth(socket.request.headers.authorization)) return next();
    next(new Error('unauthorized'));
  });
  io.on('connection', (socket) => {
    socket.on('join', (room) => socket.join(room));
    socket.on('disconnect', () => {});
  });

  server.listen(PORT, () => {
    console.log(`${process.env.SITE_NAME || 'Site'} listening on http://localhost:${PORT}`);
  });

  // ── Graceful shutdown (clean PM2 restarts) ──
  const shutdown = async () => {
    server.close();
    logStream.stop(); // flush cumulative stats to disk + close the upstream feed
    await redis.quit().catch(() => {});
    await closeMongo().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
