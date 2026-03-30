# Sediment Design System

> This document is the single source of truth for all UI styling decisions.
> It is consumed by both humans (for review) and AI (for code generation).
>
> **AI Usage**: When generating any new UI component, follow the decision tree
> in §1 first, then apply the token table in §2, and finally match the
> size × function matrix in §3 for exact class names.

---

## §1 — Decision Tree: Reuse First

Before writing ANY new styling, walk this tree top-down. Stop at the first
match and use the existing component.

```
START
│
├─ Is it a button / clickable control?
│  ├─ Icon-only (no text label) → <Button iconOnly>
│  │   • ghost   — toolbar icon, copy, expand, close …
│  │   • outline — round bordered action (settings) …
│  │   • solid   — round filled action (send) …
│  │
│  ├─ Has text label → <Button>
│  │   • primary   — confirm / save (theme-colored)
│  │   • secondary — cancel / dismiss (neutral)
│  │   • danger    — destructive action
│  │   • ghost     — text-only inline action
│  │   • pill      — selector / tag trigger (mode switch, filter)
│  │
│  └─ Canvas drag handle → <DragToCanvasHandleButton>
│
│  All buttons auto-wrap <Tooltip> when `title` is set.
│
├─ Is it an input field that needs a tooltip?
│  └─ <Input title="…"> (drop-in <input>, auto-wraps Tooltip)
│
├─ Is it a floating layer?
│  ├─ Tooltip        → <Tooltip>
│  ├─ Modal / dialog → <Modal>
│  ├─ Popover        → <Popover>
│  ├─ Dropdown menu  → <DropdownMenu> + <DropdownMenuItem>
│  └─ Select         → <Select> (single-value picker with trigger button)
│  (all portal-based, handle positioning & dismissal internally)
│
├─ Is it a loading indicator?
│  ├─ Inline spinner (inside button, next to text) → <Spinner>
│  ├─ Centered area with optional message     → <LoadingState>
│  └─ Overlay covering a parent container     → <LoadingState overlay>
│
├─ Is it an empty / zero-data state?
│  └─ <EmptyState message="…" action={<Button>…</Button>}>
│
├─ Is it a sidebar / panel shell?
│  └─ <SidebarPanel>
│
├─ Is it a canvas node?
│  └─ <NodeWrapper> (provides ring, toolbar, handles, drag, resize)
│
└─ NONE matched → Build a new component following §2 tokens + §3 matrix
```

---

## §2 — Design Tokens (Universal Rules)

These rules apply **unconditionally** to ALL components, at every level.

### 2.1 Colors

> **Naming convention**: `fg-*` = text/foreground, `bg-*` = surfaces, `edge-*` = borders.
> All tokens are CSS custom properties defined in `index.css` `:root` and mapped to
> Tailwind utility classes via `@theme inline`.

#### Text Hierarchy

| Token (Tailwind class) | CSS variable   | Light value | When to use                                           |
| ---------------------- | -------------- | ----------- | ----------------------------------------------------- |
| `text-fg-default`      | `--fg-default` | `#191919`   | All primary text, labels, titles                      |
| `text-fg-muted`        | `--fg-muted`   | `#6b6b6b`   | Secondary text, descriptions, form labels             |
| `text-fg-subtle`       | `--fg-subtle`  | `#ababab`   | Icons, placeholders, timestamps, metadata             |
| `text-fg-inverse`      | `--fg-inverse` | `#ffffff`   | Text on dark surfaces (solid buttons, tooltip, toast) |
| `text-info`            | `--info`       | `#2e90ff`   | Active / selected state text, toggle-on indicator     |
| `text-danger`          | `--danger`     | `#dc2626`   | Error text, destructive action labels                 |

#### Surface & Background

