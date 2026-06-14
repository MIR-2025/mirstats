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

### Feeding it: symlink your process-manager logs

The shipper just watches a directory, so the usual pattern is to symlink each
app's log file into one shared directory (e.g. `/opt/common`) under a friendly
name — the symlink's basename becomes the source tag.

With **PM2** (logs live in `~/.pm2/logs/<app>-out.log` and `-error.log`):

```bash
sudo mkdir -p /opt/common
# one named source per app (run as root so the links survive across users)
sudo ln -s ~/.pm2/logs/myapp-out.log /opt/common/myapp.log
sudo ln -s ~/.pm2/logs/api-out.log   /opt/common/api.log
./log-dir-shipper.sh /opt/common
```

`tail -F` follows the symlink and survives log rotation. The same works for any
log file — nginx, Apache, a systemd unit, etc.:

```bash
sudo ln -s /var/log/nginx/access.log /opt/common/nginx.log
# systemd: journalctl -u myservice -f > /opt/common/myservice.log
```

Other process managers (supervisor, Docker `--log-path`, …) work the same way:
get the lines into a `*.log` file inside the watched directory.

### Windows

`log-dir-shipper.sh` is a Bash script that depends on `tail -F`, `mkfifo`,
`curl`, `jq`, and `awk`, so it does **not** run under native `cmd`/PowerShell.

- **Recommended — WSL2.** Run everything inside a WSL2 (e.g. Ubuntu) shell; the
  Linux instructions above apply verbatim. PM2-in-WSL logs sit at the same
  `~/.pm2/logs/` path and `ln -s` works normally.
- **Git Bash / MSYS2.** The script can run, but Windows symlinks need `mklink`
  from an **admin** prompt (or with Developer Mode enabled):
  `mklink C:\common\myapp.log "%USERPROFILE%\.pm2\logs\myapp-out.log"`.
- **No symlinks at all.** Since the directory is just an argument, point the
  shipper straight at the PM2 log folder —
  `./log-dir-shipper.sh "$USERPROFILE/.pm2/logs"` — accepting that the source
  tags become the raw PM2 filenames (`myapp-out`, `myapp-error`).

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
