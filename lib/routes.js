// Known-good route index. For each configured site we fetch its sitemap(s)
// (the canonical list of real pages) plus the homepage's own links, and keep the
// set of valid paths per source. A later 404/5xx on a path that IS in this set is
// a *real broken route* — distinct from scanner noise hitting paths that never
// existed.
//
// Config: data/crawl-sites.json — map a log "source" to its public base URL:
//   [ { "source": "nafco", "url": "https://www.nafcogems.com" }, … ]
//   (or the object form  { "nafco": "https://www.nafcogems.com", … })
// No-op if the file is absent/empty. Nothing is installed on the sites; we just
// read robots.txt, the sitemap, and the homepage like any crawler.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const SITES_FILE = process.env.CRAWL_SITES_FILE || path.join(DATA_DIR, 'crawl-sites.json');
const CACHE_FILE = path.join(DATA_DIR, 'known-routes.json');
const RECRAWL_MS = Math.max(600000, +(process.env.CRAWL_INTERVAL_MS || 86400000)); // default 24h, floor 10m
const MAX_URLS = Math.max(100, +(process.env.CRAWL_MAX_URLS || 20000));            // per-site cap
const FETCH_TIMEOUT = Math.max(3000, +(process.env.CRAWL_TIMEOUT_MS || 12000));
const UA = 'MIR-Sentinel-RouteIndexer/1.0 (+known-good route map; read-only)';

// path only, no query/fragment, no trailing slash (except root), decoded once.
function normPath(u) {
  let p = u;
  const q = p.search(/[?#]/); if (q >= 0) p = p.slice(0, q);
  try { p = decodeURI(p); } catch { /* keep raw */ }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

async function fetchText(url) {
  const ctl = AbortSignal.timeout(FETCH_TIMEOUT);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,text/xml,*/*' }, signal: ctl, redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

// Find sitemap URLs from robots.txt; fall back to /sitemap.xml.
async function sitemapUrls(base) {
  const out = new Set();
  try {
    const robots = await fetchText(new URL('/robots.txt', base).href);
    for (const line of robots.split('\n')) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) out.add(m[1].trim());
    }
  } catch { /* no robots */ }
  if (!out.size) out.add(new URL('/sitemap.xml', base).href);
  return [...out];
}

// Parse a sitemap (or sitemap index) → page URLs, following nested indexes once.
async function parseSitemap(url, origin, pages, seen, depth = 0) {
  if (pages.size >= MAX_URLS || depth > 2 || seen.has(url)) return;
  seen.add(url);
  let xml;
  try { xml = await fetchText(url); } catch { return; }
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  for (const loc of locs) {
    if (pages.size >= MAX_URLS) break;
    if (isIndex) { await parseSitemap(loc, origin, pages, seen, depth + 1); continue; }
    try { const u = new URL(loc); if (u.origin === origin) pages.add(normPath(u.pathname)); } catch { /* skip */ }
  }
}

// Homepage links (one level) — catches pages a sitemap may miss.
async function homepageLinks(base, origin, pages) {
  let html;
  try { html = await fetchText(base); } catch { return; }
  pages.add(normPath(new URL(base).pathname));
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"'#]+)["']/gi)) { // pages + assets
    if (pages.size >= MAX_URLS) break;
    try { const u = new URL(m[1], base); if (u.origin === origin) pages.add(normPath(u.pathname)); } catch { /* skip */ }
  }
}

async function crawlSite(site) {
  const origin = new URL(site.url).origin;
  const pages = new Set();
  const seen = new Set();
  for (const sm of await sitemapUrls(site.url)) await parseSitemap(sm, origin, pages, seen);
  await homepageLinks(site.url, origin, pages);
  return [...pages];
}

const SAFE_SRC = /^[A-Za-z0-9_.-]{1,40}$/;
function normalizeSite(s) {
  const source = (s && s.source != null ? String(s.source) : '').trim();
  let url = (s && s.url != null ? String(s.url) : '').trim();
  if (!source || !url || !SAFE_SRC.test(source)) return null;
  try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; url = u.origin + (u.pathname === '/' ? '' : u.pathname); }
  catch { return null; }
  return { source, url };
}

