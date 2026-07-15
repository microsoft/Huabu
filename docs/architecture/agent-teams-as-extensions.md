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

The generic `agentlet.yaml` package contract and daemon execution operations are defined in the agentlet spec. The user downloads an Agent Team collection onto a daemon host and then manages it from Huabu; the user does not run `agentlet agent-team setup` or register an External Agent profile.

- Settings discovers packages from user-selected collection roots on connected agentlet daemons.
- Member Configs are shared by manifest-backed Profiles of the same package; secrets remain in the host SecretStore and are redacted from read APIs.
- Every non-internal agent uses one Agenetes Agent Profile. Manifest Profiles carry immutable placement, manifest, harness, and working-directory fields plus authoritative durable preparation state; command Profiles carry immutable placement, command, and working directory. Setup diagnostics are stored separately from the Profile CRD.
- Manifest Profiles use explicit Setup, Retry, and Cancel actions. A Profile is selectable only when its member is active, required Configs are complete, and preparation is ready; command Profiles are selectable immediately.
- The Space and Huabu Reachback remain the shared workspace and read/write bridge available to running agents.

### Prerequisites

Each machine that hosts Agent Team packages runs an agentlet daemon connected to the Huabu server's Agenetes Gateway. In the Sediment monorepo, `pnpm install` provides the agentlet binaries used by development environments.

```bash
pnpm install
```

The Agent Teams Settings tab lists connected daemon machines. It identifies the locally supervised daemon explicitly, defaults root creation to that machine, and exposes the native folder picker only for that local machine. Remote roots remain editable as absolute daemon-host paths and are validated by daemon-side scan.

## 3. Architecture: Agent Connection Topology

```text
Huabu Settings UI
       │ loopback REST
       ▼
Huabu Fastify adapter ── host storage + SecretStore
       │
       ▼
Agenetes Agent Team registry ── durable roots, members, Configs, Profiles, preparation
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
4. **Machine presence is sampled live** — the Gateway projects connected daemon profiles through `AgentTeamControlPort`; each Agent Team Settings overview read returns the currently connected machines.
5. **Setup is explicit and durable** — Setup/Retry drives preparation, required Configs gate setup and selection, cancellation and errors remain visible, and interrupted in-flight setup reconciles to an explicit error on restart.
6. **Settings reads are redacted** — secret plaintext never crosses the Settings API; the UI can only replace or clear a secret and observe whether it is configured.
7. **Runtime snapshots are immutable** — a new external thread snapshots the selected Profile's placement and launch fields. Profile deletion blocks new bindings without changing existing threads; manifest session spawn loads current Configs and validates the prepared workspace before delegating to the ACP driver.
8. **The catalog is shared** — Agenetes computes selectable Profile IDs without loading member detail; Chat and Question Nodes consume that catalog and render ready manifest Profiles under Agent Teams and command Profiles under External Agents.
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

| File/dir                                                                                             | Responsibility                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`external/agenetes/packages/agent-team/`](../../external/agenetes/packages/agent-team/)             | Durable Agent Team control-plane aggregate, unified Profile registry and driver, Config resolution, and setup state machine. |
| [`external/agenetes/packages/agentlet-gateway/`](../../external/agenetes/packages/agentlet-gateway/) | Connected daemon catalog and routed Agent Team control operations.                                                           |
| [`external/agenetes/packages/agentlet-host/`](../../external/agenetes/packages/agentlet-host/)       | Agenetes composition boundary that mounts the Gateway and Agent Team registry.                                               |
| [`apps/server/src/modules/agent-team/`](../../apps/server/src/modules/agent-team/)                   | Loopback-only REST adapter and host capability projection.                                                                   |
| [`packages/shared/src/types/api/agent-team.ts`](../../packages/shared/src/types/api/agent-team.ts)   | Shared Zod wire contracts for Settings reads and mutations.                                                                  |
| [`apps/web/src/components/Settings/agent-team/`](../../apps/web/src/components/Settings/agent-team/) | Roots, lazy member detail, Configs, manifest Profiles, preparation status, and live synchronization UI.                      |
| [`external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md)                 | Generic package and daemon execution contract.                                                                               |
