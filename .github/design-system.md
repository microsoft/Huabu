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
├─ Is it a small icon-only action (toolbar icon, copy, expand, close…)?
│  └─ YES → use <GhostButton title="…"> + lucide icon
│           (auto-wraps Tooltip when `title` is set)
│
├─ Is it a round prominent action button (send, settings, add…)?
│  └─ YES → use <IconButton size="sm|md" variant="outline|solid">
│           (auto-wraps Tooltip when `title` is set)
│
├─ Is it a pill-shaped selector / tag trigger (mode switch, filter…)?
│  └─ YES → use <PillButton> + icon + label + optional chevron
│           (auto-wraps Tooltip when `title` is set)
│
├─ Is it a drag handle for canvas?
│  └─ YES → use <DragToCanvasHandleButton>
│           (extends GhostButton, renders GripVertical)
│
├─ Is it a text-only action in a form (Save, Cancel…)?
│  └─ YES → use an inline <button> styled per §3.6 form-button rules
│
├─ Is it a floating layer (tooltip, popover, modal, dropdown, color picker)?
│  └─ YES → use createPortal() to document.body, apply §3 overlay rules
│
├─ Is it a sidebar / panel shell?
│  └─ YES → use <SidebarPanel> with the required props
│
├─ Is it a canvas node?
│  └─ YES → wrap content in <NodeWrapper> which provides ring, toolbar,
│           handles, drag handle, and resize automatically
│
└─ NONE matched → Build a new component following §2 tokens + §3 matrix
```

---

## §2 — Design Tokens (Universal Rules)

These rules apply **unconditionally** to ALL components, at every level.

### 2.1 Colors

| Token (Tailwind class)  | Value                      | When to use                                             |
| ----------------------- | -------------------------- | ------------------------------------------------------- |
| `text-main`             | `#191919` (`--foreground`) | All primary text, labels, titles                        |
| `text-muted-foreground` | `#7c7c7c`                  | Secondary text, descriptions, inactive labels           |
| `text-icon`             | `#ababab`                  | Default icon color (non-interactive or resting state)   |
| `text-theme-500`        | `#2e90ff`                  | Active / selected state text, toggle-on indicator       |
| `text-white`            | `#ffffff`                  | Text on dark surfaces (solid buttons, tooltip)          |
| `text-danger`           | `#e71d1d`                  | Error text, destructive action labels                   |
| `text-gray-600`         | —                          | IconButton outline variant text                         |
| `text-gray-700`         | —                          | PillButton text                                         |
| `bg-white`              | `#ffffff`                  | All surfaces: panels, cards, toolbars, popovers         |
| `bg-background`         | `#f5f5f5` (`--background`) | Page canvas, hover state for GhostButton, active tab bg |
| `bg-theme-50`           | `#f2f8ff`                  | Active toggle background, TreeRow highlight             |
| `bg-theme-100`          | `#dfeefe`                  | TreeRow selected state                                  |
| `bg-danger-bg`          | `#fff7f8`                  | Error / cancel background                               |
| `bg-gray-900`           | —                          | Solid buttons, tooltip bubble                           |
| `border-border`         | `#e6e6e6` (`--border`)     | **Every** border in the app uses this single color      |
| `ring-theme-500`        | `#2e90ff`                  | Selected node ring, focus ring for primary actions      |
| `ring-border`           | `#e6e6e6`                  | Hover ring on unselected nodes                          |

### 2.2 Typography

| Property        | Class                       | Usage                                      |
| --------------- | --------------------------- | ------------------------------------------ |
| Page title      | `text-lg font-medium`       | Header workspace name                      |
| Section heading | `text-sm font-semibold`     | Panel headers, modal titles, form headings |
| Body text       | `text-m leading-relaxed`    | Chat message content                       |
| UI labels       | `text-sm font-medium`       | Tab labels, form labels, tree row text     |
| Small text      | `text-xs font-medium`       | Toolbar labels, metadata, card subtitles   |
| Micro text      | `text-[10px] uppercase`     | Badges ("PREVIEW")                         |
| Placeholder     | `placeholder:text-gray-400` | Input / textarea placeholders              |

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

