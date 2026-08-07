# Milkdown Custom Toolbar Plan

Status: In-Progress
Last updated: 2026-07-07

## Problem

Huabu currently relies on Crepe's built-in floating selection toolbar for
Milkdown editing. The toolbar can be customized internally through
`featureConfigs[Crepe.Feature.Toolbar].buildToolbar`; `createMilkdown` already
uses that hook to append a block-type dropdown. That customization is still
Crepe-owned UI, rendered outside React, styled separately from the canvas node
toolbar, and not exposed as a public API on `MilkdownEditor` or
`MilkdownPreview`.

For note editing, the desired direction is a Huabu-owned React toolbar that
uses the same visual language as the canvas floating toolbars and calls a small
semantic command API on `MilkdownInstance`.

## Goals

1. Replace the editable note toolbar UI with a React toolbar that reuses the
   shared canvas toolbar chrome.
2. Keep Milkdown / ProseMirror internals contained inside
   `createMilkdown.ts`; callers should invoke semantic commands rather than
   touching Crepe state directly.
3. Disable Crepe's built-in toolbar wherever the Huabu toolbar is active so
   users never see two competing editing surfaces.
4. Support a focused V1 button set for expanded note editing without expanding
   into a general Milkdown toolbar configuration API.
5. Keep `MilkdownPreview` read-only by default and free of selection editing
   chrome.

## Non-Goals

1. Full arbitrary toolbar composition by feature plugins.
2. Exposing raw ProseMirror `EditorView`, `Ctx`, transactions, or Crepe toolbar
   builder APIs to React call sites.
3. Rebuilding slash menu, table controls, image upload, AI commands, or Crepe
   top-bar behavior in V1.
4. Per-workspace persistent toolbar preferences in V1.
5. Public toolbar composition or visibility settings in V1.

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

Both text-selection and block-handle entry points must route through the same
React toolbar and `MilkdownInstance.setBlockType()` command surface. Crepe's
legacy toolbar customization has been removed so the React toolbar is the single
editing toolbar path.

### Code Entry Points

