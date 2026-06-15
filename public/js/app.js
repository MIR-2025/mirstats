// MIR Live Stats — client. Vanilla JS only (no jQuery).
// `io` comes from /socket.io/socket.io.js loaded in the footer. We join the
// "stats" room; the server pushes a full `stats` snapshot (~1.5s) plus a live
// `tail` event per upstream log line.
const socket = io();

const $ = (id) => document.getElementById(id);

socket.on('connect', () => {
  socket.emit('join', 'stats');
  if (tailFilter) socket.emit('filter:source', tailFilter); // restore filter after a reconnect
});

// ── theme (persisted light / dark) ──
const THEME_KEY = 'mirstats.theme';
const dashEl = document.querySelector('.dash');
function applyTheme(mode) {
  const light = mode === 'light';
  document.body.classList.toggle('theme-light', light);
  if (dashEl) dashEl.setAttribute('data-bs-theme', light ? 'light' : 'dark');
  const btn = $('theme-toggle');
  if (btn) { btn.textContent = light ? '☀' : '☾'; btn.title = light ? 'Switch to dark' : 'Switch to light'; }
}
let theme = 'dark';
try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* storage disabled */ }
applyTheme(theme);
$('theme-toggle').addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
});

// Per-attacker lookup / abuse-reporting services. Each renders a small clickable
// favicon (hosted locally in /images) that opens that service's page for the IP.
const SERVICES = [
  { name: 'AbuseIPDB', icon: '/images/abuseipdb.png', url: (ip) => `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}` },
  { name: 'ipinfo', icon: '/images/ipinfo.png', url: (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}` },
];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Curated colors for a few well-known source names; any other source gets a
// stable auto-hue from the hash below. Edit these to match your own sources.
const KNOWN = {
  api: '#34d399', web: '#facc15', auth: '#a78bfa',
  cdn: '#f472b6', worker: '#fb923c', cron: '#38bdf8',
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

  // (the requests/minute chart is driven separately by the history store — see
  // the historical req/min chart section + chartLive())

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

  // auto-reports (attacker IPs past the hit threshold)
  const rep = $('reports');
  if (!d.reports || !d.reports.length) rep.innerHTML = '<div class="muted small">none yet</div>';
  else rep.innerHTML = d.reports.map((r) => {
    const loc = [r.org || r.asn, r.country].filter(Boolean).join(' · ');
    const badge = r.mode === 'submitted'
      ? `<span class="${r.ok ? 'green' : 'red'}">${r.ok ? 'reported' : 'failed' + (r.status ? ' ' + r.status : '')}</span>`
      : '<span class="yellow">flagged</span>';
    return `<div class="rep"><span class="atk-ip">${esc(r.ip)}</span> <span class="muted">${r.hits}×</span> ${badge}${loc ? ` <span class="muted">${esc(loc)}</span>` : ''}</div>`;
  }).join('');
}

// ── live tail ──
const TAIL_MAX = 150;
const tailEl = $('tail');
let autoScroll = true;
let tailFilter = null; // active source filter, or null = show all

// Click a source chip to scope the WHOLE dashboard — stats and tail — to that
// source; re-click the chip (or the ✕) clears back to all sources.
function setSourceFilter(s) {
  tailFilter = s;
  socket.emit('filter:source', s); // server replies with a snapshot for this source
  syncSourceChips();
  applyTailFilter();
}
$('sources').addEventListener('click', (e) => {
  const chip = e.target.closest('.src-chip');
  if (!chip) return;
  const s = chip.dataset.src;
  setSourceFilter(tailFilter === s ? null : s);
});
$('tail-filter').addEventListener('click', () => setSourceFilter(null));

function syncSourceChips() {
  document.querySelectorAll('#sources .src-chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.src === tailFilter));
}

function applyTailFilter() {
  for (const ln of tailEl.children) ln.hidden = tailFilter && ln.dataset.source !== tailFilter;
  const ind = $('tail-filter');
  ind.innerHTML = tailFilter
    ? `showing only <span style="color:${sourceColor(tailFilter)}">${esc(tailFilter)}</span> <span class="clear">✕</span>`
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

// ── historical req/min chart (scrollable, windowed, 1-year backing store) ──
// Per-minute bars, newest at right. The live "now" minute ticks in; scroll or
// mouse-wheel left to browse, and adjacent windows lazy-load at the edges. A
// date picker jumps anywhere in the retained year. Only a bounded window is ever
// in the DOM, so it stays smooth no matter how far back the data goes.
const RPM_ORDER = [['2xx', 's2'], ['3xx', 's3'], ['4xx', 's4'], ['5xx', 's5'], ['other', 'so']];
const BAR_PX = 4;     // must match #rpm .bar width in CSS
const CHUNK = 360;    // minutes fetched per edge-load (6h)
const DOM_MAX = 4320; // max bars kept in the DOM (3 days)
const chartEl = $('rpm');
let chartBars = [];   // loaded window, ascending by minute
let chartPeak = 1;
let following = true; // pinned to the live "now" edge
let histLatest = Math.floor(Date.now() / 60000);
let histEarliest = histLatest;
let loadingEdge = false;

function stampMin(m) {
  const d = new Date(m * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fillBar(el, b, peak) {
  el.style.height = (b.total ? Math.max(2, Math.round((b.total / peak) * 100)) : 0) + '%';
  el._b = b; // backing data for the custom tooltip (no native title -> no delay)
  el.innerHTML = b.total
    ? RPM_ORDER.filter(([k]) => b[k]).map(([k, c]) => `<span class="seg ${c}" style="height:${(b[k] / b.total) * 100}%"></span>`).join('')
    : '';
}
function makeBar(b, peak) {
  const el = document.createElement('div');
  el.className = 'bar';
  el.dataset.m = b.m;
  fillBar(el, b, peak);
  return el;
}
function renderChart() {
  chartPeak = Math.max(1, ...chartBars.map((b) => b.total));
  const frag = document.createDocumentFragment();
  for (const b of chartBars) frag.appendChild(makeBar(b, chartPeak));
  chartEl.replaceChildren(frag);
  const pk = $('rpm-peak');
  if (pk) pk.textContent = `peak ${chartPeak}/min`;
}
async function fetchWindow(fromM, toM) {
  try {
    const d = await (await fetch(`/api/rpm?from=${fromM}&to=${toM}`)).json();
    if (d.bounds) { histEarliest = d.bounds.earliest; histLatest = d.bounds.latest; }
    return d.bars || [];
  } catch { return []; }
}
async function loadNow() {
  try {
    const d = await (await fetch('/api/rpm')).json(); // default = last 12h → latest
    if (d.bounds) { histEarliest = d.bounds.earliest; histLatest = d.bounds.latest; }
    chartBars = d.bars || [];
  } catch { chartBars = []; }
  renderChart();
  chartEl.scrollLeft = chartEl.scrollWidth;
  following = true;
}
async function loadOlder() {
  if (loadingEdge || !chartBars.length || chartBars[0].m <= histEarliest) return;
  loadingEdge = true;
  const toM = chartBars[0].m - 1;
  const older = await fetchWindow(Math.max(histEarliest, toM - CHUNK + 1), toM);
  if (older.length) {
    chartBars = older.concat(chartBars);
    if (chartBars.length > DOM_MAX) chartBars = chartBars.slice(0, DOM_MAX);
    renderChart();
    chartEl.scrollLeft += older.length * BAR_PX; // keep the viewport on the same bars
  }
  loadingEdge = false;
}
async function loadNewer() {
  if (loadingEdge || !chartBars.length) return;
  const last = chartBars[chartBars.length - 1].m;
  if (last >= histLatest) return;
  loadingEdge = true;
  const newer = await fetchWindow(last + 1, Math.min(histLatest, last + CHUNK));
  if (newer.length) {
    chartBars = chartBars.concat(newer);
    if (chartBars.length > DOM_MAX) chartBars = chartBars.slice(chartBars.length - DOM_MAX);
    renderChart();
  }
  loadingEdge = false;
}
// live current-minute update from the periodic snapshot (only while following)
function chartLive(d) {
  if (d.histBounds) histLatest = Math.max(histLatest, d.histBounds.latest);
  const cur = d.rpmCur;
  if (!cur || !following || !chartBars.length) return;
  const last = chartBars[chartBars.length - 1];
  if (cur.m === last.m) {
    chartBars[chartBars.length - 1] = cur;
    if (cur.total > chartPeak) renderChart();
    else fillBar(chartEl.lastElementChild, cur, chartPeak);
  } else if (cur.m > last.m) {
    for (let m = last.m + 1; m < cur.m; m++) chartBars.push({ m, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0, total: 0 });
    chartBars.push(cur);
    if (chartBars.length > DOM_MAX) chartBars = chartBars.slice(chartBars.length - DOM_MAX);
    renderChart();
  }
  chartEl.scrollLeft = chartEl.scrollWidth;
}
// mouse wheel = horizontal scroll while hovering the chart
chartEl.addEventListener('wheel', (e) => {
  if (!e.deltaY) return;
  e.preventDefault();
  chartEl.scrollLeft += e.deltaY;
}, { passive: false });
// follow/browse state + lazy edge loading
chartEl.addEventListener('scroll', () => {
  const atRight = chartEl.scrollLeft + chartEl.clientWidth >= chartEl.scrollWidth - 8;
  const last = chartBars.length ? chartBars[chartBars.length - 1].m : 0;
  following = atRight && last >= histLatest - 1;
  if (chartEl.scrollLeft < BAR_PX * 30) loadOlder();
  else if (atRight && !following) loadNewer();
});
// date picker → jump to ±6h around the chosen time
const rpmDate = $('rpm-date');
if (rpmDate) rpmDate.addEventListener('change', async () => {
  const ms = Date.parse(rpmDate.value);
  if (isNaN(ms)) return;
  const c = Math.floor(ms / 60000);
  following = false;
  chartBars = await fetchWindow(c - 360, c + 360);
  renderChart();
  chartEl.scrollLeft = (chartEl.scrollWidth - chartEl.clientWidth) / 2;
});
// "now" button → jump back to the live edge
const rpmNow = $('rpm-now');
if (rpmNow) rpmNow.addEventListener('click', () => loadNow());

// custom chart tooltip — instant (no native title delay), themed, showing the
// per-status-class breakdown for the hovered minute. One reused element + event
// delegation, so it's cheap even with thousands of bars.
const rpmTip = document.createElement('div');
rpmTip.className = 'rpm-tip';
rpmTip.style.display = 'none';
document.body.appendChild(rpmTip);
function showTip(bar, x, y) {
  const b = bar._b;
  if (!b) return;
  const rowsHtml = RPM_ORDER.filter(([k]) => b[k])
    .map(([k]) => `<div><span class="${clsColor[k] || 'muted'}">${k}</span> ${b[k]}</div>`).join('')
    || '<div class="muted">no requests</div>';
  rpmTip.innerHTML = `<div class="rpm-tip-h">${stampMin(b.m)}</div>${rowsHtml}<div class="rpm-tip-t">${b.total}/min</div>`;
  rpmTip.style.display = 'block';
  const tw = rpmTip.offsetWidth, th = rpmTip.offsetHeight;
  let left = x + 12; let top = y + 12;
  if (left + tw > window.innerWidth - 8) left = x - tw - 12;
  if (top + th > window.innerHeight - 8) top = y - th - 12;
  rpmTip.style.left = left + 'px';
  rpmTip.style.top = top + 'px';
}
const hideTip = () => { rpmTip.style.display = 'none'; };
chartEl.addEventListener('mousemove', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) showTip(bar, e.clientX, e.clientY);
  else hideTip();
});
chartEl.addEventListener('mouseleave', hideTip);

loadNow();

// The tail is persisted across reloads in localStorage (capped at TAIL_MAX).
// Saves are throttled so a busy feed doesn't hammer storage on every line.
const TAIL_KEY = 'mirstats.tail.v1';
let tailLog = [];
let saveTimer = null;

function saveTailSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(TAIL_KEY, JSON.stringify(tailLog)); } catch { /* quota / disabled */ }
  }, 800);
}

// Render one tail payload into the DOM (no storage side effects).
function renderTail(t) {
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

// New live line: record it, render it, persist (throttled).
function appendTail(t) {
  tailLog.push(t);
  while (tailLog.length > TAIL_MAX) tailLog.shift();
  renderTail(t);
  saveTailSoon();
}

// Restore the saved tail on load so a reload doesn't start blank.
function loadTail() {
  let arr;
  try { arr = JSON.parse(localStorage.getItem(TAIL_KEY) || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr) || !arr.length) return;
  tailLog = arr.slice(-TAIL_MAX);
  for (const t of tailLog) renderTail(t);
  applyTailFilter();
}

// Clear button: wipe the DOM, the in-memory ring, and the saved copy.
$('tail-clear').addEventListener('click', () => {
  tailLog = [];
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(TAIL_KEY); } catch { /* ignore */ }
  tailEl.innerHTML = '';
});

loadTail();

socket.on('stats', (d) => { renderStats(d); chartLive(d); });
socket.on('tail', appendTail);

// Initial paint from the JSON API in case the first snapshot is slow.
fetch('/api/stats').then((r) => r.json()).then((d) => { if (d && d.counts) renderStats(d); }).catch(() => {});
