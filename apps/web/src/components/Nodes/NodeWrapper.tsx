import {
  NodeResizer,
  useInternalNode,
  useViewport,
  useStore,
} from '@xyflow/react';
import clsx from 'clsx';
import { FileWarning, FolderOpen, RefreshCw } from 'lucide-react';
import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { resolveAccent } from '@sediment/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import { getNodeContent, revealCanvasNodesFolder } from '@/api/canvas.ts';
import { Button } from '@/components/Common/Button.tsx';
import { cn } from '@/components/Common/cn.ts';
import { Loading } from '@/components/Common/Loading';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { resumeHeightCommits } from '@/components/Nodes/shared/height/commitSuspension';
import { NodeFloatingToolbar } from '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx';
import {
  AI_BADGE_MIN_SCREEN_WIDTH,
  SEMANTIC_ZOOM_CONFIG,
} from '@/config/semanticZoom.ts';
import {
  beginSnapSession,
  endSnapSession,
  applyResizeProposal,
  getResizeContext,
  getResizeSnappedRect,
} from '@/handler/snap/snapSession.ts';
import { useIsNotMouse } from '@/hooks/useInputMode.ts';
import { useNodeLOD } from '@/hooks/useNodeLOD.ts';
import useCanvasStore, {
  clearNodeDuplicateGuard,
} from '@/store/canvasStore.ts';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore.ts';
import { coerceProvenance } from '@/utils/blockProvenance';

import { getAccentTokens } from './accentTokens.ts';
import { NodeConnectionHandles } from './NodeConnectAffordance.tsx';
import { NodeTakeoverLayer } from './NodeTakeoverLayer.tsx';
import { SemanticPlaceholder } from './SemanticPlaceholder.tsx';

import type { CanvasNodeType, NodeData } from './types.ts';
import type { TakeoverState } from '@/config/nodeTakeover';

const OverlayPortal = memo(
  ({
    nodeId,
    offsetY,
    semanticVisible,
    ownerInteractionPriority,
    maxWidth,
    children,
  }: {
    nodeId: string;
    offsetY: number;
    semanticVisible: boolean;
    ownerInteractionPriority: number;
    maxWidth?: number;
    children: React.ReactNode;
  }) => {
    const domNode = useStore((state) => state.domNode);
    const rendererEl = useMemo(
      () => domNode?.querySelector('.react-flow__renderer') ?? null,
      [domNode],
    );
    const internalNode = useInternalNode(nodeId);
    const { zoom, x: vpX, y: vpY } = useViewport();

    const absX = internalNode?.internals.positionAbsolute?.x ?? 0;
    const absY = internalNode?.internals.positionAbsolute?.y ?? 0;

    const [overlayHovered, setOverlayHovered] = useState(false);
    const interactionPriority = Math.max(
      ownerInteractionPriority,
      overlayHovered ? 1 : 0,
    );
    const visible = interactionPriority > 0 || semanticVisible;

    // left/top always equal the final screen position so the label stays
    // correct during pan/zoom without any extra logic.
    const left = absX * zoom + vpX;
    const top = absY * zoom + vpY + offsetY;

    // FLIP state: a transient transform offset that starts at -Δ and
    // transitions back to (0,0), giving the illusion of smooth movement.
    const prevAbsRef = useRef({ x: absX, y: absY });
    const [flipOffset, setFlipOffset] = useState({ x: 0, y: 0 });
    const [playing, setPlaying] = useState(false);
    const rafRef = useRef(0);

    useLayoutEffect(() => {
      if (!internalNode) return;

      const dx = absX - prevAbsRef.current.x;
      const dy = absY - prevAbsRef.current.y;
      if (dx === 0 && dy === 0) return; // pan/zoom only — no position change

      prevAbsRef.current = { x: absX, y: absY };

      // Only animate when the node itself has a transition active.
      const nodeStyle = internalNode.style as
        | Record<string, unknown>
        | undefined;
      if (typeof nodeStyle?.transition !== 'string') return;

      // Invert: visually keep label at old position (no transition yet).
      setFlipOffset({ x: -dx * zoom, y: -dy * zoom });
      setPlaying(false);

      // Play: next frame — transition transform back to (0,0).
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setFlipOffset({ x: 0, y: 0 });
        setPlaying(true);
      });

      return () => cancelAnimationFrame(rafRef.current);
    }, [absX, absY, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!rendererEl || !internalNode?.internals.positionAbsolute) return null;

    return createPortal(
      <div
        style={{
          position: 'absolute',
          zIndex: 1000 + interactionPriority,
          left,
          top,
          maxWidth,
          opacity: visible ? 1 : 0,
          visibility: visible ? 'visible' : 'hidden',
          pointerEvents: visible ? 'auto' : 'none',
          transform: `translate(${flipOffset.x}px, ${flipOffset.y}px)`,
          transition: [
            playing ? 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)' : null,
            'opacity 120ms ease',
            `visibility 0s linear ${visible ? '0s' : '120ms'}`,
          ]
            .filter(Boolean)
            .join(', '),
        }}
        aria-hidden={!visible}
        onPointerEnter={() => setOverlayHovered(true)}
        onPointerLeave={() => setOverlayHovered(false)}
      >
        {children}
      </div>,
      rendererEl,
    );
  },
);
OverlayPortal.displayName = 'OverlayPortal';

