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

| Surface                                                                         | Mount                                  | Notes                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`MilkdownEditor`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)   | `editable: true`                       | Full editing with React-owned chrome; Crepe's Toolbar / LinkTooltip are off. Defaults to `linkActivation="modifier"`; expanded Note explicitly uses `plain` with host navigation and a link-edit popover.                    |
| [`MilkdownPreview`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx) | `editable: false`                      | Pure display with `contenteditable=false`. Defaults to `linkActivation="plain"`; canvas `NoteNode` explicitly uses `modifier` so plain clicks remain available for node selection.                                           |
| `MilkdownPreview` with `enableBlockDrag`                                        | `editable: true` + `previewMode: true` | ProseMirror stays editable for block-drag hit testing, but input verbs are swallowed at capture and `aria-readonly` is set. Chat explicitly uses `plain` with the shared host navigation callback, without link-edit chrome. |

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

Canvas card links show a pointer cursor only while the platform follow modifier is held (Cmd on macOS, Ctrl elsewhere). Releasing the key or blurring the window restores the default arrow cursor. This uses the existing shared modifier-key subscription and a React host attribute outside ProseMirror's observed DOM; Chat and expanded Note links retain their plain-click pointer cursor.

Expanded `NotePreview` and Chat's `MilkdownMessageCard` explicitly use `linkActivation="plain"` and show the same pointer cursor on links. Their shared `openDocumentLink` host helper uses `isElectron()` to choose the destination: an unmodified primary click opens a new browser tab in the web app without changing Preview Workspace, or a permanent URL tab in the desktop [Preview Workspace](./preview-workspace.md). Note supplies its source node ID and Chat supplies its source thread ID. `openPreviewUrl` promotes a matching source tab and opens in that source's group, settling the source Note before navigation; following a link does not consume its temporary inspection tab. Reopening the same normalized URL activates its existing tab, including across groups. `Ctrl`-click (`Cmd` on macOS, where `Ctrl`-click is the secondary-click gesture) opens externally instead of invoking the host callback; the URL renderer also keeps an external-open button visible independently of iframe loading.

Activation policy is independent of `onLinkClick`: a callback selects the destination of an eligible plain click, but never enables plain activation by itself. Without an explicit policy, the factory defaults read-only and drag-only previews to `plain`, and other editable editors to `modifier`. Canvas `NoteNode` explicitly overrides the read-only default with `modifier`; a plain primary click has its native navigation prevented, returns unhandled, and bubbles for canvas selection without opening anything. Other modifier-policy editors likewise leave plain clicks available for caret placement. The shared pointer CSS targets `.milkdown .ProseMirror[data-link-activation='plain'] a[href]`, not a Note-specific wrapper.

Every factory link handler installs the same pointer tracking and multi-click suppression, whether or not a host callback exists. Pointer movement beyond the gesture threshold suppresses navigation, including an out-and-back drag; an older text selection does not block a fresh stationary click. Eligible first clicks open immediately, without a timer. Subsequent clicks with `detail > 1` do not reopen, but cannot cancel the first activation: double-clicking an eligible link is not a selection-only gesture. The same suppression applies to platform-modifier navigation. Secondary clicks do not invoke the host callback.

Focused links also support native Enter activation: an unmodified primary click with `detail === 0` is eligible under either policy without a follow modifier. It uses the same HTTP(S) validation and host callback or external-open path as an eligible plain click. Ordinary pointer clicks on canvas cards remain selection-only, and drag/repeated-click suppression is unchanged.

```
click / auxclick on <a href> → validate HTTP(S) href
  → unsafe → preventDefault, no navigation
  → safe primary click → preventDefault
    → drag / repeated click / policy-ineligible → unhandled, no navigation
    → (plain policy + plain click, or keyboard activation) + callback → openDocumentLink
      web → window.open; desktop → openPreviewUrl in source group
    → platform modifier, or eligible activation without callback → window.open
      web → browser tab; desktop → shell.openExternal
```

No preload API or IPC is involved in external opening: the desktop main process already routes `window.open` for `http(s)` targets to the OS browser. Expanded Note and Chat share host routing while retaining different editing capabilities; raw Markdown mode remains a source editor.

### Shared editable link controls

Every editable `MilkdownEditor` mounts one `MilkdownLinkPopover`, independently of link activation policy and navigation callback presence. Chat and read-only previews do not mount edit chrome. `MilkdownFloatingToolbar` has no separate link form, URL state, or submit path: its Link button and `Cmd/Ctrl+K` while its portalled controls have focus call the instance-scoped `requestLinkEdit()`. The editor's single `onLinkEditRequested()` subscriber opens the same panel used by editor shortcuts and link hover. Explicit requests capture the current selection or focused anchor rather than borrowing an open hover target. Once explicitly opened or focused, the panel cannot be retargeted by hover.

