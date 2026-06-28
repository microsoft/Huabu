# Agent Team

> Agent Team is the packaging and setup model for reusable external agents.
> A team is a folder that can be cloned, set up by the user, and then launched
> through agentlet as a normal ACP session.

## 1. Overview

An **Agent Team** is a self-contained agent package. It lets an author publish a
folder that describes:

- what the agent is
- which tools and skills it needs
- how to launch it
- how to prepare harness-specific runnable workspaces

The key design principle is to separate:

- **source package** — authored files checked into the repository
- **setup** — explicit user-approved materialization
- **runtime launch** — later spawning from a prepared workspace

Setup is never hidden inside the first spawn. The user explicitly runs setup,
and the daemon only launches from already-prepared workspaces.

## 2. Lifecycle

```text
author writes package
        ↓
user clones / downloads folder
        ↓
user runs `npx @agentlet/agent-team setup <dir> --harness <name>`
        ├─ validates manifest
        ├─ creates workspaces/<harness>/
        ├─ installs tools (npm packages)
        ├─ installs skills (npx skills add)
        ├─ places system prompt at harness-specific location
        └─ runs onInstall script (if declared)
        ↓
host app sends { agent_dir, harness } to agentlet daemon
        ↓
daemon reads agentlet.yaml, validates workspace, spawns process
        ↓
normal ACP session from here on
```

## 3. Package Layout

Typical authored layout:

```text
<agent-team>/
  agentlet.yaml        ← declarative manifest
  system_prompt.md     ← canonical prompt (placed by setup utility)
  .env                 ← runtime secrets (not committed)
  .env.example         ← template for .env
  skills/              ← optional local skills
  scripts/             ← optional helper scripts
  assets/              ← optional static assets
```

Typical generated layout after setup:

```text
<agent-team>/
  workspaces/
    claude/            ← harness-specific prepared workspace
      CLAUDE.md        ← prompt placed by setup
      node_modules/    ← tools installed by setup
    copilot/
      .github/
        copilot-instructions.md
      node_modules/
```

Notes:

- `workspaces/` is intentionally visible, not hidden. Users may inspect it,
  debug it, or run the resolved command manually from it.
- `.env` is runtime input, not generated output.
- `agent-setup.mjs` is no longer required — the `@agentlet/agent-team` CLI
  handles setup declaratively from the manifest.

## 4. Manifest: `agentlet.yaml`

`agentlet.yaml` is the declarative identity, setup, and launch contract for the
package. It should stay small, inspectable, and safe to read without executing
code.

### 4.1 Example

```yaml
schema: agentlet-agent-schema-v1
name: hackmd-publisher
description: Syncs canvas nodes to HackMD

command:
  claude: claude --acp
  copilot: copilot --acp

tools:
  - hackmd-cli

system_prompt: system_prompt.md
```

### 4.2 Fields

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `schema` | `string` | yes | Manifest schema version. Current value: `agentlet-agent-schema-v1`. |
| `name` | `string` | yes | Stable package name. |
| `description` | `string` | yes | Human-readable summary. |
| `command` | `string \| Record<string, string>` | yes | Command used to launch the agent process over ACP stdio. May be generic or per-harness. |
| `tools` | `string[]` | no | npm packages to install in the workspace (e.g., `hackmd-cli`). |
| `skills` | `string[]` | no | Skill paths to install via `npx skills add --agent <harness>`. May be relative paths (resolved against package root) or npm package names. |
| `system_prompt` | `string` | no | Path to the canonical prompt file (relative to package root). Default: `system_prompt.md`. Placed at the harness-specific location during setup. |
| `onInstall` | `string` | no | Path to a custom setup script (relative to package root). Dynamically imported after the declarative pipeline. Must export a default async function. |
| `supported_harnesses` | `string[]` | no | _(Deprecated)_ Harnesses this package supports. Prefer using `command` map keys to declare harness support. |

### 4.3 `command`

`command` is the runtime launch command.

- If it is a string, the same command is used for all harnesses.
- If it is a map, each selected harness resolves to its own command.

The daemon reads this field at spawn time to determine what process to launch.

### 4.4 Declarative Setup Pipeline

The `@agentlet/agent-team` CLI processes these manifest fields in order:

1. **`tools`** — installs npm packages in the workspace (`npm install <pkg>`)
2. **`skills`** — installs skills via `npx skills add <path> --agent <harness>`,
   using a built-in harness→agent mapping (e.g., `claude` → `claude`,
   `copilot` → `github-copilot`)
3. **`system_prompt`** — copies the prompt file to the harness-specific
   location (e.g., `CLAUDE.md` for Claude, `.github/copilot-instructions.md`
   for Copilot)
4. **`onInstall`** — if declared, dynamically imports and runs the script
   after the above steps complete

Most agent teams need only `tools`, `skills`, and `system_prompt`. The
`onInstall` script is for truly custom logic beyond what the declarative fields
cover (generating config files, fetching external data, etc.).

### 4.5 `onInstall` Script Contract

When `onInstall` is declared in the manifest:

```yaml
onInstall: ./custom-setup.mjs
```

The script must export a default async function:

