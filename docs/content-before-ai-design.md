# Content Before AI — Snapshot & Diff Design

## Background

Sediment's block-level provenance system tracks which blocks in a note were written
or modified by AI (Phase 2). Visual indicators (purple color bars) show this on the
editor (Phase 3). However, these mechanisms only show _which blocks_ are AI-authored —
they cannot show _what was changed_: deletions, modifications to existing text, or the
overall scope of an AI edit.

Users need a way to answer: "What exactly did the AI change in my note? Did it make
any unexpected modifications?"

## Design Goals

1. Let users see a Markdown diff of AI changes with one click.
2. Auto-dismiss when the user has reviewed/edited all AI blocks.
3. Keep the data model minimal — one additional field (`contentBeforeAI`).
4. No new server-side logic — capture happens entirely on the client.

## Data Model

### New field: `NoteNodeData.contentBeforeAI`

```typescript
interface NoteNodeData {
  // ... existing fields ...
  contentBeforeAI?: string;
}
```

A snapshot of the note's canonical Markdown (`content`) taken **before** the first
AI edit in a session. Cleared when the user dismisses the banner or when all AI
blocks have been user-modified (auto-clear).

### Lifecycle

```
[user content] ── AI edit ──► contentBeforeAI = old content (captured once)
                  AI edit ──► contentBeforeAI unchanged (Strategy A: don't overwrite)
                  AI edit ──► contentBeforeAI unchanged
                  user edits all AI blocks ──► contentBeforeAI = undefined (auto-clear)
                  -- or --
                  user clicks Dismiss ──► contentBeforeAI = undefined
                  AI edit ──► contentBeforeAI = old content (new session)
```

### Strategy A: Cumulative Snapshot

`contentBeforeAI` is set **once** on the first AI edit and **not overwritten** by
subsequent AI edits. This means the diff always shows cumulative changes from the
last fully user-owned state. Rationale:

- Users want to see "everything AI changed since I last looked"
- Block-level provenance already distinguishes which diff sections are pure-AI vs
  user-modified, so mixed diffs are not confusing

## Data Flow

### Snapshot Capture

Happens in the **client-side** `mergeNodeData` command handler
(`apps/web/src/canvas/commands/mergeNodeData.ts`).

```
Server executor stamps { provenance: { __all__: { author: 'ai' } }, content: "..." }
  │
  ▼
SSE stream → client canvasStore.executeCommands
  │
  ▼
mergeNodeData handler:
  1. Has dataRec (existing node data) with dataRec.content = "old markdown"
  2. Has patchRec (incoming patch) with patchRec.content = "new markdown"
  3. Detects AI patch: patchRec.provenance has __all__ sentinel
  4. If dataRec.contentBeforeAI is unset AND dataRec.content is non-empty:
     → contentBeforeAI = dataRec.content
  5. Merges into updated node data
```

Why here and not on the server? The server's `executeCanvasCommands` does not have
access to the current node content when handling `MERGE_NODE_DATA` — it only receives
the patch. The client command handler has both the old data and the incoming patch.

### Auto-Clear

Happens in `NotePreview.tsx`'s `onChange` handler after provenance updates:

```
User edits a block
  → provenance updated (recordUserEdit)
  → check hasAnyPureAiBlock(updatedProvenance)
  → if false: include { contentBeforeAI: undefined } in the data patch
```

The `hasAnyPureAiBlock` utility iterates the provenance map and returns `true` if
any non-`__all__` entry has `getBlockAuthorStatus() === 'ai'` (pure AI, no user
modifications).

### Manual Dismiss

User clicks "Dismiss" on the banner → `onDataChange({ contentBeforeAI: undefined })`.

## UI Design

### Banner

Appears at the top of the `NotePreview` component (expanded editor view), between
the provenance `<style>` tag and the `<NoteSourceIdProvider>`.

```
┌──────────────────────────────────────────────────────────────┐
│ ✦ AI modified this note              [View changes] [Dismiss]│
├──────────────────────────────────────────────────────────────┤
│  (collapsible diff panel — shown when "View changes" toggled)│
│  - old line removed                                          │
│  + new line added                                            │
│    unchanged context line                                    │
└──────────────────────────────────────────────────────────────┘
│                                                              │
│  [BlockNote editor continues below]                          │
```

Styling:

- Banner bar: `bg-ai-bg text-ai` (uses `--color-ai-bg` and `--color-ai` theme tokens)
- Diff panel: monospace, green/red highlights for added/removed lines
- Buttons: `Button variant="ghost" size="sm"`

### Visibility Rules

- Shown when `contentBeforeAI` is a non-empty string AND not `readOnly`
- Hidden on canvas card view (only in expanded editor)

## Edge Cases

### 1. AI creates a brand-new note (no prior content)

`dataRec.content` is empty → `contentBeforeAI` is NOT set → no banner.
Correct: there is no "before" to compare against.

### 2. User edits one block, others remain pure-AI

Only the edited block's provenance changes to `user-modified`. Banner stays.
The diff still shows all changes but provenance color bars indicate which blocks
the user has already touched.

### 3. `contentBeforeAI` persistence across sessions

`contentBeforeAI` is persisted in the canvas file as part of node data. If the user
closes and reopens the app, the banner reappears if they haven't addressed AI changes.

### 4. Undo/redo

`mergeNodeData` has `snapshot: 'yes'`, so the capture is part of the undo stack.
Undoing the AI edit also undoes the snapshot capture.

### 5. `contentBeforeAI: undefined` in patches

`{ ...dataRec, ...patchRec }` with `patchRec.contentBeforeAI = undefined` sets the
key to `undefined` but does not delete it. All checks use `typeof x === 'string'`,
so this is functionally equivalent to deletion.

## Files Modified

| File                                             | Change                                           |
| ------------------------------------------------ | ------------------------------------------------ |
| `packages/shared/src/types/canvas/node.ts`       | Add `contentBeforeAI?: string` to `NoteNodeData` |
| `apps/web/src/canvas/commands/mergeNodeData.ts`  | Snapshot capture logic                           |
| `apps/web/src/utils/provenance.ts`               | Add `hasAnyPureAiBlock()` utility                |
| `apps/web/src/components/Nodes/AiDiffBanner.tsx` | New banner + diff component                      |
| `apps/web/src/components/Nodes/NotePreview.tsx`  | Banner integration + auto-clear                  |

## Dependencies

- `diff` npm package (for `diffLines` function) — added to `@sediment/web`
