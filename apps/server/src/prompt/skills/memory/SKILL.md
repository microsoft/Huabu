---
id: memory
name: Memory
description: How to propose 0–3 memory writes per turn. Open when the user asks you to record / remember / save / update something.
appliesTo: [ask, operate, sketch, external]
---

# Memory writes

You may issue **0 to 3** memory-write tool calls per turn — at most one per tier. Zero is a valid answer; do not write speculatively.

| Tier      | Tool                     | Sub-skill (read before writing)                           |
| --------- | ------------------------ | --------------------------------------------------------- |
| workspace | `memory_workspace_write` | `read("skills/memory/write/workspace-memory-writing.md")` |
| canvas    | `memory_canvas_write`    | `read("skills/memory/write/canvas-memory-writing.md")`    |
| skill     | `memory_skill_write`     | `read("skills/memory/write/skills-writing.md")`           |

## Workflow

1. **Think about what the user wants recorded** and which tier it belongs to (cross-canvas trait → workspace; this-canvas state → canvas; reusable how-to → skill).
2. **Pick the matching tool** from the table above.
3. **Use the matching sub-skill** for required args, caps, and discipline, then **issue the tool call**. Trust the writer's rejection messages.