| Token (Tailwind class) | CSS variable      | Light value | When to use                                               |
| ---------------------- | ----------------- | ----------- | --------------------------------------------------------- |
| `bg-surface`           | `--bg-surface`    | `#ffffff`   | All surfaces: panels, cards, toolbars, popovers           |
| `bg-bg-default`        | `--bg-default`    | `#f5f5f5`   | Page canvas, hover state for ghost buttons, active tab bg |
| `bg-hover`             | `--bg-hover`      | `#efefef`   | Hover state for buttons, list items                       |
| `bg-inverse`           | `--bg-inverse`    | `#1f1f1f`   | Tooltip, toast, solid button backgrounds                  |
| `bg-info-bg`           | `--info-bg`       | `#f2f8ff`   | Active toggle background, TreeRow highlight               |
| `bg-info-bg-hover`     | `--info-bg-hover` | `#dbeafe`   | TreeRow selected state                                    |
| `bg-danger-bg`         | `--danger-bg`     | `#fff7f8`   | Error / cancel background                                 |
| `bg-success-bg`        | `--success-bg`    | `#f0fdf4`   | Success background                                        |

#### Border & Ring

| Token (Tailwind class) | CSS variable     | Light value      | When to use                                        |
| ---------------------- | ---------------- | ---------------- | -------------------------------------------------- |
| `border-edge-default`  | `--edge-default` | `#e6e6e6`        | **Every** border in the app uses this single color |
| `border-border`        | `--border`       | (= edge-default) | ShadCN bridge alias — same value                   |
| `ring-info`            | `--info`         | `#2e90ff`        | Selected node ring, focus ring for primary actions |
| `ring-edge-default`    | `--edge-default` | `#e6e6e6`        | Hover ring on unselected nodes                     |

#### Status Colors

| Token (Tailwind class) | CSS variable        | Light value | When to use                         |
| ---------------------- | ------------------- | ----------- | ----------------------------------- |
| `text-success`         | `--success`         | `#16a34a`   | Success text, auth confirmed        |
| `text-success-light`   | `--success-light`   | `#22c55e`   | Success icon                        |
| `bg-success-bg`        | `--success-bg`      | `#f0fdf4`   | Success background                  |
| `text-warning`         | `--warning`         | `#d97706`   | Warning text                        |
| `text-warning-light`   | `--warning-light`   | `#f59e0b`   | Warning icon, context usage ring    |
| `text-info`            | `--info`            | `#2e90ff`   | Info status text                    |
| `text-info-light`      | `--info-light`      | `#8ac2ff`   | Info status icon                    |
| `bg-info-bg`           | `--info-bg`         | `#f2f8ff`   | Info status background              |
| `bg-info-bg-hover`     | `--info-bg-hover`   | `#dbeafe`   | Info status hover                   |
| `text-danger`          | `--danger`          | `#dc2626`   | Danger text                         |
| `text-danger-light`    | `--danger-light`    | `#f87171`   | Danger icon color (lighter variant) |
| `bg-danger-bg`         | `--danger-bg`       | `#fff7f8`   | Danger background                   |
| `bg-danger-bg-hover`   | `--danger-bg-hover` | `#fee2e2`   | Danger hover background             |

#### AI Colors

| Token (Tailwind class) | CSS variable | Light value                | When to use              |
| ---------------------- | ------------ | -------------------------- | ------------------------ |
| `text-ai` / `bg-ai`    | `--ai`       | `#bda6ce`                  | AI accent                |
| `bg-ai-light`          | `--ai-light` | `rgba(189, 166, 206, 0.3)` | AI accent at 30% opacity |
| `bg-ai-bg`             | `--ai-bg`    | `rgba(189, 166, 206, 0.1)` | AI background            |

#### Diff Colors

| Token (Tailwind class)   | CSS variable          | Light value      | When to use             |
| ------------------------ | --------------------- | ---------------- | ----------------------- |
| `bg-diff-added-bg`       | `--diff-added-bg`     | = `--success-bg` | Added line background   |
| `text-diff-added-text`   | `--diff-added-text`   | = `--success`    | Added line text         |
| `bg-diff-removed-bg`     | `--diff-removed-bg`   | = `--danger-bg`  | Removed line background |
| `text-diff-removed-text` | `--diff-removed-text` | = `--danger`     | Removed line text       |