interface NodeWrapperProps {
  id: string;
  data: NodeData;
  type: CanvasNodeType;
  selected?: boolean;

  allowOverflow?: boolean;

  children: React.ReactNode;
  className?: string;
  minWidth?: number;
  minHeight?: number;

  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  overlayContent?: React.ReactNode;
  /**
   * Opt into the continuous zoom takeover. As the node shrinks on screen, the
   * node-supplied mark glides from the readable corner badge to a centred
   * stand-in and resizes with it, while the card body fades out — a single
   * continuous morph driven by the node's on-screen width, not a discrete
   * stage swap. The engine ({@link NodeTakeoverLayer}) owns positioning and the
   * card-fade; the mark owns its own size, detail, status chrome, and click.
   */
  takeover?: {
    renderMark: (state: TakeoverState) => React.ReactNode;
    onActivate?: React.MouseEventHandler;
  };
  /** Vertical offset in screen pixels from the node's top edge. Negative = above. */
  overlayOffsetY?: number;
  /** Semantic visibility computed by the overlay owner. */
  overlayVisible?: boolean;
  /** Owner interaction priority: idle 0, hovered 1, selected 2, editing 3. */
  overlayInteractionPriority?: number;
  /** Optional screen-space width cap for overlay content. */
  overlayMaxWidth?: number;

  keepAspectRatio?: boolean;
  resizable?: boolean;
  /**
   * Escape hatch for node types whose fill is not the user-facing accent
   * — currently only `QuestionNode`, which paints a fixed sticky-yellow
   * background regardless of any `style.accent`. Leave `undefined` for
   * every other node type: the wrapper derives the fill from
   * `data.style.accent` so border + fill + text tint stay in sync.
   */
  fillColor?: string;

  onResizeStart?: () => void;
  /**
   * Live-resize tick callback. Receives the snapped width/height AND
   * the snapped local top-left (`x`, `y`) for this tick — both are
   * required so handlers that re-dispatch geometry (e.g. the frame's
   * cascade-scale path) can commit a self-contained batch that pins
   * the frame's new origin instead of relying on a separate
   * `onNodesChange` snap-mirror to set it. For BR-handle drags `x`
   * and `y` simply equal the gesture-start values.
   */
  onResize?: (width: number, height: number, x: number, y: number) => void;
  onResizeEnd?: (width: number, height: number) => void;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  resizeEndClearHeight?: boolean;
}

// Reference-memoized count of selected nodes. Every NodeWrapper needs to
// know whether it is the *sole* selected node (to show its own resize
// handles / floating toolbar vs. deferring to the multi-select bounding
// box). Filtering `nodes` inside each node's selector made this O(n) per
// node — 25 nodes × scanning 25 nodes on every store update. Since all
// selectors run during the same store notification and share the same
// immutable `nodes` array reference, we scan once per unique array and
// hand every node the cached scalar (25×O(n) → 1×O(n)).
let selectedCountNodesRef: readonly { selected?: boolean }[] | null = null;
let selectedCountCache = 0;
function selectSelectedCount(nodes: readonly { selected?: boolean }[]): number {
  if (nodes !== selectedCountNodesRef) {
    selectedCountNodesRef = nodes;
    let count = 0;
    for (const node of nodes) if (node.selected) count++;
    selectedCountCache = count;
  }
  return selectedCountCache;
}

