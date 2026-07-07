# Milkdown Custom Toolbar Plan

Status: In-Progress
Last updated: 2026-07-07

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

Both text-selection and block-handle entry points must route through the same
React toolbar and `MilkdownInstance.setBlockType()` command surface. Crepe's
legacy toolbar customization remains only as a temporary `'crepe'` migration
mode; it must not be extended as a parallel implementation for the Sediment
toolbar.

### Code Entry Points

| File/dir                                                                                                                                   | Responsibility                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`../../apps/web/src/components/Milkdown/MilkdownEditor.tsx`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)                   | Expose toolbar mode/settings props and `onReady` instance handoff.                                 |
| [`../../apps/web/src/components/Milkdown/createMilkdown.ts`](../../apps/web/src/components/Milkdown/createMilkdown.ts)                     | Disable Crepe toolbar when requested; implement semantic editor commands and active-state queries. |
| [`../../apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx`](../../apps/web/src/components/Milkdown/MilkdownFloatingToolbar.tsx) | React toolbar component for editable notes.                                                        |
| [`../../apps/web/src/components/Common/FloatingToolbar.tsx`](../../apps/web/src/components/Common/FloatingToolbar.tsx)                     | Shared toolbar chrome, buttons, dividers, selects, popovers.                                       |
| [`../../apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                     | Mount the note editing toolbar next to the editor in expanded note editing.                        |
| [`../../apps/web/src/components/Milkdown/MilkdownPreview.tsx`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx)                 | Keep preview surfaces read-only and toolbar-free.                                                  |

## Public API Draft

### `MilkdownEditorProps`

```ts
import type { AccentToken } from '@sediment/shared';

type MilkdownToolbarMode = 'none' | 'crepe' | 'sediment';
type MilkdownTextColor = AccentToken;
type MilkdownBackgroundColor = AccentToken;

interface MilkdownToolbarSettings {
  mode?: MilkdownToolbarMode;
  groups?: MilkdownToolbarGroup[];
  blockTypes?: 'all' | MilkdownBlockType[];
  inlineMarks?: MilkdownInlineMark[];
  showLink?: boolean;
  showMath?: boolean;
  showCode?: boolean;
  showTextColor?: boolean;
  showBackgroundColor?: boolean;
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
  setTextColor(color: MilkdownTextColor | null): void;
  setBackgroundColor(color: MilkdownBackgroundColor | null): void;
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

| Setting               | Values                                          | Why V1                                                                                                          |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `mode`                | `'none'`, `'sediment'`, temporary `'crepe'`     | Lets previews hide chrome, editable notes opt into the React toolbar, and migration fall back safely.           |
| `inlineMarks`         | `bold`, `italic`, `strike`, `inlineCode`        | Matches the visible Crepe inline toolbar and covers the most common editing actions.                            |
| `blockTypes`          | `'all'` or ordered supported block type IDs     | Lets users switch between every supported Milkdown block type through a scrollable popup list.                  |
| `showLink`            | boolean                                         | Link editing is already exposed by Crepe; V1 should provide an equivalent entry point or deliberately hide it.  |
| `showMath`            | boolean                                         | Math is a shipped content feature, so the toolbar should keep inline/block math discoverable.                   |
| `showTextColor`       | boolean                                         | Text color is a common note-editing affordance and should be available without opening Markdown syntax.         |
| `showBackgroundColor` | boolean                                         | Background/highlight color is useful for emphasis in notes and should ship with text color as a paired control. |
| `placement`           | `'selection'`, `'editor-top'`, `'node-toolbar'` | V1 follows the active text selection while keeping stable editor/node placements available for later variants.  |

Recommended V1 default:

```ts
const DEFAULT_MILKDOWN_TOOLBAR_SETTINGS = {
  mode: 'sediment',
  inlineMarks: ['bold', 'italic', 'strike', 'inlineCode'],
  blockTypes: 'all',
  showLink: true,
  showMath: true,
  showTextColor: true,
  showBackgroundColor: true,
  placement: 'selection',
} satisfies MilkdownToolbarSettings;
```

The selection placement should use Floating UI with a virtual selection
reference, `offset`, `flip`, `shift`, and `autoUpdate` so the toolbar appears
near the selected text and can choose a visible side when the editor is near a
viewport edge.

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
trees. When the current source block is a table, conversions back to text,
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
public built-in text/background color toolbar command, so Sediment owns these as
custom Milkdown marks. Persisted markdown uses Sediment-owned
`<span data-sediment-...>` HTML; on parse, a remark preprocessor folds the
opening HTML node, inline children, and closing HTML node
back into one color mark so reopening WYSIWYG mode never displays the span source
as plain text.

Link editing starts with a basic URL prompt behind `MilkdownInstance.toggleLink()`.
A custom popover can replace that prompt once validation and keyboard behavior are
designed.

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
| Image, upload, AI, and rich table controls     | These are larger workflows with separate state and permissions.           |

## Implementation Plan

1. Add `toolbarMode?: 'none' | 'crepe' | 'sediment'` to the factory options and
   disable `Crepe.Feature.Toolbar` when the mode is `'none'` or `'sediment'`.
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
9. Remove the Crepe toolbar migration path after parity is verified.

## Validation

1. Unit-test command methods where possible against a mounted Milkdown instance:
   mark toggles, block type changes, color changes, focus restoration, and
   markdown output.
2. Add interaction tests for note editing toolbar buttons in the web test suite.
3. Run `pnpm --filter @sediment/web typecheck` after API changes.
4. Manually verify desktop and narrow viewport layouts: no overlap with node
   toolbar, no duplicate Crepe toolbar, keyboard focus returns to the editor.
5. Verify preview contexts: AI message cards, collapsed note previews, and
   office previews do not show editing toolbar chrome.

## Open Questions

1. Should `editor-top` remain as a configurable fallback for contexts where
   selection-following UI is too noisy? Recommendation: keep the setting but use
   `selection` as the editable note default.
2. Should the basic link URL prompt be replaced with a custom popover matching
   canvas toolbar style? Recommendation: keep the prompt until validation and
   keyboard behavior are designed.
3. Should the toolbar appear for inline note editing on the canvas, expanded note
   editing, or both? Recommendation: expanded note editing first, because it has
   fewer collision risks with node-level canvas controls.
