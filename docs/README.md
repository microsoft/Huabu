# Huabu / Huabu — Docs

Authoritative design notes and proposals for the Huabu / Huabu codebase.
For what the product is and how to run it, see the [root README](../README.md).
For agent and contributor rules, see
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md).

The desktop security-review attachment is [desktop-threat-model-attachment.md](./desktop-threat-model-attachment.md).

For **diagnosing slow or misbehaving agents** (built-in Huabu agents or external
ACP agents), see [agent-diagnosis-guide.md](./agent-diagnosis-guide.md).

---

## How this folder is organized

```
docs/
  architecture/   ← Long-lived "what exists today". The system reference.
  proposals/      ← Formally reviewed design records, active or shipped.
  backlog/        ← Uncommitted ideas that are not implementation instructions.
  archive/        ← Abandoned or superseded designs kept for history.
```

**Rules**

0. Three principles: docs **describe the current system**, are **updated in the same change as the code**, and are **written for agents to read** (concise, greppable, with clickable links).
1. `architecture/*.md` describes the **current** system. No "we plan to" prose. When a proposal ships, fold the implemented behavior into the matching architecture document.
2. Every `proposals/*.md` **must** carry a lifecycle `Status:` line near the top plus a `Last updated:` date. Shipped proposals remain at their stable paths with `Status: Shipped`; they preserve design history but do not override architecture.
3. `backlog/*.md` is non-authoritative and must carry `Status: Backlog` plus a `Last reviewed:` date. Promote a backlog idea into `proposals/` before implementation.
4. `archive/*.md` is only for abandoned or superseded designs. Link prominently to the replacement when one exists.
5. Always use `git mv` when moving or renaming files already tracked by Git.
6. Cross-link between docs with relative paths. Code references use
   `../../<path>` (because docs live two levels deep now).
7. **Consistent layout formats**: directory / disk layouts use a fenced code
   block tree with inline comments; module & code-entry lists use a markdown
   table (`| File/dir | Responsibility |`) with clickable relative links; data
   flows use a small ASCII diagram (≤10 lines). Don't mix trees and tables for
   the same purpose. Every node/architecture doc ends with a "Code entry points"
   table.

---

## Architecture — current system reference

| Doc                                                                             | What it covers                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [agent-architecture.md](./architecture/agent-architecture.md)                   | Server-side agent runtime, tools, skills, SSE protocol.                                                  |
| [agent-context.md](./architecture/agent-context.md)                             | How canvas state gets shaped into `AgentChatContext` / `IntentContext` and reaches the model.            |
| [agent-reachback.md](./architecture/agent-reachback.md)                         | Huabu Reachback Tool (HRT) — how external agents read/write the Space out-of-band.                       |
| [agent-teams-as-extensions.md](./architecture/agent-teams-as-extensions.md)     | Product/vision: managed Agent Teams as Huabu's "plugin system".                                          |
| [api-design.md](./architecture/api-design.md)                                   | **Authoritative** rules for every HTTP / SSE endpoint, zod-first wire contracts.                         |
| [canvas-command-architecture.md](./architecture/canvas-command-architecture.md) | `CanvasUiIntent` / `CanvasCommand` / `CanvasExecution` three-layer model.                                |
| [canvas-input-interactions.md](./architecture/canvas-input-interactions.md)     | Mouse, touch, and pen preference resolution, gesture ownership, and multi-touch arbitration.             |
| [canvas-zoom-rendering.md](./architecture/canvas-zoom-rendering.md)             | Node LOD, Frame/edge label readability, and interaction chrome across canvas zoom.                       |
| [canvas-storage.md](./architecture/canvas-storage.md)                           | Disk layout, aggregate Space commits, lifecycle, crash recovery, Blob/structured ports, and `.memory/`.  |
| [canvas-action-log.md](./architecture/canvas-action-log.md)                     | Persistent `events.jsonl` user-action trail; consumed by the memory curator.                             |
| [canvas-realtime-sync.md](./architecture/canvas-realtime-sync.md)               | Multi-agent real-time sync: SSE broadcast, dirty-node conflict model, per-thread change-review card.     |
| [credential-storage.md](./architecture/credential-storage.md)                   | Electron OS-protected credentials, utility-process bridge, migration, and standalone fallback.           |
| [desktop-auto-update.md](./architecture/desktop-auto-update.md)                 | Desktop auto-update: electron-updater lifecycle, env-driven update feed, required release artifacts.     |
| [desktop-startup.md](./architecture/desktop-startup.md)                         | Cold start: splash window, main-window reveal, and the first-screen bundle boundary.                     |
| [agent-memory.md](./architecture/agent-memory.md)                               | Three-layer memory (workspace / canvas / skill); **Shipped**.                                            |
| [question-node.md](./architecture/question-node.md)                             | Question node: a content node that anchors a chat thread, runs the agent with its spatial neighbourhood. |
| [node-preprocessing.md](./architecture/node-preprocessing.md)                   | Unified 6-stage preprocessing pipeline; per-node profiles decide extract / enrich / persist.             |     | [node-auto-height.md](./architecture/node-auto-height.md) | Who owns a node's height, how content height is measured, and how a derived height reaches geometry. |     | [sketch-node.md](./architecture/sketch-node.md) | Sketch nodes: data model, explicit-trigger lifecycle, and the cluster → context → vision-LLM recognition pipeline. |
| [note-node.md](./architecture/note-node.md)                                     | Note node: Markdown data model, save path, and in-document input (Tab indentation, link activation).     |
| [web-architecture.md](./architecture/web-architecture.md)                       | Frontend (`apps/web/src/`) layout, dependency rules, and conventions.                                    |

