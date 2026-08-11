# Huabu Managed Agent Teams — Vision & Examples

> **Core thesis**: In the AI/Agent era, **the agent IS the plugin system**. Instead of designing extension points, hooks, event buses, and SDK APIs — you connect an agent. The agent reads context, reasons about intent, uses whatever tools exist in its environment (CLIs, APIs, SDKs), and writes results back. This is fundamentally more powerful than any plugin system because the interface is _natural language_ + _tool use_ — infinitely flexible, self-describing, and composable.

This document is the **Huabu product/vision layer** for Agent Teams. The generic packaging/runtime model lives in [`external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md). The remaining runtime-service work is tracked in [`managed-agent-teams.md`](../proposals/managed-agent-teams.md).

---

## 1. Why Agent > Plugin

| Dimension                 | Traditional Plugin                                | Agent-as-Plugin                                                                      |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Interface contract**    | Rigid API: hooks, lifecycle events, typed schemas | Natural language prompt + reachback tools                                            |
| **Integration cost**      | Write adapter code per plugin API                 | Describe the task; agent uses existing CLIs/APIs                                     |
| **Composability**         | Plugin A can't easily call Plugin B               | Agent A can delegate to Agent B (A2A)                                                |
| **Context understanding** | Gets only what the host explicitly passes         | Agent actively explores — reads nodes, understands spatial layout, queries neighbors |
| **Error recovery**        | Crash or return error code                        | Agent reasons about errors, retries, asks for clarification                          |
| **Upgrade path**          | Breaking API changes                              | Prompt evolution — backward compatible by nature                                     |
| **User customization**    | Config files, settings panels                     | "Hey agent, from now on do X instead of Y"                                           |
| **Discovery**             | Plugin marketplace, manual install                | Agent can discover and invoke other agents/tools dynamically                         |

### The Key Insight

A plugin system answers: _"What hooks do I expose?"_
An agent system answers: _"What can you read, and what can you write?"_

Huabu already has this foundation via the **Huabu Reachback Tool (HRT)**:

- **Read**: `read-node <id>` — fetch any node's content to a local file
- **Write**: `write-node --type note <file>` (create) / `write-node --id <id> <file>` (update), with `--link-to` / `--link-from` for edge creation
- **Vision**: `snapshot <id>` — rasterize sketch/image nodes to PNG for vision-capable agents
- **Semantic**: `ask-agent "<prompt>"` — delegate complex spatial/semantic queries to built-in agents with full Space context
- **Internal tools**: `get_space_outline`, `inspect_nodes`, `space_commands` (13 commands) for the built-in agent

The "plugin API" is simply: _the reachback tool_ + _whatever external tools the agent has access to_. No SDK, no hooks — just CLI commands.

---

## 2. Agent Teams as Huabu Extensions

Huabu uses **Agent Teams** as its managed external-agent extension mechanism.

- **Agent Team** — the generic agentlet packaging/runtime concept
- **Huabu-managed Agent Team** — an Agent Team packaged for Huabu workflows,
  usually bundled under `agent-teams/`

Each bundled member is dual-mode: `agentlet.yaml` keeps it independently runnable through Agent Team setup and ACP launch, while a package-root `SKILL.md` makes the same capability discoverable through standard Agent Skill installation. Both surfaces converge on the package's canonical `system_prompt.md`; the Skill contains only discovery metadata and standalone-runtime adaptation rather than a second copy of the agent procedure.

Bundled scripts, prompts, examples, and supporting documents are addressed relative to the Skill directory so installation does not preserve repository or machine-specific paths. For configured standalone Skills, the user supplies an untracked package-local `.env` following `.env.example`, and the Agent loads it for tool calls according to the runtime operating system and shell. Managed Agent Team runs do not depend on that file because the daemon injects manifest Config values into the process environment.

Repository validation discovers every bundled `agentlet.yaml` and requires a matching standards-compliant `SKILL.md`. It keeps folder, manifest, and Skill names aligned; checks trigger-oriented descriptions, the canonical prompt link, local reference resolution, and path portability; and rejects tracked secrets or generated workspaces.

The generic `agentlet.yaml` package contract and daemon execution operations are defined in the agentlet spec. Huabu currently ships one fixed Agent Team collection with the desktop application; users do not download a collection, configure a collection root, run `agentlet agent-team setup`, or register an External Agent profile.

- The Server automatically registers the bundled read-only collection after the locally supervised agentlet connects.
- Registration removes roots persisted by earlier custom-collection builds; their member metadata and Profiles remain durable but become unavailable, and Settings projects only active bundled members.
- Member Configs are shared by manifest-backed Profiles of the same package; secrets remain in the host SecretStore and are redacted from read APIs.
- Local manifest-backed Profiles default to an isolated writable directory under `<HUABU_DATA_DIR>/agent-team/workspaces/<member>/<harness>/<profile-id>` and may instead use a user-selected absolute directory. Huabu resolves either policy to the immutable `workingDirPath`; Setup prepares that directory and runtime uses it as the agent process `cwd`, so the bundled package directory is never used as the writable workspace and Profiles do not share mutable workspace state by default.
- Every non-internal agent uses one Agenetes Agent Profile. Manifest Profiles carry immutable placement, manifest, harness, and working-directory fields plus authoritative durable preparation state; command Profiles carry immutable placement, command, and working directory. Setup diagnostics are stored separately from the Profile CRD.
- Every Profile also carries an optional `customData` bag — an opaque, JSON-valued map that Agenetes persists verbatim and never interprets. Hosts use it to attach their own per-Profile data without changing the Agenetes package; Huabu stores the agent avatar (shape + color) under its `icon` key, validated only on the Huabu side.
- Declarative setup launches package-manager commands through cross-platform executable resolution, so Windows `.cmd` shims such as `npm` and `npx` work without opting into shell command construction.
- Manifest Profiles use explicit Setup, Retry, and Cancel actions. A Profile is selectable only when its member is active, required Configs are complete, and preparation is ready; command Profiles are selectable immediately.
- The Space and Huabu Reachback remain the shared workspace and read/write bridge available to running agents.

### Prerequisites

The locally supervised agentlet daemon scans and runs the bundled Agent Team packages through the Huabu server's Agenetes Gateway. In the Huabu monorepo, `pnpm install` provides the agentlet binaries used by development environments. Production Server builds bundle the daemon and its isolated Agent Team setup worker as sibling JavaScript entry points so setup does not require a runtime `node_modules` tree.

```bash
pnpm install
```

The External Agents Settings tab presents command-backed and manifest-backed Profiles in one list. Its single Add agent editor starts with an optional Template, uses one trusted Agent catalogue for both ACP recipes and manifest harness IDs, conditionally exposes member Configs, and uses the same working-directory and display-name controls for both launch kinds. Collection-root and remote-package management are not exposed.

`GET /api/acp/agent-cli` returns the complete trusted Agent catalogue in canonical order with an `installed` flag. Ordinary creation shows installed Agents first, then missing Agents in a disabled Not installed section, and keeps Custom command as the final option. A selected Preset filters that same catalogue to its manifest harness allowlist, keeps missing Agents in the same disabled section, and blocks unknown harness IDs. The selector does not embed installation commands; user documentation links to each Agent's official installation source so package changes do not stale the UI.

The `POST` create endpoint never starts Setup on its own. The Settings create action ("Create and set up") is enabled only once every required field — including the preset's required Configs — is complete, and then orchestrates Setup as a follow-up `setup` call on the newly created Profile. The unified list still owns the long-running lifecycle: it retains explicit Setup, Retry, and Cancel actions, shows preparation state alongside command-backed Profiles (which are selectable immediately), and monitors setup progress after the editor closes. If the follow-up Setup call fails, the created Profile remains and can be set up again from the list.

Chat keeps the built-in Agent separate, groups every selectable non-internal Profile under External Agents, and sends Add agent to the External Agents Settings tab rather than owning a second editor.

## 3. Architecture: Agent Connection Topology

```text
Bundled collection ── automatic local registration
       │
       ▼
Huabu Fastify adapter ── host storage + SecretStore + loopback REST
       │
       ▼
Agenetes Agent Team registry ── fixed root, members, Configs, Profiles, preparation
       │ AgentTeamControlPort
       ▼
Agenetes Agentlet Gateway ── one connected profile per daemon machine
       │ JSON-RPC over WebSocket
       ▼
agentlet daemons ── scan, setup, cancel, validate, ACP session execution
```

---

## 4. Implementation Direction

The current implementation follows these ownership boundaries:

1. **Generic packaging and execution live in agentlet** — `agentlet.yaml` and daemon-side scan/setup/validate behavior are not Huabu-specific conventions.
2. **Agenetes owns the control and runtime Profile plane** — `@agenetes/agent-team` owns durable discovery, Config metadata, the unified Profile registry, setup orchestration, availability, and Profile-to-ACP lowering; `@agenetes/agentlet-host.mountAgenetes(...)` internally composes the registry with the single Gateway instance.
3. **Huabu supplies host capabilities** — Huabu provides an absolute storage directory, the SecretStore adapter, loopback-only REST projection, and Settings UI. Huabu does not inject, select, or coordinate the Gateway.
4. **Bundled discovery follows local machine presence** — Huabu waits for the locally supervised daemon to connect, then registers and scans the fixed collection copied next to the Server bundle.
5. **Setup is explicit and durable** — Setup/Retry drives preparation, required Configs gate setup and selection, cancellation and errors remain visible, and interrupted in-flight setup reconciles to an explicit error on restart.
6. **Settings reads are redacted** — secret plaintext never crosses the Settings API; the UI can only replace or clear a secret and observe whether it is configured.
7. **Runtime snapshots are immutable** — a new external thread snapshots the selected Profile's placement and launch fields. Profile deletion blocks new bindings without changing existing threads; manifest session spawn loads current Configs and validates the prepared workspace before delegating to the ACP driver.
8. **The catalog is shared** — Agenetes computes selectable Profile IDs without loading member detail; Chat and Question Nodes consume that catalog and render every available non-internal Profile in one External Agents group.
9. **Setup diagnostics are lazy** — `<HUABU_DATA_DIR>/agent-team/registry.json` contains authoritative Profile preparation state but no setup event history. Each manifest Profile has a sibling `<encoded-profileId>.setup.jsonl` bounded to 200 phase entries. Setup and Retry truncate that file, progress appends to it without rewriting the registry, member detail loads it on demand, and Profile deletion removes it. Registry schema v3 migrates embedded schema v1/v2 logs into the sibling file.

---

## 5. The Bigger Picture: Space as OS

The ultimate vision is that the Space becomes an **operating system for thought**:

| OS Concept                  | Space Equivalent                       |
| --------------------------- | -------------------------------------- |
| Files                       | Nodes                                  |
| Folders                     | Frames                                 |
| Symlinks                    | Edges                                  |
| Processes                   | Agents                                 |
| Pipes                       | Agent-to-agent communication via Space |
| Shell                       | Question nodes / chat                  |
| Package manager             | Agent marketplace                      |
| Permissions                 | Reachback capability scoping           |
| Filesystem events (inotify) | Space change events → reactive agents  |

In a traditional OS, you don't need a "plugin" to connect `grep` to `sort` — you just pipe them. Similarly, in the agent-as-plugin model, you don't need a plugin API to connect HackMD publishing to Jira tracking — you just describe the workflow, and agents compose naturally.

**The Space is the universal data bus. Agents are the universal connectors. Natural language is the universal API.**

---

## 6. What Makes This Uniquely Powerful for Huabu

Huabu's **Space** adds a dimension that pure chat-based agent systems lack:

1. **Spatial context is semantic**: Nodes near each other are related. An agent can understand intent from position alone.
2. **Visual output**: Agents don't just return text — they create spatial arrangements that humans can scan, reorganize, and build upon.
3. **Persistent workspace**: Unlike chat (which scrolls away), canvas nodes persist. Agent outputs become part of the user's evolving knowledge base.
4. **Multi-agent visibility**: When multiple agents work on the same Space, their outputs are spatially visible and can be compared side-by-side.
5. **Human-in-the-loop naturally**: The user can rearrange agent outputs, add annotations, draw connections — the agent's next run incorporates human feedback through the spatial structure itself.

This is why "agent as the universal interface" is not just a nice idea for Huabu — it's the **natural architecture** for a spatial thinking tool. The Space was always meant to be a shared cognitive space. Agents are simply new inhabitants of that space.

---

## 7. Code entry points

| File/dir                                                                                                             | Responsibility                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`external/agenetes/packages/agent-team/`](../../external/agenetes/packages/agent-team/)                             | Durable Agent Team control-plane aggregate, unified Profile registry and driver, Config resolution, and setup state machine. |
| [`external/agenetes/packages/agentlet-gateway/`](../../external/agenetes/packages/agentlet-gateway/)                 | Connected daemon catalog and routed Agent Team control operations.                                                           |
| [`external/agenetes/packages/agentlet-host/`](../../external/agenetes/packages/agentlet-host/)                       | Agenetes composition boundary that mounts the Gateway and Agent Team registry.                                               |
| [`apps/server/src/modules/agent-team/`](../../apps/server/src/modules/agent-team/)                                   | Bundled collection registration, loopback-only REST adapter, and host capability projection.                                 |
| [`apps/server/src/modules/agent/acp/agent-cli.route.ts`](../../apps/server/src/modules/agent/acp/agent-cli.route.ts) | Loopback-only trusted Agent catalogue and host installation-state projection.                                                |
| [`packages/shared/src/types/api/agent-team.ts`](../../packages/shared/src/types/api/agent-team.ts)                   | Shared Zod wire contracts for Settings reads and mutations.                                                                  |
| [`apps/web/src/components/Settings/agent-team/`](../../apps/web/src/components/Settings/agent-team/)                 | Unified Profile list and editor, bundled-member Configs, default/custom working-directory policy, and preparation UI.        |
| [`external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md)                                 | Generic package and daemon execution contract.                                                                               |
| [`agent-teams/`](../../agent-teams)                                                                                  | Dual-mode bundled Agent Team packages and installable Skill adapters.                                                        |
| [`scripts/check-agent-team-skills.mjs`](../../scripts/check-agent-team-skills.mjs)                                   | Validate bundled Skill discovery metadata, canonical references, portability, and package hygiene.                           |
