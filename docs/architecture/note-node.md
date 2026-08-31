# Note Node

The note node: a canvas node whose content **is** a Markdown document. Most of this doc is about what happens once a key or pointer reaches that document, because that is the part with no obvious answer — the surrounding node machinery is shared with every other node type and is only summarised here with links.

---

## 1. Goals

- A note is plain Markdown, on disk and in memory. Anything the editor can do must survive a save/reload round trip through Markdown — that constraint drives §3.
- The same document renders on the canvas card and in the expanded editor, from one editor factory, so behaviour cannot drift between the two.
- Content authored by a human and content written by an agent live in the same document; block-level provenance is what keeps them distinguishable.

## 2. Data model & persistence

```ts
interface NoteNodeData extends BaseNodeData {
  type: 'note';
  content: string; // canonical Markdown — the primary representation
  style?: NodeStyle;
  provenance?: MarkdownProvenance; // block-level AI-edit markers
}
```

On disk the node is one file, `nodes/<safe(label)>.md`: front-matter carries `id` / `type` / `label` / `src`, and the body is `content` verbatim. Layout and rules live in [canvas-storage.md](./canvas-storage.md). The body's ownership is `authored`, so the preprocessing pipeline never rewrites it — see [node-preprocessing.md](./node-preprocessing.md).

Inline text and background colors persist as HTML spans with `data-huabu-text-color` and `data-huabu-background-color`. The parser also accepts the pre-rename `data-sediment-*` attributes for existing notes and serializes them back to the canonical `data-huabu-*` form on the next edit.

## 3. Lifecycle

**Creation** — notes have no creation path of their own. They go through the generic `ADD_NODES` UI intent, which resolves to a `CREATE_NODES` command; paste, canvas drop and agent-issued creation all funnel through it. See [canvas-command-architecture.md](./canvas-command-architecture.md).

**Rendering** — the canvas card mounts the read-only `MilkdownPreview`; the expanded panel mounts the editable `MilkdownEditor`, which also offers a raw-Markdown source mode alongside WYSIWYG. See §4.

**Searching** — expanded-preview find marks the WYSIWYG document or raw-Markdown editor as its searchable content root. Editor chrome, including Crepe's mounted-but-hidden slash menu and Huabu's floating toolbar and provenance controls, is outside that boundary and does not contribute matches. The shared DOM walker also rejects hidden and explicitly excluded text so counting, highlighting, and next/previous navigation agree.

**Saving** — an edit calls `updateNodeData(id, { content })`, which dispatches `UPDATE_NODE_DATA` → `MERGE_NODE_DATA`. There is **no debounce**: every editor `onChange` writes through. Concurrency is handled at the server by rev-CAS, which rejects a stale write with `409 NODE_CONTENT_CONFLICT` rather than merging it.

**Height** — a note's height is `auto` or `fixed` (`setNoteHeightMode`); measurement, freshness keys and the layout conversion are owned by [node-auto-height.md](./node-auto-height.md).

---

## 4. Two surfaces, one factory

Both surfaces are built by the same [`createMilkdown`](../../apps/web/src/components/Milkdown/createMilkdown.ts) factory, so every ProseMirror plugin registered there — the `Tab` keymap, the link-click handler — is live on both. Surface differences come from options and from React-level capture handlers, not from separate editor builds.

Everything from here on is what happens **inside** the document. Pointer routing up to that point — which gesture the canvas claims before the event ever reaches a note — belongs to [canvas-input-interactions.md](./canvas-input-interactions.md).

| Surface                                                                         | Mount                                  | Notes                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`MilkdownEditor`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)   | `editable: true`                       | Full editing. React owns the chrome, so Crepe's own Toolbar / LinkTooltip are off.                                                                                     |
| [`MilkdownPreview`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx) | `editable: false`                      | Pure display. `contenteditable=false` communicates read-only on its own.                                                                                               |
| `MilkdownPreview` with `enableBlockDrag`                                        | `editable: true` + `previewMode: true` | ProseMirror must stay editable for the block-drag handle to be hit-testable, so every input verb is swallowed at the capture phase and `aria-readonly` is set instead. |

---

## 5. Tab / Shift-Tab — indentation

### Why indentation means list nesting

Markdown has no syntax for an indented paragraph. Four leading spaces at top level is not an indent in CommonMark — it is an **indented code block**, a 2004 construct that predates fenced code blocks. A note's on-disk form is markdown, so an indent that survives a save/reload round trip has to be expressible in markdown, and the only construct that survives is list nesting.

This is where Huabu differs from Notion. Notion nests the _block itself_ under the block above it and preserves its type, because Notion stores a block tree rather than markdown. Huabu converts the paragraph into a list item instead — the visible indent is the same, the persisted shape is not.

### Behaviour

`Tab` and `Shift-Tab` are bound by a `keymap` plugin in `createMilkdown`. `tabContext` first classifies the cursor:

| Context                 | `Tab`                                                                                          | `Shift-Tab`                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Inside a list item      | Sinks one level under the sibling above.                                                       | Lifts one level; a top-level item becomes a paragraph. |
| Paragraph / heading     | Wraps into a list, merges with the list above, then sinks into it.                             | Lifts back out to a plain paragraph.                   |
| Table, code block, math | Not handled — falls through to the handler that owns the key (cell navigation, source indent). | Same.                                                  |

Nesting depth is unlimited; each `Tab` sinks exactly one level, and an item can only sink below an item that already precedes it.

Two details are load-bearing in the paragraph path:

- `wrapInList` does **not** join with an adjacent preceding list — left alone it produces a second, separate list next to the first. The wrapped item is merged into the list above with `canJoin` + `tr.join` before it can sink.
- `wrapInList` fills the new item's `listType` attribute from the schema default (`bullet`). When that attribute disagrees with the parent list, a Milkdown sync plugin renders **no marker at all**, so the attribute is taken from the preceding list instead.

