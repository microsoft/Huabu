# Space Prompt Topology Scoping

Status: Shipped
Last updated: 2026-09-08

## Context

Issue [#160](https://github.com/microsoft/Huabu/issues/160) introduced Prompt Frames as Space-global instructions captured when an Agent Node is first realized. Issue [#166](https://github.com/microsoft/Huabu/issues/166) adds a local targeting boundary without introducing a property editor or encoding configuration in Frame labels.

The original #166 request proposed persisted `space-global` and `connected` modes. The accepted design instead derives scope from visible Canvas topology: users make a Prompt local by connecting it to Agent Nodes, and an unconnected Prompt remains global.

## Decision

A recognized Prompt Frame with no directly connected Agent Nodes applies to every Agent Node in the Space. A Prompt Frame with one or more directly connected Agent Nodes applies only to those direct Agent neighbours.

An Agent Node is a Question Node with a non-empty `threadId`. The edge may name the Prompt Frame as either source or target. Arrow direction, label, line style, color, and other EdgeStyle fields do not affect scope.

Connections to ordinary Question Nodes without a thread, Text, Note, media, Skill Frames, and other non-Agent nodes do not make a Prompt local. Scope is one hop only: Agent-to-Agent paths, connections to containing Frames, and Frame descendants are not traversed.

Scope is derived and is not persisted. There is no `promptScope` field, migration, selector, or label syntax. The Frame badge reports `Prompt · Global`, `Prompt · 1 Agent`, or `Prompt · N Agents` from the same shared direct-Agent predicate used by server delivery.

## Realization and freezing

Prompt targeting uses the existing canonical realization boundary from [external-agent-capability-cache-and-realization.md](./external-agent-capability-cache-and-realization.md).

```text
create-only Agent
  -> zero or more topology edits
  -> first explicit interaction
  -> read one current Space snapshot
  -> derive applicable Prompt Frames
  -> persist one immutable WorkloadSpec
```

Creating an Agent Node without starting it does not collect or freeze a Prompt. Creating, deleting, or restyling an edge does not realize an Agent.

A create-and-start request completes Agent creation and then immediately invokes the first message, so Prompt selection freezes in that request. A caller that needs to establish Prompt edges first must create without starting, connect the nodes, and then prompt the Agent.

For external Agents, a mode, model, or config-option control is an explicit interaction and may realize the workload before the first message. GET-only capability reads remain non-realizing. Once a workload exists, later Prompt content or topology changes do not replace its captured Prompt.

The Space record read by the resolver is the linearization snapshot. A concurrent topology edit may land before or after that read, but one compilation never combines nodes or edges from different Space versions.

## Compatibility

The persisted format is unchanged, but behavior changes for an existing Prompt Frame that already has a direct edge to an Agent Node: it becomes local to its direct Agent neighbours instead of remaining global. Prompt Frames with no direct Agent connections preserve #160 behavior.

Existing realized workloads remain unchanged because their Prompt snapshot is immutable. The new targeting behavior applies when an Agent is first realized after this change.

## Regression coverage

- Zero direct Agent neighbours and non-Agent-only connections remain global.
- One or more direct Agent neighbours restrict delivery to exactly those Agents.
- Source/target order and EdgeStyle do not affect targeting.
- Agent and Frame paths are not traversed; nested Agents require their own direct edge.
- Create-only does not invoke or realize an Agent.
- Connections added or removed before the first interaction affect the captured Prompt.
- Create-and-start collects only after creation has completed.
- First-control external realization captures current topology without consuming the preamble.
- Later topology changes and recovery reuse the frozen workload snapshot.
- The Prompt badge uses the same direct-Agent predicate and displays the derived scope.

## Code entry points

| File/dir                                                                                                                                   | Responsibility                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts)                                               | Canonical Agent Node recognition and direct Frame-to-Agent adjacency. |
| [`apps/server/src/modules/agent/space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts)             | Target-aware Prompt Frame selection and deterministic rendering.      |
| [`apps/server/src/modules/agent/agent-thread.service.ts`](../../apps/server/src/modules/agent/agent-thread.service.ts)                     | Built-in first-interaction Prompt capture.                            |
| [`apps/server/src/modules/agent/acp/external-agent-realization.ts`](../../apps/server/src/modules/agent/acp/external-agent-realization.ts) | External first-message/first-control Prompt capture.                  |
| [`apps/web/src/components/Nodes/frame/FrameNode.tsx`](../../apps/web/src/components/Nodes/frame/FrameNode.tsx)                             | Live topology-derived badge count.                                    |
| [`apps/web/src/components/Nodes/frame/InstructionFrameBadge.tsx`](../../apps/web/src/components/Nodes/frame/InstructionFrameBadge.tsx)     | Global/direct-Agent scope presentation.                               |