#### ShadCN Bridge (for @blocknote/shadcn only)

These variable names are fixed by ShadCN. They alias to system tokens:
`--background` → `--bg-default`, `--foreground` → `--fg-default`, `--border` → `--edge-default`,
`--primary` → `--bg-inverse`, `--muted-foreground` → `--fg-subtle`, `--destructive` → `--danger`,
`--card` → white/dark surface, `--popover` → same as card.
**Do NOT use ShadCN class names** (`bg-card`, `text-muted-foreground`, etc.) in new components —
use the system tokens (`bg-surface`, `text-fg-subtle`, etc.) instead.

> **Node color presets** (§4.3, §4.4) are an intentional exception — they use Tailwind
> default palette colors (`red-50`, `orange-500`, etc.) because they represent
> user-selectable decorative colors, not semantic UI tokens.

### 2.2 Typography

| Property        | Class                        | Usage                                      |
| --------------- | ---------------------------- | ------------------------------------------ |
| Page title      | `text-lg font-medium`        | Header workspace name                      |
| Section heading | `text-sm font-semibold`      | Panel headers, modal titles, form headings |
| Body text       | `text-m leading-relaxed`     | Chat message content                       |
| UI labels       | `text-sm font-medium`        | Tab labels, form labels, tree row text     |
| Small text      | `text-xs font-medium`        | Toolbar labels, metadata, card subtitles   |
| Micro text      | `text-[10px] uppercase`      | Badges ("PREVIEW")                         |
| Placeholder     | `placeholder:text-fg-subtle` | Input / textarea placeholders              |

**Font families** (TextNode only): Default (system sans), Serif, Mono, Hand.

### 2.3 Spacing Conventions

| Context            | Padding              | Gap                  |
| ------------------ | -------------------- | -------------------- |
| Page-level header  | `px-3`               | `gap-3`              |
| Panel header bar   | `px-3`               | (flex space-between) |
| Panel content area | `p-3`                | —                    |
| Modal              | `p-6`                | `gap-4`              |
| Popover            | `p-4`                | `gap-3`              |
| Toolbar (node)     | `px-2 py-1`          | `gap-3`              |
| Toolbar (canvas)   | `p-2`                | `gap-2`              |
| Card               | `px-3 py-2`          | `gap-2`              |
| Chat input         | `p-3`                | (internal `mt-2`)    |
| Message bubble     | `px-4 py-3` or `p-3` | —                    |
| Form field block   | `mb-3`               | —                    |

### 2.4 Border Radius

| Class          | px                | When to use                                                             |
| -------------- | ----------------- | ----------------------------------------------------------------------- |
| `rounded-full` | 9999px            | Button `shape="pill"`, color swatches, progress bar, resize handle pill |
| `rounded-2xl`  | 16px              | Chat message bubbles, ChatInput container                               |
| `rounded-lg`   | `--radius` (10px) | CanvasToolbar, Modal, Popover, SourceCard, dropdown menu                |
| `rounded-md`   | 8px               | Tooltip, NodeToolbar, form inputs, form buttons                         |
| `rounded`      | 4px               | Button ghost variant, NodeWrapper content, tab buttons, TreeRow inner   |
| `rounded-sm`   | 2px               | Inline edit input                                                       |

### 2.5 Shadows

| Class           | Value                         | When to use                                                                |
| --------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `shadow-bottom` | `0 2px 12px rgba(0,0,0,0.08)` | Tooltip, NodeToolbar, CanvasToolbar, Modal, color picker float, focus glow |
| `shadow-lg`     | (Tailwind default)            | Popover, dropdown menu                                                     |

### 2.6 Z-Index Layers

| z-index  | Usage                                                      |
| -------- | ---------------------------------------------------------- |
| `z-9999` | Modal backdrop + dialog                                    |
| `z-50`   | Tooltip, color picker float                                |
| `z-40`   | Invisible dismiss overlay (behind color picker / dropdown) |
| `z-10`   | Node-level overlays (frame label, loading spinner)         |