| Class          | px                | When to use                                                              |
| -------------- | ----------------- | ------------------------------------------------------------------------ |
| `rounded-full` | 9999px            | IconButton, PillButton, color swatches, progress bar, resize handle pill |
| `rounded-2xl`  | 16px              | Chat message bubbles, ChatInput container                                |
| `rounded-lg`   | `--radius` (10px) | CanvasToolbar, Modal, Popover, SourceCard, dropdown menu                 |
| `rounded-md`   | 8px               | Tooltip, NodeToolbar, form inputs, form buttons                          |
| `rounded`      | 4px               | GhostButton, NodeWrapper content, tab buttons, TreeRow inner             |
| `rounded-sm`   | 2px               | Inline edit input                                                        |

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
Exception: IconButton solid variant uses `disabled:opacity-40`.

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

| Type                     | Implementation                                       | Usage                                |
| ------------------------ | ---------------------------------------------------- | ------------------------------------ |
| Horizontal rule          | `border-b border-border`                             | Below Header, below panel header bar |
| Vertical panel edge      | `border-l border-border` or `border-r border-border` | Between panels                       |
| Inline separator (short) | `<div className="bg-border h-3 w-px" />`             | Inside NodeToolbar                   |
| Inline separator (tall)  | `<div className="bg-border mx-1 h-4 w-px" />`        | Inside CanvasToolbar                 |

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
| Header      | `h-12 border-b border-border bg-white px-3 gap-3`                 |
| Content row | `flex min-h-0 flex-1`                                             |
| Children    | Left Panel → Resize Handle → Center → Resize Handle → Right Panel |

---

### 3.2 L2 — Panel

> Collapsible side panels and expanded content panels.

| Property         | Expanded                                                        | Collapsed                                                        |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Component        | `SidebarPanel`                                                  | `SidebarPanel`                                                   |
| Background       | `bg-white`                                                      | `bg-white`                                                       |
| Width            | Left: 260px (min 200, max 30%); Right: 420px (min 200, max 50%) | 48px                                                             |
| Header           | `h-12 border-b border-border px-3`                              | —                                                                |
| Content padding  | `p-3`                                                           | —                                                                |
| Overflow         | `overflow-y-auto`                                               | —                                                                |
| Side border      | Left: `border-r border-border`; Right: `border-l border-border` | same                                                             |
| Collapsed label  | —                                                               | `text-xs font-semibold text-gray-500 [writing-mode:vertical-rl]` |
| Toggle icon size | —                                                               | `16`                                                             |

**Resize Handle** (between panels):
`w-2 bg-transparent cursor-col-resize` with inner pill
`h-8 w-1 rounded-full bg-gray-300 opacity-0 → group-hover:h-12 group-hover:opacity-100 duration-300`

**ExpandedNodePanel header**: `h-10 border-b border-border px-3 gap-3`
Title: `text-xs font-medium text-muted-foreground truncate`

---

### 3.3 L3 — Card / Container

> Visually distinct surface that holds content.

#### Message Bubbles

| Variant    | Background      | Radius        | Border                  | Padding     | Align         |
| ---------- | --------------- | ------------- | ----------------------- | ----------- | ------------- |
| User       | `bg-background` | `rounded-2xl` | none                    | `p-3`       | right         |
| AI         | `bg-white`      | `rounded-2xl` | none                    | `px-4 pt-2` | left (`ml-1`) |
| Tool       | `bg-white`      | `rounded-2xl` | `border border-border`  | `px-4 py-3` | left          |
| Tool error | `bg-danger-bg`  | `rounded-2xl` | `border border-border`  | `px-4 py-3` | left          |
| Research   | status-color bg | `rounded-2xl` | `border` + status-color | `p-4`       | left          |

Font: `text-m leading-relaxed`. Between messages: `space-y-1`.

#### SourceCard

