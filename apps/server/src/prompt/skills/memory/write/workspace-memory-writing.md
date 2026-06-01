# Workspace memory — `memory_workspace_write`

**Target file:** `<workspace>/setting/.huabu.md` — cross-canvas user profile. Bullet-list prose. No frontmatter.

## When to write

A durable, cross-canvas user trait the next chat (any canvas) should know about:

- style / voice / language preferences
- recurring topics, expertise, interests
- workflow habits ("I iterate in versions, never delete the previous one")

**Not** for this-canvas situational notes — those go to canvas memory.

## Required args

| Field  | Type                     | Notes                                                                                                              |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `mode` | `"patch"` (literal only) | `"replace"` is rejected by the writer. Patching only.                                                              |
| `diff` | `string`                 | Bullet-style content to merge in. One observation per line. Writer auto-prefixes `- ` and dedups trim-equal lines. |

## Discipline

- **Each bullet ≤ 80 chars.** Distil before submitting.
- **Merged body capped at 4 KB / 80 lines.** Oversized merges are rejected; if you're close, trim or skip.
- **Read `memory/workspace.md` first.** Don't restate what's already there.
- **One coherent thought per bullet.** "prefers concise replies; also likes tables" → two bullets, not one.

## Example

```json
{
  "mode": "patch",
  "diff": "prefers concise replies\nworks primarily in Chinese\niterates story outlines in versions, never deletes prior versions"
}
```