### 2.7 Icon Sizing

| Icon context                 | `size` | `strokeWidth` |
| ---------------------------- | ------ | ------------- |
| Canvas toolbar buttons       | `18`   | default (2)   |
| Panel toggle / action icons  | `16`   | default (2)   |
| NodeToolbar / inline icons   | `14`   | default (2)   |
| Data source panel node icons | `14`   | `1.5`         |
| Tree row chevron / lock      | `12`   | `1.5`         |
| Upload empty state / hero    | `24`   | default (2)   |

### 2.8 Disabled State

All interactive elements: `disabled:cursor-not-allowed disabled:opacity-50`.

### 2.9 Transitions & Animation

| Effect        | Class                                        | Usage                              |
| ------------- | -------------------------------------------- | ---------------------------------- |
| Color hover   | `transition-colors`                          | All hover color changes            |
| Scale hover   | `hover:scale-110` or `hover:scale-125`       | Color swatches                     |
| Visibility    | `transition-opacity`                         | Drag handles, connection handles   |
| Spin          | `animate-spin`                               | Loading spinner                    |
| Pulse         | `animate-pulse`                              | Loading ellipsis                   |
| Enter         | `animate-in fade-in zoom-in duration-200`    | Modal, popover, color picker float |
| Enter (modal) | `animate-in zoom-in-95 fade-in duration-200` | UploadModal                        |

### 2.10 Dividers

| Type                     | Implementation                                                   | Usage                                |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------ |
| Horizontal rule          | `border-b border-edge-default`                                   | Below Header, below panel header bar |
| Vertical panel edge      | `border-l border-edge-default` or `border-r border-edge-default` | Between panels                       |
| Inline separator (short) | `<div className="bg-edge-default h-3 w-px" />`                   | Inside NodeToolbar                   |
| Inline separator (tall)  | `<div className="bg-edge-default mx-1 h-4 w-px" />`              | Inside CanvasToolbar                 |

---

## §3 — Size × Function Matrix

Use this matrix to determine the exact styling for any UI element.
**Rows** = size level (from largest to smallest).
**Columns** = functional category.

### 3.0 How to Read

1. Find your element's **size level** (L1–L7).
2. Find its **function** (Container, Toolbar, Interactive, Display).
3. The cell gives the exact Tailwind classes and constraints.

---

### 3.1 L1 — App Shell

> The outermost layout frame. Only one instance in the app.

| Property    | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| Component   | `MainLayout`                                                      |
| Layout      | `flex flex-col h-full w-full overflow-hidden`                     |
| Header      | `h-12 border-b border-edge-default bg-surface px-3 gap-3`         |
| Content row | `flex min-h-0 flex-1`                                             |
| Children    | Left Panel → Resize Handle → Center → Resize Handle → Right Panel |

---

### 3.2 L2 — Panel

> Collapsible side panels and expanded content panels.

| Property         | Expanded                                                                    | Collapsed                                                        |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Component        | `SidebarPanel`                                                              | `SidebarPanel`                                                   |
| Background       | `bg-surface`                                                                | `bg-surface`                                                     |
| Width            | Left: 260px (min 200, max 30%); Right: 420px (min 200, max 50%)             | 48px                                                             |
| Header           | `h-12 border-b border-edge-default px-3`                                    | —                                                                |
| Content padding  | `p-3`                                                                       | —                                                                |
| Overflow         | `overflow-y-auto`                                                           | —                                                                |
| Side border      | Left: `border-r border-edge-default`; Right: `border-l border-edge-default` | same                                                             |
| Collapsed label  | —                                                                           | `text-xs font-semibold text-fg-muted [writing-mode:vertical-rl]` |
| Toggle icon size | —                                                                           | `16`                                                             |

