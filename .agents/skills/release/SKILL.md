---
name: release
description: Use ONLY when the user explicitly asks to cut/publish a Huabu desktop release or tag a version. Performs an outward action — bumps the version in apps/desktop/package.json, commits + annotated-tags vX.Y.Z, and pushes the branch + tag. That tag push auto-builds the macOS/Windows installers and publishes a GitHub Release. Provides `status`, `bump`, `tag-push`, and a one-command `run` (bump → tag-push).
---

# Release

Huabu ships exactly one artifact: the Huabu desktop (Electron) app. So there is one version per release, held in **`apps/desktop/package.json`**. A release bumps that version, makes one `Release vX.Y.Z` commit + annotated tag, and pushes the branch + tag.

Everything past the push is automatic and lives in GitHub Actions: pushing a `vX.Y.Z` tag fires **`.github/workflows/release.yml`**, which builds the macOS + Windows installers and publishes them as a GitHub Release (with auto-generated notes) attached to that tag. The skill does **not** await that build — follow it in the Actions tab (workflow **"Release"**).

The whole release is therefore just **`run` = `bump` → `tag-push`**.

```bash
.agents/skills/release/scripts/release.sh <command> [options]
```

## Agent policy — read first

This skill pushes a tag that publishes a public GitHub Release. **Do not run `tag-push` or `run` unless the user has explicitly asked to cut/tag a release in this turn.** When unsure, print the command and let the user run it.

- Read-only / safe anytime: `status`, and any subcommand with `--dry-run`.
- `tag-push` and `run` refuse to act without `--yes` (there is no interactive prompt — be explicit).

## Commands

| Command                    | What it does                                                               |
| -------------------------- | -------------------------------------------------------------------------- |
| `status`                   | Current version, latest tag, branch, tree state. Read-only.                |
| `bump <version>`           | Write `<version>` into `apps/desktop/package.json`. Local only, no commit. |
| `tag-push <version> --yes` | Commit `Release vX.Y.Z`, annotated tag `vX.Y.Z`, push branch + tag.        |
| `run <version> --yes`      | The one release command: `bump` → `tag-push`.                              |

Options: `--dry-run` (print without running), `--yes` (confirm the push), `-m/--message <text>` (annotated-tag message; default `Release vX.Y.Z`).

## Typical flow

```bash
# 1. See where things stand.
.agents/skills/release/scripts/release.sh status

# 2. Preview the whole release without touching anything.
.agents/skills/release/scripts/release.sh run 0.3.0 --yes --dry-run

# 3. Cut it.
.agents/skills/release/scripts/release.sh run 0.3.0 --yes
```

Then watch GitHub Actions → workflow **"Release"** for the `v0.3.0` build; when it finishes, the installers are attached to the `v0.3.0` GitHub Release.

## Guardrails (built into the script)

- Version must be valid semver (`0.3.0`, `0.3.0-rc.1`).
- `tag-push` refuses if `apps/desktop/package.json` isn't already at the target version — run `bump` first (or use `run`, which does both).
- It **never moves an existing tag** — releases are immutable; pick a new version. It warns if the version doesn't advance past the latest tag.
- The release commit is scoped to `apps/desktop/package.json` only, so unrelated working-tree changes are never swept into it.
- Refuses on detached HEAD.

## Pre-release (draft) builds

To vet installers before going public, don't use this skill — run the **"Release"** workflow manually (`workflow_dispatch`) from the Actions tab with a tag like `v0.3.0-rc.1`. The workflow derives the temporary desktop app version from this tag, so installer filenames, update metadata, and the app itself use `0.3.0-rc.1` without requiring a version commit. Manual runs publish a **draft** release you can inspect before making it public.

## Notes

- The version lives **only** in `apps/desktop/package.json` — the root and other workspace packages are `private` with no meaningful version. If a future release needs to version another package, extend `VERSION_FILE` in `scripts/release.sh`.
- Skills in this repo live under `.agents/skills/` (there is no `.claude/skills` symlink), so always invoke the script by its `.agents/skills/...` path.
