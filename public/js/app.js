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

// Source colors. The server sets <div class="dash" data-palette> from the
// SOURCE_PALETTE env var: "mir" uses mir.org's /logs hues, anything else uses a
// generic example palette. This keeps app.js identical across deployments — the
// only thing that differs is .env. Unknown sources get a stable auto-hue below.
function sourcePalette() {
  const claude = { claude: '#d97757' }; // Claude Code's /v1/events telemetry from loopback
  if (document.querySelector('.dash')?.dataset.palette === 'mir') {
    return {
      'mir-com': '#34d399', 'mir-org': '#facc15', mirassertions: '#a78bfa',
      mircapture: '#f472b6', mirresolve: '#fb923c', mirprotocol: '#38bdf8', ...claude,
    };
  }
  return {
    api: '#34d399', web: '#facc15', auth: '#a78bfa',
    cdn: '#f472b6', worker: '#fb923c', cron: '#38bdf8', ...claude,
  };
}
const KNOWN = sourcePalette();
function sourceColor(s) {
  if (KNOWN[s]) return KNOWN[s];
  const k = (s || '').toLowerCase().slice(0, 3);
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h * 31) + k.charCodeAt(i)) | 0;
  return `hsl(${((h % 360) + 360) % 360}, 60%, 65%)`;
}
const clsColor = { '2xx': 'green', '3xx': 'yellow', '4xx': 'red', '5xx': 'crit', '1xx': 'muted', other: 'muted' };

// Country code → flag emoji + English name (both built-in; no data needed).
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
function countryName(cc) { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } }
function flagFor(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || '')) return '🏴';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

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

// Status split bar + legend from a byStatus map { '2xx': n, '3xx': n, … }.
function renderStatus(byStatus) {
  const order = [['2xx', 's2'], ['3xx', 's3'], ['4xx', 's4'], ['5xx', 's5'], ['other', 'so']];
  const totalS = order.reduce((a, [k]) => a + (byStatus[k] || 0), 0) || 1;
  $('status-bar').innerHTML = order
    .filter(([k]) => byStatus[k])
    .map(([k, c]) => {
      const pct = (byStatus[k] / totalS) * 100;
      return `<span class="${c}" style="width:${pct}%" data-k="${k}" data-count="${byStatus[k]}" data-pct="${pct.toFixed(1)}">${pct > 7 ? k : ''}</span>`;
    })
    .join('');
  $('status-legend').innerHTML = order
    .filter(([k]) => byStatus[k])
    .map(([k]) => `<span>${k} <span class="${clsColor[k]}">${byStatus[k].toLocaleString()}</span></span>`)
    .join('');
}

// Error-rate headline = REAL errors only (5xx + 4xx on normal routes). Scanner
// 4xx noise goes to the muted sub-line. Colour by severity so a real failure
// actually moves it. noiseRate omitted (null) when scoped to a window without it.
function setErrCard(rate, noiseRate) {
  const el = $('c-err');
  if (el) { el.textContent = rate + '%'; el.className = 'value ' + (rate < 1 ? 'green' : rate < 5 ? 'yellow' : 'red'); }
  const sub = $('c-errsub');
  if (sub && noiseRate != null) sub.textContent = `${noiseRate}% scanner 4xx`;
}

