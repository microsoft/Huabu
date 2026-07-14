# Space memory

Tool: `fs_write({ path: "memory/space.md", mode, ... })`

Per-Space situational briefing. Hidden from the user; read cold by the next agent that lands on this Space.

## Write what

Non-trivial shifts in **what this Space is for** or **where it's at**:

- current purpose (story outline, research synthesis, project plan…)
- where the user is in the workflow (act 2 of 5, draft 3, choosing between A and B)
- decisions already made that constrain future moves
- things the user explicitly asked the next agent to remember

Cross-Space traits → User memory. Reusable how-tos → skill.

## Modes

- `overwrite` — **default.** The body is the current-state briefing; rewriting it whole is the norm.
- `replace_string` — surgical edit of one line when you don't want to re-derive the rest.

## Rules

- **`read("memory/space.md")` first** to carry forward what the user still cares about.
- Briefing, not journal. One short paragraph or tight bullet list; no history of past changes.
- Body capped at 4 KB / 80 lines.

## Examples

```json
{
  "path": "memory/space.md",
  "mode": "overwrite",
  "body": "Sci-fi novel outline, protagonist's first encounter with the alien artifact. User is deciding whether to introduce the antagonist in scene 5 or postpone to Act 3."
}
```

```json
{
  "path": "memory/space.md",
  "mode": "replace_string",
  "oldString": "deciding whether to introduce the antagonist in scene 5 or postpone to Act 3",
  "newString": "settled on introducing the antagonist in Act 3"
}
```
