# Block-Level Provenance & Inline Diff Design

Status: Draft — needs owner review

Last updated: 2026-07-22

## Background

Huabu tracks which blocks in a note were written or modified by AI using a
block-level provenance system. Visual indicators (purple color bars) and inline
word-level diffs let users see _what_ the AI changed and accept or reject
individual changes.

## Design Goals

1. Per-block provenance tracking (AI vs user authorship).
2. Inline word-level diff bars for modified blocks, with accept/reject per block.
3. Deleted-block indicators with restore capability.
4. Cumulative baselines — multiple AI edits accumulate diffs against the last user-owned state.

## Data Model

### `BlockProvenance` & `BlockProvenanceMap`

Defined in `packages/shared/src/types/canvas/node.ts`:

```typescript
interface BlockProvenance {
  author: 'ai' | 'user';
  agentMode?: AgentMode;
  createdAt: string;
  modifications?: Array<{
    by: 'ai' | 'user';
    agentMode?: AgentMode;
    at: string;
  }>;
  baselineText?: string; // present = pending diff to review
  deleted?: boolean; // marks a block deleted by AI
  afterBlockId?: string | null; // positional anchor for deleted entries
}

type BlockProvenanceMap = Record<string, BlockProvenance>;
```

The special key `__all__` is a sentinel set by the server when AI creates/updates
content via Markdown (no block IDs available). The client expands this into
per-block entries when the editor initialises.

`NoteNodeData.provenance?: BlockProvenanceMap` stores the map.

### Lifecycle

```
AI edit → server stamps { provenance: { __all__: { author: 'ai' } } }
       → client mergeNodeData preserves existing per-block entries alongside sentinel
       → NotePreview resolves sentinel into per-block entries via content-based matching
       → baselineText set on modified/new blocks, __deleted_N__ entries for deletions
       → user accepts/rejects individual blocks or clicks Accept All / Reject All
       → baselineText cleared → diff bars disappear
```

## Data Flow

### Server: Provenance Injection

In `apps/server/src/modules/agent/tools/executor.ts`:

- `CREATE_NODES`: stamps `{ provenance: { __all__: sentinel } }` on note nodes with content.
- `MERGE_NODE_DATA`: reads canvas state to resolve node types, stamps provenance only on note nodes with content.

### Client: `mergeNodeData` Command

In `apps/web/src/canvas/commands/mergeNodeData.ts`:

When an AI patch with `__all__` sentinel arrives, the handler merges it with
existing per-block provenance so the diff-merge logic can later match old blocks
to new blocks and carry over user-authored provenance for unchanged content.

### Client: `NotePreview` Sentinel Resolution

In `apps/web/src/components/Nodes/NotePreview.tsx`:

On content load, `resolveSentinelProvenance()` expands the `__all__` sentinel:

1. No existing per-block entries → simple expansion (all blocks = new AI).
2. Existing per-block entries → content-based fingerprint matching:
   - Matched blocks (identical content): old provenance carried over.
   - Unmatched new blocks: stamped as AI with `baselineText` from paired old block.
   - Deleted old blocks: stored as `__deleted_N__` entries with positional anchors.

### Client: `onChange` Provenance Tracking

On each content change:

- New block IDs → `recordUserEdits()` batch stamps as user-authored.
- Cursor block edited → `recordUserEdit()` + `clearBaselineText()` (diff dismissed).
- Stale provenance entries pruned; deleted-block anchors repaired.
- Persistence (markdown serialisation + `writePatch`) debounced at 150ms.

## UI Design

### Purple Color Bars (`::before` pseudo-elements)

Dynamic CSS rules generated per block via `useMemo`:

- **Solid bar** (`--color-ai`): pure AI block with pending diff.
- **Light solid bar** (`--color-ai-light`): AI block, diff already accepted.
- **Dashed bar** (striped gradient): AI block user-modified.

### Inline Block Diffs (`InlineBlockDiffs` component)

- Modified blocks grouped into consecutive "runs".
- Hovering the bar zone shows a popover with word-level diff (powered by `diffWords` from the `diff` npm package).
- Accept/Reject buttons per run.

### Deleted Block Indicators

- Red markers positioned after the anchor block.
- Hover shows deleted text with Accept (confirm deletion) / Reject (restore block).

### Global Actions

- **Accept All / Reject All** buttons at bottom-right when any pending diff exists.
- Reject All restores all blocks to baseline text and re-inserts deleted blocks.

### Visibility Rules

- Diff UI shown only when `!readOnly` and there are pending diffs.
- Color bars always visible for AI-authored blocks regardless of diff status.

## Edge Cases

1. **AI creates a brand-new note** → all blocks get `baselineText: ''` (deep purple bars, popover shows "all added").
2. **User edits one block, others remain pure-AI** → only edited block's bar changes; diff stays for unedited blocks.
3. **Multiple sequential AI edits** → cumulative `baselineText` preserved; deletions accumulate across operations.
4. **Undo/redo** → `mergeNodeData` has `snapshot: 'yes'`, so provenance changes are part of the undo stack.
5. **Editor remount** → `lastExpandedProvenanceRef` preserves expanded provenance across re-renders; `resolveSentinelProvenance` falls back to `contentJson` parsing.

## Files

| File                                                 | Role                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/shared/src/types/canvas/node.ts`           | `BlockProvenance`, `BlockProvenanceMap`, `NoteNodeData.provenance` |
| `apps/server/src/modules/agent/tools/executor.ts`    | Stamps AI provenance sentinel on note commands                     |
| `apps/web/src/canvas/commands/mergeNodeData.ts`      | Merges sentinel with existing per-block provenance                 |
| `apps/web/src/utils/provenance.ts`                   | Provenance utilities (expand, merge, diff derivation, repair)      |
| `apps/web/src/components/Nodes/NotePreview.tsx`      | Sentinel resolution, onChange tracking, accept/reject handlers     |
| `apps/web/src/components/Nodes/InlineBlockDiffs.tsx` | Inline diff bars, popovers, word-level diff display                |
| `apps/web/src/components/Nodes/NodeWrapper.tsx`      | AI badge and provenance summary tooltip                            |
| `apps/web/src/index.css`                             | `--color-ai`, `--color-ai-light`, `--color-ai-bg` theme tokens     |

## Dependencies

- `diff` npm package (`diffWords` function) — added to `@huabu/web`
