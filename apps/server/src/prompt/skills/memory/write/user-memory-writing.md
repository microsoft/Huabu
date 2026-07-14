# User memory

Tool: `fs_write({ path: "memory/user.md", mode, ... })`

Cross-Space user profile. Bullet-list markdown, no frontmatter. Shared with the user — they may hand-edit it.

## Write what

Durable traits the next chat on any Space should know:

- style / voice / language preferences
- recurring topics, expertise, interests
- workflow habits ("iterates in versions, never deletes prior drafts")

Situational notes → Space memory. Reusable how-tos → skill.

## Modes

- `replace_string` — **default.** Add / fix / replace one bullet. Local change, can't accidentally clobber user edits.
- `overwrite` — only when restructuring the whole file, or when the file does not yet exist.

## Rules

- **`read("memory/user.md")` first.** Avoid dupes; pick a unique `oldString`.
- **Never delete user-authored bullets via `overwrite`.** If unsure, use `replace_string`.
- One thought per bullet, ≤ 80 chars.
- Merged body capped at 4 KB / 80 lines — oversized writes are rejected.

## Examples

Add a bullet:

```json
{
  "path": "memory/user.md",
  "mode": "replace_string",
  "oldString": "- prefers concise replies\n",
  "newString": "- prefers concise replies\n- works primarily in Chinese\n"
}
```

First write (file missing):

```json
{
  "path": "memory/user.md",
  "mode": "overwrite",
  "body": "- prefers concise replies\n- works primarily in Chinese\n"
}
```
