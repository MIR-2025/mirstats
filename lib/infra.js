// Infrastructure health/performance — "like netdata", built in. Pulls a few key
// metrics from a small set of Linux servers over SSH (key-only) and pushes them
// to the dashboard. No agent to install on the targets; one short /proc read per
// poll. SSH connection multiplexing (ControlPersist) keeps the handshake cost low.
//
// Targets are listed in a JSON file (default data/infra-hosts.json), e.g.:
//   [ { "label": "web1", "ssh": "deploy@1.2.3.4", "key": "/home/me/.ssh/id_ed25519" } ]
// Optional per-host: "port" (ssh port), "disk" (mount to report, default "/").
//
// No-op (disabled) if the file is absent or empty.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.REPORT_DATA_DIR || path.join(__dirname, '..', 'data');
const HOSTS_FILE = process.env.INFRA_HOSTS_FILE || path.join(DATA_DIR, 'infra-hosts.json');
const POLL_MS = Math.max(1000, +(process.env.INFRA_POLL_MS || 10000)); // floor 1s
const SSH_TIMEOUT_S = Math.max(3, +(process.env.INFRA_SSH_TIMEOUT || 8));
const HIST = 60; // samples kept per host (for sparklines)

// Thresholds for the "unhealthy" flag (percent, and load relative to cores).
const T = {
  cpu: +(process.env.INFRA_CPU_WARN || 90),
  mem: +(process.env.INFRA_MEM_WARN || 90),
  disk: +(process.env.INFRA_DISK_WARN || 90),
  temp: +(process.env.INFRA_TEMP_WARN || 80), // °C
  loadPerCore: +(process.env.INFRA_LOAD_WARN || 1.5),
  margin: +(process.env.INFRA_WARN_MARGIN || 15), // bars go amber this many points below the crit threshold
};

// One-shot remote command: emit a few clean, prefix-tagged lines we parse below.
// POSIX sh + awk only — present on any stock Linux box.
const REMOTE_CMD = [
  'echo "host $(hostname)"',
  'echo "up $(awk \'{print int($1)}\' /proc/uptime)"',
  'echo "cores $(nproc)"',
  "awk '$1==\"cpu\"{print \"cpu\",$2,$3,$4,$5,$6,$7,$8}' /proc/stat",
  "awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{print \"mem\",t,a}' /proc/meminfo",
  'echo "load $(awk \'{print $1,$2,$3}\' /proc/loadavg)"',
  "awk 'NR>2{gsub(/:/,\" \");if($1!=\"lo\"){rx+=$2;tx+=$10}}END{print \"net\",rx+0,tx+0}' /proc/net/dev",
  // hottest thermal zone in °C; silent (no line) on VMs that expose no sensors
  'temp=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -rn | head -n1); [ -n "$temp" ] && echo "temp $((temp/1000))"',
].join('; ');

function diskCmd(mount) {
  const m = (mount || '/').replace(/[^A-Za-z0-9/_.-]/g, ''); // keep it a plain path
  return `df -kP '${m}' | awk 'NR==2{sub("%","",$5);print "disk",$5,$6}'`;
}

// Parse the tagged lines into a raw reading.
function parseLines(text) {
  const r = { cpu: null, mem: null, load: null, net: null, disk: null, temp: null };
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    switch (p[0]) {
      case 'host': r.host = p.slice(1).join(' '); break;
      case 'up': r.up = +p[1] || 0; break;
      case 'cores': r.cores = +p[1] || 1; break;
      case 'cpu': r.cpu = p.slice(1).map(Number); break;        // user nice system idle iowait irq softirq
      case 'mem': r.mem = { total: +p[1], avail: +p[2] }; break; // kB
      case 'load': r.load = [+p[1], +p[2], +p[3]]; break;
      case 'net': r.net = { rx: +p[1], tx: +p[2] }; break;       // cumulative bytes
      case 'disk': r.disk = { pct: +p[1], mount: p[2] }; break;
      case 'temp': r.temp = +p[1]; break;                       // °C (hottest zone)
      default: break;
    }
  }
  return r;
}