export function createRoutes() {
  let sites = [];
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(SITES_FILE)) {
      const raw = JSON.parse(readFileSync(SITES_FILE, 'utf8'));
      const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([source, url]) => ({ source, url }));
      sites = list.map(normalizeSite).filter(Boolean);
    }
  } catch (e) { console.log('[routes] bad sites file:', e.message); }

  function persistSites() {
    try {
      writeFileSync(SITES_FILE + '.tmp', JSON.stringify(sites, null, 2));
      renameSync(SITES_FILE + '.tmp', SITES_FILE);
    } catch (e) { console.log('[routes] sites persist failed:', e.message); }
  }

  const index = new Map();  // source -> Set(paths)
  const meta = new Map();   // source -> { count, lastCrawl, error }

  // Warm from cache so classification works before the first (re)crawl.
  try {
    if (existsSync(CACHE_FILE)) {
      const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      for (const [src, paths] of Object.entries(c.index || {})) index.set(src, new Set(paths));
      for (const [src, m] of Object.entries(c.meta || {})) meta.set(src, m);
    }
  } catch { /* ignore */ }

  function persist() {
    try {
      const out = { index: {}, meta: {} };
      for (const [src, set] of index) out.index[src] = [...set];
      for (const [src, m] of meta) out.meta[src] = m;
      writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(out));
      renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
    } catch (e) { console.log('[routes] persist failed:', e.message); }
  }

  async function crawlOne(site) {
    try {
      const paths = await crawlSite(site);
      if (paths.length) index.set(site.source, new Set(paths));
      meta.set(site.source, { count: paths.length, lastCrawl: Date.now(), error: null });
      console.log(`[routes] ${site.source}: indexed ${paths.length} routes from ${site.url}`);
    } catch (e) {
      meta.set(site.source, { ...(meta.get(site.source) || {}), lastCrawl: Date.now(), error: String(e.message || e).slice(0, 120) });
      console.log(`[routes] ${site.source}: crawl failed — ${e.message}`);
    }
  }

  async function recrawl() {
    for (const site of sites) { await crawlOne(site); }  // sequential = polite across sites
    persist();
    return status();
  }

  // Is this path one of the site's real, known-good routes?
  function isKnownRoute(source, p) {
    const set = index.get(source);
    return !!(set && p && set.has(normPath(p)));
  }
  // Does this source have a usable route index? (lets the error classifier trust
  // "unknown path = noise" only for sites we've actually mapped.)
  function hasIndex(source) { const set = index.get(source); return !!(set && set.size); }
  function status() {
    return sites.map((s) => ({ source: s.source, url: s.url, ...(meta.get(s.source) || { count: index.get(s.source)?.size || 0, lastCrawl: null }) }));
  }

  function addSite(entry) {
    const s = normalizeSite(entry);
    if (!s) throw new Error('need a source name and an http(s) URL');
    if (sites.some((x) => x.source === s.source)) throw new Error(`source "${s.source}" is already configured`);
    sites.push(s);
    persistSites();
    crawlOne(s).then(persist); // index it now
    return status();
  }
  function removeSite(source) {
    const i = sites.findIndex((s) => s.source === source);
    if (i >= 0) { sites.splice(i, 1); index.delete(source); meta.delete(source); persistSites(); persist(); }
    return status();
  }

  console.log(`[routes] ${sites.length} site(s) configured; re-crawl every ${Math.round(RECRAWL_MS / 3600000)}h`);
  if (sites.length) recrawl();
  const timer = setInterval(recrawl, RECRAWL_MS);
  timer.unref?.();
  return { isKnownRoute, hasIndex, status, recrawl, addSite, removeSite, stop: () => clearInterval(timer) };
}
