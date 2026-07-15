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

Managed hosts may invoke the same pipeline through the daemon's `agent-team/setup` control operation. Managed setup requires an explicit absolute deployment workspace, runs in an isolated child process, emits structured progress, and can be cancelled without terminating the daemon. The runner clears its readiness marker before materialization and atomically writes a new marker only after every setup phase succeeds, so validation cannot mistake a partial or cancelled workspace for a ready deployment.

## 2. Lifecycle

```text
author writes package
        ↓
user clones / downloads folder
        ↓
user runs `agentlet agent-team setup --harness <name>` (from inside the folder)
        ├─ validates manifest
        ├─ creates workspaces/<harness>/
        ├─ installs tools (npm packages)
        ├─ installs skills (npx skills add)
        ├─ places system prompt at harness-specific location
        ├─ copies require.copies entries into the workspace
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
  system_prompt.md     ← canonical prompt (referenced from require.prompts)
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

require:
  cli-tools:
    - package: "@hackmd/hackmd-cli"
      installer: npm
      scope: shared
      executables:
        - hackmd
  prompts:
    - system_prompt.md
  skills:
    - ./skills/huabu-read
  env:
    - name: HACKMD_API_TOKEN
      description: API token used to publish documents
      required: true
      secret: true
    - name: HACKMD_API_URL
      description: HackMD API base URL
      required: false
      secret: false
      default: https://api.hackmd.io/v1
  copies:
    - from: deepv.mjs
      to: deepv.mjs
```

### 4.2 Fields

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `schema` | `string` | yes | Manifest schema version. Current value: `agentlet-agent-schema-v1`. |
| `name` | `string` | yes | Stable package name. |
| `description` | `string` | yes | Human-readable summary. |
| `command` | `Record<string, string>` | yes | Command used to launch the agent process over ACP stdio. The keys implicitly define the supported harnesses. |
| `require` | `{ cli-tools?: CliTool[]; prompts?: string[]; skills?: string[]; env?: EnvField[]; copies?: { from: string; to: string }[] }` | no | Declarative setup and runtime requirements: CLI packages, prompt files, skills, ordered environment fields, and plain file/directory copies. |
| `onInstall` | `string` | no | Path to a custom setup script (relative to package root). Dynamically imported after the declarative pipeline. Must export a default async function. |

Each `require.env` entry contains `name`, `description`, `required`, and `secret`. A non-secret entry may also declare a string `default`; secret entries cannot declare defaults.

Each `require.cli-tools` entry contains:

| Field | Type | Required | Meaning |
| --- | --- | ---: | --- |
| `package` | `string` | yes | Package identifier passed to the installer. |
| `installer` | `"npm"` | yes | Installation backend. The current schema supports only npm; other installers require an explicit future protocol extension. |
| `scope` | `"workspace" \| "shared"` | yes | `workspace` installs into one deployment workspace; `shared` installs once into agentlet-managed storage and is reusable across packages and deployments on that host. |
| `executables` | `string[]` | yes | Non-empty list of commands that setup and validation require the installed package to expose. |

`executables` uses installer-independent command names rather than npm's `bin` terminology. For example, the npm package `@hackmd/hackmd-cli` exposes the `hackmd` executable.

### 4.3 `command`

`command` is the runtime launch command.

- It is always a map of `harness -> command`.
- The map keys are the supported harnesses for the package.
- If no `--harness` is specified, setup/resolve uses the first command key (or
  auto-detects from the installed known harnesses during setup).

The daemon reads this field at spawn time to determine what process to launch.

### 4.4 Declarative Setup Pipeline

The `@agentlet/agent-team` CLI processes these manifest fields in order:

1. **`require.cli-tools`** — checks each package receipt and required executable, then installs missing npm tools into either the deployment workspace or the shared agentlet tools store
2. **`require.skills`** — installs skills via `npx skills add <path> --agent <agent>`,
   using the harness registry's `skillsAgent` mapping (e.g., `claude` →
   `claude-code`, `copilot` → `github-copilot`)
