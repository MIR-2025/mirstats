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
      return `<span class="${c}" style="width:${pct}%" data-k="${k}" data-count="${d.byStatus[k]}" data-pct="${pct.toFixed(1)}">${pct > 7 ? k : ''}</span>`;
    })
    .join('');
  $('status-legend').innerHTML = order
    .filter(([k]) => d.byStatus[k])
    .map(([k]) => `<span>${k} <span class="${clsColor[k]}">${d.byStatus[k].toLocaleString()}</span></span>`)
    .join('');

  // sources → donut pie + clickable legend (both filter the dashboard)
  renderSources(d.bySource);

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

// Sources as a donut pie + a clickable legend. Slices and chips both carry
// data-src so the existing click handler filters the dashboard from either.
function renderSources(items) {
  const el = $('sources');
  if (!items.length) { el.innerHTML = '<div class="muted small">none yet</div>'; return; }
  const total = items.reduce((a, s) => a + s.count, 0) || 1;
  let cum = 0;
  const slices = items.map((s) => {
    const pct = (s.count / total) * 100;
    const off = 25 - cum; // dashoffset 25 starts the arc at 12 o'clock
    cum += pct;
    const dim = tailFilter && s.key !== tailFilter ? ' dim' : '';
    return `<circle class="slice${dim}" cx="18" cy="18" r="15.915" fill="none" stroke="${sourceColor(s.key)}" stroke-width="4.5" stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(3)}" stroke-dashoffset="${off.toFixed(3)}" data-src="${esc(s.key)}" data-count="${s.count}" data-pct="${pct.toFixed(1)}"></circle>`;
  }).join('');
  const legend = items.map((s) =>
    `<span class="chip src-chip${s.key === tailFilter ? ' active' : ''}" data-src="${esc(s.key)}"><span class="dot" style="background:${sourceColor(s.key)}"></span>${esc(s.key)}<span class="c">${s.count.toLocaleString()}</span></span>`
  ).join('');
  el.innerHTML = `<div class="pie-wrap"><svg class="pie" viewBox="0 0 36 36" role="img" aria-label="sources by volume">${slices}</svg></div><div class="src-legend">${legend}</div>`;
  if (typeof sourceHover !== 'undefined' && sourceHover) highlightSource(sourceHover); // re-apply hover after re-render
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
  const el = e.target.closest('.src-chip, .slice'); // legend chip OR pie slice
  if (!el) return;
  const s = el.dataset.src;
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
const CHUNK = 360;    // minutes fetched per edge-load (6h)
const DOM_MAX = 4320; // max bars kept in the DOM (3 days)
let barW = 4;         // bar pixel width — Ctrl+wheel zooms it; mirrors CSS --barw
try { const z = +localStorage.getItem('mirstats.barw'); if (z >= 1 && z <= 24) barW = z; } catch { /* ignore */ }
const chartEl = $('rpm');
chartEl.style.setProperty('--barw', barW + 'px');
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
    chartEl.scrollLeft += older.length * barW; // keep the viewport on the same bars
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
  if (e.ctrlKey) {
    // Ctrl+wheel = zoom bar width, anchored at the bar under the cursor.
    const cursorX = e.clientX - chartEl.getBoundingClientRect().left;
    const idx = (chartEl.scrollLeft + cursorX) / barW; // fractional bar under cursor
    const next = Math.min(24, Math.max(1, +(barW * (e.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(2)));
    if (next === barW) return;
    barW = next;
    chartEl.style.setProperty('--barw', barW + 'px');
    try { localStorage.setItem('mirstats.barw', barW); } catch { /* ignore */ }
    chartEl.scrollLeft = idx * barW - cursorX; // keep that bar under the cursor
  } else {
    chartEl.scrollLeft += e.deltaY;
  }
}, { passive: false });
// follow/browse state + lazy edge loading
chartEl.addEventListener('scroll', () => {
  const atRight = chartEl.scrollLeft + chartEl.clientWidth >= chartEl.scrollWidth - 8;
  const last = chartBars.length ? chartBars[chartBars.length - 1].m : 0;
  following = atRight && last >= histLatest - 1;
  if (chartEl.scrollLeft < barW * 30) loadOlder();
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
function placeTip(html, x, y) {
  rpmTip.innerHTML = html;
  rpmTip.style.display = 'block';
  const tw = rpmTip.offsetWidth, th = rpmTip.offsetHeight;
  let left = x + 12; let top = y + 12;
  if (left + tw > window.innerWidth - 8) left = x - tw - 12;
  if (top + th > window.innerHeight - 8) top = y - th - 12;
  rpmTip.style.left = left + 'px';
  rpmTip.style.top = top + 'px';
}
function showTip(bar, x, y) {
  const b = bar._b;
  if (!b) return;
  const rowsHtml = RPM_ORDER.filter(([k]) => b[k])
    .map(([k]) => `<div><span class="${clsColor[k] || 'muted'}">${k}</span> ${b[k]}</div>`).join('')
    || '<div class="muted">no requests</div>';
  placeTip(`<div class="rpm-tip-h">${stampMin(b.m)}</div>${rowsHtml}<div class="rpm-tip-t">${b.total}/min</div>`, x, y);
}
const hideTip = () => { rpmTip.style.display = 'none'; };
chartEl.addEventListener('mousemove', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) showTip(bar, e.clientX, e.clientY);
  else hideTip();
});
chartEl.addEventListener('mouseleave', hideTip);

// sources donut: hover a slice OR a legend chip → brighten it, dim the rest
// (Anthropic-console style); slices also get a tooltip. Hover state is re-applied
// after each re-render (renderSources) so it doesn't flicker on snapshots.
let sourceHover = null;
function highlightSource(src) {
  sourceHover = src;
  const root = $('sources');
  root.classList.toggle('hovering', src != null);
  root.querySelectorAll('.slice, .src-chip').forEach((el) =>
    el.classList.toggle('hot', src != null && el.dataset.src === src));
}
$('sources').addEventListener('mousemove', (e) => {
  const el = e.target.closest('.slice, .src-chip');
  if (!el) { highlightSource(null); hideTip(); return; }
  highlightSource(el.dataset.src);
  if (el.classList.contains('slice')) {
    placeTip(
      `<div class="rpm-tip-h"><span class="dot" style="background:${sourceColor(el.dataset.src)}"></span>${esc(el.dataset.src)}</div>` +
      `<div>${(+el.dataset.count).toLocaleString()} lines</div><div class="rpm-tip-t">${el.dataset.pct}%</div>`,
      e.clientX, e.clientY,
    );
  } else hideTip();
});
$('sources').addEventListener('mouseleave', () => { highlightSource(null); hideTip(); });

// status split bar — custom tooltip per status class (count + share)
$('status-bar').addEventListener('mousemove', (e) => {
  const seg = e.target.closest('span[data-k]');
  if (!seg) { hideTip(); return; }
  const k = seg.dataset.k;
  placeTip(
    `<div class="rpm-tip-h"><span class="${clsColor[k] || 'muted'}">${k}</span></div>` +
    `<div>${(+seg.dataset.count).toLocaleString()} requests</div><div class="rpm-tip-t">${seg.dataset.pct}%</div>`,
    e.clientX, e.clientY,
  );
});
$('status-bar').addEventListener('mouseleave', hideTip);

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

// ── AI log analysis ── pick a day, server summarizes it via the Anthropic API.
const aiOut = $('ai-out');
const aiDate = $('ai-date');
const aiRun = $('ai-run');
const aiRefresh = $('ai-refresh');
const aiPdf = $('ai-pdf');
let lastAnalysis = null; // { label, md } of the most recent successful analysis
if (aiDate && !aiDate.value) {
  const n = new Date(); const p = (x) => String(x).padStart(2, '0');
  aiDate.value = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
// Minimal, safe markdown → HTML (escapes first; covers what Claude emits).
function mdToHtml(md) {
  const esc2 = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) => esc2(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  let html = ''; let list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of String(md).split('\n')) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); html += `<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`; }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) { if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\d+\.\s+(.*)$/))) { if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; } html += `<li>${inline(m[1])}</li>`; }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}