---

## Proposals — reviewed design records

> Each file's own `Status` / `Last updated` header is the source of truth.
> The column below summarises it at the time this index was written.

### Active

| Doc                                                                                                | Status            | Summary                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| [active-space-external-note-watcher.md](./proposals/active-space-external-note-watcher.md)         | Proposed          | Scope external-note watchers to Spaces with active SSE subscribers.                  |
| [agent-node-freshness-cas-plan.md](./proposals/agent-node-freshness-cas-plan.md)                   | In-Progress       | Read/write revision freshness across agent and web paths.                            |
| [canvas-checkpoint-plan.md](./proposals/canvas-checkpoint-plan.md)                                 | Proposed          | Canvas checkpoint and restoration design.                                            |
| [canvas-realtime-sync-plan.md](./proposals/canvas-realtime-sync-plan.md)                           | In-Progress       | Roadmap from multi-agent sync to multi-user co-editing.                              |
| [content-before-ai-design.md](./proposals/content-before-ai-design.md)                             | Needs review      | Block-level and inline authorship provenance.                                        |
| [credential-storage-hardening-followups.md](./proposals/credential-storage-hardening-followups.md) | Draft             | Follow-up credential storage hardening.                                              |
| [direct-space-operations.md](./proposals/direct-space-operations.md)                               | In-Progress       | #348 deterministic RFS query and mutation operations for external agents.            |
| [headless-executor-plan.md](./proposals/headless-executor-plan.md)                                 | Partly shipped    | Server-side headless canvas executor and structure/content sync.                     |
| [long-horizon-tasks.md](./proposals/long-horizon-tasks.md)                                         | Partly shipped    | Canvas-scoped recursive Agent creation, invocation, and handoff pipeline.            |
| [managed-acp-harness.md](./proposals/managed-acp-harness.md)                                       | Draft             | Resource-first Agent Team Profile compilation.                                       |
| [managed-agent-teams.md](./proposals/managed-agent-teams.md)                                       | In-Progress       | Huabu-managed discovery, configuration, preparation, and runtime.                    |
| [milkdown-custom-toolbar-plan.md](./proposals/milkdown-custom-toolbar-plan.md)                     | In-Progress       | Huabu-owned Milkdown toolbar and semantic editor commands.                           |
| [model-role-routing.md](./proposals/model-role-routing.md)                                         | Proposed          | Model selection by runtime role.                                                     |
| [multi-backend-storage.md](./proposals/multi-backend-storage.md)                                   | P1–P4 implemented | Blob split, async structured reads, aggregate commits, lifecycle, and Disk recovery. |
| [note-auto-height-stable-geometry.md](./proposals/note-auto-height-stable-geometry.md)             | Proposed          | Revision-aware offscreen Note measurement and stable auto-height geometry.           |

