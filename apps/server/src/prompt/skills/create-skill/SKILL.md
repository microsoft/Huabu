---
name: Create a user skill
description: 'Create a new user skill at setting/skills/<id>/SKILL.md.'
appliesTo:
  - operate
userInvokable: true
---

# Create a user skill

You were called because the user typed `/create-skill <instructions>` in the chat input. Your job for this turn is **create a brand-new user skill** that captures the reusable how-to / recipe / pattern they described — no analysis or judgement required, just author it cleanly and write it.

## Inputs you have

- **The free-text after `/create-skill`** in the most recent user message — this is the brief. It may be terse ("a skill for warm-healing story outlines") or detailed ("…and use a 5-frame layout with these colour rules…"). Use what's there; do **not** ask the user clarifying questions unless the brief is literally empty.
- **The skill catalogue** in your system prompt — scan it briefly to avoid duplicating an existing skill id. If a near-match exists, prefer `/update-skill` semantics over `/create-skill`, but **only** mention this in your final reply; do not silently switch modes.

## Pick the id

- Kebab-case, derived from the brief's noun phrase. Keep it short (≤ 5 words).
  - "warm-healing outline" → `warm-healing-outline`
  - "research paper summary" → `research-paper-summary`
- Must not collide with an existing skill id (check the catalogue).
- Must match `[a-z0-9-]+` — no slashes, dots, underscores, or uppercase.

## Compose the file

Submit the **entire** file via `fs_write`, including the YAML frontmatter fence. The skill id comes from the `<id>` directory segment in the path — it is **not** a frontmatter key. Frontmatter fields:

| field         | value                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| `name`        | human-readable label (Title Case is fine)                                             |
| `description` | one-sentence catalogue blurb — what the skill does, not when (the body covers when)   |
| `appliesTo`   | array; default to `["ask", "operate"]` unless the brief obviously narrows the surface |

`triggers` and `version` are optional — omit unless the brief calls for them.

Body structure (use these section headings verbatim — keeps user skills consistent and easy to scan):

```
# <Display name>

## When to use
…short list of scenarios, written from the user's perspective.

## How to apply
…step-by-step / checklist / decision rules. Be concrete.

## Examples
…minimal, copy-pasteable. Optional but very valuable.
```

Body length: keep it tight. Every byte ends up in someone's prompt later; aim for ≤ 60 lines.

## Write it

Use `fs_write` exactly once:

```json
{
  "path": "skills/<id>/SKILL.md",
  "mode": "overwrite",
  "rationale": "<≥ 20 chars explaining why no existing skill fits>",
  "body": "---\nname: \"…\"\ndescription: \"…\"\nappliesTo: [\"ask\", \"operate\"]\n---\n\n# …\n\n## When to use\n\n…\n"
}
```

`rationale` is **required** by `fs_write` because this is a skill-create on a path that doesn't yet exist. Make it substantive — "the user explicitly requested this skill via /create-skill: <brief>" is the minimum bar; better if you can name a near-miss skill from the catalogue you considered and explain why it didn't fit.

## After writing

- Briefly confirm to the user: skill id, one-line summary of what it does, and a reminder that they can now invoke it via `/<id>`.
- Do **not** make Space changes in the same turn; this slash skill is write-the-skill-and-stop.
