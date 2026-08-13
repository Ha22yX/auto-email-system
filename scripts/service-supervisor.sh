#!/usr/bin/env bash

set -uo pipefail

app_root="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node_bin="${NODE_BIN:-$(command -v node)}"
max_old_space_mb="${APP_MAX_OLD_SPACE_MB:-384}"
health_url="${APP_HEALTH_URL:-http://127.0.0.1:8787/api/health}"
health_interval_seconds="${APP_HEALTH_INTERVAL_SECONDS:-30}"
health_failure_limit="${APP_HEALTH_FAILURE_LIMIT:-3}"
health_startup_grace_seconds="${APP_HEALTH_STARTUP_GRACE_SECONDS:-45}"

export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

stopping=0
child_pid=""
health_pid=""
forced_stop_pid=""
restart_attempts=0

log() {
  printf '[supervisor] %s\n' "$*"
}

stop_child() {
  if [[ -z "$child_pid" ]] || ! kill -0 "$child_pid" 2>/dev/null; then
    return
  fi

  kill -TERM "$child_pid" 2>/dev/null || true
  (
    sleep 10
    kill -KILL "$child_pid" 2>/dev/null || true
  ) &
  forced_stop_pid=$!
}

request_shutdown() {
  local signal="$1"
  if [[ $stopping -eq 1 ]]; then
    return
  fi

  stopping=1
  log "received ${signal}; stopping"
  if [[ -n "$health_pid" ]]; then
    kill "$health_pid" 2>/dev/null || true
  fi
  stop_child
}

trap 'request_shutdown TERM' TERM
trap 'request_shutdown INT' INT
trap 'request_shutdown HUP' HUP

monitor_health() {
  local monitored_pid="$1"
  local failures=0

  sleep "$health_startup_grace_seconds"
  while kill -0 "$monitored_pid" 2>/dev/null; do
    if curl --silent --show-error --fail --max-time 10 "$health_url" \
      | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      failures=0
    else
      failures=$((failures + 1))
      log "health check failed ${failures}/${health_failure_limit}"
      if (( failures >= health_failure_limit )); then
        log "health check failure limit reached; restarting app pid=${monitored_pid}"
        kill -TERM "$monitored_pid" 2>/dev/null || true
        sleep 10
        kill -KILL "$monitored_pid" 2>/dev/null || true
        return
      fi
    fi
    sleep "$health_interval_seconds"
  done
}

cd "$app_root"

while [[ $stopping -eq 0 ]]; do
  child_started_at="$(date +%s)"
  "$node_bin" \
    "--max-old-space-size=${max_old_space_mb}" \
    --import tsx \
    server/src/server.ts &
  child_pid=$!
  log "app started pid=${child_pid} heap_limit_mb=${max_old_space_mb} malloc_arenas=${MALLOC_ARENA_MAX}"

  monitor_health "$child_pid" &
  health_pid=$!

  wait "$child_pid"
  exit_code=$?

  if [[ -n "$forced_stop_pid" ]]; then
    kill "$forced_stop_pid" 2>/dev/null || true
    wait "$forced_stop_pid" 2>/dev/null || true
    forced_stop_pid=""
  fi

  kill "$health_pid" 2>/dev/null || true
  wait "$health_pid" 2>/dev/null || true
  health_pid=""
  child_pid=""

  if [[ $stopping -eq 1 ]]; then
    break
  fi

  child_lifetime=$(( $(date +%s) - child_started_at ))
  if (( child_lifetime >= 60 )); then
    restart_attempts=0
  fi

  restart_delay=$((1 << restart_attempts))
  if (( restart_delay > 30 )); then
    restart_delay=30
  fi
  if (( restart_attempts < 5 )); then
    restart_attempts=$((restart_attempts + 1))
  fi

  log "app exited code=${exit_code}; restarting in ${restart_delay}s"
  sleep "$restart_delay" &
  wait $! 2>/dev/null || true
done

log "supervisor stopped"
