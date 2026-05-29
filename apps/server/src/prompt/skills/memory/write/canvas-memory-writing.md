# Canvas canvas memory — `memory_canvas_write`

**Target file:** `<canvas>/.memory/canvas.md` — per-canvas situational notes ("what's this canvas about right now"). Hidden from the user; consumed by future agents that land on this canvas cold.

## When to write

A non-trivial shift in **what this canvas is for** or **where it's at** that the next chat turn would benefit from knowing without having to re-derive from the node graph:

- the canvas's current purpose (story outline, research synthesis, project plan…)
- where the user is in their workflow (act 2 of 5, draft 3, debating between options A and B)
- decisions already made that constrain future moves
- things the user explicitly wants the next agent to remember

**Not** for cross-canvas preferences — those go to workspace memory.
**Not** for reusable patterns — those go to skill memory.

## Required args

| Field  | Type     | Notes                                                                   |
| ------ | -------- | ----------------------------------------------------------------------- |
| `body` | `string` | Wholesale replacement of the canvas memory body. Markdown. NOT a delta. |

## Discipline

- **Wholesale replacement.** Whatever you write becomes the entire new file. Read `memory/canvas.md` first so you don't drop context the user still cares about; carry forward what's relevant + integrate the new state.
- **Body capped at 4 KB / 80 lines.** Oversized writes are rejected.
- **Briefing, not journal.** Write the _current state_ in one short paragraph (or a tight bullet list). The next agent should be able to land cold and understand the situation in <30 seconds. No history of past changes; no chronological narrative.

## Example

```json
{
  "body": "Sci-fi novel outline. Five-act structure laid out left-to-right; Act 2 in progress, focused on the protagonist's first encounter with the alien artifact. User is deciding whether to introduce the antagonist in scene 5 or postpone to Act 3. Existing antagonist sketch in `nodes/Antagonist sketch.md` is a placeholder."
}
```
