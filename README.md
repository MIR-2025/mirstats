# MIR Stats

A self-hosted, real-time **log-stats dashboard**. It connects to a live log feed,
parses every line (across many different web-server log formats), and renders a
single live view of what's happening across one or many sites: request rate,
status-code breakdown, top paths, top IPs, **probing/attacker IPs with one-click
reputation lookups**, security alerts, and a colorized live tail you can filter by
source.

Built with Node.js + Express + Socket.io + EJS + Bootstrap. Vanilla JS on the
client (no front-end build step).

## Features

- **Live tail** — every incoming log line, colorized by source, with arrival
  timestamps. Click a **source** to filter the tail to just that site.
- **Rolling stats** (in-memory, bounded): total requests, requests/min (60-min
  sparkline + last-60s rate), 2xx/3xx/4xx/5xx split, error rate.
- **Top paths / IPs / methods / sources.**
- **Top attackers** — IPs hitting credential-probe / scanner paths (`.env`,
  `.git`, `wp-admin`, `xmlrpc`, `actuator`, `/etc/passwd`, …), each linking out to
  **AbuseIPDB** and **ipinfo** for the IP.
- **Auto-report** (optional, off by default) — when an IP crosses a hit
  threshold, report it to AbuseIPDB enriched with ipinfo + sample log lines. See
  [Auto-reporting attackers](#auto-reporting-attackers-optional).
- **Alerts feed** — surfaces `*** ALERT ***` lines from the upstream feed.
- **Tolerant parser** — extracts source / method / path / status / IP generically,
  so it handles nginx, Apache combined, JSON-ish, and custom formats without
  per-format config.
- **HTTP Basic Auth** gate over the page, the JSON API, and the Socket.io feed.

## How it works

```
upstream log feed (Socket.io)  ──►  mirstats (client)  ──►  parse + aggregate  ──►  browser dashboard
   emits `log:line` strings          subscribe:logs            in-memory stats        live snapshots + tail
```

mirstats connects to `LOG_SOURCE_URL` as a Socket.io **client**, emits
`subscribe:logs`, and folds each `log:line` event into rolling stats that it
pushes to connected dashboards (room `stats`) every ~1.5s, plus a live `tail`
event per line. `GET /api/stats` returns the current snapshot as JSON.

### Upstream feed

mirstats expects a Socket.io server that, on `subscribe:logs`, emits `log:line`
events whose payload is a single raw log line (optionally prefixed with
`[source] `). Point `LOG_SOURCE_URL` at your own such feed. If you don't have one,
a tiny emitter that tails files and `io.emit('log:line', line)` is enough.

### Shipping logs from remote hosts

If the machines generating logs aren't the machine running mirstats,
`tools/log-dir-shipper.sh` is a dependency-light companion that watches a
directory of `.log` files and POSTs new lines to your aggregator (which then
re-emits them over the Socket.io feed mirstats consumes). See
**[tools/README.md](tools/README.md)** for usage, configuration, and a systemd
example.

## Auto-reporting attackers (optional)

When a single IP crosses an attack-hit threshold, mirstats can report it to
[AbuseIPDB](https://www.abuseipdb.com) — enriched with an
[ipinfo](https://ipinfo.io) ASN/country lookup and a few of the offending log
lines as evidence — and list it in the dashboard's **auto-reports** panel.

It is **off by default** and safe to run as-is: with no keys it does nothing;
with keys but `AUTO_REPORT=0` it only *flags* offenders on the dashboard (no
submission). Set `AUTO_REPORT=1` **and** an `ABUSEIPDB_KEY` to actually submit.

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_REPORT` | `0` | `1`/`true` to actually POST to AbuseIPDB; otherwise flag-only |
| `REPORT_THRESHOLD` | `10` | attack hits from one IP before it's reported |
| `REPORT_COOLDOWN_MS` | `21600000` | re-report a persistent attacker after this (6h) |
| `ABUSEIPDB_KEY` | — | APIv2 key (see below) |
| `IPINFO_KEY` | — | Lite token (see below); enrichment only — reporting works without it |
| `ABUSEIPDB_CATEGORIES` | `21` | comma list; `21` = Web App Attack |
| `REPORT_SKIP_IPS` | — | comma list of IPs to never report (e.g. your egress) |
| `REPORT_DATA_DIR` | `./data` | where dedup state + the `reports.jsonl` audit log are kept |

Reporting is **file-persisted, no database**: per-IP cooldown/dedup state lives in
`data/reporter-state.json` (so a restart doesn't re-report), and every report is
appended to `data/reports.jsonl` as a permanent, greppable audit trail.

**Getting the keys** (both have free tiers):

- **AbuseIPDB** — register at <https://www.abuseipdb.com/register>, then generate
  an APIv2 key under <https://www.abuseipdb.com/account/api>. The free tier
  allows reporting plus a daily check quota.
- **ipinfo** — sign up at <https://ipinfo.io/signup> and copy your token from
  <https://ipinfo.io/account/token>.

Private, loopback, link-local, and CDN / reverse-proxy edge IPs (e.g. Cloudflare,
see `lib/netblocks.js`) are never reported — when a site is fronted by a CDN, the
logged IP is the CDN's edge, not the attacker. Make sure your origin logs the
real client IP (`X-Forwarded-For` / `CF-Connecting-IP`) for accurate attribution.

## Requirements

- **Node.js >= 20**
- **MongoDB** and **Redis** — used by the bundled session/magic-link auth layer
  that ships with the scaffold base. (The stats pipeline itself is in-memory; if
  you don't need the user-account layer you can strip `connectMongo`/`connectRedis`
  from `app.js` and the `routes/auth.js` mount.)

## Quick start

```bash
git clone <this-repo> mirstats && cd mirstats
npm install
cp .env.example .env          # set BASIC_AUTH_*, SESSION_SECRET, LOG_SOURCE_URL
npm start                     # or: pm2 start ecosystem.config.cjs
open http://localhost:26613
```

## Configuration

All config is via environment (`.env`); no secrets in code. See `.env.example`.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 26613) |
| `LOG_SOURCE_URL` | Upstream Socket.io log feed to consume |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Dashboard login (blank = open) |
| `SESSION_SECRET` | Session signing secret |
| `MONGODB_URI` / `MONGODB_DATABASE` | Mongo for the auth/session layer |
| `REDIS_URL` | Redis for sessions |
| `SMTP_*` | Optional, for magic-link email |

## Customizing

- **Parser & classification:** `lib/logParser.js` (formats, attack/bot/asset
  fingerprints).
- **Aggregation:** `lib/stats.js` (what's counted, retention, top-N caps).
- **Lookup services** for attacker IPs: the `SERVICES` array at the top of
  `public/js/app.js`.
- **Dashboard layout:** `views/index.ejs` + `public/js/app.js` + `public/css/style.css`.

## License

MIT
