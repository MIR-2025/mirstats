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
  **AbuseIPDB**, **Shodan**, and **ipinfo** for the IP.
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

`tools/log-dir-shipper.sh` is a dependency-light companion for the common case
where the machines generating logs aren't the machine running mirstats. It
watches a directory of `.log` files (one source per file, named by the
filename), batches new lines, and POSTs them as JSON to an HTTP ingest endpoint:

```bash
INGEST_URL=https://your-aggregator.example.com/ingest \
  tools/log-dir-shipper.sh /var/log/myapp
# → POST {"source":"<filename>","lines":[ ... ]}  (any 2xx = success)
```

Run one per host (not per app); new `.log` files are picked up automatically.
Note it ships to **your** aggregator, which is then responsible for re-emitting
those lines over the Socket.io `log:line` channel that mirstats consumes — the
shipper does not talk to mirstats directly. Requires `bash` ≥ 4, `tail`, `curl`,
`jq`, `awk`.

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
