---
name: sketch-gestures
description: Map freehand canvas sketch gestures (lines, loops, scribbles, "?" / "!" marks) to the canvas_commands invocations that realise them. Pipeline-only — not loaded by chat / operate / external agents.
appliesTo: [sketch]
version: 1
---

# Sketch Gestures

The host system prompt already pinned **what role you play** (executor, not narrator) and **how every turn must end** (in a tool call — prose alone is a silent no-op). This skill is purely **how to read each gesture and pick the right `canvas_commands` to invoke**.

For the canvas filesystem layout, the read / inspect / grep boundaries, and the full command catalogue, load `skills/canvas/SKILL.md` on demand.

## Where the answer comes from

The screenshot is the **primary signal**. The cluster payload only tells you _which existing nodes / edges are nearby or enclosed_ — no labels, no positions, no shape inference.

- Gesture _shape_ (line, loop, cross, "?", "!", underline, …) → from the screenshot.
- Gesture _targets_ → from the nearby / enclosed id lists.
- Gesture _meaning_ over an unfamiliar node → `read("nodes/<filename>.md")` for content (locate via `find` / `grep` if only the id is known) and `inspect_nodes({ ids: [...] })` for layout / style.

Iterate read / inspect calls as long as you need before invoking `canvas_commands`.

## Gesture → invocation

These are common patterns, not deterministic rules. Trust the screenshot.

| Gesture                                                        | Invoke                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line / arrow connecting two nodes                              | `CONNECT_NODES` with one edge. For plain lines without an arrow head, pick the direction that makes more semantic sense after inspecting node contents.                                                     |
| Circle / loop enclosing several nodes                          | `CREATE_NODES` (frame) + `SET_NODE_PARENT` for the enclosed nodes. Inspect at least one to choose a meaningful frame label.                                                                                 |
| Cross / X / scribble OVER a node                               | `DELETE_NODES` that node.                                                                                                                                                                                   |
| Cross / X / scribble OVER an edge (not over any node)          | `DISCONNECT_EDGES` that edge id (use the nearby edges list).                                                                                                                                                |
| "?" near a node                                                | `CREATE_QUESTION` about that node. Read the node first to phrase a sensible question.                                                                                                                       |
| "!" / star / underline marking a single node                   | `MERGE_NODE_DATA` with a highlight patch (e.g. `style.accent`), OR `CREATE_NODES` with a sibling note expanding on the topic. **Highlighting / marking IS the action — do not skip it as "just emphasis".** |
| Genuinely empty / ambiguous gesture, far from any node or edge | Invoke `canvas_commands` with no commands and a one-sentence reasoning. Reserved for true no-ops; default to mapping the gesture to _some_ command.                                                         |

## Rules

- **Never invent node or edge ids.** Only reference ids that appear in the cluster payload, plus ids you create in the same invocation.
- **Edge ids always start with `edge-`** and only come from the nearby edges list.
- For any newly created node, use the **cluster bbox centre** as the position. Explicit positions are honoured verbatim by `CREATE_NODES`.
- Keep `reasoning` under 20 words. It is shown to the user.
