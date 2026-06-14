// Tolerant parser for a heterogeneous web-server log stream.
//
// Lines arrive over the upstream `log:line` channel in many per-site formats
// (nginx / apache-combined / JSON-ish / custom), each optionally prefixed with
// `[source] ` by the upstream shipper. Rather than match every format exactly,
// we extract the few fields that matter for stats generically: source, method,
// path, status, ip — plus a handful of class flags.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const STATUS_RE = /^[1-5]\d\d$/;

// Probe / scanner fingerprints seen constantly in the stream.
const ATTACK_RE = new RegExp(
  [
    '\\.env', '\\.git', '\\.aws', '\\.ssh', 'id_rsa', 'id_ed25519',
    'wp-admin', 'wp-login', 'wp-config', 'xmlrpc', 'wlwmanifest', 'wp-json',
    'phpinfo', 'php-cgi', 'eval-stdin', 'cgi-bin', 'etc/passwd', 'etc/shadow',
    'proc/self', 'actuator', 'telescope', 'wlwmanifest', 'jolokia', 'heapdump',
    'credentials', 'secrets', 'config\\.json', 'config\\.php', 'settings\\.py',
    '\\.aws/credentials', 'global-protect', 'tmui', 'docker-compose',
    'backup\\.sql', 'dump\\.sql', '_ignition', 'com_jce', 'gravitysmtp',
    '\\.DS_Store', '\\.npmrc', '\\.pypirc', 'application\\.properties',
  ].join('|'),
  'i'
);

const ASSET_RE = /\.(?:webp|png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|xml|txt)(?:[?#]|$)|\/socket\.io|\/widget\.js|\/launcher-image/i;

// Bot/crawler markers (only present when a UA is in the line — apache/quoted formats).
const BOT_RE = /\b(bot|spider|crawl|bingbot|googlebot|gptbot|chatgpt|oai-searchbot|claudebot|ahrefs|bytespider|applebot|amazonbot|yandex|semrush|petalbot|dataforseo|facebookexternalhit|palo alto|censys|expanse)\b/i;

function looksLikeIp(tok) {
  if (!tok) return false;
  if (IPV4_RE.test(tok)) return true;
  // IPv6 — but NOT clock times like "9:20:35" or "04:16:07" (2 colons, decimal).
  // Accept compressed form (contains "::"), or a full address: >=6 groups of
  // 1–4 hex with at least one group carrying a hex letter or 3+ digits.
  if (!/^[0-9a-f:.]+$/i.test(tok)) return false;
  if (tok.includes('::')) return true;
  const groups = tok.split(':');
  if (groups.length >= 6 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) &&
      groups.some((g) => /[a-f]/i.test(g) || g.length >= 3)) return true;
  return false;
}

function normalizePath(target) {
  if (!target) return null;
  let t = target.replace(/^"+|"+$/g, ''); // strip surrounding quotes (apache "GET /x HTTP/1.1")
  // Strip a leading host (localhost/v1/..., .mirregistry.org/..., mir.events/...).
  if (!t.startsWith('/')) {
    const slash = t.indexOf('/');
    t = slash >= 0 ? t.slice(slash) : '/' + t;
  }
  // Drop query/fragment for grouping; keep it short.
  const q = t.search(/[?#]/);
  if (q >= 0) t = t.slice(0, q);
  if (t.length > 80) t = t.slice(0, 80) + '…';
  return t || '/';
}

/**
 * Parse one raw log line. Returns a structured record; fields are null when the
 * line doesn't carry them (heartbeats, app debug dumps, alert banners).
 */
export function parseLine(raw) {
  const rec = {
    raw,
    source: 'mir',
    method: null,
    path: null,
    status: null,
    statusClass: 'other',
    ip: null,
    isAlert: false,
    isAttack: false,
    isAsset: false,
    isBot: false,
    isRequest: false,
  };
  if (typeof raw !== 'string' || !raw.length) return rec;

  let line = raw;

  // Optional [source] prefix (alnum/-/_), added by the upstream shipper. A bracketed
  // timestamp like "[6/10/2026, 5:16 PM]" contains "/" and won't match.
  const srcMatch = line.match(/^\[([a-zA-Z0-9_-]+)\]\s+/);
  if (srcMatch) {
    rec.source = srcMatch[1];
    line = line.slice(srcMatch[0].length);
  }

  rec.isAlert = raw.includes('*** ALERT ***') || raw.includes('ALERT sample line');

  // Tokenize on whitespace for positional extraction.
  const tokens = line.split(/\s+/);

  // method = first token that is exactly a verb, or a quoted "GET.
  let mIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const bare = tokens[i].replace(/^"/, '');
    if (METHODS.includes(bare)) { rec.method = bare; mIdx = i; break; }
  }

  if (mIdx >= 0) {
    rec.isRequest = true;
    // path = next token after the method.
    rec.path = normalizePath(tokens[mIdx + 1]);
    // status = first 3-digit 1xx–5xx token after the method.
    for (let i = mIdx + 1; i < tokens.length; i++) {
      if (STATUS_RE.test(tokens[i])) {
        rec.status = Number(tokens[i]);
        rec.statusClass = tokens[i][0] + 'xx';
        break;
      }
    }
  } else if (!rec.method && METHOD_RE.test(line)) {
    // Fallback for unusual spacing.
    const m = line.match(METHOD_RE);
    rec.method = m[1];
    rec.isRequest = true;
  }

  // ip = first IP-looking token anywhere in the (de-prefixed) line.
  for (const tok of tokens) {
    const clean = tok.replace(/[",]/g, '');
    if (looksLikeIp(clean)) { rec.ip = clean; break; }
  }

  if (rec.path) {
    rec.isAttack = ATTACK_RE.test(rec.path);
    rec.isAsset = ASSET_RE.test(rec.path);
  }
  rec.isBot = BOT_RE.test(raw);

  // Claude Code's own telemetry: POST /v1/events from loopback. Relabel the
  // source "claude" so it's distinct from real partner event ingest (which
  // comes from a prod node IP, not 127.0.0.1). Note: the log line carries no
  // per-session field, so the many concurrent CLI instances all collapse into
  // this one "claude" source -- they are indistinguishable upstream.
  const loopback = rec.ip === '127.0.0.1' || rec.ip === '::1' || (rec.ip && rec.ip.endsWith(':127.0.0.1'));
  if (rec.path === '/v1/events' && loopback) {
    rec.source = 'claude';
    rec.isAsset = true; // keep it out of "top paths" noise
  }

  return rec;
}

export const _internals = { ATTACK_RE, ASSET_RE, BOT_RE };
