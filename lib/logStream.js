// Connects to mir.org's live `/logs` Socket.io feed as a CLIENT, parses every
// line, folds it into the stats aggregator, and fans results out to this site's
// own dashboard room ("stats") over our local Socket.io server.
//
// Upstream protocol (see mir.org server.ts /logs): connect → emit
// 'subscribe:logs' → receive 'log:line' (raw string) events. socket.io-client
// reconnects automatically, re-emitting subscribe on every (re)connect.

import { io as ioClient } from 'socket.io-client';
import { parseLine } from './logParser.js';
import { createStats } from './stats.js';

const SOURCE_URL = process.env.LOG_SOURCE_URL || 'http://localhost:51211';
const SNAPSHOT_MS = 1500; // how often a fresh snapshot is pushed to dashboards

export function startLogStream(io) {
  const stats = createStats();
  let upstream = 'connecting';

  const upstreamSocket = ioClient(SOURCE_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelayMax: 10000,
  });

  upstreamSocket.on('connect', () => {
    upstream = 'connected';
    upstreamSocket.emit('subscribe:logs');
    console.log(`[logStream] connected to ${SOURCE_URL}`);
  });
  upstreamSocket.on('disconnect', (reason) => {
    upstream = 'disconnected';
    console.log(`[logStream] upstream disconnected: ${reason}`);
  });
  upstreamSocket.on('connect_error', (err) => {
    upstream = 'error';
    console.log(`[logStream] upstream connect_error: ${err.message}`);
  });

  upstreamSocket.on('log:line', (line) => {
    const rec = parseLine(line);
    stats.record(rec);
    // Compact live-tail event (the browser caps how many it shows).
    io.to('stats').emit('tail', {
      t: Date.now(),
      raw: rec.raw,
      source: rec.source,
      method: rec.method,
      status: rec.status,
      cls: rec.statusClass,
      ip: rec.ip,
      path: rec.path,
      attack: rec.isAttack,
      alert: rec.isAlert,
    });
  });

  // Each dashboard socket views either all sources (null) or one selected
  // source. We track that per socket and push every viewer its own snapshot.
  const viewers = new Map(); // socket -> selected source (null = all)
  const snapFor = (source) => ({ upstream, ...stats.snapshot(source) });

  // Periodic snapshot to all connected dashboards, scoped per viewer.
  const timer = setInterval(() => {
    for (const [socket, source] of viewers) socket.emit('stats', snapFor(source));
  }, SNAPSHOT_MS);
  timer.unref?.();

  io.on('connection', (socket) => {
    // Push a full snapshot immediately when a dashboard joins.
    socket.on('join', (room) => {
      if (room !== 'stats') return;
      viewers.set(socket, null);
      socket.emit('stats', snapFor(null));
    });
    // Client clicked a source chip → scope this viewer's whole stats view to it
    // (falsy clears back to all). Refresh immediately, don't wait for the tick.
    socket.on('filter:source', (source) => {
      if (!viewers.has(socket)) return;
      const s = source || null;
      viewers.set(socket, s);
      socket.emit('stats', snapFor(s));
    });
    socket.on('disconnect', () => viewers.delete(socket));
  });

  return {
    snapshot: () => ({ upstream, ...stats.snapshot() }),
    stop: () => {
      clearInterval(timer);
      upstreamSocket.close();
    },
  };
}