`rounded-lg border border-border bg-white px-3 py-2 hover:bg-background`
Favicon: `h-3.5 w-3.5 rounded-sm`.
DragHandle: hidden by default, `opacity-0 group-hover:opacity-100`.

#### ChatInput Container

`rounded-2xl border border-border bg-white p-3`

#### Modal (UploadModal)

| Property        | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Backdrop        | `fixed inset-0 bg-background/80 backdrop-blur-[1px] z-9999`               |
| Dialog          | `rounded-lg border border-border bg-white shadow-bottom w-90 p-6`         |
| Title           | `text-sm font-semibold text-main`                                         |
| Close button    | `text-muted-foreground hover:text-danger rounded p-1`, icon `X size={16}` |
| Enter animation | `animate-in zoom-in-95 fade-in duration-200`                              |

#### Popover

| Property       | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Surface        | `rounded-lg border border-border bg-white shadow-lg w-80 p-4` |
| Position       | `fixed`, anchored below trigger + 6px, right-aligned          |
| Implementation | `createPortal(…, document.body)`                              |

#### Dropdown Menu

| Property    | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Surface     | `rounded border border-border bg-popover shadow-lg py-1` |
| Item        | `px-3 py-1.5 text-xs hover:bg-accent w-full text-left`   |
| Active item | add `font-bold text-blue-500`                            |

---

### 3.4 L4 — Toolbar / Bar

> Floating or docked strips of controls.

#### NodeToolbar (per-node floating)

| Property        | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| Shape           | `rounded-md border border-border bg-white shadow-bottom`    |
| Size            | `h-8 px-2 py-1 gap-3`                                       |
| Position        | Above node, `offset={12}`, visible when single-selected     |
| Icon size       | `14`                                                        |
| Icon color      | `text-muted-foreground`                                     |
| Section divider | `<div className="bg-border h-3 w-px" />`                    |
| Layout          | Left: type icon → divider → Right: GhostButton action icons |

#### CanvasToolbar (bottom floating)

| Property      | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| Shape         | `rounded-lg border-0 bg-white shadow-bottom`                    |
| Size          | `p-2 gap-2`                                                     |
| Position      | `Panel position="bottom-center" className="mb-6"`               |
| Icon size     | `18`                                                            |
| Icon color    | `text-muted-foreground`, active: `text-theme-500 bg-background` |
| Group divider | `<div className="bg-border mx-1 h-4 w-px" />`                   |

#### Panel Header Bar

Already defined in §3.2. Key: `h-12 px-3 border-b border-border bg-white`.

#### Tabs (inside panel header)

| State    | Classes                                                                               |
| -------- | ------------------------------------------------------------------------------------- |
| Active   | `bg-background text-foreground rounded px-2 py-1 text-sm font-medium`                 |
| Inactive | `text-muted-foreground hover:text-foreground rounded px-2 py-1 text-sm font-semibold` |

---

### 3.5 L5 — Row / List Item

> Repeated items in a scrollable list.

#### TreeRowItem

| Property                              | Value                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| Height                                | `h-9`                                                      |
| Background                            | `bg-white`                                                 |
| Inner wrapper                         | `rounded px-2 py-1 text-sm transition-colors`              |
| Indent                                | `paddingLeft: 12 + depth × 16` px                          |
| Default hover                         | `hover:bg-background`                                      |
| Selected                              | `bg-theme-100`                                             |
| Highlighted (child of selected frame) | `bg-theme-50`                                              |
| Icon                                  | `text-muted-foreground size={14} strokeWidth={1.5}`        |
| Label                                 | `text-main truncate select-none`                           |
| Chevron                               | `size={12} strokeWidth={1.5}`                              |
| Edit input                            | `h-6 rounded-sm border bg-white px-1 text-xs outline-none` |
| Lock / action icons                   | appear on hover, `size={12} strokeWidth={1.5}`             |

#### ResearchStepItem

`flex items-start gap-2 text-xs`
Status icon: `h-3 w-3`. Title: `font-medium text-gray-900`. Detail: `mt-0.5 text-gray-600`.

