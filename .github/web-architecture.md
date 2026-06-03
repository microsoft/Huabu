# Web App Architecture (`apps/web/src/`)

This document describes the frontend directory structure. Follow this layout when adding new files.

## Directory Overview

```
src/
├── App.tsx                 # Router + WorkspaceGuard
├── main.tsx                # ReactDOM entry
├── index.css               # Global CSS / design tokens
│
├── pages/                  # Route-level pages & app shell
├── components/             # Reusable UI components (no business logic)
├── handler/                # Core processing logic (non-React, pure functions)
├── hooks/                  # Shared React hooks
├── store/                  # Zustand global state
├── api/                    # Backend API clients
├── config/                 # Static configuration & constants
└── utils/                  # Generic utility functions (non-React)
```

## Dependency Rules

```
pages → components, handler, hooks, store, api, config, utils
components → hooks, store, utils, config
handler → utils, config, api, store (read-only), other handler modules
hooks → store, api, handler, utils, config
store → api, handler, utils, config
api → config
utils → config (no React imports except Common re-exports)
config → (leaf — imports nothing internal)
```

**Never import upward** — e.g. `utils/` must not import from `components/` or `pages/`.

---

## `pages/`

Route-level page components and app-shell layout. Each file maps to a route in `App.tsx`.

```
pages/
├── CanvasPage.tsx           # Main canvas editor (loads canvas, renders MainLayout)
├── CanvasListPage.tsx       # Home page — list / create / import canvases
├── WorkspaceSetupPage.tsx   # First-launch workspace folder selection
├── ComponentShowcasePage.tsx # Design system playground
└── Layout/
    ├── MainLayout.tsx       # Three-column shell (header + left/center/right panels)
    └── CenterArea.tsx       # Canvas + expanded-node split view
```

## `components/`

Pure UI rendering — no direct API calls or heavy business logic. Organised by feature area.

```
components/
├── Common/                  # Shared design-system primitives
│   ├── Button.tsx           # Base button (variant / tone / shape / size)
│   ├── Input.tsx            # Text input with tooltip
│   ├── Select.tsx           # Custom select dropdown
│   ├── Modal.tsx            # Portal dialog
│   ├── Popover.tsx          # Floating panel (viewport-clamped)
│   ├── Tooltip.tsx          # Hover tooltip
│   ├── Toast.tsx            # Imperative toast notifications
│   ├── DropdownMenu.tsx     # Popover-based menu
│   ├── Spinner.tsx          # Loading indicator
│   ├── TabGroup.tsx         # Segmented control
│   ├── EmptyState.tsx       # Empty list placeholder
│   ├── LoadingState.tsx     # Centered spinner + message
│   ├── ThinkingIndicator.tsx # AI thinking shimmer animation
│   ├── NodeRef.tsx          # Clickable node reference badge
│   ├── NodeBgColorSelector.tsx
│   ├── NodeTextColorSelector.tsx
│   ├── DragToCanvasHandleButton.tsx
│   └── cn.ts               # clsx + tailwind-merge utility
│
├── BlockNote/               # BlockNote editor customisations
│   ├── blockNoteContent.ts
│   ├── NoteEditorSideMenu.tsx
│   └── shadcnOverrides.tsx
│
├── Nodes/                   # Canvas node renderers (one subfolder per type)
│   ├── NodeWrapper.tsx      # Base node container (handles, resize, toolbar)
│   ├── PreviewCard.tsx      # Shared preview card layout
│   ├── FloatingDragHandle.tsx
│   ├── NodePreviewContent.tsx # Dispatches to type-specific preview
│   ├── previews.ts          # Node-type → preview component registry
│   ├── types.ts             # Node data type definitions
│   ├── frame/               # FrameNode
│   ├── image/               # ImageNode, ImagePreview
│   ├── note/                # NoteNode, NotePreview, InlineBlockDiffs
│   ├── pdf/                 # PDFNode, PDFPreview, PDFPageWithOverlay
│   ├── text/                # TextNode
│   ├── video/               # VideoNode, VideoPreview
│   └── web/                 # WebNode, WebPreview
│
├── Panels/                  # Application panels
│   ├── SidebarPanel.tsx     # Reusable collapsible sidebar wrapper
│   ├── CanvasMenu.tsx       # Title input + undo/redo + export
│   ├── Canvas/              # Main canvas area components
│   │   ├── Canvas.tsx       # ReactFlow canvas (drag-drop, node types)
│   │   ├── CanvasToolbar.tsx # Bottom toolbar (tools, upload, layout)
│   │   ├── ExpandedNodePanel.tsx
│   │   ├── IntentPopover.tsx
│   │   └── MultiSelectToolbar.tsx
│   ├── ChatPanel/           # AI chat sidebar
│   │   ├── index.tsx        # Chat orchestrator
│   │   ├── ChatInput.tsx
│   │   ├── NewChatMenu.tsx
│   │   ├── SelectedNodeRefs.tsx
│   │   └── ContextUsageRing.tsx
│   ├── CanvasLayerPanel/     # Canvas layer sidebar
│   │   ├── index.tsx
│   │   ├── CanvasLayerTree.tsx
│   │   ├── TreeRowItem.tsx
│   │   └── types.ts
│   └── Header/              # Top header bar
│       ├── Header.tsx
│       ├── SettingsPopover.tsx
│       ├── LLMSettings.tsx
│       └── KeyboardShortcutsModal.tsx
│
└── Messages/                # Chat message components
    ├── types.ts
    ├── MessageList.tsx
    ├── AIMessage.tsx
    ├── UserMessage.tsx
    ├── ToolMessage.tsx
    ├── StatusMessage.tsx
    ├── IntentSelectMessage.tsx
    └── Card/
        ├── BlockNoteCard.tsx
        └── SourceCard.tsx
```

