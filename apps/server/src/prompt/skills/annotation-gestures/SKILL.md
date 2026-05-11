---
id: annotation-gestures
name: annotation-gestures
description: Convert freehand canvas annotation gestures (lines, loops, scribbles, "?" / "!" marks) into atomic canvas command batches. Pipeline-only — not loaded by chat / operate / external agents.
appliesTo: [annotation]
version: 1
---

# Annotation Gestures

You convert freehand canvas annotations into executable canvas commands. The host system prompt already gave you the input contract (screenshot + minimal cluster payload) and the JSON output contract — this skill is about **how to read the gesture and pick the right commands**.

The mental model for the canvas filesystem, the read / inspect / grep tool boundaries, and the full `canvas_commands` catalogue all live in the shared canvas skill — load it on demand: `read("skills/canvas/SKILL.md")`. Do not duplicate that knowledge here.

## Where the answer comes from

The screenshot is the **primary signal**. The cluster payload only tells you _which existing nodes / edges are nearby or enclosed_; it carries no labels, no positions, no distances, no shape inference. Concretely:

- The gesture's _shape_ (line, loop, cross, "?", "!", underline, …) → comes from looking at the screenshot.
- The gesture's _targets_ → from the nearby / enclosed ID lists in the payload.
- The gesture's _meaning_ for nodes you do not yet understand → call `read("nodes/<filename>.md")` for content (or use `find("nodes/*.md")` / `grep` if only id is known) and `inspect_nodes({ ids: [...] })` for layout / style.

You may iterate tool calls before producing the final JSON. Tool boundaries: see `skills/canvas/SKILL.md` § "Tool decision matrix".

## Gesture interpretation guidance

These are common patterns, not deterministic rules. Trust the screenshot.

- **Line / arrow connecting two nodes** → `CONNECT_NODES` with one edge. For plain lines without an arrow head, pick whichever direction makes more semantic sense after inspecting node contents.
- **Circle / loop enclosing several nodes** → `CREATE_NODES` (frame) + `SET_NODE_PARENT` for the enclosed nodes. Inspect at least one of them to choose a meaningful frame label.
- **Cross / X / scribble OVER a node** → `DELETE_NODES` that node.
- **Cross / X / scribble OVER an edge** (and not over any node) → `DISCONNECT_EDGES` that edge id (use the nearby edges list).
- **"?" near a node** → `CREATE_QUESTION` about that node. Call `read("nodes/<filename>.md")` first (or locate it via `grep`/`find`) to phrase a sensible question.
- **"!" / star / underline marking a single node** → `MERGE_NODE_DATA` with a highlight patch (e.g. `style.accent`), OR `CREATE_NODES` with a sibling note expanding on the topic.
- **Empty / ambiguous gesture far from any node or edge** → return `commands: []` with a one-sentence reasoning explaining why no action was warranted.

## Rules

- **Never invent node or edge ids.** Only reference ids that appear in the cluster payload, plus ids you create in the same batch.
- **Edge ids always start with `edge-`** and only come from the nearby edges list.
- For any newly created node, use the **cluster bbox centre** as the position and set `skipAutoLayout: true`.
- Keep `reasoning` under 20 words. It is shown to the user.

## Output reminder

When you have finished tool calls, output exactly one JSON object as your final message:

```
{
  "reasoning": "one short sentence explaining what the user intended",
  "commands": [ /* array of CanvasCommand objects, executed atomically */ ]
}
```

No leading text. No markdown fences. No trailing text. The presence of a `{`-prefixed JSON object terminates the loop — while you still want to call tools, do **not** emit a final JSON, emit a tool call.
