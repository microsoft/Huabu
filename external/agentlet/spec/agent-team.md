# Agent Team

> Agent Team is the packaging and setup model for reusable external agents.
> A team is a folder that can be cloned, set up by the user, and then launched
> through agentlet as a normal ACP session.

## 1. Overview

An **Agent Team** is a self-contained agent package. It lets an author publish a
folder that describes:

- what the agent is
- which harnesses it supports
- how to launch it
- how to prepare harness-specific runnable workspaces

The key design principle is to separate:

- **source package** — authored files checked into the repository
- **setup (unpack)** — explicit user-approved materialization
- **runtime launch** — later spawning from a prepared workspace

Setup is never hidden inside the first spawn. The user explicitly runs setup,
and the daemon only launches from already-prepared workspaces.

## 2. Lifecycle

```text
author writes package
        ↓
user clones / downloads folder
        ↓
user runs `node agent-setup.mjs unpack [--harness ...]`
        ├─ validates manifest
        ├─ detects / selects harnesses
        ├─ creates workspaces/<harness>/
        └─ runs package-specific setup callbacks
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
  agent-setup.mjs      ← setup entry point (thin wrapper over runtime)
  system_prompt.md     ← canonical prompt (distributed during setup)
  .env                 ← runtime secrets (not committed)
  .env.example         ← template for .env
  scripts/             ← optional helper scripts
  assets/              ← optional static assets
```

Typical generated layout after setup:

```text
<agent-team>/
  workspaces/
    default/           ← if no harness specified
    claude/            ← harness-specific prepared workspace
    copilot/
```

Notes:

- `workspaces/` is intentionally visible, not hidden. Users may inspect it,
  debug it, or run the resolved command manually from it.
- `.env` is runtime input, not generated output.
- The exact authored files are up to the package. `system_prompt.md` is a
  common convention, not a required schema field.

## 4. Manifest: `agentlet.yaml`

`agentlet.yaml` is the declarative identity and launch contract for the package.
It should stay small, inspectable, and safe to read without executing code.

### 4.1 Example

```yaml
schema: agentlet-agent-schema-v1
name: hackmd-publisher
description: Syncs canvas nodes to HackMD

supported_harnesses:
  - claude
  - copilot

command:
  claude: claude --acp
  copilot: copilot --acp
```

### 4.2 Fields

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `schema` | `string` | yes | Manifest schema version. Current value: `agentlet-agent-schema-v1`. |
| `name` | `string` | yes | Stable package name. |
| `description` | `string` | yes | Human-readable summary. |
| `supported_harnesses` | `string[]` | no | Harnesses this package is known to support, such as `claude`, `copilot`, `codex`, `pi`. |
| `command` | `string \| Record<string, string>` | yes | Command used to launch the agent process over ACP stdio. May be generic or per-harness. |

### 4.3 `supported_harnesses`

If present, `supported_harnesses` constrains what setup should prepare.

- Setup validates `--harness <name>` against this list.
- Setup can auto-detect installed harnesses from this list.
- By default, setup prepares all supported harnesses.

If omitted, the package is treated as harness-agnostic and setup creates
`workspaces/default/`.

### 4.4 `command`

`command` is the runtime launch command.

- If it is a string, the same command is used for all harnesses.
- If it is a map, each selected harness resolves to its own command.

The daemon reads this field at spawn time to determine what process to launch.

## 5. `agent-setup.mjs`

`agent-setup.mjs` is the **user-facing entry point** for setting up the
package. The user runs it directly:

```bash
node agent-setup.mjs unpack
node agent-setup.mjs unpack --harness claude
node agent-setup.mjs validate
node agent-setup.mjs doctor
```

### 5.1 Prerequisites

Agent Teams require **agentlet** to be installed. Agentlet provides both the
daemon (runtime spawn) and the `@agentlet/agent-team-runtime` package (setup
utilities).

Agentlet is not yet open-sourced. Current installation paths:

- **Monorepo consumers**: if agentlet is included as a subtree or workspace
  dependency, `npm/pnpm install` at the repo root makes both the CLI and
  `@agentlet/agent-team-runtime` available.
- **Standalone / future**: once published, `npm install -g agentlet` (or
  equivalent) will provide both the CLI and the runtime package globally.

### 5.2 Why a script entry point

- **Each package is self-contained** — clone folder, `node agent-setup.mjs
  unpack`, done.
- **Custom logic is first-class** — the script IS the entry point, not a
  side-channel invoked by a generic tool.
- **agentlet daemon stays focused** — daemon handles spawn/relay, not package
  management.

### 5.2 Why MJS, not shell commands in YAML