## `handler/`

Core processing logic — pure functions and algorithms, no React components. Contains the canvas command system, auto-layout engine, and PDF utilities.

```
handler/
├── canvasCommand/           # Canvas command execution system
│   ├── executor.ts          # Batch-executes CanvasExecution against state
│   ├── runtime.ts           # Executor interfaces (decoupled from Zustand)
│   ├── uiIntent.ts          # UI gesture → canvas command translator
│   ├── postEffects.ts       # Post-commit side effects (rerouting, preprocessing)
│   ├── preprocess.ts        # Node preprocessing (server-side enrichment)
│   ├── nodeInputBuilders.ts # Build AddNodeInput from files/URLs/text
│   ├── commands/            # One handler per command type
│   │   ├── index.ts         # HANDLERS registry + COMMAND_META
│   │   ├── types.ts         # CommandHandler, CommandDefinition
│   │   ├── alignNodes.ts
│   │   ├── autoLayout.ts
│   │   ├── connectNodes.ts
│   │   ├── createNodes.ts
│   │   ├── deleteNodes.ts
│   │   ├── disconnectEdges.ts
│   │   ├── dissolveFrame.ts
│   │   ├── distributeNodes.ts
│   │   ├── mergeNodeData.ts
│   │   ├── reorderNodes.ts
│   │   ├── setExpandedNode.ts
│   │   ├── setNodeGeometry.ts
│   │   ├── setNodeLocked.ts
│   │   ├── setNodeParent.ts
│   │   └── setNodeSelection.ts
│   ├── resolvers/           # UI gesture → command resolution
│   │   ├── index.ts
│   │   ├── resolveAddNodes.ts
│   │   ├── resolveDisconnectEdge.ts
│   │   ├── resolveGroupRectIntoFrame.ts
│   │   ├── resolveGroupSelectionIntoFrame.ts
│   │   ├── resolveNodeDragStop.ts
│   │   ├── resolvePasteClipboard.ts
│   │   └── resolveSelectNodes.ts
│   └── utils/               # Canvas-specific utilities
│       ├── index.ts
│       ├── alignment.ts
│       ├── edge.ts           # Smart handles, edge rerouting
│       ├── frame.ts         # Frame tree operations
│       └── screenshot.ts
│
├── autoLayout/              # Force-directed layout engine
│   ├── index.ts             # Barrel exports
│   ├── coordinator.ts       # Entry point: layoutAll / layoutGroup / placeNode
│   ├── engine.ts            # Solver delegation (Cola vs fCoSE)
│   ├── graphModel.ts        # Canvas → LayoutGraph conversion
│   ├── applier.ts           # Maps layout results onto canvas nodes
│   ├── types.ts             # UI-agnostic layout types
│   └── solvers/
│       ├── types.ts         # LayoutSolver interface
│       ├── solverUtils.ts   # Absolute position resolution
│       ├── colaSolver.ts    # WebCola (full relayout)
│       └── fcoseSolver.ts   # fCoSE (incremental placement)
│
└── pdfHighlight/            # PDF highlight computation
    └── highlight.ts         # Rect merging, overlap, toggle
```