| File/dir                                                                                                                                   | Responsibility                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`../../apps/web/src/components/Milkdown/MilkdownEditor.tsx`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)                   | Mount editable Milkdown and hand its instance to the note preview through `onReady`.               |
| [`../../apps/web/src/components/Milkdown/createMilkdown.ts`](../../apps/web/src/components/Milkdown/createMilkdown.ts)                     | Disable Crepe toolbar when requested; implement semantic editor commands and active-state queries. |
| [`../../apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx`](../../apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx) | React toolbar component for editable notes.                                                        |
| [`../../apps/web/src/components/Common/FloatingToolbar.tsx`](../../apps/web/src/components/Common/FloatingToolbar.tsx)                     | Shared toolbar chrome, buttons, dividers, selects, popovers.                                       |
| [`../../apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                     | Mount the note editing toolbar next to the editor in expanded note editing.                        |
| [`../../apps/web/src/components/Milkdown/MilkdownPreview.tsx`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx)                 | Keep preview surfaces read-only and toolbar-free.                                                  |

## Public API Shape

### `MilkdownEditorProps`

`MilkdownEditor` does not expose a public toolbar settings object in V1. The
React toolbar is owned by expanded note editing and is mounted by
`NotePreview` next to the editor instance it receives from `onReady`.

```ts
type MilkdownToolbarMode = 'none' | 'huabu';
```

`createMilkdown` keeps an internal `toolbarMode` option so editable notes can
enable the Huabu toolbar command path while `MilkdownPreview` uses `'none'`.
Crepe's built-in toolbar remains disabled in both modes.

### `MilkdownInstance`

V1 should add semantic commands and state reads rather than exposing editor
internals:

```ts
interface MilkdownInstance {
  focus(): void;
  getFormattingState(): MilkdownFormattingState;
  getSelectionRange(includeEmpty?: boolean): MilkdownTextRange | null;
  getActiveLink(): MilkdownLinkState | null;
  toggleMark(mark: MilkdownInlineMark): void;
  setBlockType(type: MilkdownBlockType): void;
  setTextColor(color: MilkdownTextColor | null): void;
  setBackgroundColor(color: MilkdownBackgroundColor | null): void;
  setLink(href: string | null, range?: MilkdownTextRange | null): void;
  insertInlineMath(): void;
  setInlineMath(value: string, range?: MilkdownTextRange | null): void;
}
```

`getFormattingState()` should be cheap and derived from the current selection.
If toolbar active state needs to update on every selection move, prefer an
`onFormattingStateUpdated(listener)` subscription over polling from React.

## V1 Toolbar Shape

The V1 toolbar is a fixed expanded-note toolbar, not a configurable toolbar
framework. It follows the active text selection with Floating UI and exposes the
formatting controls needed by note editing:

- Block type popup with the supported Milkdown block types grouped as Text,
  List, and Advanced.
- Inline typographic marks: bold, italic, and strikethrough.
- Text color and highlight color from Huabu `AccentToken` values.
- Link popover with safe URL handling.
- Inline code and inline math controls.

The toolbar should use Floating UI with a virtual selection reference, `offset`,
`flip`, `shift`, and `autoUpdate` so it appears near the selected text and can
choose a visible side when the editor is near a viewport edge.

`inlineCode` remains a mark internally, but the React toolbar should render it
next to inline math rather than beside bold / italic / strike because both code
and math represent inline literal/semantic content rather than typographic
emphasis.

The block-type control should render as a bounded, scrollable popup list rather
than a small fixed dropdown. Its default list mirrors Crepe's add menu grouping:
`Text` (`Text`, headings 1-6, quote, divider), `List` (bullet, ordered, task),
and `Advanced` (code, table, math). Internally, the plain-text block remains the
Milkdown `paragraph` node type, but the UI label follows Crepe and displays
`Text`. Unsupported or extension-gated block types should stay out of the
command surface. List and table actions should prefer Milkdown's own markdown
parser to create schema-valid nodes rather than hand-building ProseMirror node
trees. List actions preserve the user's current list item and nesting level;
when a cursor sits inside a nested ordered/task/bullet item, changing the list
type rewrites that item's immediate list segment rather than lifting the item or
replacing the whole top-level list. Editable Milkdown instances also bind
`Tab` / `Shift+Tab` to list indent / outdent for bullet, ordered, and task
items. When the current source block is a table, conversions back to text,
headings, quote, list, code, math, or divider should also replace the whole
top-level table from parser-created markdown instead of running textblock-only
ProseMirror commands inside a table cell.
The same replacement path should handle Crepe block-handle `NodeSelection`s so
block-handle-triggered toolbar actions do not diverge from text-selection
toolbar actions.

Text and background color controls should use shared `AccentToken` values from
`ACCENT_PALETTE` rather than arbitrary color input in V1. When applying a color,
the command should resolve the token through `resolveAccent()` and then derive
the rendered CSS through the same `getAccentTokens()` formulas used by semantic
zoom nodes: text color uses `accentTokens.fg`, and background/highlight color
uses `accentTokens.highlightBg` instead of `accentTokens.bg` because inline
highlights need more contrast than full-card node backgrounds. Passing `null` to
the command clears the corresponding color mark/style. Crepe does not ship a
public built-in text/background color toolbar command, so Huabu owns these as
custom Milkdown marks. Persisted markdown uses Huabu-owned
`<span data-huabu-...>` HTML; on parse, a remark preprocessor folds the
opening HTML node, inline children, and closing HTML node
back into one color mark so reopening WYSIWYG mode never displays the span source
as plain text.

Link editing uses a React popover and routes writes through
`MilkdownInstance.setLink()`, which rejects unsafe URL schemes.

### Deferred Until There Is a Real Multi-Context Need

| Capability                           | Reason to defer                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Configurable toolbar groups          | Adds public surface before there is more than one real toolbar consumer.       |
| Configurable visibility / placement  | Expanded note editing only needs selection-following behavior in V1.           |
| Configurable link or math modes      | Current note editing has concrete popover behavior; alternatives are not used. |
| Mobile-specific toolbar layout modes | Should be driven by screenshots after the fixed note toolbar is stable.        |

### Explicitly Out of V1

| Setting                                        | Reason                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Custom React render functions per toolbar item | Too much public surface before the internal command API is stable.        |
| Arbitrary ProseMirror command injection        | Leaks editor internals and makes focus / undo behavior hard to guarantee. |
| Persistent user toolbar customization          | Product decision; not needed for the first implementation.                |
| Public toolbar settings object                 | Over-designed while the toolbar only serves expanded note editing.        |
| Image, upload, AI, and rich table controls     | These are larger workflows with separate state and permissions.           |

## Implementation Plan

1. Keep the factory-level `toolbarMode?: 'none' | 'huabu'` internal option
   and keep `Crepe.Feature.Toolbar` disabled.
2. Move the existing block-type command implementation behind
   `MilkdownInstance.setBlockType()` and remove Crepe-specific toolbar DOM code
   once the React toolbar covers it.
3. Add inline mark commands using ProseMirror/Milkdown command helpers, each
   restoring editor focus after dispatch.
4. Add text color and background color commands that accept `AccentToken` values,
   apply the same derived `accentTokens.fg` / `accentTokens.bg` CSS used by node
   semantic zoom, clear the corresponding selection styling on `null`, and
   restore editor focus after dispatch.
5. Add formatting state reads/subscription so React buttons can render active
   state without inspecting the DOM.
6. Implement `MilkdownFloatingToolbar` with `FloatingToolbar.Group`,
   `ToggleButton`, `ActionButton`, a grouped scrollable block-type popup,
   color controls, and `Divider`.
7. Mount the toolbar in note editing flows and pass the instance received from
   `MilkdownEditor.onReady`.
8. Make `MilkdownPreview` explicitly toolbar-free, independent of drag mode.
9. Keep Crepe toolbar customization deleted; all note editing toolbar UI should
   go through `MilkdownFloatingToolbar`.

## Validation

1. Unit-test command methods where possible against a mounted Milkdown instance:
   mark toggles, block type changes, color changes, focus restoration, and
   markdown output.
2. Add interaction tests for note editing toolbar buttons in the web test suite.
3. Run `pnpm --filter @huabu/web typecheck` after API changes.
4. Manually verify desktop and narrow viewport layouts: no overlap with node
   toolbar, no duplicate Crepe toolbar, keyboard focus returns to the editor.
5. Verify preview contexts: AI message cards, collapsed note previews, and
   office previews do not show editing toolbar chrome.

## Open Questions

1. Should the toolbar appear for inline note editing on the canvas, expanded note
   editing, or both? Recommendation: expanded note editing first, because it has
   fewer collision risks with node-level canvas controls.