```js
export default async function({ packageDir, manifest, harness, workspaceDir, log }) {
  // Custom setup logic runs AFTER tools/skills/prompt are in place
  log.info('Running custom setup...');
}
```

The function receives a context object with:
- `packageDir` — absolute path to the package root
- `manifest` — parsed agentlet.yaml
- `harness` — the harness being set up
- `workspaceDir` — absolute path to `workspaces/<harness>/`
- `log` — logging helpers (`info`, `warn`, `error`, `success`)

## 5. `@agentlet/agent-team`

The shared runtime package that provides both the CLI and library API.

### 5.1 CLI Usage

```bash
# Set up an agent team for a specific harness
npx @agentlet/agent-team setup ./my-agent --harness claude

# Validate workspace readiness
npx @agentlet/agent-team validate ./my-agent --harness claude

# Run diagnostics
npx @agentlet/agent-team doctor ./my-agent
```

### 5.2 Capabilities

- manifest parsing and validation
- harness detection (which CLIs are on PATH)
- harness-specific prompt file placement
- npm tool installation
- skill installation via `npx skills add`
- custom onInstall script loading
- workspace creation and validation
- doctor diagnostics

### 5.3 Package name

```text
@agentlet/agent-team
```

### 5.4 Intended consumers

- CLI users setting up agent teams
- host applications — can reuse harness detection, manifest parsing, and
  validation logic from their own build/runtime pipeline

### 5.5 Library API (backward compat)

For agent teams that need complex custom setup, a per-package script can still
import `runSetup`:

```js
import { runSetup } from '@agentlet/agent-team';

runSetup({
  onInstall(harness, workspaceDir, ctx) {
    // Custom setup logic
  },
});
```

This is the legacy pattern and is optional — the CLI + declarative manifest
covers most use cases.

### 5.6 Design constraints

- Node-focused and reusable
- No hardwiring to CLI-only output or daemon lifecycle internals
- Should not import from `@agentlet/server` or `@agentlet/local`

## 6. Harness-Specific Mappings

The setup utility maintains internal mappings for harness-specific behavior.
Agent team authors don't need to know these details — the manifest is
harness-agnostic.

### 6.1 Prompt File Placement

| Harness | Prompt location |
|---|---|
| `claude` | `CLAUDE.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `codex` | `AGENTS.md` |
| _(unknown)_ | `system_prompt.md` (fallback) |

### 6.2 Skills Agent Mapping

| Harness | `--agent` value for `npx skills add` |
|---|---|
| `claude` | `claude` |
| `copilot` | `github-copilot` |
| `codex` | `codex` |

See https://github.com/vercel-labs/skills#supported-agents for the
authoritative list.

## 7. `workspaces/`

`workspaces/` contains the generated runnable outputs of setup.

- `workspaces/default/` — generic workspace when no harness is specified
- `workspaces/<harness>/` — harness-specific prepared workspace

These folders are intentionally visible and user-facing: users may inspect
them, debug them, or run the resolved command manually inside them.

## 8. Daemon Integration

The agentlet daemon is **per-machine infrastructure**. It gains thin Agent Team
awareness — just enough to resolve a folder into a spawnable process — but does
not run setup or understand package-specific callbacks.

### 8.1 Agent Team SessionSpec variant

In addition to the existing `SessionSpec { command, cwd, env, ... }`, there is
an Agent Team variant:

```text
{ agent_dir, harness }
```

This is represented as a nested field on `SessionSpec`:

```ts
agentTeam?: { agentDir: string; harness?: string }
```

### 8.2 Daemon behavior on Agent Team spawn

When the daemon receives `{ agent_dir, harness }`:

1. **Read** `agentlet.yaml` from `agent_dir`
2. **Validate** that `workspaces/<harness|default>/` exists (i.e., setup has
   been done)
3. **Resolve** `command` from the manifest for the chosen harness
4. **Derive** `cwd = agent_dir/workspaces/<harness|default>/`
5. **Load** `.env` from `agent_dir` if present
6. **Spawn** the resolved command — from here on, identical to any other ACP
   session

The daemon does **not**:

- run setup / unpack
- install dependencies
- understand package-specific callbacks

### 8.3 Host-app integration

Host applications send `{ agent_dir, harness }` to the daemon
instead of a fully-resolved `SessionSpec`. The daemon handles resolution
internally. The host only needs to know:

1. where the Agent Team folder is
2. which harness to use (or let the daemon pick from the manifest)

## 9. Open Questions

### Resolved

- **manifest filename**: keeping `agentlet.yaml`
- **`.env` loading**: daemon loads `.env` before spawning the process
- **lock file**: dropped — `validate` subcommand covers workspace readiness
- **callback API**: `(harness, workspaceDir, ctx)` where `ctx = { packageDir, manifest, harness, workspaceDir, log }`
- **package name**: `@agentlet/agent-team`
- **setup entry point**: `@agentlet/agent-team` CLI is the primary entry point; per-package `agent-setup.mjs` is optional
- **declarative setup**: `tools`, `skills`, `system_prompt` in manifest; `onInstall` for custom logic
- **SessionSpec variant**: nested `agentTeam?: { agentDir, harness? }` field on existing `SessionSpec`
