#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

set -euo pipefail

# Huabu release helper.
#
# One version per release, held in apps/desktop/package.json (the Electron app —
# the only artifact we ship). A release bumps that version, makes one
# "Release vX.Y.Z" commit + annotated tag, and pushes the branch + tag.
#
# Everything past the push is automatic and lives in GitHub Actions:
# pushing a vX.Y.Z tag fires .github/workflows/release.yml, which builds the
# macOS + Windows installers and publishes them as a GitHub Release (with
# auto-generated notes) attached to that tag. This script does NOT await that
# build — follow it in the Actions tab (workflow "Release").
#
# The whole release is therefore just `run` = bump -> tag-push.
#
#   <skill-root>/release/scripts/release.sh <command> [options]
#
# where <skill-root> is .agents/skills.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- Repo root ---------------------------------------------------------------

resolve_repo_root() {
  local start_dir="$1" search_dir="$1"
  if git -C "${start_dir}" rev-parse --show-toplevel >/dev/null 2>&1; then
    git -C "${start_dir}" rev-parse --show-toplevel
    return 0
  fi
  while [[ "${search_dir}" != "/" ]]; do
    [[ -f "${search_dir}/pnpm-workspace.yaml" ]] && { printf '%s\n' "${search_dir}"; return 0; }
    search_dir="$(dirname -- "${search_dir}")"
  done
  return 1
}

repo_root="$(resolve_repo_root "${script_dir}")" || {
  printf 'error: unable to locate huabu repo root from %s\n' "${script_dir}" >&2
  exit 1
}

# --- Constants ---------------------------------------------------------------

# Single source of truth for the release version. Keep in sync with the
# vX.Y.Z tag that .github/workflows/release.yml builds from.
readonly VERSION_FILE="apps/desktop/package.json"

# --- Helpers -----------------------------------------------------------------

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

# Print-or-run wrapper honoring the global dry_run flag.
run() {
  if ((dry_run)); then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

require_node() {
  command -v node >/dev/null 2>&1 || die "node is required for JSON parsing but was not found on PATH"
}

ensure_repo_root() {
  cd "${repo_root}"
  [[ -f "${VERSION_FILE}" ]] || die "expected ${VERSION_FILE} under ${repo_root}"
}

validate_version() {
  local v="$1"
  local semver_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  [[ "${v}" =~ ${semver_re} ]] ||
    die "invalid version '${v}'; expected semver like 0.3.0 or 0.3.0-rc.1"
}

# Confirmation gate for outward (push) actions. dry-run is always allowed;
# otherwise --yes is mandatory (no interactive TTY is assumed).
require_confirmation() {
  ((dry_run)) && return 0
  ((assume_yes)) && return 0
  die "$1 pushes to origin; re-run with --yes to confirm (or --dry-run to preview)"
}

current_version() {
  node -p "require('${repo_root}/${VERSION_FILE}').version" 2>/dev/null || printf ''
}

latest_tag() {
  git -C "${repo_root}" tag -l 'v*' | sort -V | tail -1
}

# Rewrite only the first "version" field of VERSION_FILE, preserving the file's
# exact formatting (targeted replace, not a JSON re-serialize).
write_version() {
  local version="$1"
  node - "${repo_root}/${VERSION_FILE}" "${version}" <<'NODE'
const fs = require('fs');
const [file, version] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
let replaced = false;
const out = src.replace(/("version"\s*:\s*")[^"]*(")/, (_m, a, b) => {
  replaced = true;
  return a + version + b;
});
if (!replaced) { console.error(`no "version" field found in ${file}`); process.exit(1); }
fs.writeFileSync(file, out);
NODE
}

usage() {
  cat <<'USAGE'
Usage: release.sh <command> [options]

Commands:
  status                    Show current version, latest tag, branch, tree state (read-only).
  bump <version>            Write <version> into apps/desktop/package.json (local only, no commit).
  tag-push <version> --yes  Commit "Release vX.Y.Z" + annotated tag vX.Y.Z, push branch + tag.
  run <version> --yes       The one release command: bump -> tag-push.
  help                      Show this help.

Options:
  --dry-run                 Print the git/write commands without running them.
  --yes                     Confirm the outward (push) action.
  -m, --message <text>      Annotated-tag message (default: "Release vX.Y.Z").

The vX.Y.Z tag push fires .github/workflows/release.yml, which builds the
macOS + Windows installers and publishes a GitHub Release. This script does not
await that build — follow it in the Actions tab (workflow "Release").

For a pre-release you want to vet before going public, skip this script and run
the "Release" workflow manually (workflow_dispatch) with a tag like v0.3.0-rc.1.
It derives the app version from the tag and publishes a *draft* release instead.

Examples:
  release.sh status
  release.sh bump 0.3.0 --dry-run
  release.sh run 0.3.0 --yes --dry-run
  release.sh run 0.3.0 --yes
USAGE
}

# --- status ------------------------------------------------------------------

cmd_status() {
  ensure_repo_root
  require_node

  local ver latest branch
  ver="$(current_version)"
  latest="$(latest_tag)"
  branch="$(git -C "${repo_root}" branch --show-current)"

  log "Version file : ${VERSION_FILE}"
  log "Current      : ${ver:-<none>}"
  log "Latest tag   : ${latest:-<none>}"
  log "Branch       : ${branch:-<detached>}"
  if [[ -n "$(git -C "${repo_root}" status --porcelain -- "${VERSION_FILE}")" ]]; then
    log "Version file : dirty (uncommitted changes)"
  fi
}

# --- bump --------------------------------------------------------------------

cmd_bump() {
  dry_run=0
  local version=""
  while (($#)); do
    case "$1" in
      --dry-run) dry_run=1 ;;
      -h | --help) usage; return 0 ;;
      -*) die "unknown bump option: $1" ;;
      *) [[ -z "${version}" ]] || die "unexpected extra argument: $1"; version="$1" ;;
    esac
    shift
  done

  [[ -n "${version}" ]] || die "bump requires a version, e.g. release.sh bump 0.3.0"
  validate_version "${version}"
  ensure_repo_root
  require_node

  local old; old="$(current_version)"
  if ((dry_run)); then
    printf '+ write %s version %s -> %s\n' "${VERSION_FILE}" "${old:-?}" "${version}"
  else
    write_version "${version}"
    log "${VERSION_FILE}: ${old:-?} -> ${version}"
  fi
}

