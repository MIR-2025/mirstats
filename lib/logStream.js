// Connects to mir.org's live `/logs` Socket.io feed as a CLIENT, parses every
// line, folds it into the stats aggregator, and fans results out to this site's
// own dashboard room ("stats") over our local Socket.io server.
//
// Upstream protocol (see mir.org server.ts /logs): connect → emit
// 'subscribe:logs' → receive 'log:line' (raw string) events. socket.io-client
// reconnects automatically, re-emitting subscribe on every (re)connect.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { parseLine } from 'mir-sentinel';
import { createStats } from './stats.js';
import { createReporter } from './reporter.js';
import { createHistory } from './history.js';
import { createGeo } from './geo.js';
import { collections } from './mongo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'stats-state.json');
const SOURCE_URL = process.env.LOG_SOURCE_URL || 'http://localhost:51211';
const SNAPSHOT_MS = 1500; // how often a fresh snapshot is pushed to dashboards
const STATE_SAVE_MS = 30000; // how often cumulative stats are snapshotted to disk

export function startLogStream(io, { routes } = {}) {
  const isKnownRoute = routes ? routes.isKnownRoute : () => false;
  const hasIndex = routes ? routes.hasIndex : () => false;
  const stats = createStats();
  const reporter = createReporter(io);
  const history = createHistory();
  const geo = createGeo();
  let upstream = 'connecting';

  // Restore cumulative stats from the last snapshot so a restart keeps the cards.
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(STATE_FILE)) {
      stats.restore(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
      console.log('[stats] restored cumulative state from disk');
    }
  } catch (e) {
    console.log('[stats] restore failed:', e.message);
  }

  function saveState() {
    try {
      writeFileSync(STATE_FILE + '.tmp', JSON.stringify(stats.serialize()));
      renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch { /* ignore disk errors */ }
  }
  const stateTimer = setInterval(saveState, STATE_SAVE_MS);
  stateTimer.unref?.();

  // Per-request event log to Mongo (batched) for IP search. Best-effort: if Mongo
  // is unavailable the batch is dropped rather than blocking the stream.
  const eventBatch = [];
  const flushEvents = async () => {
    if (!eventBatch.length) return;
    const docs = eventBatch.splice(0, eventBatch.length);
    try { await collections.events().insertMany(docs, { ordered: false }); } catch { /* mongo down -> drop */ }
  };
  const eventTimer = setInterval(flushEvents, 2000);
  eventTimer.unref?.();

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
    if (rec.ip) rec.country = geo.country(rec.ip); // 2-letter CC or null
    // Route-index signals: whether this source is mapped, and whether the path is
    // one of its real routes. Lets stats tell a broken route / real 4xx from a
    // 404 on a path that never existed (scanner noise).
    if (rec.isRequest && rec.path) {
      rec.knownRoute = isKnownRoute(rec.source, rec.path);
      rec.indexedSource = hasIndex(rec.source);
      if (rec.knownRoute && (rec.status === 404 || rec.statusClass === '5xx')) rec.brokenRoute = true;
    }
    stats.record(rec);
    if (rec.isRequest) history.record(rec.statusClass);
    if (rec.isRequest && rec.ip) {
      eventBatch.push({ t: new Date(), ip: rec.ip, source: rec.source, method: rec.method, path: rec.path, status: rec.status, cls: rec.statusClass, attack: !!rec.isAttack, country: rec.country || null });
      if (eventBatch.length > 5000) eventBatch.splice(0, eventBatch.length - 5000); // cap memory if Mongo is down
    }
    if (rec.isAttack) reporter.onAttack(rec);
    if (rec.isRequest && rec.ip) reporter.onRequest(rec); // behavioral 4xx-burst signal
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
  const snapFor = (source) => {
    const cur = history.current(); // one read, so the card and the live bar can't disagree by a stray line
    return {
      upstream,
      ...stats.snapshot(source),
      reports: reporter.recent(),
      rpmCur: cur, // current bucket, for live bar updates
      histBounds: history.bounds(), // earliest/latest minute available
      rpmBucket: history.bucket, // minutes per chart bar
      hits5: cur.total, // current in-progress 5-min bucket — equals the live right-edge bar by construction
    };
  };

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
    snapshot: () => snapFor(null),
    rpmWindow: (from, to) => history.windowFor(from, to),
    rpmBounds: () => history.bounds(),
    rpmMaxSpan: history.MAX_SPAN,
    rpmBucket: history.bucket,
    stop: () => {
      clearInterval(timer);
      clearInterval(stateTimer);
      clearInterval(eventTimer);
      saveState();
      flushEvents();
      upstreamSocket.close();
    },
  };
}