**Resize Handle** (between panels):
`w-2 bg-transparent cursor-col-resize` with inner pill
`h-8 w-1 rounded-full bg-fg-subtle opacity-0 → group-hover:h-12 group-hover:opacity-100 duration-300`

**ExpandedNodePanel header**: `h-10 border-b border-edge-default px-3 gap-3`
Title: `text-xs font-medium text-fg-muted truncate`

---

### 3.3 L3 — Card / Container

> Visually distinct surface that holds content.

#### Message Bubbles

| Variant    | Background      | Radius        | Border                       | Padding     | Align         |
| ---------- | --------------- | ------------- | ---------------------------- | ----------- | ------------- |
| User       | `bg-bg-default` | `rounded-2xl` | none                         | `p-3`       | right         |
| AI         | `bg-surface`    | `rounded-2xl` | none                         | `px-4 pt-2` | left (`ml-1`) |
| Tool       | `bg-surface`    | `rounded-2xl` | `border border-edge-default` | `px-4 py-3` | left          |
| Tool error | `bg-danger-bg`  | `rounded-2xl` | `border border-edge-default` | `px-4 py-3` | left          |
| Research   | status-color bg | `rounded-2xl` | `border` + status-color      | `p-4`       | left          |

Font: `text-m leading-relaxed`. Between messages: `space-y-1`.

#### SourceCard

`rounded-lg border border-edge-default bg-surface px-3 py-2 hover:bg-bg-default`
Favicon: `h-3.5 w-3.5 rounded-sm`.
DragHandle: hidden by default, `opacity-0 group-hover:opacity-100`.

#### ChatInput Container

`rounded-2xl border border-edge-default bg-surface p-3`

#### Modal (UploadModal)

| Property        | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Backdrop        | `fixed inset-0 bg-bg-default/80 backdrop-blur-[1px] z-9999`               |
| Dialog          | `rounded-lg border border-edge-default bg-surface shadow-bottom w-90 p-6` |
| Title           | `text-sm font-semibold text-fg-default`                                   |
| Close button    | `text-fg-subtle hover:text-danger rounded p-1`, icon `X size={16}`        |
| Enter animation | `animate-in zoom-in-95 fade-in duration-200`                              |

#### Popover

| Property       | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| Surface        | `rounded-lg border border-edge-default bg-surface shadow-lg` + size/padding per use case    |
| Position       | `fixed`, configurable via `anchor` (`top-left`, `top-right`, `bottom-left`, `bottom-right`) |
| Implementation | `createPortal(…, document.body)`                                                            |

#### Dropdown Menu / Select

Both `<DropdownMenu>` and `<Select>` use `<Popover>` internally and share a unified
`align` prop (`bottom-left`, `bottom-right`, `top-left`, `top-right`) for panel placement
relative to the trigger.

| Property    | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Surface     | `rounded border border-edge-default bg-surface shadow-lg py-1`  |
| Item        | `px-4 py-2 text-sm text-fg-muted w-full justify-start`          |
| Active item | `bg-info-bg` (DropdownMenu) / `text-info` + check icon (Select) |

---

### 3.4 L4 — Toolbar / Bar

> Floating or docked strips of controls.

#### NodeToolbar (per-node floating)

| Property        | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Shape           | `rounded-md border border-edge-default bg-surface shadow-bottom`      |
| Size            | `h-8 px-2 py-1 gap-3`                                                 |
| Position        | Above node, `offset={12}`, visible when single-selected               |
| Icon size       | `14`                                                                  |
| Icon color      | `text-fg-subtle`                                                      |
| Section divider | `<div className="bg-edge-default h-3 w-px" />`                        |
| Layout          | Left: type icon → divider → Right: Button iconOnly ghost action icons |

#### CanvasToolbar (bottom floating)

| Property      | Value                                               |
| ------------- | --------------------------------------------------- |
| Shape         | `rounded-lg border-0 bg-surface shadow-bottom`      |
| Size          | `p-2 gap-2`                                         |
| Position      | `Panel position="bottom-center" className="mb-6"`   |
| Icon size     | `18`                                                |
| Icon color    | `text-fg-subtle`, active: `text-info bg-bg-default` |
| Group divider | `<div className="bg-edge-default mx-1 h-4 w-px" />` |