---

### 3.6 L6 — Button / Control

> All clickable controls. **Always check §1 reuse tree first.**

#### GhostButton (icon action)

| Property   | Value                                              |
| ---------- | -------------------------------------------------- |
| Shape      | `rounded`                                          |
| Background | `bg-transparent`, hover `bg-background`            |
| Border     | none                                               |
| Padding    | `p-1`                                              |
| Tooltip    | auto via `title` prop                              |
| Usage      | Toolbar icons, panel toggles, message action icons |

#### IconButton (prominent round button)

| Property        | sm                                                    | md             |
| --------------- | ----------------------------------------------------- | -------------- |
| Size            | `h-8 w-8`                                             | `h-9 w-9`      |
| Shape           | `rounded-full`                                        | `rounded-full` |
| Outline variant | `border border-border text-gray-600 hover:bg-gray-50` | same           |
| Solid variant   | `bg-gray-900 text-white hover:bg-gray-800`            | same           |
| Tooltip         | auto via `title` prop                                 | same           |
| Usage           | Send button (solid sm), Settings (outline md)         |                |

#### PillButton (label + icon combo)

| Property     | Value                               |
| ------------ | ----------------------------------- |
| Shape        | `rounded-full border border-border` |
| Padding      | `px-3 py-1.5`                       |
| Font         | `text-xs font-medium text-gray-700` |
| Hover        | `hover:bg-gray-50`                  |
| Internal gap | `gap-1`                             |
| Tooltip      | auto via `title` prop               |
| Usage        | ModeSelector trigger                |

#### DragToCanvasHandleButton

| Property   | Value                               |
| ---------- | ----------------------------------- |
| Based on   | GhostButton                         |
| Size       | `h-4.5 w-4.5`                       |
| Icon       | `GripVertical size={16}`            |
| Color      | `text-icon hover:text-main`         |
| Cursor     | `cursor-grab`                       |
| Visibility | `opacity-0 group-hover:opacity-100` |

#### Form Buttons (inline, non-component)

| Variant             | Classes                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| Primary (Save)      | `rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800`            |
| Secondary (Cancel)  | `rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100`                     |
| Confirm (theme)     | `rounded bg-theme-50 hover:bg-theme-100 text-theme-500 px-2 py-1 text-xs`            |
| Cancel (danger)     | `rounded text-danger bg-danger-bg px-2 py-1 text-xs`                                 |
| Toggle (selected)   | `rounded-md border border-blue-500 bg-blue-50 text-blue-700 px-3 py-1.5 text-sm`     |
| Toggle (unselected) | `rounded-md border border-border text-gray-600 hover:bg-gray-50 px-3 py-1.5 text-sm` |

#### Color Picker Float (NodeBgColorSelector / NodeTextColorSelector)

| Property        | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| Float surface   | `rounded-full border border-border bg-white shadow-bottom px-2 py-1.5 gap-2`  |
| Position        | `absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50`                    |
| Animation       | `animate-in fade-in zoom-in duration-200`                                     |
| Swatch          | `h-4 w-4 rounded-full border hover:scale-110` (bg) / `hover:scale-125` (text) |
| Selected swatch | add `ring-2 ring-offset-1` + matching ring color                              |
| Dismiss layer   | `fixed inset-0 z-40` (invisible overlay)                                      |

---

### 3.7 L7 — Atomic / Primitive

> Smallest indivisible UI elements.

#### Tooltip

| Property       | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| Shape          | `rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow-bottom` |
| Z-index        | `z-50`                                                              |
| Positioning    | `fixed`, JS-calculated, prefer above, fallback below                |
| Interaction    | `pointer-events-none`                                               |
| Implementation | `createPortal(…, document.body)`                                    |

#### Inline Separator

| Variant              | Classes                   |
| -------------------- | ------------------------- |
| Short (NodeToolbar)  | `bg-border h-3 w-px`      |
| Tall (CanvasToolbar) | `bg-border mx-1 h-4 w-px` |