function renderStats(d) {
  // upstream + header
  const up = $('upstream');
  up.textContent = d.upstream;
  up.className = d.upstream === 'connected' ? 'pulse-ok' : 'pulse-bad';
  $('uptime').textContent = fmtUptime(d.uptimeMs);
  $('lines').textContent = d.counts.lines.toLocaleString();

  // cards
  // REQUESTS + ERROR RATE follow the visible window while browsing (see
  // updateEnds); only refresh them from the live snapshot at the live edge.
  lastCounts = d.counts; lastErr = d.realErrorRate;
  if (following) $('c-req').textContent = d.counts.requests.toLocaleString();
  $('c-reqsub').textContent = `${d.counts.requests ? Math.round((d.counts.assets / d.counts.requests) * 100) : 0}% assets`;
  $('c-rate').textContent = d.ratePerMin.toLocaleString();
  if (following) setErrCard(d.realErrorRate, d.noiseRate);
  if (following) $('c-atk').textContent = d.counts.attacks.toLocaleString();
  $('c-atksub').textContent = d.attackRate + '% of reqs';
  $('c-alert').textContent = d.counts.alerts.toLocaleString();
  $('c-bots').textContent = d.counts.bots.toLocaleString();
  $('c-assetsub').textContent = `${d.counts.assets.toLocaleString()} asset hits`;
  if (d.hits5 != null) $('c-hits5').textContent = d.hits5.toLocaleString();

  // (the requests/minute chart is driven separately by the history store — see
  // the historical req/min chart section + chartLive())

  // sources donut reflects the visible window while browsing; keep the live one
  // stashed. (The status split is driven by the visible bars — see updateEnds.)
  lastBySource = d.bySource;
  if (!viewScoped) renderSources(d.bySource);

  // tables
  rows($('paths'), d.topPaths);
  rows($('ips'), d.topIps);
  rows($('countries'), d.topCountries || [], (it) =>
    `<span class="flag">${flagFor(it.key)}</span> ${esc(countryName(it.key))} <span class="muted">${esc(it.key)}</span>`);
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

  // broken routes — known-good pages returning 404/5xx (real problems, not noise)
  const br = $('broken');
  if (br) {
    const items = d.brokenRoutes || [];
    br.innerHTML = items.length
      ? items.map((b) => `<div class="broken-row"><span class="src" style="color:${sourceColor(b.source)}">[${esc(b.source)}]</span> ` +
          `<span class="broken-path">${esc(b.path)}</span> <span class="muted broken-n">${b.count.toLocaleString()}×</span></div>`).join('')
      : '<div class="muted small">none — real pages returning 404/5xx will show here</div>';
  }

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
    const ts = r.t ? `<span class="rep-t">${stampMin(Math.floor(r.t / 60000))}</span> ` : '';
    return `<div class="rep">${ts}<span class="atk-ip">${esc(r.ip)}</span> <span class="muted">${r.hits}×${r.reason === 'burst' ? ' burst' : ''}</span> ${badge}${loc ? ` <span class="muted">${esc(loc)}</span>` : ''}</div>`;
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
// How many lines the tail keeps (DOM + saved ring). User-adjustable via the
// header select; persisted per-browser. Older lines aren't lost data — use
// click-a-bar / IP search to pull history from Mongo.
const TAIL_MAX_KEY = 'mirstats.tailmax';
const TAIL_SIZES = [50, 100, 150, 300, 500, 1000];
let TAIL_MAX = 300;
try { const v = +localStorage.getItem(TAIL_MAX_KEY); if (TAIL_SIZES.includes(v)) TAIL_MAX = v; } catch { /* ignore */ }
const tailEl = $('tail');
let autoScroll = true;
let tailFilter = null; // active source filter, or null = show all
let tailIpFilter = ''; // active IP / /24 prefix filter (empty = show all)
let tailPinned = false; // true while showing a clicked chart bar's stored logs

// A tail line is hidden if it fails the active source OR the active IP filter.
function tailHidden(source, ip) {
  if (tailFilter && source !== tailFilter) return true;
  if (tailIpFilter && !(ip === tailIpFilter || (ip && ip.startsWith(tailIpFilter + '.')))) return true;
  return false;
}

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
// Filter the live tail by an IP or /24 (e.g. "195.178.110" or "195.178.110.0/24").
const tailIp = $('tail-ip');
if (tailIp) tailIp.addEventListener('input', () => {
  let f = tailIp.value.trim().replace(/\/\d+$/, ''); // strip a trailing /24
  if (f.endsWith('.0')) f = f.slice(0, -2); // 1.2.3.0 -> 1.2.3 (a /24 prefix)
  tailIpFilter = f;
  applyTailFilter();
});

function syncSourceChips() {
  document.querySelectorAll('#sources .src-chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.src === tailFilter));
}

function applyTailFilter() {
  for (const ln of tailEl.children) ln.hidden = tailHidden(ln.dataset.source, ln.dataset.ip);
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
const EDGE_PX = 300;  // start lazy-loading at either edge within this many px
const VIEW_MINUTES = 360; // most recent 6h fills the viewport on load
let barW = 4;         // bar pixel width — Ctrl+wheel zooms it; mirrors CSS --barw
let hasSavedZoom = false; // true once the user has zoomed — remembered across reloads
try { const z = +localStorage.getItem('mirstats.barw'); if (z >= 1 && z <= 24) { barW = z; hasSavedZoom = true; } } catch { /* ignore */ }
const chartEl = $('rpm');
chartEl.style.setProperty('--barw', barW + 'px');
const rpmAxis = $('rpm-axis');
let chartBars = [];   // loaded window, ascending by minute
let chartPeak = 1;
let following = true; // pinned to the live "now" edge
let histLatest = Math.floor(Date.now() / 60000);
let histEarliest = histLatest;
let loadingEdge = false;
let chartIp = null; // when set, the chart is filtered to this IP / /24 prefix
let chartBucket = 1; // minutes per bar (from the server; 1 unless RPM_BUCKET_MIN is set)
// "scope to view": while browsing a past window, the tail + donut reflect the
// chart's visible range; at the live edge they resume live.
let viewScoped = false;    // true while donut + status reflect a windowed view
let lastBySource = [];     // most recent live source breakdown (to restore on resume)
let lastCounts = null;     // most recent live counts (to restore the cards at the edge)
let lastErr = 0;           // most recent live error rate
let lastScopeKey = '';     // dedupe identical visible ranges
let scopeTimer = null;     // debounce for scope-to-view

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
// rolling time axis: clock-aligned ticks that scroll in sync with the bars; the
// label interval widens/narrows with the zoom so labels never crowd.
function niceInterval(mins) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  for (const s of steps) if (s >= mins) return s;
  return 2880;
}
function syncAxis() {
  if (rpmAxis) rpmAxis.style.transform = `translateX(${-chartEl.scrollLeft}px)`;
}
function renderAxis() {
  if (!rpmAxis) return;
  if (!chartBars.length) { rpmAxis.innerHTML = ''; return; }
  rpmAxis.style.width = (chartBars.length * barW) + 'px';
  // one label per hour, on the hour (step out to 2/3/6/12/24h only if it crowds)
  const pxPerHour = (60 / chartBucket) * barW;
  const hourStep = [1, 2, 3, 6, 12, 24].find((h) => pxPerHour * h >= 22) || 24;
  const stepMin = 60 * hourStep;
  const p = (n) => String(n).padStart(2, '0');
  let html = '';
  for (let i = 0; i < chartBars.length; i++) {
    const m = chartBars[i].m;
    if (m % stepMin !== 0) continue; // only on the hour
    const d = new Date(m * 60000);
    const midnight = d.getHours() === 0;
    const label = midnight ? `${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${d.getHours()}`;
    html += `<span class="rpm-tick${midnight ? ' day' : ''}" style="left:${i * barW}px">${label}</span>`;
  }
  rpmAxis.innerHTML = html;
  syncAxis();
}
function renderChart() {
  chartPeak = Math.max(1, ...chartBars.map((b) => b.total));
  const frag = document.createDocumentFragment();
  for (const b of chartBars) frag.appendChild(makeBar(b, chartPeak));
  chartEl.replaceChildren(frag);
  const pk = $('rpm-peak');
  if (pk) pk.textContent = `peak ${chartPeak}/${bucketUnit()}`;
  const ttl = $('rpm-title');
  if (ttl) ttl.innerHTML = `${bucketTitle()} &middot; history`;
  renderAxis();
  updateEnds();
}
// Up to 3 per-status hit counts for an edge bar, each in its segment color and
// ordered largest-first; '' when the bar has no hits.
function endHtml(b) {
  if (!b) return '';
  const t = `<span class="rpm-end-t">${stampMin(b.m)}</span>`; // the edge bar's date + time
  if (!b.total) return t;
  return t + RPM_ORDER.filter(([k]) => b[k])
    .sort((x, y) => b[y[0]] - b[x[0]])
    .slice(0, 3)
    .map(([k]) => `<span class="${clsColor[k] || 'muted'}">${b[k].toLocaleString()}</span>`)
    .join('');
}
// Each bar is a chartBucket-minute bucket, so its total is "hits per bucket"
// (the same unit as the HITS / N MIN card) — label everything to match.
const bucketUnit = () => (chartBucket === 1 ? 'min' : chartBucket + 'min');        // "min" | "5min"
const bucketTitle = () => (chartBucket === 1 ? 'requests / minute' : `requests / ${chartBucket} min`);
// Average hits-per-bucket over the trailing ~60 minutes of loaded bars.
function avg60() {
  if (!chartBars.length) return 0;
  const n = Math.min(chartBars.length, Math.ceil(60 / chartBucket));
  let sum = 0;
  for (let i = chartBars.length - n; i < chartBars.length; i++) sum += chartBars[i].total;
  return sum / n; // hits per bucket (matches the bar values + the HITS/Nmin card)
}
// Status breakdown of the bars currently at the left and right edges of the viewport.
function updateEnds() {
  const L = $('rpm-end-l'); const R = $('rpm-end-r');
  if (!L || !R) return;
  const av = $('rpm-avg');
  if (av) av.textContent = chartBars.length ? `60m avg ${Math.round(avg60())}/${bucketUnit()}` : '';
  for (const el of chartEl.querySelectorAll('.bar.edge')) el.classList.remove('edge');
  if (!chartBars.length) { L.innerHTML = ''; R.innerHTML = ''; return; }
  const last = chartBars.length - 1;
  // left: one bar inward — the exact left-edge bar is usually clipped/hidden
  const li = Math.max(0, Math.min(last, Math.floor(chartEl.scrollLeft / barW) + 1));
  const ri = Math.max(0, Math.min(last, Math.ceil((chartEl.scrollLeft + chartEl.clientWidth) / barW) - 1));
  L.innerHTML = endHtml(chartBars[li]);
  R.innerHTML = endHtml(chartBars[ri]);
  const bars = chartEl.children; // 1:1 with chartBars (appended in order)
  if (bars[li]) bars[li].classList.add('edge'); // only the left edge bar is tinted
  // status split bar + legend reflect exactly the visible bars (no fetch),
  // updated on every render / scroll / zoom / live tick.
  const bs = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  for (let i = li; i <= ri; i++) { const b = chartBars[i]; for (const k in bs) bs[k] += b[k] || 0; }
  renderStatus(bs);
  // REQUESTS + ERROR RATE cards: window total while browsing, live at the edge.
  if (!following) {
    const tot = bs['2xx'] + bs['3xx'] + bs['4xx'] + bs['5xx'] + bs.other;
    $('c-req').textContent = tot.toLocaleString();
    // c-err while browsing is the window's REAL error rate — set by scopeDonut
    // (the bars can't tell scanner noise from real 4xx; that needs the events).
  } else if (lastCounts) {
    $('c-req').textContent = lastCounts.requests.toLocaleString();
    setErrCard(lastErr);
    $('c-atk').textContent = lastCounts.attacks.toLocaleString();
  }
}
async function fetchWindow(fromM, toM) {
  try {
    const url = chartIp
      ? `/api/rpm-ip?ip=${encodeURIComponent(chartIp)}&from=${fromM}&to=${toM}`
      : `/api/rpm?from=${fromM}&to=${toM}`;
    const d = await (await fetch(url)).json();
    if (d.bounds) { histEarliest = d.bounds.earliest; histLatest = d.bounds.latest; }
    if (d.bucket) chartBucket = d.bucket;
    return d.bars || [];
  } catch { return []; }
}
async function loadNow() {
  try {
    const url = chartIp ? `/api/rpm-ip?ip=${encodeURIComponent(chartIp)}` : '/api/rpm'; // default = recent window
    const d = await (await fetch(url)).json();
    if (d.bounds) { histEarliest = d.bounds.earliest; histLatest = d.bounds.latest; }
    if (d.bucket) chartBucket = d.bucket;
    chartBars = d.bars || [];
  } catch { chartBars = []; }
  fitWindow();                          // size bars so the most recent 6h fill the view
  renderChart();
  following = true;
  await fillToScrollable();             // ensure older data is loaded to scroll into
  chartEl.scrollLeft = chartEl.scrollWidth; // newest bar flush at the right edge
}
// Size the bars so the most recent VIEW_MINUTES (6h) fill the visible width; the
// rest of the loaded window is reached by scrolling. This is only the default —
// once the user has Ctrl+wheel zoomed, that zoom is remembered across reloads.
function fitWindow() {
  if (hasSavedZoom) return; // honor the remembered zoom instead of re-fitting to 6h
  const w = chartEl.clientWidth;
  if (!w) return;
  const barsInView = Math.max(1, Math.round(VIEW_MINUTES / chartBucket));
  barW = +Math.max(1, Math.min(24, w / barsInView)).toFixed(2);
  chartEl.style.setProperty('--barw', barW + 'px');
}
// A short default window (e.g. 5-min buckets ≈ 145 bars) can be narrower than the
// chart container, leaving no horizontal overflow — so the wheel can't scroll and
// the bars sit bunched at the left. Pad with older history until it overflows
// (bounded by available data + a guard) so the chart is always browsable.
async function fillToScrollable() {
  let guard = 0;
  while (guard++ < 12 && chartEl.clientWidth > 0 && chartBars.length
      && chartBars[0].m > histEarliest
      && chartEl.scrollWidth <= chartEl.clientWidth + 4) {
    await loadOlder();
  }
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
  if (chartIp) return; // filtered to an IP — static view, no global live tick
  if (d.histBounds) histLatest = Math.max(histLatest, d.histBounds.latest);
  const cur = d.rpmCur;
  if (!cur || !following || !chartBars.length) return;
  const last = chartBars[chartBars.length - 1];
  if (cur.m === last.m) {
    chartBars[chartBars.length - 1] = cur;
    if (cur.total > chartPeak) renderChart();
    else fillBar(chartEl.lastElementChild, cur, chartPeak);
  } else if (cur.m > last.m) {
    for (let m = last.m + chartBucket; m < cur.m; m += chartBucket) chartBars.push({ m, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0, total: 0 });
    chartBars.push(cur);
    if (chartBars.length > DOM_MAX) chartBars = chartBars.slice(chartBars.length - DOM_MAX);
    renderChart();
  }
  chartEl.scrollLeft = chartEl.scrollWidth;
  updateEnds();
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
    hasSavedZoom = true; // remember this zoom across reloads (overrides 6h-fit)
    chartEl.style.setProperty('--barw', barW + 'px');
    try { localStorage.setItem('mirstats.barw', barW); } catch { /* ignore */ }
    chartEl.scrollLeft = idx * barW - cursorX; // keep that bar under the cursor
    renderAxis();
    updateEnds();
    scheduleScope(); // zoom changes the visible window → re-scope tail + donut
  } else {
    chartEl.scrollLeft += Math.sign(e.deltaY) * barW; // one bar (one bucket) per wheel notch
  }
}, { passive: false });
// follow/browse state + lazy edge loading
chartEl.addEventListener('scroll', () => {
  syncAxis();
  updateEnds();
  const atRight = chartEl.scrollLeft + chartEl.clientWidth >= chartEl.scrollWidth - 8;
  const nearRight = chartEl.scrollLeft + chartEl.clientWidth >= chartEl.scrollWidth - EDGE_PX;
  const last = chartBars.length ? chartBars[chartBars.length - 1].m : 0;
  following = atRight && last + chartBucket > histLatest;
  if (chartEl.scrollLeft < EDGE_PX) loadOlder();
  else if (nearRight && !following) loadNewer(); // lazy-load newer toward the live edge
  scheduleScope(); // scroll changes the visible window → re-scope tail + donut
});