async function runAnalysis(refresh) {
  const v = aiDate && aiDate.value;
  if (!v) return;
  const start = new Date(v + 'T00:00:00'); // local midnight of the chosen day
  if (isNaN(start)) return;
  const fromMin = Math.floor(start.getTime() / 60000);
  const endMin = Math.floor((start.getTime() + 24 * 3600 * 1000 - 60000) / 60000);
  const toMin = Math.min(Math.floor(Date.now() / 60000), endMin); // don't go past "now"
  if (aiRun) aiRun.disabled = true;
  if (aiRefresh) aiRefresh.disabled = true;
  aiOut.className = 'muted small';
  aiOut.textContent = refresh ? 'Re-analyzing…' : 'Analyzing…';
  try {
    const d = await (await fetch('/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: fromMin, to: toMin, label: v, refresh }),
    })).json();
    if (d.ok) {
      aiOut.className = 'ai-analysis';
      aiOut.innerHTML = (d.cached ? '<div class="ai-meta">cached · ↻ to refresh</div>' : '') + mdToHtml(d.analysis || '_(empty response)_');
      lastAnalysis = { label: v, md: d.analysis || '' };
      if (aiPdf) aiPdf.disabled = false;
    } else {
      aiOut.className = 'red small';
      aiOut.textContent = d.error || 'analysis failed';
    }
  } catch {
    aiOut.className = 'red small';
    aiOut.textContent = 'request failed';
  }
  if (aiRun) aiRun.disabled = false;
  if (aiRefresh) aiRefresh.disabled = false;
}
if (aiRun) aiRun.addEventListener('click', () => runAnalysis(false));
if (aiRefresh) aiRefresh.addEventListener('click', () => runAnalysis(true));

// Export the rendered analysis to PDF via the browser's print → Save as PDF.
// Opens a clean light-themed doc; the <title> becomes the default file name.
function downloadPdf() {
  if (!lastAnalysis) return;
  const title = `mirstats analysis — ${lastAnalysis.label}`;
  const win = window.open('', '_blank');
  if (!win) { aiOut.insertAdjacentHTML('afterbegin', '<div class="ai-meta">popup blocked — allow popups to export PDF</div>'); return; }
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<style>body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 22px;}` +
    `h1{font-size:19px;margin:0 0 4px;}h2,h3,h4,h5,h6{margin:14px 0 4px;font-size:15px;}p{margin:0 0 8px;}ul,ol{margin:0 0 8px;padding-left:22px;}` +
    `code{background:#f1f1f1;border-radius:3px;padding:0 3px;font-family:ui-monospace,Menlo,Consolas,monospace;}` +
    `.meta{color:#777;font-size:12px;margin:0 0 18px;}@media print{body{margin:0;}}</style></head>` +
    `<body><h1>${esc(title)}</h1><div class="meta">generated ${esc(new Date().toLocaleString())}</div>${mdToHtml(lastAnalysis.md)}</body></html>`,
  );
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}
if (aiPdf) aiPdf.addEventListener('click', downloadPdf);