The key is consumed for any text context, so a stray `Tab` mid-edit can never move focus out of the editor. `Escape` remains the keyboard exit path.

In `MilkdownPreview`, `Tab` is deliberately _not_ in the swallowed-key set: its own branch calls `stopPropagation()` without `preventDefault()`, so the key never reaches the document-mutating keymap but the browser still advances focus — the accessibility-correct behaviour for a read-only surface.

---

## 6. Link activation

`Ctrl`-click (`Cmd` on macOS, where `Ctrl`-click is the secondary-click gesture) opens the link under the pointer. A plain click is reserved for placing the caret, which is what keeps link text editable — the same convention as VS Code, Word and Obsidian. Only the primary button counts.

Because the handler lives in the shared factory, this works in the read-only preview too.

```
Ctrl/Cmd + primary click on <a href>
  → handleLinkClick  (ProseMirror handleDOMEvents: click / auxclick)
  → normalizeSafeLinkHref  ── unsafe ─→ preventDefault, no navigation
  → window.open(href, '_blank', 'noopener,noreferrer')
        web      → new browser tab
        desktop  → setWindowOpenHandler denies the window, shell.openExternal
```

No preload API or IPC is involved: the desktop main process already routes `window.open` for `http(s)` targets to the OS browser.

### Why the href is re-validated at click time

Only `setLink` screens what the _user_ types. Markdown parsed from an agent reply, a paste or an externally synced file renders its `href` verbatim, so `[docs](javascript:alert(1))` reaches the DOM as a live `<a href="javascript:alert(1)">`. In the desktop renderer that URL would run with application privileges.

An anchor's `javascript:` URL can only be activated by a click — browsers refuse it for middle-click and for the context menu's "open link" entries — so the click handler is the closing point. An unsafe href has its default suppressed but the handler returns `false`, so ProseMirror still places the caret and the text stays editable.

`normalizeSafeLinkHref` admits `http:` and `https:` only; everything else, including relative and `mailto:` targets, is treated as unsafe.

---

## 7. Note-specific behaviours

These exist only for notes, and none of them are guessable from the node model above.

| Behaviour                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block provenance         | The server stamps agent edits into `data.provenance` at the mutation source; the editor realigns markers to live block keys on re-serialization, and `<ProvenanceOverlay>` renders Accept / Reject / Restore. Fingerprints run the same math-delimiter normalization as Milkdown, canonicalize reference-style links and images to the inline forms Milkdown emits, and exclude their non-rendered definition blocks, so server-authored markers survive the editor round trip. Edited-block diffs open only from the narrow right-gutter marker hit area, leaving the text body free for reading and selection. A top-level Markdown list remains one provenance action but displays each top-level item as a separate diff row; nested items stay with their parent item. `VITE_PROVENANCE=off` disables it. |
| Block drag-out           | Dragging a block out of a note creates a new note and deletes the block from the source as **one** undo entry (`MOVE_NOTE_EXCERPT`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Block move between notes | Dropping a block onto another note deletes and inserts atomically, again as one undo entry (`MOVE_NOTE_BLOCK_INTO_NOTE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Drop onto a note         | Huabu payloads dropped on a note append a block; the copy modifier decides move vs. copy, and locked notes decline the drop so the canvas creates a new node instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Drop into an open note   | The insertion point is read verbatim out of `prosemirror-drop-indicator`'s own state — the exact position the blue bar is drawing — so what the user sees and what lands can never disagree. That plugin targets the nearest block edge at any depth, so content can land inside a nested list item rather than after the whole list. Falls back to appending when no bar was showing.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| External `.md` import    | A `.md` file dropped into `<Space>/nodes/` from the OS file manager is picked up by a per-Space watcher and imported as a note — see [canvas-storage.md](./canvas-storage.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## Code entry points

| File                                                                                              | Responsibility                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`createMilkdown.ts`](../../apps/web/src/components/Milkdown/createMilkdown.ts)                   | Sole owner of Crepe/ProseMirror wiring: `tabContext`, `indentSelection`, `outdentSelection`, `handleLinkClick`, `normalizeSafeLinkHref`. |
| [`node.ts`](../../packages/shared/src/types/canvas/node.ts)                                       | `NoteNodeData` and the `isNoteNode` guard.                                                                                               |
| [`NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx)                           | Canvas card: layout shell, height-mode toggle, drop handling.                                                                            |
| [`NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                     | Expanded surface: `MilkdownEditor`, WYSIWYG/raw toggle, provenance overlay, write-through to `updateNodeData`.                           |
| [`blockProvenance.ts`](../../apps/web/src/utils/blockProvenance.ts)                               | Block keys and provenance realignment.                                                                                                   |
| [`MilkdownEditor.tsx`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)                 | Editable surface; reconciles the `editable` toggle onto a mounted instance.                                                              |
| [`MilkdownPreview.tsx`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx)               | Read-only surface; capture-phase key/paste/cut/drop suppression and the `Tab` focus exemption.                                           |
| [`platform.ts`](../../apps/web/src/utils/platform.ts)                                             | `isMac`, which selects the follow modifier.                                                                                              |
| [`main.ts`](../../apps/desktop/src/main.ts)                                                       | `setWindowOpenHandler` / `will-navigate` guards that turn `window.open` into `shell.openExternal`.                                       |
| [`blockCommands.test.ts`](../../apps/web/src/components/Milkdown/__tests__/blockCommands.test.ts) | Coverage for indent/outdent and for link activation, including the unsafe-scheme block.                                                  |