- Shell snippets like `cp`, `mkdir -p`, or env expansion are not portable.
- Setup often needs real logic, not just linear commands.
- Node's `fs`/`path` APIs make cross-platform behavior straightforward.

### 5.3 Typical implementation

`agent-setup.mjs` should be a thin wrapper over `@agentlet/agent-team-runtime`,
providing only package-specific callbacks:

```js
import { runSetup } from '@agentlet/agent-team-runtime';

runSetup({
  onInstall({ harness, workspaceDir, packageDir, fs, log }) {
    // Distribute prompt to harness-specific location
    const targets = {
      claude: 'CLAUDE.md',
      copilot: '.github/copilot-instructions.md',
    };
    const target = targets[harness];
    if (target) {
      fs.copySync(
        path.join(packageDir, 'system_prompt.md'),
        path.join(workspaceDir, target),
      );
    }
    log.info('Prompt distributed');
  },
});
```

## 6. `@agentlet/agent-team-runtime`

Most setup flows share the same skeleton, so common logic lives in a shared
runtime package.

### 6.1 Capabilities

- harness detection
- argument parsing for setup subcommands (`unpack`, `validate`, `doctor`)
- workspace creation (`workspaces/<harness>/`)
- common copy/link helpers
- validation helpers
- logging / doctor output

### 6.2 Package name

```text
@agentlet/agent-team-runtime
```

### 6.3 Intended consumers

- per-package `agent-setup.mjs` — primary consumer
- host applications — can reuse harness detection, manifest parsing, and
  validation logic from their own build/runtime pipeline

### 6.4 Design constraints

- Node-focused and reusable
- No hardwiring to CLI-only output or daemon lifecycle internals
- Should not import from `@agentlet/server` or `@agentlet/local`

## 7. Callback-Based Setup Model

Per-package setup scripts should be thin adapters over the runtime rather than
reimplementing the whole pipeline.

### 7.1 Conceptual API

```ts
runSetup({
  onValidate,
  onInstall,
  onUnpack,
  onDoctor,
})
```

The exact API is TBD, but the shape is:

- runtime owns the standard flow (parse args, read manifest, detect harness,
  create workspace)
- package script provides callbacks for agent-specific behavior

### 7.2 Responsibilities

| Layer | Responsibility |
|---|---|
| runtime | parse manifest, detect harness, create workspace |
| package callbacks | distribute prompt files, install harness-specific assets, validate local assumptions |

### 7.3 Context object

A rich context object should be passed to callbacks:

- `manifest` — parsed `agentlet.yaml`
- `packageDir` — absolute path to the source package
- `workspaceDir` — absolute path to the target workspace being prepared
- `harness` — which harness is being prepared
- `fs` — filesystem helpers
- `log` — logging helpers

## 8. `workspaces/`

`workspaces/` contains the generated runnable outputs of setup.

- `workspaces/default/` — generic workspace when no harness is specified
- `workspaces/<harness>/` — harness-specific prepared workspace

These folders are intentionally visible and user-facing: users may inspect
them, debug them, or run the resolved command manually inside them.

## 9. Harness Detection

Harness detection logic should be shared, not reimplemented by every package.

That logic belongs in `@agentlet/agent-team-runtime` so that:

- `agent-setup.mjs` can use it
- host apps can reuse the same behavior

Packages should declare support; the runtime should detect availability.

## 10. Daemon Integration

The agentlet daemon is **per-machine infrastructure**. It gains thin Agent Team
awareness — just enough to resolve a folder into a spawnable process — but does
not run setup or understand package-specific callbacks.

### 10.1 Agent Team SessionSpec variant

In addition to the existing `SessionSpec { command, cwd, env, ... }`, there is
a new variant for Agent Team launches:

```text
{ agent_dir, harness }
```

How this combines with the existing `SessionSpec` union is TBD.

### 10.2 Daemon behavior on Agent Team spawn

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
- parse or invoke `agent-setup.mjs`
- install dependencies
- understand package-specific callbacks

### 10.3 Host-app integration

Host applications send `{ agent_dir, harness }` to the daemon
instead of a fully-resolved `SessionSpec`. The daemon handles resolution
internally. The host only needs to know:

1. where the Agent Team folder is
2. which harness to use (or let the daemon pick from the manifest)

## 11. Open Questions

- exact callback API shape in `@agentlet/agent-team-runtime`
- how the Agent Team `SessionSpec` variant combines with the existing
  `SessionSpec` type (union, subtype, flag, etc.)

### Resolved

- **manifest filename**: keeping `agentlet.yaml`
- **`.env` loading**: daemon loads `.env` before spawning the process
- **lock file**: dropped — `node agent-setup.mjs validate` covers workspace
  readiness checks; no separate lock artifact needed
