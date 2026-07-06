# Milkdown Custom Toolbar Plan

Status: Draft
Last updated: 2026-07-06

## Problem

Sediment currently relies on Crepe's built-in floating selection toolbar for
Milkdown editing. The toolbar can be customized internally through
`featureConfigs[Crepe.Feature.Toolbar].buildToolbar`; `createMilkdown` already
uses that hook to append a block-type dropdown. That customization is still
Crepe-owned UI, rendered outside React, styled separately from the canvas node
toolbar, and not exposed as a public API on `MilkdownEditor` or
`MilkdownPreview`.

For note editing, the desired direction is a Sediment-owned React toolbar that
uses the same visual language as the canvas floating toolbars and calls a small
semantic command API on `MilkdownInstance`.

## Goals

1. Replace the editable note toolbar UI with a React toolbar that reuses the
   shared canvas toolbar chrome.
2. Keep Milkdown / ProseMirror internals contained inside
   `createMilkdown.ts`; callers should invoke semantic commands rather than
   touching Crepe state directly.
3. Disable Crepe's built-in toolbar wherever the Sediment toolbar is active so
   users never see two competing editing surfaces.
4. Support a focused V1 set of formatting settings that covers common note
   editing without expanding into a full document editor.
5. Keep `MilkdownPreview` read-only by default and free of selection editing
   chrome.

## Non-Goals

1. Full arbitrary toolbar composition by feature plugins.
2. Exposing raw ProseMirror `EditorView`, `Ctx`, transactions, or Crepe toolbar
   builder APIs to React call sites.
3. Rebuilding slash menu, table controls, image upload, AI commands, or Crepe
   top-bar behavior in V1.
4. Per-workspace persistent toolbar preferences in V1.

## Proposed Shape

### Ownership Boundary

```
React toolbar UI
  -> MilkdownInstance semantic commands
    -> createMilkdown.ts owns Crepe / ProseMirror commands
      -> markdownUpdated emits controlled markdown
```

The React toolbar owns rendering, grouping, icons, disabled states, and canvas
popover positioning. `createMilkdown.ts` owns editor command execution,
selection inspection, focus restoration, and feature toggles.

### Code Entry Points