3. **`require.prompts`** — places the first prompt file at the harness-specific
   location (e.g., `CLAUDE.md` for Claude, `.github/copilot-instructions.md`
   for Copilot)
4. **`require.copies`** — copies each `{ from, to }` entry into the workspace.
   `from` may live anywhere on disk: relative paths resolve against the package
   root (where `agentlet.yaml` lives), while absolute paths and a leading `~`
   are honored (e.g. seeding a workspace from a file in the user's home
   directory). `to` resolves relative to the workspace directory and is
   constrained to stay inside it (no `..` traversal) so setup never writes
   outside the workspace it owns. Files and directories are copied recursively
   and overwritten on re-setup. Use this for runtime helpers the agent invokes
   (e.g. a driver `.mjs`) without needing a custom `onInstall` script.
5. **`onInstall`** — if declared, dynamically imports and runs the script
   after the above steps complete

Unknown harness keys are allowed in `command`, but they are treated as
best-effort during setup: the CLI still installs `require.cli-tools`, copies
`require.copies`, and runs `onInstall`, but skips skills installation and
prompt placement because those need harness-specific registry entries.

For `scope: workspace`, npm packages and receipts live in the deployment workspace. For `scope: shared`, they live under `~/.agentlet/tools/npm` by default; operators may set `AGENTLET_SHARED_NPM_TOOLS_DIR` to an absolute alternative. Shared installation is protected by an inter-process lock so concurrent deployment setup does not mutate the same npm prefix simultaneously.

Setup skips installation only when the stored receipt exactly matches the declared package and executable list and every executable exists. A successful npm process that does not expose all declared executables fails setup. Both workspace and shared `.bin` directories are prepended to the spawned agent's `PATH`.

Most agent teams need only `require.cli-tools`, `require.skills`, `require.prompts`, and `require.copies`. The `onInstall` script is for truly custom logic beyond what the declarative fields cover (generating config files, fetching external data, etc.).

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

The shared runtime package that provides the library API. Its setup CLI is
exposed through the `agentlet` daemon binary as the `agent-team` subcommand.

### 5.1 CLI Usage

Run these from inside the agent-team folder (the directory containing
`agentlet.yaml`); all commands operate on the current working directory.

```bash
cd my-agent

# Set up an agent team for a specific harness
agentlet agent-team setup --harness claude

# Validate workspace readiness
agentlet agent-team validate --harness claude

# Run diagnostics
agentlet agent-team doctor
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
- Should not import the daemon CLI or a host-specific Gateway implementation

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
| _(unknown)_ | skipped (no registry entry) |

### 6.2 Skills Agent Mapping

| Harness | `--agent` value for `npx skills add` |
|---|---|
| `claude` | `claude-code` |
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
{ manifestPath, workingDirPath, harness }
```

This is represented as a nested field on `SessionSpec`:

```ts
agentTeam?: {
  manifestPath: string
  workingDirPath: string
  harness: string
}
```

### 8.2 Daemon behavior on Agent Team spawn

When the daemon receives `{ manifestPath, workingDirPath, harness }`:

1. **Read** the selected `manifestPath`.
2. **Validate** that `workingDirPath` exists and remains prepared.
3. **Resolve** `command` from the manifest for the chosen harness.
4. **Use** `workingDirPath` as `cwd`.
5. **Load** `.env` from the manifest directory if present.
6. **Prepend** the deployment workspace and agentlet-shared npm `.bin` directories to `PATH`
7. **Spawn** the resolved command — from here on, identical to any other ACP session

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
- **declarative setup**: structured npm requirements in `require.cli-tools`, plus `require.skills`, `require.prompts`, and `require.copies`; `onInstall` remains available for custom logic
- **SessionSpec variant**: nested `agentTeam?: { manifestPath, workingDirPath, harness }` field on existing `SessionSpec`; the legacy `{ agentDir, harness? }` variant remains readable for existing durable workloads