Pointer-over captures the hovered anchor's full link range without moving the caret or stealing focus; dragging and touch do not open it. A caret or selection wholly within one link expands to that full link, including mixed-mark runs. Other supported text selections open Create link with an empty URL, including ordinary text, mixed linked/unlinked text, multiple links with different URLs or titles, and native Select All. These snapshots retain exactly the selected inline extent rather than borrowing the first link's URL or expanding partially selected links. Inline atoms, code, and incompatible marks remain unsupported; the toolbar uses the same snapshot validator to disable Link for those selections. An empty unlinked caret and node selections do not create links; a collapsed caret does not show the selection toolbar.

The form edits display text and HTTP(S) URL, copies the captured existing address, or removes only the existing link mark. Copy and Remove are disabled for creation. Single-inline-range labels must be nonempty and single-line; cross-block selections keep a read-only display-text field and receive link marks without replacing text or flattening paragraphs/lists. The existing `editLink()`/`setLink()` transaction path replaces only selected link marks with the new shared URL, preserving unrelated marks, unchanged text runs, block structure, and unselected link fragments and attributes. Single-link editing retains that link's attributes; mixed/multiple-link creation does not inherit an arbitrary old title. Text and URL changes form one undoable transaction. All URLs use the shared safe-link validator.

Snapshots are opaque capabilities bound to the captured ProseMirror document identity and original selection. Document transactions invalidate stale panels immediately, including identity changes with equal serialized Markdown; selection-only transactions neither invalidate nor retarget them. Commands revalidate before writing. Escape restores the original selection and editor/focused-anchor focus only while the captured document is current; returning from toolbar chrome focuses the editor. Save, Enter, Remove, blur, and outside dismissal close the panel. Dismissal disarms hover until the pointer actually moves: document/overlay replacement can emit `pointerover` beneath a stationary pointer, but cannot reopen the just-saved panel. No DOM mutation inside ProseMirror is used.

### Preview link DOM updates

Read-only and drag-only previews share the factory's `nodrag` link attribute, including Chat message previews whose ProseMirror view remains editable for block dragging. The factory extends Milkdown's native `linkAttr` configuration, preserving inherited attributes, so ProseMirror renders the class itself on initial links and links introduced by `setMarkdown`. No plugin walks or patches link DOM after view updates: those writes can feed ProseMirror's DOM observer back into the plugin indefinitely, and even adding an already-present class emits an attribute mutation in Chromium. The class is a render attribute, not persisted Markdown. The Chromium regression in [preview-link-mutations.spec.ts](../../apps/web/e2e/preview-link-mutations.spec.ts) exercises the production factory with linked and link-free initial content, subsequent replacements, selection changes, and link navigation in both preview modes.

### Why the href is re-validated at click time

Only `setLink` screens what the _user_ types. Markdown parsed from an agent reply, a paste or an externally synced file renders its `href` verbatim, so `[docs](javascript:alert(1))` reaches the DOM as a live `<a href="javascript:alert(1)">`. In the desktop renderer that URL would run with application privileges.

An anchor's `javascript:` URL can only be activated by a click — browsers refuse it for middle-click and for the context menu's "open link" entries — so the click handler is the closing point. An unsafe href has its default suppressed but the handler returns `false`, so ProseMirror still places the caret and the text stays editable.

`normalizeSafeLinkHref` in `utils/safeLink.ts` admits `http:` and `https:` only; everything else, including relative and `mailto:` targets, is treated as unsafe. It preserves the trimmed original href for link invocation; the URL target model uses the same `parseSafeLinkUrl` validator's parsed `URL.href` for canonical identity without reparsing it. Milkdown, the URL target model, and the URL renderer reuse this validator without importing the editor into tab infrastructure.

---

## 7. Note-specific behaviours

These exist only for notes, and none of them are guessable from the node model above.

When a later agent rewrite restores a modified block to its original user-owned baseline, its pending `modified` provenance record is removed. The first edit saves the full-document normalized block fingerprint as `baselineKey`, without a duplicate occurrence suffix, and later edits retain it alongside `baselineMarkdown`. This preserves reference-link and reference-image identity even though the stored Markdown fragment omits document-level definitions. Legacy records without `baselineKey` retain best-effort fragment comparison; missing original definitions cannot be reconstructed reliably, so those records may retain a pending marker. Other pending records and operation history are unchanged.