| File/dir                                                                                                                   | Responsibility                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`../../apps/web/src/components/Milkdown/MilkdownEditor.tsx`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)   | Expose toolbar mode/settings props and `onReady` instance handoff.                                 |
| [`../../apps/web/src/components/Milkdown/createMilkdown.ts`](../../apps/web/src/components/Milkdown/createMilkdown.ts)     | Disable Crepe toolbar when requested; implement semantic editor commands and active-state queries. |
| `apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx` (planned)                                                   | New React toolbar component for editable notes.                                                    |
| [`../../apps/web/src/components/Common/FloatingToolbar.tsx`](../../apps/web/src/components/Common/FloatingToolbar.tsx)     | Shared toolbar chrome, buttons, dividers, selects, popovers.                                       |
| [`../../apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)     | Mount the note editing toolbar next to the editor in expanded note editing.                        |
| [`../../apps/web/src/components/Milkdown/MilkdownPreview.tsx`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx) | Keep preview surfaces read-only and toolbar-free.                                                  |

## Public API Draft

### `MilkdownEditorProps`

```ts
type MilkdownToolbarMode = 'none' | 'crepe' | 'sediment';

interface MilkdownToolbarSettings {
  mode?: MilkdownToolbarMode;
  groups?: MilkdownToolbarGroup[];
  blockTypes?: MilkdownBlockType[];
  inlineMarks?: MilkdownInlineMark[];
  showLink?: boolean;
  showMath?: boolean;
  showCode?: boolean;
}
```

`mode` defaults to `'sediment'` for editable `MilkdownEditor` instances once the
new toolbar ships. `MilkdownPreview` should use `'none'` internally.
`'crepe'` remains as a temporary migration escape hatch until the React toolbar
reaches parity with the current editing flow.

### `MilkdownInstance`

V1 should add semantic commands and state reads rather than exposing editor
internals:

```ts
interface MilkdownInstance {
  focus(): void;
  getFormattingState(): MilkdownFormattingState;
  toggleMark(mark: MilkdownInlineMark): void;
  setBlockType(type: MilkdownBlockType): void;
  toggleLink(): void;
  insertInlineMath(): void;
  setCodeBlock(): void;
}
```

`getFormattingState()` should be cheap and derived from the current selection.
If toolbar active state needs to update on every selection move, prefer an
`onFormattingStateUpdated(listener)` subscription over polling from React.

## V1 Settings Priority

### P0: Ship First

| Setting       | Values                                                                                                        | Why V1                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `mode`        | `'none'`, `'sediment'`, temporary `'crepe'`                                                                   | Lets previews hide chrome, editable notes opt into the React toolbar, and migration fall back safely.          |
| `inlineMarks` | `bold`, `italic`, `strike`, `inlineCode`                                                                      | Matches the visible Crepe inline toolbar and covers the most common editing actions.                           |
| `blockTypes`  | `paragraph`, `heading-1`, `heading-2`, `heading-3`, `blockquote`, `bullet-list`, `ordered-list`, `code-block` | Matches the existing custom block-type dropdown behavior and preserves content while changing block shape.     |
| `showLink`    | boolean                                                                                                       | Link editing is already exposed by Crepe; V1 should provide an equivalent entry point or deliberately hide it. |
| `showMath`    | boolean                                                                                                       | Math is a shipped content feature, so the toolbar should keep inline/block math discoverable.                  |
| `placement`   | `'selection'`, `'editor-top'`, `'node-toolbar'`                                                               | Allows V1 to start with a stable note-level placement while leaving room for selection-following UI.           |

Recommended V1 default:

```ts
const DEFAULT_MILKDOWN_TOOLBAR_SETTINGS = {
  mode: 'sediment',
  inlineMarks: ['bold', 'italic', 'strike', 'inlineCode'],
  blockTypes: [
    'paragraph',
    'heading-1',
    'heading-2',
    'heading-3',
    'blockquote',
    'bullet-list',
    'ordered-list',
    'code-block',
  ],
  showLink: true,
  showMath: true,
  placement: 'editor-top',
} satisfies MilkdownToolbarSettings;
```

### P1: Add After V1 Stabilizes

| Setting        | Values                               | Reason to defer                                                                        |
| -------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `groups`       | ordered group IDs                    | Useful for product variants, but it adds API surface before the command set is proven. |
| `visibleWhen`  | `'selection'`, `'focus'`, `'always'` | Requires more selection/focus state plumbing and keyboard testing.                     |
| `linkMode`     | `'prompt'`, `'popover'`              | A polished link popover should be designed with validation and keyboard behavior.      |
| `mathMode`     | `'inline'`, `'block'`, `'both'`      | Needs clear UX around existing selection replacement.                                  |
| `mobileLayout` | `'scroll'`, `'wrap'`, `'compact'`    | Should be driven by screenshots once desktop behavior is correct.                      |

### Explicitly Out of V1

| Setting                                        | Reason                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Custom React render functions per toolbar item | Too much public surface before the internal command API is stable.        |
| Arbitrary ProseMirror command injection        | Leaks editor internals and makes focus / undo behavior hard to guarantee. |
| Persistent user toolbar customization          | Product decision; not needed for the first implementation.                |
| Table, image, upload, and AI toolbar groups    | These are larger workflows with separate state and permissions.           |

## Implementation Plan

1. Add `toolbarMode?: 'none' | 'crepe' | 'sediment'` to the factory options and
   disable `Crepe.Feature.Toolbar` when the mode is `'none'` or `'sediment'`.
2. Move the existing block-type command implementation behind
   `MilkdownInstance.setBlockType()` and remove Crepe-specific toolbar DOM code
   once the React toolbar covers it.
3. Add inline mark commands using ProseMirror/Milkdown command helpers, each
   restoring editor focus after dispatch.
4. Add formatting state reads/subscription so React buttons can render active
   state without inspecting the DOM.
5. Implement `MilkdownFloatingToolbar` with `FloatingToolbar.Group`,
   `ToggleButton`, `ActionButton`, `ToolbarSelect`, and `Divider`.
6. Mount the toolbar in note editing flows and pass the instance received from
   `MilkdownEditor.onReady`.
7. Make `MilkdownPreview` explicitly toolbar-free, independent of drag mode.
8. Remove the Crepe toolbar migration path after parity is verified.

## Validation

1. Unit-test command methods where possible against a mounted Milkdown instance:
   mark toggles, block type changes, focus restoration, and markdown output.
2. Add interaction tests for note editing toolbar buttons in the web test suite.
3. Run `pnpm --filter @sediment/web typecheck` after API changes.
4. Manually verify desktop and narrow viewport layouts: no overlap with node
   toolbar, no duplicate Crepe toolbar, keyboard focus returns to the editor.
5. Verify preview contexts: AI message cards, collapsed note previews, and
   office previews do not show editing toolbar chrome.

## Open Questions

1. Should the first React toolbar be anchored to the expanded note editor frame
   or follow the text selection? Recommendation: start with editor-top placement
   for predictable layout, then add selection-following behavior after commands
   are stable.
2. Should link editing open a lightweight URL prompt first, or a custom popover
   matching canvas toolbar style? Recommendation: start with a simple popover if
   the existing common popover primitives are enough; otherwise hide link in V1
   rather than shipping a rough prompt.
3. Should the toolbar appear for inline note editing on the canvas, expanded note
   editing, or both? Recommendation: expanded note editing first, because it has
   fewer collision risks with node-level canvas controls.