#### Panel Header Bar

Already defined in §3.2. Key: `h-12 px-3 border-b border-edge-default bg-surface`.

#### Tabs (inside panel header)

| State    | Classes                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| Active   | `bg-bg-default text-fg-default rounded px-2 py-1 text-sm font-medium`         |
| Inactive | `text-fg-muted hover:text-fg-default rounded px-2 py-1 text-sm font-semibold` |

---

### 3.5 L5 — Row / List Item

> Repeated items in a scrollable list.

#### TreeRowItem

| Property                              | Value                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| Height                                | `h-9`                                                        |
| Background                            | `bg-surface`                                                 |
| Inner wrapper                         | `rounded px-2 py-1 text-sm transition-colors`                |
| Indent                                | `paddingLeft: 12 + depth × 16` px                            |
| Default hover                         | `hover:bg-bg-default`                                        |
| Selected                              | `bg-info-bg-hover`                                           |
| Highlighted (child of selected frame) | `bg-info-bg`                                                 |
| Icon                                  | `text-fg-subtle size={14} strokeWidth={1.5}`                 |
| Label                                 | `text-fg-default truncate select-none`                       |
| Chevron                               | `size={12} strokeWidth={1.5}`                                |
| Edit input                            | `h-6 rounded-sm border bg-surface px-1 text-xs outline-none` |
| Lock / action icons                   | appear on hover, `size={12} strokeWidth={1.5}`               |

#### ResearchStepItem

`flex items-start gap-2 text-xs`
Status icon: `h-3 w-3`. Title: `font-medium text-fg-default`. Detail: `mt-0.5 text-fg-muted`.

---

### 3.6 L6 — Button / Control

> All clickable controls. **Always check §1 reuse tree first.**

#### Button (unified text / pill / ghost button)

| Variant     | Classes                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `primary`   | `rounded-md font-medium bg-info-bg text-info hover:bg-info-bg-hover`                                         |
| `secondary` | `rounded-md font-medium border border-edge-default text-fg-muted bg-surface hover:bg-hover`                  |
| `danger`    | `rounded-md font-medium bg-danger text-fg-inverse hover:bg-danger/90`                                        |
| `ghost`     | `rounded border-none bg-transparent p-1 enabled:hover:bg-bg-default`                                         |
| `pill`      | `rounded-full border border-edge-default px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-hover gap-1` |

Sizes (apply to `primary`, `secondary`, `danger` only):

| Size | Classes               |
| ---- | --------------------- |
| `sm` | `px-2 py-1 text-xs`   |
| `md` | `px-3 py-1.5 text-sm` |

All variants: `disabled:cursor-not-allowed disabled:opacity-50`. Tooltip auto via `title` prop.

#### Button `iconOnly` (icon-only buttons)

When `iconOnly` is set, `Button` uses equal padding instead of asymmetric px/py, and SVG sizes are controlled by `iconSizeClasses`.

| Size | Padding | SVG size |
| ---- | ------- | -------- |
| `sm` | `p-1`   | 13×13    |
| `md` | `p-1.5` | 16×16    |

Use `shape="pill"` for round icon buttons (e.g., send, settings). Default shape is `rounded-md`.
Tooltip auto via `title` prop. Usage: Send button (`solid iconOnly shape="pill"`), toolbar icons (`ghost iconOnly`).

#### DragToCanvasHandleButton

| Property   | Value                                  |
| ---------- | -------------------------------------- |
| Based on   | Button (iconOnly)                      |
| Size       | `h-4.5 w-4.5`                          |
| Icon       | `GripVertical size={16}`               |
| Color      | `text-fg-subtle hover:text-fg-default` |
| Cursor     | `cursor-grab`                          |
| Visibility | `opacity-0 group-hover:opacity-100`    |

