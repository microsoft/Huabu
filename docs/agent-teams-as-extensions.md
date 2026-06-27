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

The generic mechanics — `agentlet.yaml`, `agent-setup.mjs`,
`@agentlet/agent-team-runtime`, and `workspaces/` — are
defined in the agentlet spec. Users set up packages themselves
(`node agent-setup.mjs unpack`); Huabu sends `{ agent_dir, harness }` to the
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
# postinstall adds bin/agentlet to PATH
# @agentlet/agent-team-runtime is resolvable via pnpm workspace
```

After that, any bundled agent-team can be set up with:

```bash
cd agent-teams/<team-name>
node agent-setup.mjs unpack --harness claude
```

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

## 4. Example Gallery: Agent-as-Plugin Scenarios

### 4.1 Publishing Agent — "Sync to HackMD"

**Scenario**: User has a collection of markdown notes on the canvas. They want to publish selected ones to HackMD.

**How it works**:
1. User selects nodes on canvas, opens external agent chat
2. Types: "Publish these notes to HackMD as a single document"
3. Agent uses **reachback** to read each node's full content (`read-node <id>` → saves to local file)
4. Agent understands the spatial layout (via `ask-agent "describe the layout of these nodes"`)
5. Agent assembles a coherent markdown document, respecting the canvas topology
6. Agent uses `hackmd-cli` (or HackMD API directly) to create/update the note
7. Agent **writes back** via `write-node --type note --link-to <original-id> result.md`

```
Canvas:                          HackMD:
┌─────────────────┐              ┌──────────────────────┐
│ Frame: "Blog"   │    agent     │ hackmd.io/@user/blog  │
│  [Intro]        │ ──────────►  │                       │
│  [Chapter 1]    │              │ # My Blog Post        │
│  [Chapter 2]    │              │ ## Introduction ...    │
│  [Conclusion]   │              │ ## Chapter 1 ...      │
└─────────────────┘              └──────────────────────┘
        │
  [📎 Published to HackMD]  ◄── agent writes back
  [URL: hackmd.io/...]
  [Last sync: 2026-06-26]
```

**Agent implementation**: A simple agent wrapper around `hackmd-cli` or the HackMD API. The agent:
- Has `hackmd-cli` installed in its environment
- Uses reachback to read canvas nodes
- Maintains sync state (could be stored in a `.artifacts/hackmd-sync.json`)
- Can do incremental updates on subsequent invocations

**Why this is better than a plugin**: No HackMD-specific plugin API needed. Tomorrow, the user says "also publish to Medium" — same agent pattern, different CLI tool. The agent handles format differences, API quirks, error recovery.

---

### 4.2 Research Agent — "Deep Dive with Citations"

**Scenario**: User has a topic node. They want deep research with sources.

**How it works**:
1. User writes a question node: "What are the latest advances in protein folding?"
2. External agent (e.g., a research-focused agent with web access) receives the context
3. Agent uses web search tools, academic APIs (Semantic Scholar, arXiv), reads papers
4. Agent writes back multiple nodes to the canvas:
   - Summary node connected to the question
   - Individual citation nodes (each linked to source URL)
   - A "methodology comparison" frame with structured notes
5. All nodes are spatially organized relative to the question

```
                    [Question: protein folding?]
                           │
              ┌────────────┼────────────────┐
              │            │                │
     [AlphaFold3]    [RoseTTAFold]    [ESMFold]
     arxiv:2401...   nature:2024...   science:...
              │            │                │
              └────────┬───┘                │
                       │                    │
               [Comparison Table]    [Open Problems]
```

**Why this is better than a plugin**: A "research plugin" would need a rigid data model for citations, a UI for results, API integrations for each academic source. An agent just... does research. It adapts to what it finds. It can decide to create 3 nodes or 30, to add a comparison table or not, based on what it discovers.

---

### 4.3 Code Execution Agent — "Run My Code"

**Scenario**: User has pseudocode or real code in a note node. They want to execute it and see results.

**How it works**:
1. User selects a code node, sends to external agent (Claude Code / Copilot CLI)
2. Agent reads the code via reachback
3. Agent writes the code to a temporary file, executes it
4. Agent writes results back as a new node connected to the code node:
   - Output/result node
   - Error node (if failed, with fix suggestions)
   - Visualization node (if the code produces charts/images)

```
[Code: fibonacci.py]  ────►  [Output: 1, 1, 2, 3, 5, 8, ...]
       │
       └──── [Agent: fixed import error, re-ran successfully]
