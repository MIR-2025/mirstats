// Known reverse-proxy / CDN edge ranges.
//
// When a site sits behind a CDN like Cloudflare and the origin doesn't un-wrap
// the real client IP (X-Forwarded-For / CF-Connecting-IP), the logged source IP
// is the CDN's edge, not the attacker. So we must NOT treat these as attackers
// or report them. This is only for CDNs that FRONT sites — not cloud hosting
// (GCP / DigitalOcean / etc.), where a rented VM genuinely is the abuse origin.
//
// Matching is done with real bit-masks (works for both IPv4 and IPv6).

const CIDRS = [
  // Cloudflare IPv4 — https://www.cloudflare.com/ips-v4
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/12',
  '172.64.0.0/13', '131.0.72.0/22',
  // Cloudflare IPv6 — https://www.cloudflare.com/ips-v6
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function v4ToBig(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const o of p) {
    const x = Number(o);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8n) | BigInt(x);
  }
  return n; // 32-bit
}

function v6ToBig(ip) {
  ip = ip.replace(/^\[|\]$/g, '').split('%')[0]; // strip brackets / zone id
  if (!ip.includes(':') || ip.includes('.')) return null; // skip IPv4-mapped — rare here
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const hasGap = halves.length === 2;
  const tail = hasGap && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (!hasGap) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n; // 128-bit
}

function parseCidr(cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const v6 = net.includes(':');
  const total = v6 ? 128 : 32;
  const base = v6 ? v6ToBig(net) : v4ToBig(net);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > total) return null;
  const all = (1n << BigInt(total)) - 1n;
  const mask = bits === 0 ? 0n : (~0n << BigInt(total - bits)) & all;
  return { v6, base: base & mask, mask };
}

const PARSED = CIDRS.map(parseCidr).filter(Boolean);

// True if `ip` falls inside a known CDN/reverse-proxy range.
export function isProxyIp(ip) {
  if (!ip) return false;
  const v6 = ip.includes(':');
  const n = v6 ? v6ToBig(ip) : v4ToBig(ip);
  if (n === null) return false;
  for (const c of PARSED) {
    if (c.v6 !== v6) continue;
    if ((n & c.mask) === c.base) return true;
  }
  return false;
}