#### Color Picker Float (NodeBgColorSelector / NodeTextColorSelector)

| Property        | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| Float surface   | `rounded-full border border-edge-default bg-surface shadow-bottom px-2 py-1.5 gap-2` |
| Position        | `absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50`                           |
| Animation       | `animate-in fade-in zoom-in duration-200`                                            |
| Swatch          | `h-4 w-4 rounded-full border hover:scale-110` (bg) / `hover:scale-125` (text)        |
| Selected swatch | add `ring-2 ring-offset-1` + matching ring color                                     |
| Dismiss layer   | `fixed inset-0 z-40` (invisible overlay)                                             |

---

### 3.7 L7 — Atomic / Primitive

> Smallest indivisible UI elements.

#### Tooltip

| Property       | Value                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| Shape          | `rounded-md bg-inverse px-2 py-1 text-xs text-fg-inverse shadow-bottom` |
| Z-index        | `z-50`                                                                  |
| Positioning    | `fixed`, JS-calculated, prefer above, fallback below                    |
| Interaction    | `pointer-events-none`                                                   |
| Implementation | `createPortal(…, document.body)`                                        |

#### Inline Separator

| Variant              | Classes                         |
| -------------------- | ------------------------------- |
| Short (NodeToolbar)  | `bg-edge-default h-3 w-px`      |
| Tall (CanvasToolbar) | `bg-edge-default mx-1 h-4 w-px` |

#### Spinner

> Component: `<Spinner>` from `Common/Spinner.tsx`

| Prop        | Type                   | Default | Description                                        |
| ----------- | ---------------------- | ------- | -------------------------------------------------- |
| `size`      | `'xs' \| 'sm' \| 'md'` | `'sm'`  | xs = 12px, sm = 16px, md = 18px                    |
| `className` | `string`               | —       | Pass color tokens via className (e.g. `text-info`) |

Uses `Loader2` icon with `animate-spin`. Default color inherits from parent.

#### LoadingState

> Component: `<LoadingState>` from `Common/LoadingState.tsx`

Centered spinner + optional text label. Replaces all inline loading patterns.

| Prop         | Type      | Default | Description                                  |
| ------------ | --------- | ------- | -------------------------------------------- |
| `message`    | `string`  | —       | Optional text shown next to the spinner      |
| `overlay`    | `boolean` | `false` | Absolute-positioned to fill parent container |
| `fullScreen` | `boolean` | `false` | Full viewport height (`h-screen`)            |
| `className`  | `string`  | —       | Additional container classes                 |

#### EmptyState

> Component: `<EmptyState>` from `Common/EmptyState.tsx`

Centered message + optional action for zero-data states.

| Prop        | Type        | Default | Description                            |
| ----------- | ----------- | ------- | -------------------------------------- |
| `message`   | `string`    | —       | Primary message text                   |
| `action`    | `ReactNode` | —       | Optional action rendered below message |
| `className` | `string`    | —       | Additional container classes           |

---

## §4 — Canvas Node System

All canvas nodes share the same `NodeWrapper` shell.

### 4.1 NodeWrapper Provides

| Feature            | Implementation                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Selection ring     | `ring ring-info` (selected) / `ring-edge-default hover:ring` (unselected)                                          |
| Background         | User-chosen preset or `bg-transparent`                                                                             |
| Border             | `border-0` (ring replaces border)                                                                                  |
| Radius             | `rounded`                                                                                                          |
| Resize             | `<NodeResizer color="#e6e6e6">`                                                                                    |
| Toolbar            | `<NodeToolbar>` above node, `offset={12}`, single-select only                                                      |
| Connection handles | 8 handles (top/right/bottom/left × source/target), `bg-info h-1 w-1 border-none opacity-0 group-hover:opacity-100` |
| Drag handle        | `absolute top-0 -left-4.5 h-6 w-4 text-fg-subtle hover:text-fg-default opacity-0 group-hover:opacity-100`          |
| Ingestion overlay  | Spinner over `bg-bg-default/40`                                                                                    |
| Research indicator | `border-l-4 border-l-purple-500`                                                                                   |

