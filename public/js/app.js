// MIR Live Stats — client. Vanilla JS only (no jQuery).
// `io` comes from /socket.io/socket.io.js loaded in the footer. We join the
// "stats" room; the server pushes a full `stats` snapshot (~1.5s) plus a live
// `tail` event per upstream log line.
const socket = io();

socket.on('connect', () => socket.emit('join', 'stats'));

const $ = (id) => document.getElementById(id);

// Per-attacker lookup / abuse-reporting services. Each renders a small clickable
// favicon (hosted locally in /images) that opens that service's page for the IP.
const SERVICES = [
  { name: 'AbuseIPDB', icon: '/images/abuseipdb.png', url: (ip) => `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}` },
  { name: 'Shodan', icon: '/images/shodan.png', url: (ip) => `https://www.shodan.io/host/${encodeURIComponent(ip)}` },
  { name: 'ipinfo', icon: '/images/ipinfo.png', url: (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}` },
];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Source colors mirror mir.org's /logs viewer; unknown sources get a stable hue.
const KNOWN = {
  'mir-com': '#34d399', 'mir-org': '#facc15', mirassertions: '#a78bfa',
  mircapture: '#f472b6', mirresolve: '#fb923c', mirprotocol: '#38bdf8',
  claude: '#d97757', // Claude Code's own /v1/events telemetry from loopback
};
function sourceColor(s) {
  if (KNOWN[s]) return KNOWN[s];
  const k = (s || '').toLowerCase().slice(0, 3);
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h * 31) + k.charCodeAt(i)) | 0;
  return `hsl(${((h % 360) + 360) % 360}, 60%, 65%)`;
}
const clsColor = { '2xx': 'green', '3xx': 'yellow', '4xx': 'red', '5xx': 'crit', '1xx': 'muted', other: 'muted' };

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function rows(tbody, items, fmtVal) {
  if (!items.length) { tbody.innerHTML = '<tr><td class="muted">—</td></tr>'; return; }
  tbody.innerHTML = items
    .map((it) => `<tr><td class="key">${fmtVal ? fmtVal(it) : esc(it.key)}</td><td class="num">${it.count.toLocaleString()}</td></tr>`)
    .join('');
}

function renderStats(d) {
  // upstream + header
  const up = $('upstream');
  up.textContent = d.upstream;
  up.className = d.upstream === 'connected' ? 'pulse-ok' : 'pulse-bad';
  $('uptime').textContent = fmtUptime(d.uptimeMs);
  $('lines').textContent = d.counts.lines.toLocaleString();

  // cards
  $('c-req').textContent = d.counts.requests.toLocaleString();
  $('c-reqsub').textContent = `${d.counts.requests ? Math.round((d.counts.assets / d.counts.requests) * 100) : 0}% assets`;
  $('c-rate').textContent = d.ratePerMin.toLocaleString();
  $('c-err').textContent = d.errorRate + '%';
  $('c-atk').textContent = d.counts.attacks.toLocaleString();
  $('c-atksub').textContent = d.attackRate + '% of reqs';
  $('c-alert').textContent = d.counts.alerts.toLocaleString();
  $('c-bots').textContent = d.counts.bots.toLocaleString();
  $('c-assetsub').textContent = `${d.counts.assets.toLocaleString()} asset hits`;

  // rpm bars
  const peak = Math.max(1, ...d.rpm);
  $('rpm-peak').textContent = `peak ${peak}/min`;
  $('rpm').innerHTML = d.rpm
    .map((v) => {
      const pct = Math.round((v / peak) * 100);
      const hot = v >= peak * 0.8 && v > 0;
      return `<div class="bar${hot ? ' hot' : ''}" style="height:${v ? Math.max(2, pct) : 0}%" title="${v}/min"></div>`;
    })
    .join('');

  // status split bar
  const order = [['2xx', 's2'], ['3xx', 's3'], ['4xx', 's4'], ['5xx', 's5'], ['other', 'so']];
  const totalS = order.reduce((a, [k]) => a + (d.byStatus[k] || 0), 0) || 1;
  $('status-bar').innerHTML = order
    .filter(([k]) => d.byStatus[k])
    .map(([k, c]) => {
      const pct = (d.byStatus[k] / totalS) * 100;
      return `<span class="${c}" style="width:${pct}%" title="${k}: ${d.byStatus[k]}">${pct > 7 ? k : ''}</span>`;
    })
    .join('');
  $('status-legend').innerHTML = order
    .filter(([k]) => d.byStatus[k])
    .map(([k]) => `<span>${k} <span class="${clsColor[k]}">${d.byStatus[k].toLocaleString()}</span></span>`)
    .join('');

  // sources chips (clickable -> filter the live tail)
  $('sources').innerHTML = d.bySource
    .map((s) => `<span class="chip src-chip${s.key === tailFilter ? ' active' : ''}" data-src="${esc(s.key)}"><span style="color:${sourceColor(s.key)}">${esc(s.key)}</span><span class="c">${s.count.toLocaleString()}</span></span>`)
    .join('');

  // tables
  rows($('paths'), d.topPaths);
  rows($('ips'), d.topIps);
  rows($('attackers'), d.topAttackers, (it) => {
    const links = SERVICES.map((s) =>
      `<a class="svc" href="${s.url(it.key)}" target="_blank" rel="noopener noreferrer" title="${s.name}: ${esc(it.key)}"><img src="${s.icon}" alt="${s.name}" width="14" height="14" loading="lazy"></a>`
    ).join('');
    return `<span class="atk-ip">${esc(it.key)}</span> <span class="svc-row">${links}</span>`;
  });

  // methods
  $('methods').innerHTML = d.byMethod
    .map((m) => `<span class="chip"><span class="green">${esc(m.key)}</span><span class="c">${m.count.toLocaleString()}</span></span>`)
    .join('');

  // alerts
  const al = $('alerts');
  if (!d.alerts.length) al.innerHTML = '<div class="muted small">none yet</div>';
  else al.innerHTML = d.alerts.map((a) => `<div class="a">${esc(a.line)}</div>`).join('');
}

// ── live tail ──
const TAIL_MAX = 150;
const tailEl = $('tail');
let autoScroll = true;
let tailFilter = null; // active source filter, or null = show all

// Click a source chip to filter the tail to that source (toggle off by re-click).
$('sources').addEventListener('click', (e) => {
  const chip = e.target.closest('.src-chip');
  if (!chip) return;
  const s = chip.dataset.src;
  tailFilter = tailFilter === s ? null : s;
  syncSourceChips();
  applyTailFilter();
});
$('tail-filter').addEventListener('click', () => { tailFilter = null; syncSourceChips(); applyTailFilter(); });

function syncSourceChips() {
  document.querySelectorAll('#sources .src-chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.src === tailFilter));
}

function applyTailFilter() {
  for (const ln of tailEl.children) ln.hidden = tailFilter && ln.dataset.source !== tailFilter;
  const ind = $('tail-filter');
  ind.innerHTML = tailFilter
    ? `filtering <span style="color:${sourceColor(tailFilter)}">${esc(tailFilter)}</span> <span class="clear">✕</span>`
    : '';
  if (autoScroll) tailEl.scrollTop = tailEl.scrollHeight;
}
tailEl.addEventListener('scroll', () => {
  autoScroll = tailEl.scrollTop + tailEl.clientHeight >= tailEl.scrollHeight - 40;
});
function clock(ms) {
  const d = ms ? new Date(ms) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendTail(t) {
  const div = document.createElement('div');
  div.className = 'ln' + (t.alert ? ' alert' : t.attack ? ' atk' : '');
  const ts = `<span class="ts">${clock(t.t)}</span> `;
  const src = `<span class="src" style="color:${sourceColor(t.source)}">[${esc(t.source)}]</span> `;
  const meth = t.method ? `<span class="green">${esc(t.method)}</span> ` : '';
  const st = t.status ? `<span class="${clsColor[t.cls] || 'muted'}">${t.status}</span> ` : '';
  const ip = t.ip ? `<span class="muted">${esc(t.ip)}</span> ` : '';
  div.dataset.source = t.source || 'mir';
  if (tailFilter && div.dataset.source !== tailFilter) div.hidden = true;
  div.innerHTML = ts + src + meth + st + ip + `<span>${esc(t.path || t.raw)}</span>`;
  tailEl.appendChild(div);
  while (tailEl.children.length > TAIL_MAX) tailEl.removeChild(tailEl.firstChild);
  if (autoScroll && !div.hidden) tailEl.scrollTop = tailEl.scrollHeight;
}

socket.on('stats', renderStats);
socket.on('tail', appendTail);

// Initial paint from the JSON API in case the first snapshot is slow.
fetch('/api/stats').then((r) => r.json()).then((d) => { if (d && d.counts) renderStats(d); }).catch(() => {});
