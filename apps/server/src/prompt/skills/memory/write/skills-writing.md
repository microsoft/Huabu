# User skill

Tool: `fs_write({ path: "skills/<id>/SKILL.md", mode, ... })`

Reusable how-to (decision rules, recipes, patterns) any future agent on an unrelated Space can `read("skills/<id>/SKILL.md")` to apply.

## Write what

- ✓ "for story outlines, use this 5-frame layout with these colour rules"
- ✓ "when summarising research papers, group by methodology not topic"
- ✗ "this Space has 17 nodes about birds" — Space memory
- ✗ "user prefers concise replies" — User memory

## Modes

- `replace_string` — **default for edits.** Add a section, fix an example, refine a rule. No risk of silently dropping prior content.
- `overwrite` — (a) creating a brand-new skill (requires `rationale` ≥ 20 chars). (b) Structural rewrite of an existing skill.

## Rules

- **Strongly prefer editing an existing skill.** Scan the user-skill catalogue in your system prompt; if anything is close, edit it.
- **`read("skills/<id>/SKILL.md")` first** before any edit.
- **`overwrite` wholesale-replaces the file** — anything you omit is permanently deleted.
- Frontmatter is **not** rendered for you; submit the full file including the leading fence:

  ```
  ---
  id: <skill-id>
  name: "Display label"
  description: "One-sentence catalogue blurb."
  appliesTo: ["ask", "operate"]
  ---
  ```

  `appliesTo` ⊆ `ask` / `operate` / `external`. **Include your own surface** or you won't see the skill next turn.

- Skill body is uncapped — still, keep it tight; every byte enters someone's prompt later.

## Examples

Create:

```json
{
  "path": "skills/warm-healing-outline/SKILL.md",
  "mode": "overwrite",
  "rationale": "narrative-outline-five-acts is plot-mechanic focused; this captures the genre-specific colour palette, frame conventions, and emotional pacing it explicitly does not cover.",
  "body": "---\nid: warm-healing-outline\nname: \"Warm-healing outline\"\ndescription: \"Frame layout for warm-healing story arcs.\"\nappliesTo: [\"ask\", \"operate\"]\n---\n\n# Warm-healing outline\n\n## When to use\n\n...\n"
}
```

Edit (preferred):

```json
{
  "path": "skills/narrative-outline-five-acts/SKILL.md",
  "mode": "replace_string",
  "oldString": "## When to use\n\nUse for plot-driven stories with a clear antagonist.",
  "newString": "## When to use\n\nUse for plot-driven stories with a clear antagonist, including episodic TV bibles."
}
```