### Shipped

| Doc                                                                                                  | Summary                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [agent-reachback-rfs.md](./proposals/agent-reachback-rfs.md)                                         | Canvas-scoped RFS file plane, ask-agent control plane, and skill bootstrap.                          |
| [agenetes-agentlet-gateway-consolidation.md](./proposals/agenetes-agentlet-gateway-consolidation.md) | Agenetes-owned stateless Agentlet Gateway and ACP placement.                                         |
| [agenetes-thread-rehydration-and-forking.md](./proposals/agenetes-thread-rehydration-and-forking.md) | Durable-thread recovery and driver-owned rehydration.                                                |
| [agent-request-render-resolution.md](./proposals/agent-request-render-resolution.md)                 | Generic agent submission and input boundary.                                                         |
| [canvas-pointer-router.md](./proposals/canvas-pointer-router.md)                                     | Unified pointer routing and recognizer takeover priority.                                            |
| [layered-architecture.md](./proposals/layered-architecture.md)                                       | Interaction-, protocol-, and task-driven architecture layers.                                        |
| [node-write-unification-plan.md](./proposals/node-write-unification-plan.md)                         | Unified authored-content persistence and revision handling.                                          |
| [world-canvas.md](./proposals/world-canvas.md)                                                       | Workspace-level World Canvas, project Portals, pinned references, and headless source conversations. |
| [pi-harness-driver-refactor-plan.md](./proposals/pi-harness-driver-refactor-plan.md)                 | Agenetes harness driver boundary.                                                                    |
| [question-node-zoom-lod-avatar.md](./proposals/question-node-zoom-lod-avatar.md)                     | Continuous zoom takeover: question node's agent mark stands in at deep zoom.                         |
| [unified-external-agent-settings.md](./proposals/unified-external-agent-settings.md)                 | Unified command-backed and manifest-backed Agent Profiles.                                           |

When a proposal ships, set `Status: Shipped`, record the merge PR or commit, update the corresponding architecture document, and retain the proposal's stable path.

---

## Backlog

Backlog documents are preserved discussion material, not approved implementation guidance.

| Doc                                                  | Summary                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| [huabu-cli-design.md](./backlog/huabu-cli-design.md) | Early CLI/MCP exploration whose CLI-first assumptions predate #348. |

---

## Archive

Archive contains only abandoned or superseded designs.

| Doc                                                                          | Status     | Summary                                                                                         |
| ---------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| [acp-eventstore-refactor-plan.md](./archive/acp-eventstore-refactor-plan.md) | Superseded | Earlier EventStore adaptation replaced by Gateway-owned live buffering and Agenetes durability. |
| [agent-reachback.md](./archive/agent-reachback.md)                           | Superseded | Removed HRT `.mjs` node-CRUD reachback design.                                                  |
| [agentlet-upgrade-plan.md](./archive/agentlet-upgrade-plan.md)               | Superseded | Earlier split-hello migration absorbed by the Gateway consolidation.                            |

---

## Reading order for new contributors / agents

1. [root README](../README.md) — what Huabu is.
2. [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) — non-negotiable rules (API design, button/color tokens, subtree commits).
3. [architecture/agent-architecture.md](./architecture/agent-architecture.md) — how the agent loop, tools, and skills fit together.
4. [architecture/canvas-storage.md](./architecture/canvas-storage.md) + [architecture/canvas-command-architecture.md](./architecture/canvas-command-architecture.md) — the canvas data model.
5. [architecture/api-design.md](./architecture/api-design.md) — every HTTP / SSE boundary follows this.
6. Specific docs in `architecture/` as you touch the relevant area.

For agent-team / external-agent work also read
[`external/agentlet/spec/`](../external/agentlet/spec) and
[`agent-teams/README.md`](../agent-teams/README.md).
