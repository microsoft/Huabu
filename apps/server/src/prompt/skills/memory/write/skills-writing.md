# User skill — `memory_skill_write`

**Target file:** `<workspace>/setting/skills/<id>/SKILL.md` — reusable how-to (decision rules, recipes, patterns) that any future agent can `read("skills/<id>/SKILL.md")`.

## When to write

A **reusable pattern** emerged that another agent could apply on a future, unrelated canvas. Skills are precious; the bar is high.

- ✓ "next time someone asks for a story outline, use this 5-frame layout with these colour rules"
- ✓ "when summarising research papers, group by methodology not topic"
- ✗ "this canvas has 17 nodes about birds" — that's canvas memory, not a skill
- ✗ "I like concise replies" — that's workspace memory, not a skill

## Required args

| Field         | Type                    | Required on `create`     | Required on `update` | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------- | ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op`          | `"create"` / `"update"` | always                   | always               | Prefer `update`.                                                                                                                                                                                                                                                                                                                                                           |
| `id`          | `string`                | always                   | always               | Lowercase + hyphens (e.g. `narrative-outline-five-acts`). Writer enforces FS safety.                                                                                                                                                                                                                                                                                       |
| `body`        | `string`                | always                   | always               | Markdown body **only** — do NOT wrap it in a `---\n...\n---` frontmatter fence. Use the top-level `description` / `appliesTo` / `title` args for metadata; the writer renders frontmatter from those. On `update`, wholesale replacement: read the existing SKILL.md first if prior prose should be preserved, strip its frontmatter, then merge into your submitted body. |
| `title`       | `string`                | optional                 | optional             | Display label. Defaults to `id`.                                                                                                                                                                                                                                                                                                                                           |
| `description` | `string`                | **required**             | optional             | One-sentence catalogue blurb. On update, overrides the existing description when provided.                                                                                                                                                                                                                                                                                 |
| `appliesTo`   | `string[]`              | **required, non-empty**  | optional             | Agent surfaces: `ask` / `operate` / `sketch` / `external`. **MUST include your own surface** or you won't see it next turn. On `update`, passing this REPLACES the existing array — omit to keep what's there.                                                                                                                                                             |
| `rationale`   | `string`                | **required, ≥ 20 chars** | ignored              | Why no existing skill could be updated. Vague rationales ("useful pattern", "user asked") are rejected. Reference the existing catalogue and explain the gap.                                                                                                                                                                                                              |

## Discipline

- **Strongly prefer `op: "update"`.** Read the user-skill catalogue in your system prompt (`{{skillCatalogue}}`) before creating; if anything is close, update it.
- **Body = reusable how-to.** Concrete decision rules, layout patterns, worked examples. Not canvas-specific narrative.
- **Body is markdown**; structure with `##` sections (when to use, core mechanism, examples, anti-patterns).
- **`op: "update"` wholesale-replaces the body — silent data loss is the failure mode.**
  Mandatory protocol:
  1. **Call `read("skills/<id>/SKILL.md")` first, in the same turn.** If you have not just read it, do not call `memory_skill_write` with `op: "update"`.
  2. Take the existing body, strip its leading `---\n...\n---` frontmatter fence, and treat that as your starting point.
  3. Apply your edits _on top of_ that body. Anything you omit from the submitted `body` is permanently deleted from the file.

## Example (update)

```json
{
  "op": "update",
  "id": "narrative-outline-five-acts",
  "body": "# Narrative outline — five acts\n\n...full body including any prior content you want to keep, plus your additions..."
}
```

## Example (create)

```json
{
  "op": "create",
  "id": "warm-healing-outline",
  "description": "Frame layout for warm-healing story arcs centred on a female protagonist.",
  "appliesTo": ["ask", "operate"],
  "rationale": "narrative-outline-five-acts is plot-mechanic focused; this captures the genre-specific colour palette, frame conventions, and emotional pacing that the existing skill explicitly does not cover.",
  "body": "# Warm-healing outline\n\n## When to use\n\n..."
}
```