export const NodeWrapper = memo(
  ({
    id,
    type,
    data,
    selected,
    children,
    className,
    minWidth,
    minHeight,
    toolbar,
    actions,
    overlayContent,
    takeover,
    overlayOffsetY = 0,
    overlayVisible = true,
    overlayInteractionPriority = 0,
    overlayMaxWidth,
    keepAspectRatio = false,
    resizable = true,

    allowOverflow = false,

    fillColor,

    onResizeStart,
    onResize: onResizeProp,
    onResizeEnd,
    onDoubleClick,
    resizeEndClearHeight = false,
  }: NodeWrapperProps) => {
    const selectedCount = useCanvasStore((state) =>
      selectSelectedCount(state.nodes),
    );

    // Hide the floating toolbar + side "add node" affordances while this
    // node is being dragged, so they don't occlude the drop placeholder
    // (the structured-frame ghost / snap feedback) under the cursor.
    const isDragging = useCanvasStore(
      (state) => state.nodes.find((node) => node.id === id)?.dragging ?? false,
    );

    const setNodeGeometry = useCanvasStore((state) => state.setNodeGeometry);
    const onNodeResizeStart = useCanvasStore(
      (state) => state.onNodeResizeStart,
    );
    const updateResizePreview = useCanvasStore(
      (state) => state.updateResizePreview,
    );
    const endResizePreview = useCanvasStore((state) => state.endResizePreview);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);
    // Question nodes already surface their working state via the
    // `StatusBadge` (running / done). Their content-ingestion spinner
    // would otherwise overlap that badge with a redundant second spinner
    // the moment the prompt is authored on send, so suppress it here.
    const showIngestionOverlay =
      type !== 'frame' &&
      type !== 'question' &&
      ingestion?.status === 'pending';

    const [hovered, setHovered] = useState(false);
    const [editing, setEditing] = useState(false);

    // Open the canvas's `nodes/` folder so the user can resolve a
    // duplicate-sidecar collision by hand (keep one file, delete the
    // rest). `canvasId` is read lazily from the store so the wrapper
    // doesn't subscribe every node to it. Both outcomes toast so the
    // user gets explicit feedback on whether the folder opened.
    const handleOpenDuplicateFolder = useCallback(() => {
      const canvasId = useCanvasStore.getState().canvasId;
      if (!canvasId) return;
      void revealCanvasNodesFolder(canvasId)
        .then(() => {
          toast('Opened the node folder in your file manager.', {
            tone: 'success',
          });
        })
        .catch((error: unknown) => {
          toast(
            error instanceof Error ? error.message : 'Failed to open folder',
            { tone: 'danger' },
          );
        });
    }, []);

    // Re-fetch just this node's server state so the duplicate hint
    // clears once the user has deleted the extra file on disk — no full
    // page reload. `getNodeContent` runs the same hydration as the
    // canvas GET, so it reports the current duplicate status; we patch
    // the flags silently (these are transient hints, never persisted).
    const handleRefreshDuplicate = useCallback(() => {
      const canvasId = useCanvasStore.getState().canvasId;
      if (!canvasId) return;
      void getNodeContent(canvasId, id)
        .then((res) => {
          if (!res) return;
          useCanvasStore.getState().patchNodeSilent(id, {
            contentDuplicate: res.contentDuplicate ?? false,
            duplicateFiles: res.duplicateFiles ?? [],
          });
          if (!res.contentDuplicate) {
            // Resolved on disk — drop the once-per-node toast guard so a
            // *later* duplicate on this node alerts again (resolving via
            // Refresh never goes through a successful save, which is the
            // only other place the guard is cleared).
            clearNodeDuplicateGuard(id);
            toast('Duplicate resolved — editing re-enabled.', {
              tone: 'success',
            });
          } else {
            toast('Still more than one file on disk for this node.', {
              tone: 'warning',
            });
          }
        })
        .catch((error: unknown) => {
          toast(
            error instanceof Error ? error.message : 'Failed to refresh node',
            { tone: 'danger' },
          );
        });
    }, [id]);

    const renderMode = useNodeLOD(id, type);
    const rootRef = useRef<HTMLDivElement>(null);
    const { zoom } = useViewport();
    const isNotMouse = useIsNotMouse();

    // Read canvas-space dimensions for SemanticPlaceholder text fitting
    const nodeWidth = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.width as number) || node?.measured?.width || 400;
    });
    const nodeHeight = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.height as number) || node?.measured?.height || 200;
    });

    // Deliberately *not* `resolveHeightMode`: this asks whether a layout
    // height exists to fill, not who owns it. An auto note now carries a
    // materialized number and must stretch to it exactly like a pinned
    // one; only the types that still express auto as an absent height
    // (text / question) take the growing branch.
    const hasLayoutHeight = useStore(
      (s) => typeof s.nodeLookup.get(id)?.style?.height === 'number',
    );

    // Check if this node was generated by AI
    const isAIGenerated = data.origin?.type?.startsWith('ai-');
    const showAIBadge =
      isAIGenerated && nodeWidth * zoom >= AI_BADGE_MIN_SCREEN_WIDTH;

    // Compute provenance summary for note nodes (Phase 4 shape).
    const provenanceSummary = useMemo(() => {
      if (!('provenance' in data)) return null;
      const prov = coerceProvenance(
        (data as { provenance?: unknown }).provenance,
      );
      const total = prov.blocks.length + prov.deletedBlocks.length;
      if (total === 0) return null;
      return {
        editedCount: prov.blocks.length,
        deletedCount: prov.deletedBlocks.length,
      };
    }, [data]);

    const handleResize = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        const zoom = useCanvasStore.getState().rfInstance?.getZoom() ?? 1;
        const snapped = applyResizeProposal(params, zoom);
        // Keep the frame-fit overlay aligned with the live resize.
        updateResizePreview(id);
        // Forward the snapped local top-left as well as the snapped
        // size. Non-BR handles move the node's local origin every
        // tick — callers that cascade-update children (FrameNode)
        // need the new origin so they can pin the frame's position
        // in the same batch as the children's scaled positions.
        onResizeProp?.(snapped.width, snapped.height, snapped.x, snapped.y);
      },
      [id, onResizeProp, updateResizePreview],
    );

    const handleResizeStart = useCallback(
      (
        event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        onNodeResizeStart();

        const state = useCanvasStore.getState();
        const nodes = state.nodes as NestableNode[];
        const byId = indexById(nodes);
        const getAbs = createAbsolutePositionGetter(byId);
        const self = byId.get(id);
        const parentOffset = { x: 0, y: 0 };
        if (self?.parentId) {
          const pa = getAbs(self.parentId);
          if (pa) {
            parentOffset.x = pa.x;
            parentOffset.y = pa.y;
          }
        }

        const altPressed =
          (event as { altKey?: boolean } | undefined)?.altKey ?? false;
        beginSnapSession({
          nodes,
          gestureIds: new Set([id]),
          altPressed,
          kind: 'resize',
          resizeContext: {
            nodeId: id,
            startRect: {
              x: parentOffset.x + params.x,
              y: parentOffset.y + params.y,
              w: params.width,
              h: params.height,
            },
            startLocalPos: { x: params.x, y: params.y },
            parentOffset,
            lockAspect: keepAspectRatio,
          },
        });

        onResizeStart?.();
      },
      [id, onNodeResizeStart, onResizeStart, keepAspectRatio],
    );

    const handleResizeEnd = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        endResizePreview();
        const snapped = getResizeSnappedRect();
        const ctx = getResizeContext();
        const finalSize = snapped
          ? { width: snapped.size.width, height: snapped.size.height }
          : { width: params.width, height: params.height };
        const finalLocalPos = snapped?.local ?? { x: params.x, y: params.y };

        const positionChanged =
          !!ctx &&
          (finalLocalPos.x !== ctx.startLocalPos.x ||
            finalLocalPos.y !== ctx.startLocalPos.y);

        // Run the per-node `onResizeEnd` BEFORE the canonical
        // `setNodeGeometry` commit. For frames this drains any trailing
        // rAF-coalesced cascade-scale tick (`flushFrameResizeScale`) so
        // the scaled-children batch lands in the same React commit as
        // the frame's pinned size — otherwise the geometry commit runs
        // once with stale child sizes (last preview tick before the
        // trailing rAF was coalesced away) and then the flush re-runs
        // RESIZE_NODE a second time with the trailing values, producing
        // a visible one-frame children kick on pointer release. For
        // non-frame nodes `onResizeEnd` is undefined so this is a no-op.
        onResizeEnd?.(finalSize.width, finalSize.height);

        setNodeGeometry([
          {
            nodeId: id,
            size: resizeEndClearHeight
              ? { width: finalSize.width, height: 'auto' }
              : finalSize,
            position: positionChanged ? finalLocalPos : undefined,
          },
        ]);

        endSnapSession();
        // Paired with the `suspendHeightCommits` in `onNodeResizeStart`.
        // Released after the geometry commit so a queued correction is
        // evaluated against the node's final width.
        resumeHeightCommits();
      },
      [
        endResizePreview,
        setNodeGeometry,
        id,
        onResizeEnd,
        resizeEndClearHeight,
      ],
    );

    const isMinimal = renderMode === 'minimal';
    const supportsMinimalLOD =
      SEMANTIC_ZOOM_CONFIG.nodeLOD[type]?.minimal === 'minimal';

    // Per-node resize handles are only ever shown when this is the *sole*
    // selected node (multi-selection draws a single bounding-box resizer
    // via `MultiSelectResizer` instead). Mounting `<NodeResizer>` only
    // when that holds — rather than keeping it permanently mounted and
    // toggling `isVisible` — keeps it off the first paint for every
    // unselected node on a freshly loaded canvas. Selecting a node already
    // re-renders this component, so the handles still mount in the same
    // commit as the selection highlight (no perceptible delay).
    const showResizer =
      selected && resizable && !data.locked && selectedCount === 1;

    // While a stroke-level (sketch) selection exists, its own toolbar (or,
    // on desktop, none) owns the surface — suppress this node's floating
    // toolbar so a mixed lasso never shows the node toolbar. Boolean
    // selector so this only re-renders when the flag flips.
    const hasStrokeSelection = useGesturePreviewStore(
      (s) => Object.keys(s.sketchStrokeSelection).length > 0,
    );

    // Derive accent-tinted tokens once so border/shadow stay in sync with
    // the rest of the canvas (PreviewCard, SemanticPlaceholder, ...).
    // Stored value is a palette token (or legacy hex); resolve to CSS color.
    const accent = resolveAccent(data.style?.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;
    // Accent controls colour only. Elevation is interaction-driven and only
    // applies to card-like content nodes; text, sketch, question, and frame
    // nodes retain their deliberately flat visual language.
    const hasCardSurface =
      type !== 'text' &&
      type !== 'sketch' &&
      type !== 'question' &&
      type !== 'frame';

    return (
      <>
        {showResizer && (
          <NodeResizer
            color="var(--color-info-light)"
            minWidth={minWidth}
            minHeight={minHeight}
            keepAspectRatio={keepAspectRatio}
            onResizeStart={handleResizeStart}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
            handleStyle={{
              width: isNotMouse ? 12 : 8,
              height: isNotMouse ? 12 : 8,
              borderRadius: 0,
            }}
            lineClassName="!border-transparent"
          />
        )}
        {selected &&
          selectedCount === 1 &&
          !isDragging &&
          !hasStrokeSelection && (
            <NodeFloatingToolbar
              id={id}
              type={type}
              data={data}
              toolbar={toolbar}
              actions={actions}
            />
          )}

        {/* Zoom-invariant overlay portal — isolated component to avoid re-rendering the entire NodeWrapper on pan/zoom */}
        {overlayContent && (
          <OverlayPortal
            nodeId={id}
            offsetY={overlayOffsetY}
            semanticVisible={overlayVisible}
            ownerInteractionPriority={Math.max(
              overlayInteractionPriority,
              hovered ? 1 : 0,
            )}
            maxWidth={overlayMaxWidth}
          >
            {overlayContent}
          </OverlayPortal>
        )}

        {/* Discrete three-stage zoom takeover — screen-space overlay that also
            drives the card fade. Isolated + memoised so continuous zoom never
            re-renders the node body. */}
        {takeover && (
          <NodeTakeoverLayer
            nodeId={id}
            renderMark={takeover.renderMark}
            onActivate={takeover.onActivate}
            nodeRootRef={rootRef}
          />
        )}

        <div
          ref={rootRef}
          className={cn(
            // `transition` (not `transition-all`) intentionally
            // EXCLUDES width / height from the animated property
            // list. The outer RF node container's `style.width` /
            // `style.height` is rewritten on every resize tick
            // (`SET_NODE_GEOMETRY` + the snap-mirror in
            // `onNodesChange`); this inner div uses `h-full w-full`
            // so its computed pixel size derives from the parent.
            // With `transition-all` here, the resolved percentage
            // would animate over 120 ms each tick, making the frame
            // body visibly trail the resize handle by one beat.
            // `transition` still animates color / bg / border / ring
            // / shadow / transform / opacity — i.e. all the
            // selection-state visuals this class is here to smooth.
            'semantic-lod-node group relative flex h-full w-full flex-col rounded-lg transition duration-120',

            hasCardSurface && 'hover:shadow-sm',
            hasCardSurface && editing && 'shadow-sm',
            hasCardSurface && isDragging && 'shadow-md',
            !accentTokens && !fillColor && 'bg-transparent',
            // Selection outline is rendered as a screen-space HUD overlay
            // by `<SelectionOutlines />` (Canvas-level), not as a ring on
            // the node DOM. Mirroring common design tools: clicking a node MUST NOT
            // change its z-order, so the selection indicator lives on a
            // layer that is always on top regardless of node stacking.
            // Hover ring (only for non-sketch) stays here because it
            // tracks `:hover`, which the overlay cannot observe.
            !selected && type !== 'sketch' && 'ring-edge-default hover:ring',

            type !== 'sketch' && 'border-3 border-transparent',
            // Question nodes need visible overflow for status badges and progress bar
            type === 'question' && 'overflow-visible',
            className,
          )}
          style={{
            // Fill priority: explicit override (`fillColor`, used by
            // QuestionNode) > accent-derived tint > nothing (let the
            // `bg-transparent` class above show the canvas through).
            ...(fillColor
              ? { backgroundColor: fillColor }
              : accentTokens
                ? { backgroundColor: accentTokens.bg }
                : {}),
            ...(accentTokens && {
              borderColor: accentTokens.border,
            }),
            ...(type === 'question' && {
              borderColor: 'transparent',
            }),
          }}
          data-lod={renderMode}
          onDoubleClick={onDoubleClick}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        >
          {/*
            Keep the lightweight placeholder mounted inside the node shell
            so CSS can cross-fade both directions. Its position in this
            shared containing block also guarantees that the full-LOD hiding
            selector and the absolute inset use the same structural anchor.
          */}
          {supportsMinimalLOD && (
            <SemanticPlaceholder
              type={type}
              data={data}
              active={isMinimal}
              width={nodeWidth}
              height={nodeHeight}
            />
          )}

          {showIngestionOverlay && (
            <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-10">
              <Loading layout="inline" size="xs" className="text-fg-subtle" />
            </div>
          )}

          {/* AI provenance badge */}
          {showAIBadge && (
            <Tooltip
              content={
                provenanceSummary
                  ? `AI edits pending: ${provenanceSummary.editedCount}, deletions: ${provenanceSummary.deletedCount}`
                  : 'AI generated'
              }
            >
              <div
                className={clsx(
                  'absolute top-1 right-1 z-10 flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium',
                  'bg-ai-bg text-ai',
                )}
              >
                <span>AI</span>
              </div>
            </Tooltip>
          )}

          {/* Duplicate-sidecar warning: more than one `.md` on disk claims
              this node's id. Server-set hint (`data.contentDuplicate`);
              the node still renders off the last-scanned file, but writes
              are refused until the user removes the extra file on disk.
              Rendered as a full-cover overlay (occupying the whole node)
              so the warning is unmissable and the now-uneditable body is
              hidden behind it. Lists the colliding filenames so the user
              can decide which one to keep, and offers an "Open folder"
              shortcut. No Remove button: the fix is to delete the
              duplicate file in the folder, not the node. */}
          {data.contentDuplicate && (
            <div className="border-warning-light bg-surface absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed p-3 text-center">
              <FileWarning className="text-warning h-7 w-7 shrink-0" />
              <div className="text-fg-default text-sm font-medium">
                Duplicate files on disk
              </div>
              <div className="text-fg-subtle max-w-[32ch] text-xs">
                More than one file represents this node, so editing is disabled.
                Keep one and delete the rest, then reload.
              </div>
              {Array.isArray(data.duplicateFiles) &&
                data.duplicateFiles.length > 0 && (
                  <ul className="border-edge-default bg-bg-default text-fg-muted max-h-20 w-full max-w-[36ch] overflow-auto rounded border px-2 py-1 text-left text-[11px] leading-relaxed">
                    {data.duplicateFiles.map((file) => (
                      <li key={file} className="truncate" title={file}>
                        {file}
                      </li>
                    ))}
                  </ul>
                )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  tone="neutral"
                  onClick={handleOpenDuplicateFolder}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Open folder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  tone="neutral"
                  onClick={handleRefreshDuplicate}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
            </div>
          )}

          <div
            className={clsx(
              'semantic-lod-content p-0',

              hasLayoutHeight ? 'min-h-0 flex-1' : 'min-h-0',

              allowOverflow ? 'overflow-visible' : 'overflow-hidden rounded-md',
            )}
          >
            {children}
          </div>

          <NodeConnectionHandles
            nodeId={id}
            hovered={hovered}
            selected={!!selected}
            isNotMouse={isNotMouse}
          />
        </div>
      </>
    );
  },
);
