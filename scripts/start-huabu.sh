#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

set -euo pipefail

main() {
  local branch_name=''
  local interactive=1
  local script_dir
  local huabu_dir
  local tmux_session='app'
  local log_file='/tmp/huabu-app.log'
  local server_port=''
  local readiness_timeout_seconds="${HUABU_CANARY_READINESS_TIMEOUT_SECONDS:-300}"

  for argument in "$@"; do
    case "$argument" in
      --non-interactive)
        interactive=0
        ;;
      --*)
        echo "Unknown option: $argument" >&2
        return 2
        ;;
      *)
        if [[ -n "$branch_name" ]]; then
          echo "Usage: $0 <branch_name> [--non-interactive]" >&2
          return 2
        fi
        branch_name="$argument"
        ;;
    esac
  done

  if [[ -z "$branch_name" ]]; then
    echo "Usage: $0 <branch_name> [--non-interactive]" >&2
    return 2
  fi
  if [[ ! "$readiness_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    echo "HUABU_CANARY_READINESS_TIMEOUT_SECONDS must be a positive integer." >&2
    return 2
  fi
  if (( ${#branch_name} > 255 )) ||
    [[ "$branch_name" == -* ]] ||
    ! git check-ref-format --branch "$branch_name" >/dev/null 2>&1 ||
    ! git check-ref-format "refs/heads/$branch_name" >/dev/null 2>&1; then
    echo "Invalid branch name: $branch_name" >&2
    return 2
  fi

  script_dir="$(
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
    pwd -P
  )"
  huabu_dir="$(
    cd -- "$script_dir/.."
    pwd -P
  )"

  if [[ -n "${SERVER_PORT:-}" ]]; then
    server_port="$SERVER_PORT"
  elif [[ -f "$huabu_dir/.env" ]]; then
    server_port="$(
      node --input-type=module - "$huabu_dir/.env" <<'NODE'
import fs from 'node:fs';

const source = fs.readFileSync(process.argv[2], 'utf8');
let value = '';
for (const line of source.split(/\r?\n/u)) {
  const assignment = line.match(
    /^\s*(?:export\s+)?SERVER_PORT\s*=\s*(.*)$/u,
  );
  if (!assignment) continue;

  const rawValue = assignment[1].trim();
  const quotedValue = rawValue.match(/^(["'])(.*?)\1\s*(?:#.*)?$/u);
  value = quotedValue
    ? quotedValue[2]
    : rawValue.replace(/\s*#.*$/u, '').trim();
}
process.stdout.write(value);
NODE
    )"
  fi
  server_port="${server_port:-3001}"
  if [[ ! "$server_port" =~ ^[1-9][0-9]*$ ]] ||
    ((10#$server_port > 65535)); then
    echo "SERVER_PORT must be an integer between 1 and 65535." >&2
    return 2
  fi

  if [[ "$(git -C "$huabu_dir" rev-parse --show-toplevel)" != "$huabu_dir" ]]; then
    echo "ERROR: $huabu_dir is not the Huabu repository root." >&2
    return 1
  fi
  if [[ -n "$(git -C "$huabu_dir" status --porcelain)" ]]; then
    echo "ERROR: Working tree has uncommitted changes." >&2
    return 1
  fi

  portlisten() {
    local kill_mode=0
    local ports
    local pid
    local -a pids=()

    if [[ "${1:-}" == "-k" ]]; then
      kill_mode=1
      shift
    fi
    ports="${1:-}"
    if [[ ! "$ports" =~ ^[0-9]+(-[0-9]+)?$ ]]; then
      echo "Usage: portlisten [-k] <port|start-end>" >&2
      return 2
    fi
    if (( !kill_mode )); then
      command lsof -nP "-iTCP:${ports}" -sTCP:LISTEN
      return
    fi
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && pids+=("$pid")
    done < <(
      command lsof -t -nP "-iTCP:${ports}" -sTCP:LISTEN |
        sort -u
    )
    if (( ${#pids[@]} == 0 )); then
      return 0
    fi
    echo "Sending SIGTERM to listeners on TCP port(s) ${ports}:"
    command lsof -nP "-iTCP:${ports}" -sTCP:LISTEN
    command kill -TERM "${pids[@]}"
  }

  echo "==> Stopping the service on port $server_port"
  portlisten -k "$server_port"
  for attempt in {1..20}; do
    if [[ -z "$(portlisten "$server_port")" ]]; then
      break
    fi
    if [[ "$attempt" -eq 20 ]]; then
      echo "ERROR: Port $server_port is still in use." >&2
      portlisten "$server_port"
      return 1
    fi
    sleep 0.5
  done

  if tmux has-session -t "$tmux_session" 2>/dev/null; then
    tmux kill-session -t "$tmux_session"
  fi

  local branch_ref="refs/heads/$branch_name"
  local remote_ref="refs/remotes/origin/$branch_name"
  echo "==> Updating $branch_name from origin in $huabu_dir"
  git -C "$huabu_dir" fetch --no-tags origin "$branch_ref:$remote_ref"
  if git -C "$huabu_dir" show-ref --verify --quiet "$branch_ref"; then
    git -C "$huabu_dir" checkout "$branch_name"
    git -C "$huabu_dir" merge --ff-only "$remote_ref"
  else
    git -C "$huabu_dir" checkout -b "$branch_name" --track "$remote_ref"
  fi

  echo "==> Installing dependencies"
  pnpm --dir "$huabu_dir" install --frozen-lockfile

  rm -f "$log_file"
  touch "$log_file"
  tmux new-session \
    -d \
    -s "$tmux_session" \
    -c "$huabu_dir" \
    "set -o pipefail; pnpm start:web 2>&1 | tee '$log_file'"
  tmux set-option -t "$tmux_session" remain-on-exit on

  if (( interactive )); then
    echo "==> Watching startup logs"
    echo "Session: $tmux_session"
    echo "Log:     $log_file"
    tail -f "$log_file"
    return 0
  fi

  echo "==> Waiting up to ${readiness_timeout_seconds}s for Huabu readiness on port $server_port"
  for ((attempt = 1; attempt <= readiness_timeout_seconds; attempt++)); do
    if node --input-type=module -e '
      const port = process.argv[1];
      const headers = {};
      const user = process.env.HUABU_BASIC_AUTH_USER;
      const pass = process.env.HUABU_BASIC_AUTH_PASS;
      if (user && pass) {
        headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/deployment/readiness`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) process.exit(1);
    ' "$server_port" 2>/dev/null; then
      echo "==> Huabu is ready"
      return 0
    fi
    sleep 1
  done

  echo "ERROR: Huabu did not become ready within ${readiness_timeout_seconds} seconds." >&2
  echo "Log: $log_file" >&2
  return 1
}

main "$@"