### 4.2 Node Toolbar Internal Layout

```
[ TypeIcon (14px, text-fg-subtle) ]
[ Divider (bg-edge-default h-3 w-px) ]
[ Button iconOnly ghost actions (icon 14px) ... ]
```

Optional extras for TextNode: font-family select, font-size input,
bold/italic/underline toggles, text-color selector, bg-color selector.

Active toggle style: `text-info bg-info-bg`.
Inactive toggle style: `text-fg-subtle hover:bg-bg-default`.

### 4.3 Background Color Presets

| Name        | bg class         | border class          |
| ----------- | ---------------- | --------------------- |
| Transparent | `bg-transparent` | `border-info`         |
| White       | `bg-white`       | `border-edge-default` |
| Red         | `bg-red-50`      | `border-red-200`      |
| Orange      | `bg-orange-50`   | `border-orange-200`   |
| Yellow      | `bg-yellow-50`   | `border-yellow-200`   |
| Green       | `bg-green-50`    | `border-green-200`    |
| Blue        | `bg-blue-50`     | `border-blue-200`     |
| Purple      | `bg-purple-50`   | `border-purple-200`   |

### 4.4 Text Color Presets

| Name    | Hex       | Preview class    |
| ------- | --------- | ---------------- |
| Default | `#191919` | `bg-gray-800`    |
| Orange  | `#f97316` | `bg-orange-500`  |
| Amber   | `#f59e0b` | `bg-amber-500`   |
| Green   | `#10b981` | `bg-emerald-500` |
| Blue    | `#3b82f6` | `bg-blue-500`    |
| Purple  | `#a855f7` | `bg-purple-500`  |

---

## §5 — Quick Reference: Import Paths

```ts
// Reusable components — always prefer these
import { Button } from '@/components/Common/Button'; // use iconOnly for icon-only buttons
import { DragToCanvasHandleButton } from '@/components/Common/DragToCanvasHandleButton';
import { EmptyState } from '@/components/Common/EmptyState';
import { Input } from '@/components/Common/Input';
import { LoadingState } from '@/components/Common/LoadingState';
import { Modal } from '@/components/Common/Modal';
import { Popover } from '@/components/Common/Popover';
import { Spinner } from '@/components/Common/Spinner';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { Select } from '@/components/Common/Select';
import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector';

// CanvasPage shells
import { SidebarPanel } from '@/components/Panels/SidebarPanel';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';

// State
import useCanvasStore from '@/store/canvasStore';
import { usePreviewStore } from '@/store/previewStore';
import { useResearchStore } from '@/store/researchStore';

// Utilities
import clsx from 'clsx';
import { createPortal } from 'react-dom';
```

---

## §6 — Checklist for New Components

When an AI or developer creates a new UI component, verify:

- [ ] Walked §1 decision tree — no existing component fits
- [ ] Loading states use `<Spinner>` / `<LoadingState>` — no inline CSS spinners
- [ ] Empty states use `<EmptyState>` — no ad-hoc "no data" patterns
- [ ] All colors come from §2.1 system tokens (`fg-*`, `bg-*`, `edge-*`, status, AI) — no arbitrary hex values
- [ ] Border color is `border-edge-default` — no other border colors (except status-specific)
- [ ] Border radius matches §2.4 for the component's size level
- [ ] Shadow matches §2.5 — only `shadow-bottom` or `shadow-lg`
- [ ] Icon sizes follow §2.7 — correct `size` for the context
- [ ] Disabled state uses `disabled:cursor-not-allowed disabled:opacity-50`
- [ ] Any button with `title` prop auto-wraps `Tooltip`
- [ ] `clsx()` used for conditional classes — never string templates for dynamic classes
- [ ] `createPortal` used for any floating layer that escapes parent overflow
- [ ] No `z-index` values outside the defined set in §2.6
- [ ] English comments and JSDoc
