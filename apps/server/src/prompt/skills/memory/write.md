# Memory write — rules

You may only call the three memory-write tools when the **user explicitly** asks you to record / remember / save / update something. A background curator already digests passive sediment from chat history; do not duplicate its work.

## Pick the tool

| User says…                                                       | Tool                     |
| ---------------------------------------------------------------- | ------------------------ |
| "记住我喜欢 X" / "remember I prefer X" (cross-canvas preference) | `memory_workspace_write` |
| "记住这个画布在做 X" / "save current progress" (this canvas)     | `memory_canvas_write`    |
| "把这套做法记下" / "save this as a skill / pattern / recipe"     | `memory_skill_write`     |

If the user's intent doesn't clearly map to a tier, ask before writing.

## Read before you write

For any non-trivial write, read the current contents first (`read("memory/workspace.md")`, `read("memory/canvas.md")`, or `read("skills/<id>/SKILL.md")`) so you don't restate, overwrite useful prose, or duplicate existing entries.

## Trust the writer

The writer enforces all structural rules — body caps, bullet dedup, frontmatter validation, rationale length, op semantics. If it rejects your call you'll get a short reason in the tool result; adjust and retry rather than guessing the rules.

## Skill writes — one critical gotcha

`memory_skill_write` with `op: "create"` requires an `appliesTo` array. **Include your current agent surface in `appliesTo`** (`"ask"` if you're the ask agent, `"operate"` if you're the operate agent), otherwise the skill is invisible to you on the next turn and you've written something you can't use.

On `op: "update"`, passing `appliesTo` replaces the existing array — omit the field to keep what's already there.
