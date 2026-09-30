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
  local server_port="${SERVER_PORT:-${PORT:-3001}}"

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
  if [[ ! "$branch_name" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    [[ "$branch_name" == -* ]] ||
    [[ "$branch_name" == *..* ]]; then
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

  echo "==> Stopping services on ports 3001-3005"
  portlisten -k 3001-3005
  for attempt in {1..20}; do
    if [[ -z "$(portlisten 3001-3005)" ]]; then
      break
    fi
    if [[ "$attempt" -eq 20 ]]; then
      echo "ERROR: Ports 3001-3005 are still in use." >&2
      portlisten 3001-3005
      return 1
    fi
    sleep 0.5
  done

  if tmux has-session -t "$tmux_session" 2>/dev/null; then
    tmux kill-session -t "$tmux_session"
  fi

  echo "==> Updating $branch_name in $huabu_dir"
  git -C "$huabu_dir" checkout "$branch_name"
  git -C "$huabu_dir" pull --ff-only origin "$branch_name"

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

  echo "==> Waiting for Huabu readiness on port $server_port"
  for attempt in {1..120}; do
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
      if (( interactive )); then
        echo "Session: $tmux_session"
        echo "Log:     $log_file"
        tail -f "$log_file"
      fi
      return 0
    fi
    sleep 1
  done

  echo "ERROR: Huabu did not become ready within 120 seconds." >&2
  echo "Log: $log_file" >&2
  return 1
}

main "$@"
