// HTTP Basic Auth gate for the whole dashboard (and the Socket.io feed).
//
// Credentials live in this site's .env (BASIC_AUTH_USER / BASIC_AUTH_PASS).
// Same-origin browsers replay the Authorization header on the socket.io
// handshake once Basic Auth is established for the page, so gating both the
// HTTP middleware and the io handshake with `checkBasicAuth` covers the live
// stream too -- a raw unauthenticated socket client is rejected.
import crypto from 'node:crypto';

const USER = process.env.BASIC_AUTH_USER || '';
const PASS = process.env.BASIC_AUTH_PASS || '';
const ENABLED = Boolean(USER && PASS);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function checkBasicAuth(authHeader) {
  if (!ENABLED) return true; // unconfigured = open (won't lock out via misconfig)
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), USER) && safeEqual(decoded.slice(i + 1), PASS);
}

export function basicAuth(req, res, next) {
  if (req.path === '/healthz') return next(); // keep uptime checks open
  if (checkBasicAuth(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="mirstats", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

export const basicAuthEnabled = ENABLED;