```

**Extension — Notebook-like experience**:
- Frame = "notebook", child nodes = "cells"
- Agent executes cells in order, maintaining state
- Results appear as connected nodes below each cell
- This is a Jupyter notebook... built from canvas primitives + an agent

---

### 4.4 Project Management Agent — "Canvas → Jira/Linear"

**Scenario**: User plans a project on canvas using frames and notes. They want to sync this to their project management tool.

**How it works**:
1. User organizes nodes in frames: "Sprint 1", "Sprint 2", "Backlog"
2. External agent reads the canvas structure via reachback
3. Agent maps: Frame → Epic, Note → Ticket, Edge → Dependency
4. Agent uses `jira-cli` or Linear API to create/update issues
5. Agent writes back ticket IDs and statuses as node metadata
6. On subsequent runs, agent syncs bidirectionally: status changes in Jira update node labels on canvas

```
Canvas:                          Jira:
┌─────────────────┐              ┌──────────────────────┐
│ Sprint 1        │              │ Sprint 1 (Active)     │
│  [Auth System]──┤─────sync────►│  AUTH-101: Auth System│
│  [User API]     │              │  AUTH-102: User API   │
│       │         │              │    blocked by AUTH-101│
│       ▼         │              └──────────────────────┘
│  [Dashboard]    │
└─────────────────┘
```

---

### 4.5 Design System Agent — "Figma ↔ Canvas"

**Scenario**: Designer exports Figma frames; agent imports them as image + annotation nodes, maintaining the design hierarchy.

**How it works**:
1. Agent has Figma API access
2. Reads a Figma file URL from a canvas node
3. Exports each frame as PNG, creates image nodes
4. Adds annotation notes extracted from Figma comments
5. Preserves hierarchy: Figma pages → Huabu frames, Figma frames → child image nodes

---

### 4.6 Knowledge Graph Agent — "Connect the Dots"

**Scenario**: User has many disparate notes. Agent reads them all, identifies relationships, and creates edges + summary nodes.

**How it works**:
1. Agent reads all nodes via `get_canvas_outline` + batch `read-node`
2. Uses NLP/embeddings to find semantic relationships
3. Creates edges between related nodes
4. Creates "bridge" summary nodes that explain connections
5. Suggests spatial reorganization (move related nodes closer)

---

### 4.7 Data Pipeline Agent — "CSV → Canvas Intelligence"

**Scenario**: User uploads a CSV. Agent analyzes it and creates a data exploration canvas.

**How it works**:
1. Agent reads the CSV from the node content
2. Runs analysis: distributions, correlations, outliers
3. Creates a structured exploration:
   - Summary statistics node
   - Key findings frame with individual insight nodes
   - Chart images (generated via matplotlib/plotly)
   - Recommended next analysis steps

---

### 4.8 Meeting Notes Agent — "Record → Canvas"

**Scenario**: User has a meeting recording (audio node). Agent transcribes and structures it.

**How it works**:
1. Agent reads audio file reference from node
2. Uses Whisper or similar for transcription
3. Creates structured output:
   - Full transcript node
   - Key decisions frame
   - Action items (each as a note, assigned to people)
   - Follow-up questions
4. Connects action items to existing project nodes on the canvas

---

### 4.9 Version Control Agent — "Canvas History"

**Scenario**: User wants to snapshot the current canvas state, compare with previous versions, or branch their thinking.

**How it works**:
1. Agent reads the full canvas via reachback
2. Uses `git` to commit the canvas state
3. Can show diffs between versions as canvas annotations
4. Can "branch" thinking: duplicate a frame, let the user explore alternatives

---

### 4.10 Multi-Agent Orchestration — "Agent Teams"

**Scenario**: Complex task requiring multiple specialized agents working together.

**How it works**:
1. User describes a complex goal in a question node
2. An "orchestrator" agent reads it and decomposes into subtasks
3. Each subtask is assigned to a specialized agent:
   - Research agent gathers information
   - Code agent implements prototypes
   - Design agent creates mockups
   - Writing agent produces documentation
4. Each agent writes to its own frame on the canvas
5. Orchestrator agent monitors progress and creates synthesis nodes

```
[Goal: Build MVP for idea X]
         │
    [Orchestrator Agent]
         │
    ┌────┼────┬─────────┐
    │    │    │         │
 [Research] [Code]  [Design]  [Docs]
  Frame     Frame    Frame    Frame
```

---

## 5. Implementation Direction

Huabu's current direction is:

1. **Generic packaging lives in agentlet** — the source of truth is the Agent
   Team spec, not Huabu-specific ad hoc conventions.
2. **Bundled examples live in `agent-teams/`** — Huabu ships concrete managed
   teams like `hackmd-publisher`.
3. **Setup is explicit** — users unpack an Agent Team package before runtime
   launch.
4. **Per-team setup uses shared runtime primitives** — common setup logic lives
   in `@agentlet/agent-team-runtime`, while each package provides only
   team-specific callbacks.
5. **Huabu focuses on product UX** — discovery, selection, launch, and canvas
   integration, rather than inventing a separate extension protocol.

Longer term, Huabu can still grow:

- marketplace-like discovery of Agent Teams
- canvas-scoped or always-on teams
- reactive/event-driven teams
- teams that compose other teams

---

## 6. The Bigger Picture: Canvas as OS

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

## 7. What Makes This Uniquely Powerful for Huabu

Huabu's **spatial canvas** adds a dimension that pure chat-based agent systems lack:

1. **Spatial context is semantic**: Nodes near each other are related. An agent can understand intent from position alone.
2. **Visual output**: Agents don't just return text — they create spatial arrangements that humans can scan, reorganize, and build upon.
3. **Persistent workspace**: Unlike chat (which scrolls away), canvas nodes persist. Agent outputs become part of the user's evolving knowledge base.
4. **Multi-agent visibility**: When multiple agents work on the same canvas, their outputs are spatially visible and can be compared side-by-side.
5. **Human-in-the-loop naturally**: The user can rearrange agent outputs, add annotations, draw connections — the agent's next run incorporates human feedback through the spatial structure itself.

This is why "agent as the universal interface" is not just a nice idea for Huabu — it's the **natural architecture** for a spatial thinking tool. The canvas was always meant to be a shared cognitive space. Agents are simply new inhabitants of that space.

---

## 8. Immediate Next Steps

1. **Pick 2-3 concrete examples** to implement as working agent templates
2. **Keep the generic mechanics in the agentlet spec** and avoid duplicating the
   package/runtime contract in Huabu docs
3. **Build the first example**: HackMD publisher or GitHub Issues sync
4. **Document the Huabu authoring pattern** on top of the generic Agent Team
   model
5. **Explore `ask-agent` composition**: external agents delegating spatial
   reasoning to built-in agents via reachback

---

*This document is a living vision. The examples above are meant to inspire and demonstrate the pattern, not to prescribe a fixed roadmap. The beauty of the agent-as-plugin model is that we don't need to anticipate every use case — we just need to make the read/write interface rich enough, and agents will fill the gaps.*