## `hooks/`

Shared React hooks used across components.

```
hooks/
├── useAgentStream.ts        # Agent SSE streaming + canvas command execution
├── useChatHistory.ts        # Chat history loading + reconnection
├── useCanvasChanges.ts      # Per-command canvas change tracking + revert preview
├── useCornerZoomResize.ts   # Corner-drag viewport zoom
├── useNodeScale.ts          # Node content CSS scale factor
└── shortcuts/               # Keyboard shortcut hooks (canvas + page chrome)
    ├── useCanvasShortcuts.ts   # Canvas-scoped shortcuts + paste handling
    ├── usePageShortcuts.ts     # Window-scoped page shortcuts (? help modal)
    ├── isEditableTarget.ts     # Shared input/textarea/contentEditable guard
    └── index.ts                # Barrel
```

## `store/`

Zustand stores for global state management.

```
store/
├── canvasStore.ts           # Core canvas state (nodes, edges, undo/redo, autosave)
├── canvasHistoryManager.ts  # Undo/redo snapshot manager
├── chatStore.ts             # Chat messages + thread management
├── intentStore.ts           # Intent recognition popover state
├── llmStore.ts              # LLM provider/model config + OAuth
├── previewStore.ts          # Expanded preview panel state
└── workspaceStore.ts        # Workspace folder path + recent list
```

## `api/`

Backend API client modules. Each file corresponds to a server endpoint group.

```
api/
├── index.ts                 # Barrel re-export
├── agent.ts                 # SSE streaming agent (chat/operate modes)
├── artifact.ts              # File uploads (image, PDF, video)
├── canvas.ts                # Canvas CRUD + import/export + preprocessing
├── intent.ts                # Intent recognition stream + episode logging
├── knowledge.ts             # Knowledge base sources CRUD
├── llm.ts                   # LLM config + OAuth
├── web.ts                   # Web content preview/reader
└── workspace.ts             # Workspace path management
```

## `config/`

Static configuration constants. No runtime logic.

```
config/
├── api.ts                   # API base URL (VITE_API_BASE)
├── canvas.ts                # Grid size, snap-to-grid
├── nodeIcons.ts             # Node type → Lucide icon + label mapping
└── shortcuts.ts             # Keyboard shortcut definitions
```

## `utils/`

Generic utility functions — no React components, no business logic.

```
utils/
├── provenance.ts            # Block-level content provenance (AI vs human tracking)
├── shadowStyleCache.ts      # Shared stylesheets for Shadow DOM
├── tokenCount.ts            # GPT tokeniser wrapper
├── __tests__/               # Unit tests for provenance
├── io/                      # I/O utilities
│   ├── index.ts             # Barrel re-export
│   ├── clipboard.ts         # Copy to clipboard
│   ├── dragDrop.ts          # Drag-drop payload serialisation
│   └── media.ts             # File type detection, URL validation
└── node/                    # Node-related utilities
    ├── index.ts             # Barrel re-export
    ├── labels.ts            # Auto-generated node labels
    ├── nodeDefaultSize.ts   # Default dimensions per node type
    └── size.ts              # Node size reading (measured → style → fallback)
```

## Conventions

1. **Use `@/` alias** for cross-directory imports (e.g. `@/store/canvasStore`). Use relative paths only within the same directory subtree.
2. **No `.ts` / `.tsx` extensions** in import paths.
3. **New UI primitives** go in `components/Common/`. Always check existing components before creating new ones.
4. **New canvas commands** get a file in `handler/canvasCommand/commands/` and are registered in `commands/index.ts`.
5. **Hooks** that are used by multiple components belong in `hooks/`. Hooks local to a single component can stay co-located.
6. **Barrel exports** (`index.ts`) are used in `handler/`, `utils/io/`, and `utils/node/` to provide clean import paths.
