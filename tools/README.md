# tools/

Standalone helpers that ship alongside mirstats but run independently of it.

## log-dir-shipper.sh

A dependency-light log shipper for the common case where the machines generating
logs aren't the machine running mirstats. It watches a directory of `.log` files,
treats each file's basename as a **source** tag, batches new lines, and POSTs
them as JSON to an HTTP ingest endpoint.

It ships to **your** aggregator — the service that owns the ingest endpoint and
is responsible for re-emitting those lines over the Socket.io `log:line` channel
that mirstats consumes. The shipper does not talk to mirstats directly.

```
.log files ─► log-dir-shipper.sh ─► POST /ingest ─► your aggregator ─► Socket.io ─► mirstats
```

### Usage

```bash
# ship every *.log in /var/log/myapp to your endpoint
INGEST_URL=https://your-aggregator.example.com/ingest \
  ./log-dir-shipper.sh /var/log/myapp
```

- One file per source; the source tag is the filename without `.log`
  (`nginx.log` → source `nginx`). New `.log` files in the directory are picked up
  automatically within `RESCAN_INTERVAL` seconds — no restart needed.
- Run **one shipper per host**, not one per application.

### The request it sends

For each batch it POSTs (any `2xx` response counts as success):

```json
{ "source": "nginx", "lines": ["line one", "line two", "..."] }
```

Source tags are validated against `^[a-zA-Z0-9_-]{1,64}$`; files whose basename
doesn't match are skipped (most ingest endpoints would reject them anyway).

### Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `INGEST_URL` | `http://localhost:8080/ingest` | HTTP endpoint to POST batches to |
| `BATCH_INTERVAL` | `1` | flush interval, seconds |
| `BATCH_MAX` | `100` | max lines per flush, per source |
| `RESCAN_INTERVAL` | `30` | how often to scan for new `.log` files, seconds |

Positional argument 1 is the log directory (default `./logs`).

### Requirements

`bash` ≥ 4 (associative arrays), `tail`, `curl`, `jq`, `awk`, `mktemp`.

### Running it under systemd

```ini
# /etc/systemd/system/log-shipper.service
[Unit]
Description=log-dir-shipper
After=network-online.target

[Service]
Environment=INGEST_URL=https://your-aggregator.example.com/ingest
ExecStart=/opt/mirstats/tools/log-dir-shipper.sh /var/log/myapp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now log-shipper
journalctl -u log-shipper -f
```