// Optional fallback key for every host (e.g. INFRA_SSH_KEY=~/.ssh/id_rsa). If
// neither this nor a per-host key is set, ssh uses your normal resolution:
// ~/.ssh/config, the default identity files, and the agent. No key is copied.
const GLOBAL_KEY = process.env.INFRA_SSH_KEY || '';
const expandTilde = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function sshArgs(h) {
  const ctl = path.join(DATA_DIR, `.ssh-infra-${(h.label || 'h').replace(/[^A-Za-z0-9_-]/g, '')}`);
  const a = [
    '-o', 'BatchMode=yes',                  // never prompt — key/agent must work non-interactively
    '-o', `ConnectTimeout=${SSH_TIMEOUT_S}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',             // reuse one connection per host
    '-o', `ControlPath=${ctl}`,
    '-o', 'ControlPersist=120',
  ];
  const key = expandTilde(h.key || GLOBAL_KEY);   // per-host key → global key → ssh defaults
  if (key) a.push('-i', key);
  if (h.port) a.push('-p', String(h.port));
  a.push(h.ssh, REMOTE_CMD + '; ' + diskCmd(h.disk));
  return a;
}

function sshExec(h) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(h), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, (SSH_TIMEOUT_S + 4) * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(kill); reject(e); });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}: ${err.trim().split('\n').pop() || ''}`));
    });
  });
}

