---
id: memory
name: Memory
description: How to propose 0–3 memory writes per turn. Open when the user asks you to record / remember / save / update something.
appliesTo: [ask, operate, sketch, external]
---

# Memory writes

You may issue **0 to 3** memory-write tool calls per turn — at most one per tier. Zero is a perfectly valid answer; do not write speculatively.

Each tier has its own validation contract; read the matching sub-skill **before** constructing the call so your args are well-formed and your content meets the per-tier discipline.

| Tier      | Tool                     | Sub-skill (read first)                                    |
| --------- | ------------------------ | --------------------------------------------------------- |
| workspace | `memory_workspace_write` | `read("skills/memory/write/workspace-memory-writing.md")` |
| canvas    | `memory_canvas_write`    | `read("skills/memory/write/canvas-memory-writing.md")`    |
| skill     | `memory_skill_write`     | `read("skills/memory/write/skills-writing.md")`           |

## Workflow

1. **Decide tiers.** Map the user's request to 0–3 of the tiers above. If nothing maps cleanly, ask the user before guessing.
2. **Read the existing content** of each tier you plan to write — workspace memory at `read("memory/workspace.md")`, canvas at `read("memory/canvas.md")`, an existing skill at `read("skills/<id>/SKILL.md")`. This prevents duplication, accidental overwrites, and rationale collisions.
3. **Read the matching sub-skill** above for required args, caps, gotchas.
4. **Issue the tool call(s).** Trust the writer's rejection messages — they tell you exactly what to fix; don't guess.

## Hard rules (all tiers)

- **Never invent.** Every entry must cite something concrete the user said or did this turn.
- **Never duplicate.** If existing content already says it, skip.
- **Match tier to content.** Cross-canvas user traits → workspace. This-canvas state → canvas. Reusable how-tos → skill. Don't cross-pollinate.