| Behaviour                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block provenance         | The server stamps agent edits into `data.provenance` at the mutation source; the editor realigns markers to live block keys on re-serialization, and `<ProvenanceOverlay>` renders Accept / Reject / Restore. Sequential agent edits preserve the first pending user-owned baseline, so each diff accumulates all agent changes since that block was last changed or accepted by the user; an agent-only insertion that a later agent edit removes leaves no pending diff. Fingerprints run the same math-delimiter normalization as Milkdown, canonicalize reference-style links and images to the inline forms Milkdown emits, and exclude their non-rendered definition blocks, so server-authored markers survive the editor round trip. Edited-block diffs open only from the narrow right-gutter marker hit area, leaving the text body free for reading and selection. A top-level Markdown list remains one provenance action but displays each top-level item as a separate diff row; nested items stay with their parent item. `VITE_PROVENANCE=off` disables it. |
| Block drag-out           | Dragging a block out of a note creates a new note and deletes the block from the source as **one** undo entry (`MOVE_NOTE_EXCERPT`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Block move between notes | Dropping a block onto another note deletes and inserts atomically, again as one undo entry (`MOVE_NOTE_BLOCK_INTO_NOTE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Drop onto a note         | Huabu payloads dropped on a note append a block; the copy modifier decides move vs. copy, and locked notes decline the drop so the canvas creates a new node instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Drop into an open note   | The insertion point is read verbatim out of `prosemirror-drop-indicator`'s own state — the exact position the blue bar is drawing — so what the user sees and what lands can never disagree. That plugin targets the nearest block edge at any depth, so content can land inside a nested list item rather than after the whole list. Falls back to appending when no bar was showing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| External `.md` import    | A `.md` file dropped into `<Space>/nodes/` from the OS file manager is picked up by a per-Space watcher and imported as a note — see [canvas-storage.md](./canvas-storage.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## Code entry points

| File                                                                                                | Responsibility                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`createMilkdown.ts`](../../apps/web/src/components/Milkdown/createMilkdown.ts)                     | Sole owner of Crepe/ProseMirror wiring, explicit link activation, shared gesture tracking, and document-bound link snapshots and editing. |
| [`openDocumentLink.ts`](../../apps/web/src/utils/openDocumentLink.ts)                               | Shared Note/Chat host routing with source node or thread identity.                                                                        |
| [`MilkdownLinkPopover.tsx`](../../apps/web/src/components/Milkdown/MilkdownLinkPopover.tsx)         | Single editable-editor link panel for toolbar, keyboard and hover creation/editing, copy, remove, and snapshot invalidation.              |
| [`MilkdownFloatingToolbar.tsx`](../../apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx) | Formatting toolbar; forwards link actions and portal-focused shortcuts to the instance-scoped panel owner.                                |
| [`safeLink.ts`](../../apps/web/src/utils/safeLink.ts)                                               | Shared HTTP(S)-only link validation for Milkdown and URL preview targets.                                                                 |
| [`node.ts`](../../packages/shared/src/types/canvas/node.ts)                                         | `NoteNodeData` and the `isNoteNode` guard.                                                                                                |
| [`NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx)                             | Canvas card: layout shell, height-mode toggle, drop handling.                                                                             |
| [`NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                       | Expanded surface: `MilkdownEditor`, WYSIWYG/raw toggle, provenance overlay, write-through to `updateNodeData`.                            |
| [`blockProvenance.ts`](../../apps/web/src/utils/blockProvenance.ts)                                 | Block keys and provenance realignment.                                                                                                    |
| [`MilkdownEditor.tsx`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)                   | Editable surface; reconciles the `editable` toggle onto a mounted instance.                                                               |
| [`MilkdownPreview.tsx`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx)                 | Read-only surface; capture-phase key/paste/cut/drop suppression and the `Tab` focus exemption.                                            |
| [`platform.ts`](../../apps/web/src/utils/platform.ts)                                               | `isMac`, which selects the follow modifier.                                                                                               |
| [`main.ts`](../../apps/desktop/src/main.ts)                                                         | `setWindowOpenHandler` / `will-navigate` guards that turn `window.open` into `shell.openExternal`.                                        |
| [`blockCommands.test.ts`](../../apps/web/src/components/Milkdown/__tests__/blockCommands.test.ts)   | Coverage for indent/outdent and for link activation, including the unsafe-scheme block.                                                   |
