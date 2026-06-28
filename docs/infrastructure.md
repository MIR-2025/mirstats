# Infrastructure health

A built-in, "like-netdata" panel that shows **CPU, RAM, disk, load average, and
network throughput** for a small set of Linux servers, with a per-host CPU
sparkline and a warning flag when something crosses a threshold or goes offline.

It is **pull-based over SSH**: MIR Sentinel reaches out to each server, runs one
short read of `/proc` (plus `df`/`nproc`), and computes the metrics itself.
There is **no agent to install** on the targets — the SSH user only needs to read
`/proc` and run `df`, `nproc`, `hostname`, and `awk`.

It is **off by default** and a complete no-op until you list at least one host.

---

## Quick start

1. On the machine running MIR Sentinel, create `data/infra-hosts.json`:

   ```json
   [
     "deploy@10.0.0.1",
     "deploy@10.0.0.2"
   ]
   ```

2. Make sure that machine can SSH to those targets **non-interactively** (see
   [Keys & connecting](#keys--connecting)). Test it by hand:

   ```bash
   ssh -o BatchMode=yes deploy@10.0.0.1 'uptime; nproc'
   ```

3. Restart the app (`pm2 restart mirstats`). The **infrastructure** card fills in
   within a poll interval (~10s). CPU% and network rates appear on the *second*
   poll, since they are computed from the change between two readings.

That's it. To add a server later, just add another line.

---

## The host list

`data/infra-hosts.json` is a JSON array. Each entry is either a **bare SSH
target string** or an **object** for when you want to override something.

### String form (simplest)

```json
[
  "deploy@10.0.0.1",
  "deploy@web2.internal",
  "prod-db"
]
```

- The string is passed straight to `ssh`, so anything your SSH already
  understands works: `user@host`, `user@1.2.3.4`, a bare `host`, or a **`Host`
  alias from `~/.ssh/config`** (e.g. `prod-db`).
- The **label** shown in the dashboard is derived from the target (the part after
  `@`, or the whole string if there's no `@`).

### Object form (overrides)

```json
[
  { "label": "web1", "ssh": "deploy@10.0.0.1" },
  { "label": "db",   "ssh": "deploy@10.0.0.3", "disk": "/data", "port": 2222 },
  { "ssh": "deploy@10.0.0.4", "key": "~/.ssh/infra_ed25519" }
]
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `ssh` | yes | — | SSH target (`user@host`, IP, or a `~/.ssh/config` alias) |
| `label` | no | derived from `ssh` | name shown in the card |
| `disk` | no | `/` | mount point to report disk usage for |
| `port` | no | 22 (or your ssh config) | SSH port |
| `key` | no | see below | private key path for this host (`~` is expanded) |

You can mix strings and objects in the same file.

> The file is **gitignored** — it holds server addresses and should not be
> committed. A committed `data/infra-hosts.example.json` shows the format.

### Add / remove from the dashboard

The **infrastructure** card (right column) has an **add a server** box and a list
of the configured hosts with a ✕ to remove each. Adding `user@host` there polls
it immediately and writes it to `data/infra-hosts.json` for you — no restart
needed. (Advanced fields like a custom `disk`/`key`/`port` still need the file.)
The ssh target is validated server-side, so it can never be an ssh option or
contain shell characters.

---

## Keys & connecting

MIR Sentinel runs `ssh` **as the user that started the app** (typically you, via
PM2 on localhost). That means it uses your existing SSH setup, and **no private
key is ever copied or duplicated** into the app.

### How the key is chosen (in order)

1. **Per-host `key`** in the host object (`"key": "~/.ssh/infra_ed25519"`), if set.
2. **Global `INFRA_SSH_KEY`** env var (e.g. `INFRA_SSH_KEY=~/.ssh/id_rsa`), if set.
3. **SSH's own resolution** — `~/.ssh/config` (`IdentityFile`, `User`, `Port`,
   `ProxyJump`, …), the default identity files (`~/.ssh/id_ed25519`,
   `~/.ssh/id_rsa`, …), and the SSH agent.

So in the common case you set **nothing**: drop in `"user@ip"` and it uses the
same key you already use to log in. To point every host at one key without
repeating it, set `INFRA_SSH_KEY` once. `~` is expanded in all key paths.

### Must work non-interactively

The app connects with `BatchMode=yes`, so it will **never** prompt. The key must
therefore be usable without typing anything:

- a **passphrase-less** private key, **or**
- a **passphrase-protected** key whose passphrase is loaded into an `ssh-agent`
  that the app's process can reach (`SSH_AUTH_SOCK` must be in the app's
  environment — note that PM2 does **not** inherit your interactive shell's agent
  unless you arrange it).

If you see `Permission denied (publickey)` only from the app but `ssh` works in
your terminal, this is almost always the agent/passphrase difference. The simplest
fix is a dedicated passphrase-less key restricted to the metrics command (below).

### Host key checking

The app uses `StrictHostKeyChecking=accept-new`: the first connection pins the
host key into `~/.ssh/known_hosts`, and a later key change is refused. Pre-seed it
if you prefer:

```bash
ssh-keyscan -H 10.0.0.1 >> ~/.ssh/known_hosts
```

### Connection reuse

Each host uses SSH multiplexing (`ControlMaster`/`ControlPersist=120`), so the
expensive handshake happens once and subsequent polls reuse the open connection.
The control sockets live next to the host file (`data/.ssh-infra-<label>`).

---

## Hardening: a dedicated, locked-down key (recommended)

For a monitoring connection you do **not** want to hand over a general-purpose
login key. Create a dedicated key that can do exactly one thing — print metrics —
and nothing else.

**1. Generate a dedicated key (no passphrase) on the MIR Sentinel host:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mir-infra -N '' -C 'mir-sentinel-infra'
```

**2. On each target, install a tiny metrics script** (`/usr/local/bin/mir-metrics.sh`):

```sh
#!/bin/sh
echo "host $(hostname)"
echo "up $(awk '{print int($1)}' /proc/uptime)"
echo "cores $(nproc)"
awk '$1=="cpu"{print "cpu",$2,$3,$4,$5,$6,$7,$8}' /proc/stat
awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{print "mem",t,a}' /proc/meminfo
echo "load $(awk '{print $1,$2,$3}' /proc/loadavg)"
awk 'NR>2{gsub(/:/," ");if($1!="lo"){rx+=$2;tx+=$10}}END{print "net",rx+0,tx+0}' /proc/net/dev
df -kP / | awk 'NR==2{sub("%","",$5);print "disk",$5,$6}'
```

```bash
sudo install -m 0755 mir-metrics.sh /usr/local/bin/mir-metrics.sh
```

**3. Add the key to the monitoring user's `~/.ssh/authorized_keys` with a forced
command and restrictions** so the key can *only* run that script:

```
command="/usr/local/bin/mir-metrics.sh",restrict,from="<mir-sentinel-host-ip>" ssh-ed25519 AAAA...your mir-infra.pub... mir-sentinel-infra
```

- `command="…"` — the server ignores whatever the client asks for and always runs
  the metrics script. Even if the key leaks, it can't get a shell.
- `restrict` — disables port/agent/X11 forwarding and PTY allocation (modern
  OpenSSH; on older versions list `no-pty,no-port-forwarding,no-agent-forwarding,
  no-X11-forwarding`).
- `from="…"` — only accept this key from the MIR Sentinel host's IP.

**4. Point the host list at the dedicated key:**

```json
[ { "label": "web1", "ssh": "monitor@10.0.0.1", "key": "~/.ssh/mir-infra" } ]
```

or set it globally: `INFRA_SSH_KEY=~/.ssh/mir-infra`.

> With a forced command, the per-host `disk` field is ignored (the script reports
> `/`). To watch a different mount, edit the `df` line in the script on that host.

A dedicated low-privilege user is ideal (`monitor`), but the script only reads
public `/proc` data, so it does not require root.

---

## Environment variables

All optional; sensible defaults shown.

| Variable | Default | Purpose |
|---|---|---|
| `INFRA_HOSTS_FILE` | `data/infra-hosts.json` | path to the host list (relative to the app dir) |
| `INFRA_SSH_KEY` | — | fallback private key for every host; omit to use ssh defaults |
| `INFRA_POLL_MS` | `10000` | poll interval per host in ms (floor 1000) |
| `INFRA_SSH_TIMEOUT` | `8` | per-host SSH connect timeout in seconds |
| `INFRA_CPU_WARN` | `90` | flag a host when CPU% ≥ this |
| `INFRA_MEM_WARN` | `90` | flag when memory used % ≥ this |
| `INFRA_DISK_WARN` | `90` | flag when disk used % ≥ this |
| `INFRA_LOAD_WARN` | `1.5` | flag when 1-min load average **per core** ≥ this |
| `INFRA_WARN_MARGIN` | `15` | per-metric bars turn amber this many points below the crit (`*_WARN`) threshold; red at/above it |

`REPORT_DATA_DIR` (shared with the reporter/history) also moves where the host
file and the SSH control sockets live, if you've set it.

---

## What's collected, and how

Per poll, the app reads these on each host and derives the metrics:

| Shown | Source | Notes |
|---|---|---|
| **CPU %** | `/proc/stat` `cpu` line | busy fraction over the interval between two polls (idle = idle + iowait) |
| **RAM %** | `/proc/meminfo` | `(MemTotal − MemAvailable) / MemTotal` |
| **Disk %** | `df -kP <mount>` | used % of the configured mount (default `/`) |
| **Load** | `/proc/loadavg` | 1 / 5 / 15-minute averages; warn compares 1-min ÷ cores |
| **Net ↓/↑** | `/proc/net/dev` | bytes/sec, summed over all non-loopback interfaces, from the counter delta |
| **Uptime** | `/proc/uptime` | — |
| **Cores** | `nproc` | used to normalize the load warning |

CPU% and network rates are **deltas**, so a freshly-added host shows them blank
until its second poll.

---

## The card

Each server is a row: a status dot (green ok / red warning / grey offline), the
label and hostname, a small **CPU sparkline** (recent history), uptime, then bars
for CPU / RAM / disk and a line with load and net throughput. A host is flagged
(red) when any threshold is crossed, and shown dimmed as **offline** with the SSH
error if a poll fails.

---

## Troubleshooting

- **`infrastructure monitoring disabled` in the logs** — the host file is missing
  or empty. Check `INFRA_HOSTS_FILE` and that the JSON is a non-empty array.
- **A host shows `offline · Permission denied (publickey)`** — the app's process
  can't authenticate non-interactively. Use a passphrase-less dedicated key, or
  make the agent reachable to the app. Test: `ssh -o BatchMode=yes <target> true`.
- **`offline · timeout`** — host unreachable / firewalled / slow. Raise
  `INFRA_SSH_TIMEOUT`, confirm the port and any `ProxyJump`.
- **`offline · Host key verification failed`** — the host key changed or isn't
  trusted. `ssh-keyscan -H <host> >> ~/.ssh/known_hosts` (after verifying it).
- **CPU%/net stay blank** — wait one more poll; they need two samples.
- **Wrong disk** — set `"disk": "/your/mount"` (string-form hosts always report `/`).
- **Works in your terminal but not the app** — almost always the SSH agent /
  passphrase difference between your shell and the PM2 process. See
  [Must work non-interactively](#must-work-non-interactively).

---

## Disabling

Remove or empty `data/infra-hosts.json` (or point `INFRA_HOSTS_FILE` elsewhere)
and restart. The card shows "no hosts configured" and no SSH connections are made.
