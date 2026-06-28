# Huabu Managed Agent Teams — Vision & Examples

> **Core thesis**: In the AI/Agent era, **the agent IS the plugin system**. Instead of designing extension points, hooks, event buses, and SDK APIs — you connect an agent. The agent reads context, reasons about intent, uses whatever tools exist in its environment (CLIs, APIs, SDKs), and writes results back. This is fundamentally more powerful than any plugin system because the interface is *natural language* + *tool use* — infinitely flexible, self-describing, and composable.

This document is the **Huabu product/vision layer** for Agent Teams. The
generic packaging/runtime model lives in
[`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md).
Huabu's bundled teams live under [`agent-teams/`](../agent-teams/).

---

## 1. Why Agent > Plugin

| Dimension | Traditional Plugin | Agent-as-Plugin |
|---|---|---|
| **Interface contract** | Rigid API: hooks, lifecycle events, typed schemas | Natural language prompt + reachback tools |
| **Integration cost** | Write adapter code per plugin API | Describe the task; agent uses existing CLIs/APIs |
| **Composability** | Plugin A can't easily call Plugin B | Agent A can delegate to Agent B (A2A) |
| **Context understanding** | Gets only what the host explicitly passes | Agent actively explores — reads nodes, understands spatial layout, queries neighbors |
| **Error recovery** | Crash or return error code | Agent reasons about errors, retries, asks for clarification |
| **Upgrade path** | Breaking API changes | Prompt evolution — backward compatible by nature |
| **User customization** | Config files, settings panels | "Hey agent, from now on do X instead of Y" |
| **Discovery** | Plugin marketplace, manual install | Agent can discover and invoke other agents/tools dynamically |

### The Key Insight

A plugin system answers: *"What hooks do I expose?"*
An agent system answers: *"What can you read, and what can you write?"*

Huabu already has this foundation via the **Huabu Reachback Tool (HRT)**:
- **Read**: `read-node <id>` — fetch any node's content to a local file
- **Write**: `write-node --type note <file>` (create) / `write-node --id <id> <file>` (update), with `--link-to` / `--link-from` for edge creation
- **Vision**: `snapshot <id>` — rasterize sketch/image nodes to PNG for vision-capable agents
- **Semantic**: `ask-agent "<prompt>"` — delegate complex spatial/semantic queries to built-in agents with full canvas context
- **Internal tools**: `get_canvas_outline`, `inspect_nodes`, `canvas_commands` (14 commands) for the built-in agent

The "plugin API" is simply: *the reachback tool* + *whatever external tools the agent has access to*. No SDK, no hooks — just CLI commands.

---

## 2. Agent Teams as Huabu Extensions

Huabu uses **Agent Teams** as its managed external-agent extension mechanism.

- **Agent Team** — the generic agentlet packaging/runtime concept
- **Huabu-managed Agent Team** — an Agent Team packaged for Huabu workflows,
  usually bundled under `agent-teams/`

The generic mechanics — `agentlet.yaml`, the `agentlet agent-team` setup CLI,
`@agentlet/agent-team`, and `workspaces/` — are
defined in the agentlet spec. Users set up packages themselves
(`agentlet agent-team setup`); Huabu sends `{ agent_dir, harness }` to the
agentlet daemon, which resolves the manifest and spawns from the prepared
workspace. Huabu builds on that foundation and contributes:

- the canvas as the shared workspace
- Huabu Reachback as the read/write bridge
- product-level UX for discovery, selection, and launch
- bundled examples such as `hackmd-publisher`

### Prerequisites

Agent Teams require **agentlet** installed on the machine. In the Sediment
monorepo, this is handled automatically:

```bash
pnpm install
# postinstall adds the bin/ wrappers (agentlet + start-agentlet-daemon) to PATH
# @agentlet/agent-team is resolvable via pnpm workspace
```

After that, any bundled agent-team can be set up by running the command from
inside its folder:

```bash
cd agent-teams/<team-name>
agentlet agent-team setup --harness claude
```

> The global `agentlet` command forwards straight to the CLI (both
> `agentlet daemon …` and `agentlet agent-team …`). `start-agentlet-daemon`
> is a separate convenience that autofills `--server`/`--allow-insecure`
> from the repo's `.env` for the manual daemon self-spawn scenario.

No additional global installs are needed beyond `pnpm install` at the repo root.

## 3. Architecture: Agent Connection Topology

```
                    ┌─────────────────────────────────────┐
                    │         Huabu Canvas                 │
                    │                                      │
                    │   [Note] ── [Note] ── [Frame]        │
                    │      │                   │           │
                    │   [Question]          [Note]         │
                    │                                      │
                    └──────────┬──────────────────────────┘
                               │
                    ┌──────────┴──────────────────────────┐
                    │      Huabu Server                    │
                    │  ┌─────────────────────────────┐    │
                    │  │  Internal Agent (ask/operate) │    │
                    │  │  Canvas tools + Skills        │    │
                    │  └─────────────────────────────┘    │
                    │  ┌─────────────────────────────┐    │
                    │  │  Agentlet Bridge (ACP/WSS)    │    │
                    │  └──────┬──────────────────────┘    │
                    └─────────┼───────────────────────────┘
                              │
              ┌───────────────┼───────────────────────┐
              │               │                       │
     ┌────────▼──────┐ ┌─────▼───────┐  ┌───────────▼──────────┐
     │ Claude Code    │ │ Copilot CLI │  │ Custom Agent          │
     │ (full IDE)     │ │ (code tasks)│  │ (domain-specific)     │
     │                │ │             │  │                       │
     │ ┌────────────┐ │ │ ┌─────────┐│  │ ┌───────────────────┐ │
     │ │ git, npm,  │ │ │ │ gh CLI  ││  │ │ hackmd-cli        │ │
     │ │ docker,    │ │ │ │ az CLI  ││  │ │ notion-sdk        │ │
     │ │ terraform  │ │ │ │ ...     ││  │ │ slack-api          │ │
     │ └────────────┘ │ │ └─────────┘│  │ │ jira-cli           │ │
     └────────────────┘ └────────────┘  │ │ custom-scripts     │ │
                                        │ └───────────────────┘ │
                                        └──────────────────────┘
```

---

## 4. Implementation Direction

Huabu's current direction is:

1. **Generic packaging lives in agentlet** — the source of truth is the Agent
   Team spec, not Huabu-specific ad hoc conventions.
2. **Bundled examples live in `agent-teams/`** — Huabu ships concrete managed
   teams like `hackmd-publisher`.
3. **Setup is explicit** — users unpack an Agent Team package before runtime
   launch.
4. **Per-team setup uses shared runtime primitives** — common setup logic lives
   in `@agentlet/agent-team`, while each package provides only
   team-specific callbacks.
5. **Huabu focuses on product UX** — discovery, selection, launch, and canvas
   integration, rather than inventing a separate extension protocol.

Longer term, Huabu can still grow:

- marketplace-like discovery of Agent Teams
- canvas-scoped or always-on teams
- reactive/event-driven teams
- teams that compose other teams

---

## 5. The Bigger Picture: Canvas as OS

The ultimate vision is that the canvas becomes an **operating system for thought**:

| OS Concept | Canvas Equivalent |
|---|---|
| Files | Nodes |
| Folders | Frames |
| Symlinks | Edges |
| Processes | Agents |
| Pipes | Agent-to-agent communication via canvas |
| Shell | Question nodes / chat |
| Package manager | Agent marketplace |
| Permissions | Reachback capability scoping |
| Filesystem events (inotify) | Canvas change events → reactive agents |

In a traditional OS, you don't need a "plugin" to connect `grep` to `sort` — you just pipe them. Similarly, in the agent-as-plugin model, you don't need a plugin API to connect HackMD publishing to Jira tracking — you just describe the workflow, and agents compose naturally.

**The canvas is the universal data bus. Agents are the universal connectors. Natural language is the universal API.**

---

## 6. What Makes This Uniquely Powerful for Huabu

Huabu's **spatial canvas** adds a dimension that pure chat-based agent systems lack:

1. **Spatial context is semantic**: Nodes near each other are related. An agent can understand intent from position alone.
2. **Visual output**: Agents don't just return text — they create spatial arrangements that humans can scan, reorganize, and build upon.
3. **Persistent workspace**: Unlike chat (which scrolls away), canvas nodes persist. Agent outputs become part of the user's evolving knowledge base.
4. **Multi-agent visibility**: When multiple agents work on the same canvas, their outputs are spatially visible and can be compared side-by-side.
5. **Human-in-the-loop naturally**: The user can rearrange agent outputs, add annotations, draw connections — the agent's next run incorporates human feedback through the spatial structure itself.

This is why "agent as the universal interface" is not just a nice idea for Huabu — it's the **natural architecture** for a spatial thinking tool. The canvas was always meant to be a shared cognitive space. Agents are simply new inhabitants of that space.

---

## 7. Immediate Next Steps

1. **Pick 2-3 concrete examples** to implement as working agent templates
2. **Keep the generic mechanics in the agentlet spec** and avoid duplicating the
   package/runtime contract in Huabu docs
3. **Build the first example**: HackMD publisher or GitHub Issues sync
4. **Document the Huabu authoring pattern** on top of the generic Agent Team
   model
5. **Explore `ask-agent` composition**: external agents delegating spatial
   reasoning to built-in agents via reachback

---

*This document is a living vision. Concrete examples live in [`agent-teams/`](../agent-teams/) as working implementations. The beauty of the agent-as-plugin model is that we don't need to anticipate every use case — we just need to make the read/write interface rich enough, and agents will fill the gaps.*