# --- tag-push ----------------------------------------------------------------

cmd_tag_push() {
  dry_run=0
  assume_yes=0
  local version="" message=""
  while (($#)); do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --yes) assume_yes=1 ;;
      -m | --message) shift; (($#)) || die "--message requires text"; message="$1" ;;
      -h | --help) usage; return 0 ;;
      -*) die "unknown tag-push option: $1" ;;
      *) [[ -z "${version}" ]] || die "unexpected extra argument: $1"; version="$1" ;;
    esac
    shift
  done

  [[ -n "${version}" ]] || die "tag-push requires a version, e.g. release.sh tag-push 0.3.0"
  validate_version "${version}"
  require_confirmation "tag-push"

  ensure_repo_root
  require_node

  local tag="v${version}"
  [[ -z "${message}" ]] && message="Release ${tag}"

  local branch; branch="$(git -C "${repo_root}" branch --show-current)"
  [[ -n "${branch}" ]] || die "detached HEAD; switch to a branch before releasing"

  # Guard: the version file must already hold the target version (did you bump?).
  local ver; ver="$(current_version)"
  if ((! dry_run)) && [[ "${ver}" != "${version}" ]]; then
    die "${VERSION_FILE} is at ${ver:-?}, not ${version}; run 'bump ${version}' first"
  fi

  # Guard: never move an existing release tag.
  if git -C "${repo_root}" rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1; then
    die "tag ${tag} already exists; releases are immutable — pick a new version"
  fi

  # Soft check: warn if the version does not advance past the latest tag.
  local latest; latest="$(latest_tag)"
  if [[ -n "${latest}" && "$(printf '%s\n%s\n' "${latest#v}" "${version}" | sort -V | tail -1)" != "${version}" ]]; then
    log "warning: ${tag} is not newer than latest tag ${latest}"
  fi

  # Commit only the version file so the release commit is scoped to the bump,
  # never sweeping unrelated working-tree changes into it.
  log "Committing ${message}"
  run git -C "${repo_root}" add -- "${VERSION_FILE}"
  if git -C "${repo_root}" diff --cached --quiet -- "${VERSION_FILE}"; then
    printf '    no version change to commit (already committed?)\n'
  else
    run git -C "${repo_root}" commit -m "${message}" -- "${VERSION_FILE}"
  fi

  log "Tagging ${tag}"
  run git -C "${repo_root}" tag -a "${tag}" -m "${message}"

  log "Pushing ${branch} + ${tag} to origin (fires the Release workflow)"
  run git -C "${repo_root}" push --atomic origin "${branch}" "refs/tags/${tag}"

  log "Done. Follow the build in GitHub Actions -> workflow \"Release\" for ${tag}."
}

# --- run ---------------------------------------------------------------------

cmd_run() {
  dry_run=0
  assume_yes=0
  local version="" message="" pass_dry=()
  while (($#)); do
    case "$1" in
      --dry-run) dry_run=1; pass_dry=(--dry-run) ;;
      --yes) assume_yes=1 ;;
      -m | --message) shift; (($#)) || die "--message requires text"; message="$1" ;;
      -h | --help) usage; return 0 ;;
      -*) die "unknown run option: $1" ;;
      *) [[ -z "${version}" ]] || die "unexpected extra argument: $1"; version="$1" ;;
    esac
    shift
  done

  [[ -n "${version}" ]] || die "run requires a version, e.g. release.sh run 0.3.0 --yes"
  validate_version "${version}"
  require_confirmation "run"

  log "RELEASE ${version} — bump -> tag-push"
  cmd_bump "${version}" "${pass_dry[@]+"${pass_dry[@]}"}"

  local yes_flag=(); ((assume_yes)) && yes_flag=(--yes)
  local msg_flag=(); [[ -n "${message}" ]] && msg_flag=(-m "${message}")
  cmd_tag_push "${version}" \
    "${pass_dry[@]+"${pass_dry[@]}"}" \
    "${yes_flag[@]+"${yes_flag[@]}"}" \
    "${msg_flag[@]+"${msg_flag[@]}"}"
}

# --- Dispatch ----------------------------------------------------------------

main() {
  local command="help"
  if (($#)) && [[ "$1" != -* ]]; then command="$1"; shift; fi
  case "${command}" in
    status) cmd_status "$@" ;;
    bump) cmd_bump "$@" ;;
    tag-push | tagpush) cmd_tag_push "$@" ;;
    run | release) cmd_run "$@" ;;
    help | -h | --help) usage ;;
    *) die "unknown command: ${command}" ;;
  esac
}

main "$@"