#### Loading Spinner

| Property | Value                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------- |
| Spinner  | `h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground` |
| Overlay  | `bg-background/40 absolute inset-0 z-10 flex items-center justify-center`                         |

#### Loading Ellipsis (chat)

`<Ellipsis className="text-icon animate-pulse" />`

#### Badge

`bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] uppercase`

#### Progress Bar

Track: `h-1.5 w-full rounded-full` + status bg (e.g. `bg-blue-200`).
Fill: `h-full rounded-full transition-all duration-300` + status color (e.g. `bg-blue-600`).

---

## §4 — Canvas Node System

All canvas nodes share the same `NodeWrapper` shell.

### 4.1 NodeWrapper Provides

| Feature            | Implementation                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Selection ring     | `ring ring-theme-500` (selected) / `ring-border hover:ring` (unselected)                                                |
| Background         | User-chosen preset or `bg-transparent`                                                                                  |
| Border             | `border-0` (ring replaces border)                                                                                       |
| Radius             | `rounded`                                                                                                               |
| Resize             | `<NodeResizer color="#e6e6e6">`                                                                                         |
| Toolbar            | `<NodeToolbar>` above node, `offset={12}`, single-select only                                                           |
| Connection handles | 8 handles (top/right/bottom/left × source/target), `bg-theme-500 h-1 w-1 border-none opacity-0 group-hover:opacity-100` |
| Drag handle        | `absolute top-0 -left-4.5 h-6 w-4 text-icon hover:text-main opacity-0 group-hover:opacity-100`                          |
| Ingestion overlay  | Spinner over `bg-background/40`                                                                                         |
| Research indicator | `border-l-4 border-l-purple-500`                                                                                        |

### 4.2 Node Toolbar Internal Layout

```
[ TypeIcon (14px, text-muted-foreground) ]
[ Divider (bg-border h-3 w-px) ]
[ GhostButton actions (icon 14px) ... ]
```

Optional extras for TextNode: font-family select, font-size input,
bold/italic/underline toggles, text-color selector, bg-color selector.

Active toggle style: `text-theme-500 bg-theme-50`.
Inactive toggle style: `text-muted-foreground hover:bg-background`.

### 4.3 Background Color Presets

| Name        | bg class         | border class        |
| ----------- | ---------------- | ------------------- |
| Transparent | `bg-transparent` | `border-theme-500`  |
| White       | `bg-white`       | `border-border`     |
| Red         | `bg-red-50`      | `border-red-200`    |
| Orange      | `bg-orange-50`   | `border-orange-200` |
| Yellow      | `bg-yellow-50`   | `border-yellow-200` |
| Green       | `bg-green-50`    | `border-green-200`  |
| Blue        | `bg-blue-50`     | `border-blue-200`   |
| Purple      | `bg-purple-50`   | `border-purple-200` |

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
import { GhostButton } from '@/components/Common/GhostButton';
import { IconButton } from '@/components/Common/IconButton';
import { PillButton } from '@/components/Common/PillButton';
import { Tooltip } from '@/components/Common/Tooltip';
import { DragToCanvasHandleButton } from '@/components/Common/DragToCanvasHandleButton';
import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector';

// Layout shells
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
- [ ] All colors come from §2.1 tokens — no arbitrary hex values
- [ ] Border color is `border-border` — no other border colors (except status-specific)
- [ ] Border radius matches §2.4 for the component's size level
- [ ] Shadow matches §2.5 — only `shadow-bottom` or `shadow-lg`
- [ ] Icon sizes follow §2.7 — correct `size` for the context
- [ ] Disabled state uses `disabled:cursor-not-allowed disabled:opacity-50`
- [ ] Any button with `title` prop auto-wraps `Tooltip`
- [ ] `clsx()` used for conditional classes — never string templates for dynamic classes
- [ ] `createPortal` used for any floating layer that escapes parent overflow
- [ ] No `z-index` values outside the defined set in §2.6
- [ ] English comments and JSDoc
