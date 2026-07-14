---
name: Update a user skill
description: 'Find an existing user skill and apply the requested change to its SKILL.md.'
appliesTo:
  - operate
userInvokable: true
---

# Update a user skill

You were called because the user typed `/update-skill <target-and-change>` in the chat input. Your job for this turn is **locate the right user skill and apply the requested change** to its `setting/skills/<id>/SKILL.md`. Reuse `fs_write` — no other writes.

## Inputs you have

- **The free-text after `/update-skill`** in the most recent user message — usually mixes a target hint ("the warm-healing skill") with the actual change ("add a frame-spacing rule for vertical layouts"). Parse out both.
- **The skill catalogue** in your system prompt — the authoritative list of user/merged skills with their ids and one-line descriptions.

## Resolve the target

1. **Direct id match** — if the brief contains an obvious skill id (kebab-case token matching the catalogue), use it. Done.
2. **Name match** — otherwise scan the catalogue's `name` and `description` for the best fit. If exactly one matches, use it. Done.
3. **Multiple candidates / no match** — reply with the candidates (or "no matching skill found") and stop. Do not guess.

Constraints:

- Only `user` / `merged` skills can be updated. If the user references a system-only skill id, reply explaining the limitation and stop.
- Never create a new file in this flow. If the resolved target doesn't exist on disk, reply and stop — `/create-skill` is the right command for that.

## Read before you write

Always `read("skills/<id>/SKILL.md")` first to see the current content. Do not rely on the catalogue blurb or your memory of the file.

## Pick the mode

- **`replace_string`** — default. Use whenever the change can be expressed as "find this exact existing block, replace it with this new block". Safer: nothing else in the file is touched. Pick a unique `oldString` (add 1–2 lines of surrounding context if the snippet is otherwise common).
- **`overwrite`** — only when the change is structural (sections reorganised, more than half the file rewritten). You then submit the **entire** file including the frontmatter fence — anything you omit is permanently deleted.

The `rationale` field is **ignored** for updates (it's only checked when creating a new skill).

## Write it

For a targeted edit:

```json
{
  "path": "skills/<id>/SKILL.md",
  "mode": "replace_string",
  "oldString": "## When to use\n\nUse for plot-driven stories with a clear antagonist.",
  "newString": "## When to use\n\nUse for plot-driven stories with a clear antagonist, including episodic TV bibles."
}
```

For a structural rewrite:

```json
{
  "path": "skills/<id>/SKILL.md",
  "mode": "overwrite",
  "body": "---\nname: \"…\"\ndescription: \"…\"\nappliesTo: [\"ask\", \"operate\"]\n---\n\n# …\n\n## When to use\n\n…\n"
}
```

## After writing

- Briefly confirm to the user: skill id, mode used (`replace_string` / `overwrite`), and a one-line summary of what changed.
- Do **not** make Space changes in the same turn.