export function createInfra(io) {
  // Each entry may be a bare "user@host" string (label derived from the host) or
  // an object { label?, ssh, key?, port?, disk? }. The string form lets you add a
  // server by just dropping in its ssh target and nothing else.
  const labelFor = (ssh) => (ssh.includes('@') ? ssh.slice(ssh.indexOf('@') + 1) : ssh);
  // Strict validation — the ssh target becomes a child-process arg, so reject
  // anything outside a safe charset and never let it look like an ssh option.
  const SAFE_SSH = /^[A-Za-z0-9_.+@:-]+$/;
  const SAFE_LABEL = /^[A-Za-z0-9_.-]{1,40}$/;
  const SAFE_DISK = /^[A-Za-z0-9/_.-]{1,80}$/;
  function normalizeHost(h) {
    let o = null;
    if (typeof h === 'string') { const ssh = h.trim(); if (ssh) o = { label: labelFor(ssh), ssh }; }
    else if (h && typeof h.ssh === 'string' && h.ssh.trim()) {
      o = { label: (h.label || labelFor(h.ssh.trim())), ssh: h.ssh.trim() };
      if (h.disk) o.disk = h.disk; if (h.key) o.key = h.key; if (h.port) o.port = h.port;
    }
    if (!o) return null;
    if (!SAFE_SSH.test(o.ssh) || o.ssh.startsWith('-')) return null; // no option injection
    if (!SAFE_LABEL.test(o.label)) return null;
    if (o.disk && !SAFE_DISK.test(o.disk)) delete o.disk;
    return o;
  }

  let hosts = [];
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(HOSTS_FILE)) hosts = JSON.parse(readFileSync(HOSTS_FILE, 'utf8'));
  } catch (e) { console.log('[infra] bad hosts file:', e.message); }
  hosts = (Array.isArray(hosts) ? hosts : []).map(normalizeHost).filter(Boolean);

  function persist() {
    try {
      writeFileSync(HOSTS_FILE + '.tmp', JSON.stringify(hosts, null, 2));
      renameSync(HOSTS_FILE + '.tmp', HOSTS_FILE);
    } catch (e) { console.log('[infra] persist failed:', e.message); }
  }

  const state = new Map(); // label -> view object the dashboard renders
  const prev = new Map();  // label -> { cpu:[...], net:{rx,tx}, t } for delta math

  function compute(h, raw, now) {
    const view = { label: h.label, host: raw.host || h.label, up: raw.up || 0, cores: raw.cores || 1, offline: false, t: now };
    // CPU % from the jiffies delta between polls (idle = idle + iowait).
    if (raw.cpu) {
      const p = prev.get(h.label);
      const tot = raw.cpu.reduce((a, b) => a + b, 0);
      const idle = (raw.cpu[3] || 0) + (raw.cpu[4] || 0);
      if (p && p.cpuTot != null && tot > p.cpuTot) {
        const dt = tot - p.cpuTot, di = idle - p.cpuIdle;
        view.cpu = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
      }
      prev.set(h.label, { ...(p || {}), cpuTot: tot, cpuIdle: idle });
    }
    if (raw.mem && raw.mem.total) view.mem = Math.round(((raw.mem.total - raw.mem.avail) / raw.mem.total) * 100);
    if (raw.load) view.load = raw.load;
    if (raw.disk) view.disk = raw.disk;
    if (raw.temp != null && Number.isFinite(raw.temp)) view.temp = raw.temp;
    // Net rate (bytes/s) from the cumulative-counter delta.
    if (raw.net) {
      const p = prev.get(h.label);
      if (p && p.net && p.t && now > p.t) {
        const dts = (now - p.t) / 1000;
        view.rx = Math.max(0, Math.round((raw.net.rx - p.net.rx) / dts));
        view.tx = Math.max(0, Math.round((raw.net.tx - p.net.tx) / dts));
      }
      prev.set(h.label, { ...(prev.get(h.label) || {}), net: raw.net, t: now });
    } else {
      prev.set(h.label, { ...(prev.get(h.label) || {}), t: now });
    }
    // Unhealthy flag + the thresholds the client colors the per-metric bars by,
    // so bar colors and the card warn always agree (and track the env vars).
    view.warn = (view.cpu >= T.cpu) || (view.mem >= T.mem) || (view.disk && view.disk.pct >= T.disk)
      || (view.temp != null && view.temp >= T.temp)
      || (view.load && view.cores && view.load[0] / view.cores >= T.loadPerCore);
    view.warnAt = { cpu: T.cpu, mem: T.mem, disk: T.disk, temp: T.temp, margin: T.margin };
    // Rolling history for sparklines (cpu / mem).
    const old = state.get(h.label);
    const hist = (old && old.hist) ? old.hist.slice(-(HIST - 1)) : [];
    hist.push({ cpu: view.cpu ?? null, mem: view.mem ?? null });
    view.hist = hist;
    return view;
  }

  async function pollHost(h) {
    const now = Date.now();
    try {
      const out = await sshExec(h);
      state.set(h.label, compute(h, parseLines(out), now));
    } catch (e) {
      const old = state.get(h.label) || { label: h.label, host: h.label, hist: [] };
      state.set(h.label, { ...old, offline: true, error: String(e.message || e).slice(0, 120), t: now });
    }
  }

  const emit = () => io.to('stats').emit('infra', latest());

  // Each host runs its own loop: poll, push, then schedule the next poll POLL_MS
  // after this one *finished* — so polls never pile up and a slow/down host (it
  // waits out its ssh timeout) never holds up the healthy ones.
  let stopped = false;
  const timers = new Map(); // label -> setTimeout handle
  function loopHost(h) {
    if (stopped) return;
    const t0 = Date.now();
    pollHost(h).catch(() => {}).then(() => {
      emit();
      if (stopped || !hosts.some((x) => x.label === h.label)) return;
      timers.set(h.label, setTimeout(() => loopHost(h), Math.max(0, POLL_MS - (Date.now() - t0))));
    });
  }

  function latest() { return hosts.map((h) => state.get(h.label) || { label: h.label, host: h.label, offline: true, hist: [] }); }

  // The configured host list for the manage-servers UI (no secrets/keys).
  function configList() { return hosts.map((h) => ({ label: h.label, ssh: h.ssh, disk: h.disk || '/' })); }

  // Add a host (string or object), persist, and poll it immediately so it shows
  // up without waiting for the next cycle. Throws on invalid / duplicate label.
  function addHost(entry) {
    const h = normalizeHost(entry);
    if (!h) throw new Error('invalid host (expected user@host)');
    if (hosts.some((x) => x.label === h.label)) throw new Error(`a host labelled "${h.label}" already exists`);
    hosts.push(h);
    persist();
    loopHost(h); // start its own loop (polls immediately, then on its own cadence)
    return configList();
  }
  function removeHost(label) {
    const i = hosts.findIndex((h) => h.label === label);
    if (i >= 0) {
      hosts.splice(i, 1); state.delete(label); prev.delete(label);
      const tm = timers.get(label); if (tm) clearTimeout(tm); timers.delete(label);
      persist(); emit();
    }
    return configList();
  }

  console.log(`[infra] monitoring ${hosts.length} host(s) every ${POLL_MS / 1000}s${hosts.length ? ': ' + hosts.map((h) => h.label).join(', ') : ' (none yet — add via the dashboard)'}`);
  hosts.forEach(loopHost);
  return { latest, configList, addHost, removeHost, stop: () => { stopped = true; for (const tm of timers.values()) clearTimeout(tm); timers.clear(); } };
}
