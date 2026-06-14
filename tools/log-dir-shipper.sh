#!/bin/bash
#
# log-dir-shipper.sh -- watch a directory of .log files and ship each new line
# to an HTTP ingest endpoint. The basename of each file (without .log) becomes
# the "source" tag. New .log files dropped into the directory are picked up
# within RESCAN_INTERVAL seconds without restarting the shipper.
#
# One watcher per directory; the source name comes from the filename. Run one of
# these per host, not one per application.
#
# It POSTs small JSON batches, treating any 2xx as success:
#   {"source":"<tag>","lines":["line one","line two", ...]}
#
# Usage:
#   ./log-dir-shipper.sh [log-dir]
#
# Defaults:
#   log-dir      ./logs
#   INGEST_URL   http://localhost:8080/ingest
#
# Override the endpoint with the INGEST_URL env var (or pass the dir as an arg).
#
# Optional env:
#   BATCH_INTERVAL    flush interval in seconds                 (default: 1)
#   BATCH_MAX         max lines per flush per source            (default: 100)
#   RESCAN_INTERVAL   how often to scan for new .log files (s)  (default: 30)
#
# Requires: bash >= 4 (associative arrays), tail, curl, jq, awk, mktemp.

set -euo pipefail

LOG_DIR="${1:-./logs}"

INGEST_URL="${INGEST_URL:-http://localhost:8080/ingest}"

BATCH_INTERVAL="${BATCH_INTERVAL:-1}"
BATCH_MAX="${BATCH_MAX:-100}"
RESCAN_INTERVAL="${RESCAN_INTERVAL:-30}"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "Not a directory: $LOG_DIR" >&2
  exit 2
fi

for cmd in tail curl jq awk mktemp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

WORK=$(mktemp -d)
FIFO="$WORK/bus"
TAIL_PIDS="$WORK/pids"
mkfifo "$FIFO"
: > "$TAIL_PIDS"

cleanup() {
  if [[ -f "$TAIL_PIDS" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$TAIL_PIDS"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# Hold the FIFO's write side open on this process too, so the reader never sees
# EOF if all tails happen to die simultaneously. Open in read+write mode (<>)
# rather than write-only (>) because opening a FIFO write-only blocks until a
# reader appears -- and our reader (FD 3) is opened later in the script.
# Read+write open never blocks on a FIFO.
exec 4<>"$FIFO"

declare -A STARTED
declare -A COUNTS

start_tail() {
  local file="$1"
  local source
  source=$(basename "$file" .log)

  # Many ingest endpoints validate the source tag as [a-zA-Z0-9_-]{1,64}. Skip
  # files whose basename doesn't qualify -- the line would be rejected anyway.
  if [[ ! "$source" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
    return
  fi
  if [[ -n "${STARTED[$source]:-}" ]]; then
    return
  fi

  # Background a subshell running tail -> awk(prefix with source\t) -> FIFO.
  # The subshell PID is what `$!` returns and what we kill on shutdown; SIGTERM
  # propagates to the tail and awk children.
  ( tail -F -n 0 "$file" 2>/dev/null | awk -v s="$source" '{print s"\t"$0; fflush()}' > "$FIFO" ) &
  echo "$!" >> "$TAIL_PIDS"
  STARTED[$source]=1
  echo "[$(date '+%F %T')] tailing $file (source=$source)" >&2
}

scan() {
  shopt -s nullglob
  for f in "$LOG_DIR"/*.log; do
    start_tail "$f"
  done
  shopt -u nullglob
}

flush_source() {
  local source="$1"
  local buf="$WORK/buf.$source"
  [[ -s "$buf" ]] || return

  local n
  n=$(wc -l < "$buf" | tr -d ' ')

  local body
  body=$(jq -Rsc --arg s "$source" 'rtrimstr("\n") | split("\n") | {source: $s, lines: .}' < "$buf")

  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
      -X POST "$INGEST_URL" \
      -H "Content-Type: application/json" \
      --data-binary "$body" 2>/dev/null) || code="000"

  # Treat any 2xx as success; log anything else.
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    echo "[$(date '+%F %T')] [$source] ingest HTTP $code (dropped $n lines)" >&2
  fi

  : > "$buf"
}

flush_all() {
  local s
  for s in "${!COUNTS[@]}"; do
    if [[ "${COUNTS[$s]:-0}" -gt 0 ]]; then
      flush_source "$s"
      COUNTS[$s]=0
    fi
  done
}

# Initial scan + periodic rescan in background
scan
(
  while sleep "$RESCAN_INTERVAL"; do
    scan
  done
) &
echo "$!" >> "$TAIL_PIDS"

exec 3<"$FIFO"

echo "[$(date '+%F %T')] shipping $LOG_DIR/*.log to $INGEST_URL (interval=${BATCH_INTERVAL}s, max=$BATCH_MAX/source, rescan=${RESCAN_INTERVAL}s)"

NEXT_FLUSH=$((SECONDS + BATCH_INTERVAL))

while true; do
  rc=0
  IFS=$'\t' read -r -t "$BATCH_INTERVAL" source line <&3 || rc=$?

  if [[ $rc -eq 0 ]]; then
    if [[ -n "$source" ]]; then
      printf '%s\n' "$line" >> "$WORK/buf.$source"
      COUNTS[$source]=$((${COUNTS[$source]:-0} + 1))
      if [[ "${COUNTS[$source]}" -ge "$BATCH_MAX" ]]; then
        flush_source "$source"
        COUNTS[$source]=0
      fi
    fi
  elif [[ $rc -gt 128 ]]; then
    # Read timed out (no input for BATCH_INTERVAL). Handled by the time-based
    # flush below.
    :
  else
    # Should not happen because FIFO write side is held open on FD 4. If it
    # does, brief sleep so we don't spin.
    sleep 0.1
  fi

  # Time-based flush -- fires every BATCH_INTERVAL seconds independent of read
  # activity. Without this, one constantly-noisy source keeps `read` returning
  # success forever, and quiet sources never reach BATCH_MAX, so their buffered
  # lines would sit unsent indefinitely.
  if [[ "$SECONDS" -ge "$NEXT_FLUSH" ]]; then
    flush_all
    NEXT_FLUSH=$((SECONDS + BATCH_INTERVAL))
  fi
done