// ── click a bar to pin that bucket's stored logs into the tail feed ──
// Live lines keep recording (see appendTail) but stop drawing until "✕ live".
const hhmm = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
// "MM-DD HH:MM–HH:MM" within a day; "MM-DD HH:MM – MM-DD HH:MM" across days.
function stampRange(fromMs, toMs) {
  const p = (n) => String(n).padStart(2, '0');
  const day = (ms) => { const d = new Date(ms); return `${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  return day(fromMs) === day(toMs)
    ? `${day(fromMs)} ${hhmm(fromMs)}–${hhmm(toMs)}`
    : `${day(fromMs)} ${hhmm(fromMs)} – ${day(toMs)} ${hhmm(toMs)}`;
}
function unpinTail() {
  if (!tailPinned) return;
  tailPinned = false;
  $('tail-pin').innerHTML = '';
  autoScroll = true;
  tailEl.innerHTML = '';
  for (const t of tailLog) renderTail(t); // redraw the live ring we kept recording
  applyTailFilter();
  tailEl.scrollTop = tailEl.scrollHeight;
}
// Pin the tail to a stored time window [fromMs, toMs] (mirrors the active tail
// filters). Used by both click-a-bar and scope-to-view.
async function pinRange(fromMs, toMs) {
  const qs = new URLSearchParams({ from: String(fromMs), to: String(toMs) });
  if (tailFilter) qs.set('source', tailFilter);            // mirror the active tail filters
  const ipf = chartIp || tailIpFilter;
  if (ipf) qs.set('ip', ipf);
  let d;
  try { d = await (await fetch('/api/events?' + qs.toString())).json(); } catch { return; }
  if (!d || d.error) return;
  tailPinned = true;
  autoScroll = false;
  tailEl.innerHTML = '';
  // Only the last TAIL_MAX are kept on screen anyway — render just those instead
  // of building (and immediately deleting) up to ~1000 rows.
  const lines = (d.lines || []).slice(-TAIL_MAX);
  if (lines.length) { for (const t of lines) renderTail(t); applyTailFilter(); }
  else tailEl.innerHTML = '<div class="ln muted">no stored logs in this interval</div>';
  tailEl.scrollTop = 0;
  const more = d.count >= d.limit ? '+' : '';
  $('tail-pin').innerHTML = `<span class="pin-dot">●</span> ${d.count}${more} lines <span class="pin-x" title="Back to live">✕ ${stampRange(fromMs, toMs)}</span>`;
}
function pinBar(m) { return pinRange(m * 60000, (m + chartBucket) * 60000); }

// Hide phantom truncated sources (mirror of the server filter) in the windowed donut.
function dropTrunc(list) {
  return list.filter((s) => !list.some((t) =>
    t.key.length === s.key.length + 1 && t.key.endsWith(s.key) && t.count > s.count * 4));
}
// Point the donut at one time window's source breakdown.
async function scopeDonut(fromMs, toMs) {
  try {
    const d = await (await fetch(`/api/sources?from=${fromMs}&to=${toMs}`)).json();
    if (d && Array.isArray(d.sources)) {
      renderSources(dropTrunc(d.sources));
      $('c-atk').textContent = (d.attacks || 0).toLocaleString(); // window attacks
      if (d.realErrorRate != null) setErrCard(d.realErrorRate, d.noiseRate); // window real error rate
    }
  } catch { /* ignore */ }
}
// Return tail + donut + status to live.
function clearScope() {
  if (!viewScoped && !tailPinned) return;
  viewScoped = false;
  lastScopeKey = '';
  renderSources(lastBySource);
  unpinTail();
}
// Re-scope tail + donut to the chart's currently-visible range; at the live edge
// resume live. Debounced via scheduleScope() so a flurry of wheel/scroll events
// only fires one fetch once movement settles.
async function scopeToView() {
  if (!chartBars.length) return;
  if (following) { clearScope(); return; }
  const last = chartBars.length - 1;
  const li = Math.max(0, Math.min(last, Math.floor(chartEl.scrollLeft / barW) + 1));
  const ri = Math.max(0, Math.min(last, Math.ceil((chartEl.scrollLeft + chartEl.clientWidth) / barW) - 1));
  const fromMs = chartBars[li].m * 60000;
  const toMs = (chartBars[ri].m + chartBucket) * 60000;
  const key = fromMs + '-' + toMs;
  if (key === lastScopeKey) return;
  lastScopeKey = key;
  viewScoped = true;
  await Promise.all([pinRange(fromMs, toMs), scopeDonut(fromMs, toMs)]); // tail + donut in parallel
}
function scheduleScope() { if (scopeTimer) clearTimeout(scopeTimer); scopeTimer = setTimeout(scopeToView, 120); }
$('tail-pin').addEventListener('click', unpinTail);
chartEl.addEventListener('click', (e) => {
  const bar = e.target.closest('.bar');
  if (!bar) return;
  const m = +bar.dataset.m;
  if (Number.isFinite(m)) pinBar(m);
});
// The chart & tail cards default collapsed, so they're laid out at zero width
// while hidden — re-fit them the first time (and any time) they're expanded.
document.getElementById('acc-rpm')?.addEventListener('shown.bs.collapse', async () => {
  fitWindow();
  renderChart();
  await fillToScrollable();
  if (following) chartEl.scrollLeft = chartEl.scrollWidth;
});
document.getElementById('acc-tail')?.addEventListener('shown.bs.collapse', () => {
  if (autoScroll && !tailPinned) tailEl.scrollTop = tailEl.scrollHeight;
});
// date picker → jump to ±6h around the chosen time
const rpmDate = $('rpm-date');
if (rpmDate) rpmDate.addEventListener('change', async () => {
  const ms = Date.parse(rpmDate.value);
  if (isNaN(ms)) return;
  const c = Math.floor(ms / 60000);
  following = false;
  chartBars = await fetchWindow(c - 360, c + 360);
  fitWindow();
  renderChart();
  chartEl.scrollLeft = (chartEl.scrollWidth - chartEl.clientWidth) / 2;
});
// "now" button → jump back to the live edge
const rpmNow = $('rpm-now');
if (rpmNow) rpmNow.addEventListener('click', () => loadNow());

// IP filter on the chart (driven by the IP search) — shows a tag + ✕ to clear.
function updateChartIpTag() {
  const el = $('rpm-ip');
  if (el) el.innerHTML = chartIp ? `<span class="rpm-ip-tag">▸ ${esc(chartIp)} <span class="clear">✕</span></span>` : '';
}
function setChartIp(ip) {
  chartIp = ip || null;
  updateChartIpTag();
  loadNow();
}
const rpmIpEl = $('rpm-ip');
if (rpmIpEl) rpmIpEl.addEventListener('click', () => setChartIp(null));

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
  div.className = 'ln' + (t.alert ? ' alert' : t.attack ? ' atk' : '') + (t.status === 404 ? ' s404' : '');
  const ts = `<span class="ts">${clock(t.t)}</span> `;
  const src = `<span class="src" style="color:${sourceColor(t.source)}">[${esc(t.source)}]</span> `;
  const meth = t.method ? `<span class="green">${esc(t.method)}</span> ` : '';
  const st = t.status ? `<span class="${clsColor[t.cls] || 'muted'}">${t.status}</span> ` : '';
  const ip = t.ip ? `<span class="muted">${esc(t.ip)}</span> ` : '';
  div.dataset.source = t.source || 'mir';
  div.dataset.ip = t.ip || '';
  div.hidden = tailHidden(div.dataset.source, div.dataset.ip);
  div.innerHTML = ts + src + meth + st + ip + `<span>${esc(t.path || t.raw)}</span>`;
  tailEl.appendChild(div);
  while (tailEl.children.length > TAIL_MAX) tailEl.removeChild(tailEl.firstChild);
  if (autoScroll && !div.hidden) tailEl.scrollTop = tailEl.scrollHeight;
}

// New live line: record it, render it, persist (throttled).
function appendTail(t) {
  tailLog.push(t);
  while (tailLog.length > TAIL_MAX) tailLog.shift();
  if (!tailPinned) renderTail(t); // while pinned to a bar, keep recording but don't redraw
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
  tailPinned = false;
  $('tail-pin').innerHTML = '';
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(TAIL_KEY); } catch { /* ignore */ }
  tailEl.innerHTML = '';
});

// Tail-length select: change how many lines the tail keeps, trim immediately.
const tailMaxSel = $('tail-max');
if (tailMaxSel) {
  tailMaxSel.value = String(TAIL_MAX);
  tailMaxSel.addEventListener('change', () => {
    const v = +tailMaxSel.value;
    if (!TAIL_SIZES.includes(v)) return;
    TAIL_MAX = v;
    try { localStorage.setItem(TAIL_MAX_KEY, String(v)); } catch { /* ignore */ }
    while (tailLog.length > TAIL_MAX) tailLog.shift();
    while (tailEl.children.length > TAIL_MAX) tailEl.removeChild(tailEl.firstChild);
    saveTailSoon();
  });
}

loadTail();

socket.on('stats', (d) => { renderStats(d); chartLive(d); });
socket.on('tail', appendTail);
socket.on('infra', renderInfra);

// Initial paint from the JSON API in case the first snapshot is slow.
fetch('/api/stats').then((r) => r.json()).then((d) => { if (d && d.counts) renderStats(d); }).catch(() => {});
fetch('/api/infra').then((r) => r.json()).then(renderInfra).catch(() => {});

// ── infrastructure health (SSH-pulled per-server metrics) ──
function infraRate(bps) {
  if (bps == null) return '–';
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + 'M/s';
  if (bps >= 1e3) return Math.round(bps / 1e3) + 'K/s';
  return Math.round(bps) + 'B/s';
}
function infraUp(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const pctCls = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok');
function infraSpark(hist) {
  const v = (hist || []).map((x) => x.cpu).filter((x) => x != null);
  if (v.length < 3) return '';
  const W = 64, H = 14, n = v.length;
  const pts = v.map((x, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - x / 100 * H).toFixed(1)}`).join(' ');
  return `<svg class="infra-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}
function infraBar(label, pct) {
  if (pct == null) return '';
  return `<div class="im"><span class="im-l">${label}</span><span class="im-bar"><span class="im-fill ${pctCls(pct)}" style="width:${Math.min(100, pct)}%"></span></span><span class="im-v">${pct}%</span></div>`;
}
// Live per-server cards in the row under the stat strip.
function renderInfra(hosts) {
  const el = $('infra-cards');
  if (!el) return;
  if (!Array.isArray(hosts) || !hosts.length) { el.innerHTML = ''; return; }
  el.innerHTML = hosts.map((s) => {
    let body;
    if (s.offline) {
      body = `<div class="srv-h"><span class="infra-dot off"></span><span class="srv-name">${esc(s.label)}</span>` +
        `<span class="srv-up muted">offline</span></div><div class="muted small srv-off">${esc(s.error || 'unreachable')}</div>`;
    } else {
      const load = s.load ? s.load.map((x) => x.toFixed(2)).join(' ') : '–';
      const host = s.host && s.host !== s.label ? `<span class="srv-host muted">${esc(s.host)}</span>` : '';
      body = `<div class="srv-h"><span class="infra-dot ${s.warn ? 'warn' : 'ok'}"></span>` +
        `<span class="srv-name">${esc(s.label)}</span>${host}${infraSpark(s.hist)}</div>` +
        infraBar('cpu', s.cpu) + infraBar('mem', s.mem) + (s.disk ? infraBar('disk', s.disk.pct) : '') +
        `<div class="infra-meta"><span class="muted">load</span> ${load} <span class="muted">net</span> ` +
        `↓${infraRate(s.rx)} ↑${infraRate(s.tx)} <span class="muted">· ${infraUp(s.up)}</span></div>`;
    }
    return `<div class="col-6 col-md"><div class="card stat-card srv-card h-100${s.warn ? ' warn' : ''}">` +
      `<div class="card-body py-2">${body}</div></div></div>`;
  }).join('');
}
// Configured-host list in the sidebar "infrastructure" card, with remove buttons.
function renderInfraHosts(list) {
  const el = $('infra-hosts');
  if (!el) return;
  if (!Array.isArray(list) || !list.length) { el.innerHTML = '<div class="muted small">no servers yet — add one above</div>'; return; }
  el.innerHTML = list.map((h) =>
    `<div class="srv-cfg"><span class="srv-cfg-l">${esc(h.label)}</span>` +
    `<span class="muted srv-cfg-s">${esc(h.ssh)}</span>` +
    `<span class="srv-rm" data-label="${esc(h.label)}" role="button" title="remove">✕</span></div>`).join('');
}
async function infraAdd() {
  const inp = $('srv-add'); const msg = $('srv-add-msg');
  const ssh = (inp.value || '').trim();
  if (!ssh) return;
  msg.textContent = 'adding…'; msg.className = 'muted small';
  try {
    const r = await fetch('/api/infra/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssh }) });
    const d = await r.json();
    if (!r.ok) { msg.textContent = d.error || 'failed'; msg.className = 'red small'; return; }
    inp.value = ''; msg.textContent = ''; renderInfraHosts(d);
  } catch { msg.textContent = 'request failed'; msg.className = 'red small'; }
}
async function infraRemove(label) {
  try {
    const r = await fetch('/api/infra/hosts/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    renderInfraHosts(await r.json());
  } catch { /* ignore */ }
}
$('srv-add-btn')?.addEventListener('click', infraAdd);
$('srv-add')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') infraAdd(); });
$('infra-hosts')?.addEventListener('click', (e) => {
  const rm = e.target.closest('.srv-rm');
  if (rm) infraRemove(rm.dataset.label);
});
fetch('/api/infra/hosts').then((r) => r.json()).then(renderInfraHosts).catch(() => {});

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

// ── IP search (Mongo-backed typeahead) ── type an IP or /24 prefix; the dropdown
// fills with matching IPs in the date range; pick one to see its breakdown.
const ipq = $('ipq');
if (ipq) {
  const ipqFrom = $('ipq-from'); const ipqTo = $('ipq-to');
  const ipqList = $('ipq-list'); const ipqResult = $('ipq-result');
  const fmt = (d) => { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  if (ipqTo && !ipqTo.value) ipqTo.value = fmt(new Date());
  if (ipqFrom && !ipqFrom.value) ipqFrom.value = fmt(new Date(Date.now() - 7 * 86400 * 1000));
  const rangeMs = () => ({
    from: ipqFrom.value ? new Date(ipqFrom.value + 'T00:00:00').getTime() : 0,
    to: ipqTo.value ? new Date(ipqTo.value + 'T23:59:59').getTime() : Date.now(),
  });
  let ipqTimer = null;
  async function ipqSearch() {
    const q = ipq.value.trim();
    if (q.length < 2) { ipqList.innerHTML = ''; return; }
    const { from, to } = rangeMs();
    try {
      const rows = await (await fetch(`/api/ips?q=${encodeURIComponent(q)}&from=${from}&to=${to}`)).json();
      if (!Array.isArray(rows) || !rows.length) { ipqList.innerHTML = '<div class="ipq-empty">no matches in range</div>'; return; }
      ipqList.innerHTML = rows.map((r) =>
        `<div class="ipq-item" data-ip="${esc(r.ip)}"><span class="ip">${esc(r.ip)}</span><span class="ipq-c">${r.count.toLocaleString()}${r.attacks ? ` · <span class="red">${r.attacks} atk</span>` : ''}</span></div>`,
      ).join('');
    } catch { ipqList.innerHTML = '<div class="ipq-empty">search failed</div>'; }
  }
  async function ipqDetail(ip) {
    const { from, to } = rangeMs();
    ipqResult.innerHTML = '<div class="muted small">loading…</div>';
    try {
      const d = await (await fetch(`/api/ip?ip=${encodeURIComponent(ip)}&from=${from}&to=${to}`)).json();
      if (d.error) { ipqResult.innerHTML = `<div class="red small">${esc(d.error)}</div>`; return; }
      const st = ['2xx', '3xx', '4xx', '5xx', 'other'].filter((k) => d.byStatus[k]).map((k) => `<span class="${clsColor[k] || 'muted'}">${k} ${d.byStatus[k]}</span>`).join(' ');
      const paths = (d.topPaths || []).slice(0, 6).map((p) => `<div class="ipq-path"><span class="key">${esc(p.path || '/')}</span><span class="num">${p.count}</span></div>`).join('') || '<div class="muted small">—</div>';
      const span = d.first ? `${new Date(d.first).toLocaleString()} → ${new Date(d.last).toLocaleString()}` : '—';
      ipqResult.innerHTML =
        `<div class="ipq-head"><span class="atk-ip">${esc(d.ip)}</span> <span class="muted">${d.count.toLocaleString()} reqs${d.distinctIps > 1 ? ` · ${d.distinctIps} IPs` : ''}${d.attacks ? ` · <span class="red">${d.attacks} attacks</span>` : ''}</span></div>` +
        `<div class="small muted ipq-span">${esc(span)}</div>` +
        `<div class="ipq-status">${st || '—'}</div>${paths}`;
    } catch { ipqResult.innerHTML = '<div class="red small">failed</div>'; }
  }
  ipq.addEventListener('input', () => { clearTimeout(ipqTimer); ipqTimer = setTimeout(ipqSearch, 250); });
  ipqList.addEventListener('click', (e) => {
    const item = e.target.closest('.ipq-item');
    if (!item) return;
    ipq.value = item.dataset.ip;
    ipqList.innerHTML = '';
    ipqDetail(item.dataset.ip);
    setChartIp(item.dataset.ip); // also filter the req/min chart to this IP/24
  });
  [ipqFrom, ipqTo].forEach((el) => el && el.addEventListener('change', () => { if (ipq.value.trim().length >= 2) ipqSearch(); }));
}

// ── persist each collapsible card's open/closed state across reloads ──
// Default: the req/min chart is open, every other collapsible card is closed.
// A saved choice (from the user toggling a card) overrides the default.
const COLLAPSE_KEY = 'mirstats.collapsed.v1';
const collapseDefault = { 'acc-rpm': true };
function readCollapse() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch { return {}; } }
function writeCollapse(id, open) {
  const s = readCollapse(); s[id] = open;
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(s)); } catch { /* quota / disabled */ }
}
(function initCollapseState() {
  if (typeof bootstrap === 'undefined' || !bootstrap.Collapse) return;
  const saved = readCollapse();
  document.querySelectorAll('.dash .collapse[id^="acc-"]').forEach((el) => {
    const want = el.id in saved ? !!saved[el.id] : !!collapseDefault[el.id];
    const inst = bootstrap.Collapse.getOrCreateInstance(el, { toggle: false });
    if (want !== el.classList.contains('show')) { if (want) inst.show(); else inst.hide(); } // only animate on a real diff
    el.addEventListener('shown.bs.collapse', () => writeCollapse(el.id, true));
    el.addEventListener('hidden.bs.collapse', () => writeCollapse(el.id, false));
  });
})();
