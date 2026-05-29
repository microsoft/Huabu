# User skill — `memory_skill_write`

**Target file:** `<workspace>/setting/skills/<id>/SKILL.md` — reusable how-to (decision rules, recipes, patterns) that any future agent can `read("skills/<id>/SKILL.md")`.

## When to write

A **reusable pattern** emerged that another agent could apply on a future, unrelated canvas. Skills are precious; the bar is high.

- ✓ "next time someone asks for a story outline, use this 5-frame layout with these colour rules"
- ✓ "when summarising research papers, group by methodology not topic"
- ✗ "this canvas has 17 nodes about birds" — that's canvas memory, not a skill
- ✗ "I like concise replies" — that's workspace memory, not a skill

## Required args

| Field         | Type                    | Required on `create`     | Required on `update` | Notes                                                                                                                                                                                                          |
| ------------- | ----------------------- | ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op`          | `"create"` / `"update"` | always                   | always               | Prefer `update`.                                                                                                                                                                                               |
| `id`          | `string`                | always                   | always               | Lowercase + hyphens (e.g. `narrative-outline-five-acts`). Writer enforces FS safety.                                                                                                                           |
| `body`        | `string`                | always                   | always               | Markdown. On `update` this is appended under a dated `## Update — YYYY-MM-DD` section; prior body preserved.                                                                                                   |
| `title`       | `string`                | optional                 | optional             | Display label. Defaults to `id`.                                                                                                                                                                               |
| `description` | `string`                | **required**             | optional             | One-sentence catalogue blurb. On update, overrides the existing description when provided.                                                                                                                     |
| `appliesTo`   | `string[]`              | **required, non-empty**  | optional             | Agent surfaces: `ask` / `operate` / `sketch` / `external`. **MUST include your own surface** or you won't see it next turn. On `update`, passing this REPLACES the existing array — omit to keep what's there. |
| `rationale`   | `string`                | **required, ≥ 20 chars** | ignored              | Why no existing skill could be updated. Vague rationales ("useful pattern", "user asked") are rejected. Reference the existing catalogue and explain the gap.                                                  |

## Discipline

- **Strongly prefer `op: "update"`.** Read the user-skill catalogue in your system prompt (`{{skillCatalogue}}`) before creating; if anything is close, update it.
- **Body = reusable how-to.** Concrete decision rules, layout patterns, worked examples. Not canvas-specific narrative.
- **Body is markdown**; structure with `##` sections (when to use, core mechanism, examples, anti-patterns).
- **Read `skills/<id>/SKILL.md` first when updating** so you know what's already in there and don't repeat yourself.
- On `update`, you can NOT delete prior content — only append. If the existing body is wrong, ask the user to edit it manually.

## Example (update)

```json
{
  "op": "update",
  "id": "narrative-outline-five-acts",
  "body": "## Refinement: edge styling\n\nFor foreshadowing arcs, use line-style `dashed`. For causal links, use solid."
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
