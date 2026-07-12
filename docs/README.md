# Sediment / Huabu — Docs

Authoritative design notes and proposals for the Sediment / Huabu codebase.
For what the product is and how to run it, see the [root README](../README.md).
For agent and contributor rules, see
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md).

For **diagnosing slow or misbehaving agents** (built-in Huabu agents or external
ACP agents), see [agent-diagnosis-guide.md](./agent-diagnosis-guide.md).

---

## How this folder is organized

```
docs/
  architecture/   ← Long-lived "what exists today". The system reference.
  proposals/      ← In-flight design / refactor plans. Each has a Status header.
  archive/        ← Shipped or superseded proposals, kept for history.
  user-guide/     ← End-user facing guides + changelog.
```

**Rules**

0. Three principles: docs **describe the current system**, are **updated in the same change as the code**, and are **written for agents to read** (concise, greppable, with clickable links).
1. `architecture/*.md` describes the **current** system. No "we plan to" prose.
   When a proposal ships, fold the lasting design into the matching
   `architecture/*.md` and move (or delete) the original proposal.
2. Every `proposals/*.md` **must** carry a `Status:` line in its first 10 lines
   (`Draft` · `Planning` · `In-Progress` · `Shipped` · `Superseded`) plus a
   `Last updated:` date.
3. When a proposal is fully shipped: either fold it into `architecture/` or
   `git mv` it into `archive/`. Never leave a stale plan in `proposals/`.
4. Cross-link between docs with relative paths. Code references use
   `../../<path>` (because docs live two levels deep now).
5. **Consistent layout formats**: directory / disk layouts use a fenced code
   block tree with inline comments; module & code-entry lists use a markdown
   table (`| File/dir | Responsibility |`) with clickable relative links; data
   flows use a small ASCII diagram (≤10 lines). Don't mix trees and tables for
   the same purpose. Every node/architecture doc ends with a "Code entry points"
   table.

---

## Architecture — current system reference

| Doc                                                                             | What it covers                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [agent-architecture.md](./architecture/agent-architecture.md)                   | Server-side agent runtime, tools, skills, SSE protocol.                                                            |
| [agent-context.md](./architecture/agent-context.md)                             | How canvas state gets shaped into `AgentChatContext` / `IntentContext` and reaches the model.                      |
| [agent-reachback.md](./architecture/agent-reachback.md)                         | Huabu Reachback Tool (HRT) — how external agents read/write the canvas out-of-band.                                |
| [agent-teams-as-extensions.md](./architecture/agent-teams-as-extensions.md)     | Product/vision: managed Agent Teams as Huabu's "plugin system".                                                    |
| [api-design.md](./architecture/api-design.md)                                   | **Authoritative** rules for every HTTP / SSE endpoint, zod-first wire contracts.                                   |
| [canvas-command-architecture.md](./architecture/canvas-command-architecture.md) | `CanvasUiIntent` / `CanvasCommand` / `CanvasExecution` three-layer model.                                          |
| [canvas-storage.md](./architecture/canvas-storage.md)                           | On-disk layout of a canvas (`canvas.json`, `nodes/`, `.artifacts/`, `memory/`).                                    |
| [canvas-action-log.md](./architecture/canvas-action-log.md)                     | Persistent `events.jsonl` user-action trail; consumed by the memory curator.                                       |
| [canvas-realtime-sync.md](./architecture/canvas-realtime-sync.md)               | Multi-agent real-time sync: SSE broadcast, dirty-node conflict model, per-thread change-review card.               |
| [credential-storage.md](./architecture/credential-storage.md)                   | Electron OS-protected credentials, utility-process bridge, migration, and standalone fallback.                     |
| [agent-memory.md](./architecture/agent-memory.md)                               | Three-layer memory (workspace / canvas / skill); **Shipped**.                                                      |
| [question-node.md](./architecture/question-node.md)                             | Question node: a content node that anchors a chat thread, runs the agent with its spatial neighbourhood.           |
| [node-preprocessing.md](./architecture/node-preprocessing.md)                   | Unified 6-stage preprocessing pipeline; per-node profiles decide extract / enrich / persist.                       |
| [sketch-node.md](./architecture/sketch-node.md)                                 | Sketch nodes: data model, explicit-trigger lifecycle, and the cluster → context → vision-LLM recognition pipeline. |
| [web-architecture.md](./architecture/web-architecture.md)                       | Frontend (`apps/web/src/`) layout, dependency rules, and conventions.                                              |

---

## Proposals — in-flight design & refactor plans

> Each file's own `Status` / `Last updated` header is the source of truth.
> The column below summarises it at the time this index was written.

| Doc                                                                                                  | Status                                          | Summary                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [acp-eventstore-refactor-plan.md](./proposals/acp-eventstore-refactor-plan.md)                       | Plan                                            | Collapse the duplicated ACP init/session layers so daemon EventStore sees the same `sessionId` as Huabu's prompt traffic.      |
| [agent-request-render-resolution.md](./proposals/agent-request-render-resolution.md)                 | Draft                                           | Persist source requests and ordered canonical harness inputs together through an explicit `AgentSubmission`.                   |
| [agentlet-upgrade-plan.md](./proposals/agentlet-upgrade-plan.md)                                     | Planning                                        | Upgrade Sediment's embedded agentlet to the new `agentlet/hello` + `agent/hello` split protocol.                               |
| [canvas-realtime-sync-plan.md](./proposals/canvas-realtime-sync-plan.md)                             | In-Progress (P0+P1 shipped)                     | Roadmap from multi-agent sync to multi-user co-editing; shipped foundation folded into `architecture/canvas-realtime-sync.md`. |
| [content-before-ai-design.md](./proposals/content-before-ai-design.md)                               | Unknown — needs owner review                    | Block-level provenance (AI vs user authorship) + inline word-level diff bars per block.                                        |
| [headless-executor-plan.md](./proposals/headless-executor-plan.md)                                   | Partly shipped (M2 referenced from `canvas.ts`) | Server-side headless canvas executor + structure/content sync split.                                                           |
| [huabu-cli-design.md](./proposals/huabu-cli-design.md)                                               | Draft                                           | `huabu` CLI + MCP server so any agent can read/write canvases without a custom adapter.                                        |
| [layered-architecture.md](./proposals/layered-architecture.md)                                       | Draft                                           | Three-layer model — Interaction-driven (HAI) / Protocol-driven (Agent-as-a-Local-Service) / Task-driven (Task Automation).     |
| [milkdown-custom-toolbar-plan.md](./proposals/milkdown-custom-toolbar-plan.md)                       | Draft                                           | Replace Crepe's built-in Milkdown toolbar with a Sediment-owned React toolbar and semantic editor command API.                 |
| [agenetes-thread-rehydration-and-forking.md](./proposals/agenetes-thread-rehydration-and-forking.md) | Completed                                       | Agenetes-managed recovery and thread forking as one durable-thread realization model across drivers.                           |

When you ship one of these, edit it to add `Status: Shipped` + the merge
commit/PR, and either fold lasting parts into the matching
`architecture/*.md` or move the whole file with `git mv` into `archive/`.

---

## Archive

Shipped or superseded proposals end up under [archive/](./archive/) so
`grep` against `proposals/` only returns work that's actually in flight.

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
