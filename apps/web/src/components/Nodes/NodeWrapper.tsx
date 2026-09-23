// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useViewport, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { FileWarning, FolderOpen, RefreshCw } from 'lucide-react';
import React, {
  memo,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { getNodeContent, revealCanvasNodesFolder } from '@/api/canvas.ts';
import { Button } from '@/components/Common/Button.tsx';
import { cn } from '@/components/Common/cn.ts';
import { Loading } from '@/components/Common/Loading';
import { toast } from '@/components/Common/Toast';
import { resumeHeightCommits } from '@/components/Nodes/shared/height/commitSuspension';
import { NodeFloatingToolbar } from '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx';
import { SEMANTIC_ZOOM_CONFIG } from '@/config/semanticZoom.ts';
import {
  beginSnapSession,
  endSnapSession,
  applyResizeProposal,
  getResizeContext,
  getResizeSnappedRect,
} from '@/handler/snap/snapSession.ts';
import { handleCanvasFocusEscape } from '@/hooks/useCanvasFocusEscape';
import { useIsNotMouse } from '@/hooks/useInputMode.ts';
import { useMultiSelectModifierHeld } from '@/hooks/useMultiSelectModifier.ts';
import { useNodePresentation } from '@/hooks/useNodePresentation';
import useCanvasStore, {
  clearNodeDuplicateGuard,
} from '@/store/canvasStore.ts';
import { useConnectPortStore } from '@/store/connectPortStore.ts';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore.ts';
import { useNodeCollapseStore } from '@/store/nodeCollapseStore.ts';

import { getAccentTokens } from './design/accentTokens';
import { resolveNodeAccent } from './design/nodeAccentPolicy';
import {
  nodeBoundaryForAccent,
  nodeLayoutBorderInset,
} from './design/nodeBoundary';
import { nodeMetricsForSize } from './design/nodeDesign';
import { frameRegionSurfaceStyle } from './frame/frameRegionStyle';
import { FrameSurface } from './frame/FrameSurface.tsx';
import { useFrameSuppressed } from './frame/FrameZoomContext';
import { NodeConnectionHandles } from './NodeConnectAffordance.tsx';
import {
  NodeResizeControls,
  type ResizeControlPolicy,
} from './NodeResizeControls';
import { NodeTakeoverLayer } from './NodeTakeoverLayer.tsx';
import { noteSurfaceStyle } from './note/noteDesign';
import { ViewportSemanticPlaceholder } from './SemanticPlaceholder.tsx';
import { selectSelectedCount } from './shared/selectedCount';

import type { CanvasNodeType, NodeData } from './types.ts';
import type { TakeoverState } from '@/config/nodeTakeover';
import type { ComponentPropsWithoutRef } from 'react';

interface SurfaceRootProps extends ComponentPropsWithoutRef<'div'> {
  frameAppearance?: {
    accent: string | null;
    borderRadius?: number;
  };
}

const SurfaceRoot = forwardRef<HTMLDivElement, SurfaceRootProps>(
  ({ frameAppearance, ...props }, ref) =>
    frameAppearance ? (
      <FrameSurface ref={ref} {...frameAppearance} {...props} />
    ) : (
      <div ref={ref} {...props} />
    ),
);
SurfaceRoot.displayName = 'SurfaceRoot';

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
  /** Resolved lightweight text, shared with the node's ordinary content. */
  farLabel?: { title: string; description?: string };
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
    fontSize?: number;
    forceCollapsed?: boolean;
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
  /** Override the shared size-tier radius; Frame retains its own surface policy. */
  borderRadius?: number;
  /**
   * Escape hatch for node types whose fill is not the user-facing accent
   * — currently only `QuestionNode`, which paints a fixed sticky-yellow
   * background regardless of any `style.accent`. Leave `undefined` for
   * every other node type: Notes use their subdued accent surface; other
   * non-Frame nodes derive their fill from `data.style.accent`.
   */
  fillColor?: string;

  onResizeStart?: (mode?: 'fit' | 'width' | 'scale') => void;
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
    farLabel,
    takeover,
    overlayOffsetY = 0,
    overlayVisible = true,
    overlayInteractionPriority = 0,
    overlayMaxWidth,
    keepAspectRatio = false,
    resizable = true,
    borderRadius,

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
    // Question nodes already surface their working state via their agent
    // badge (running / done). Their content-ingestion spinner
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

    const presentation = useNodePresentation(id, type, 'none');
    // Media owners retain their cover/body instead of the generic text placeholder.
    const keepsOverviewCard =
      type === 'pdf' || type === 'web' || type === 'video';
    const renderMode =
      presentation.mode === 'minimal' && !keepsOverviewCard
        ? 'minimal'
        : 'full';
    const [nodeRoot, setNodeRoot] = useState<HTMLDivElement | null>(null);
    const isNotMouse = useIsNotMouse();
    const [resizing, setResizing] = useState(false);
    const [resizeEpoch, setResizeEpoch] = useState(0);
    const resizeGesture = useRef<{
      params: { x: number; y: number; width: number; height: number };
      cursor: string;
    } | null>(null);

    // Read canvas-space dimensions for SemanticPlaceholder text fitting
    const nodeWidth = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (node?.style?.width as number) || node?.measured?.width || 400;
    });
    const nodeHeight = useStore((s) => {
      const node = s.nodeLookup.get(id);
      return (
        (node?.style?.height as number) ||
        node?.measured?.height ||
        (type === 'pdf' || type === 'web' ? 400 : 200)
      );
    });

    // Deliberately *not* `resolveHeightMode`: this asks whether a layout
    // height exists to fill, not who owns it. An auto note now carries a
    // materialized number and must stretch to it exactly like a pinned
    // one; only the types that still express auto as an absent height
    // (text / question) take the growing branch.
    const hasLayoutHeight = useStore(
      (s) => typeof s.nodeLookup.get(id)?.style?.height === 'number',
    );

    const handleResize = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        if (!resizeGesture.current) return;
        const zoom = useCanvasStore.getState().rfInstance?.getZoom() ?? 1;
        const snapped = applyResizeProposal(params, zoom);
        resizeGesture.current.params = snapped;
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
        policy: ResizeControlPolicy,
      ) => {
        resizeGesture.current = { params, cursor: policy.cursor };
        setResizing(true);
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
            mode: policy.mode,
            lockAspect: policy.lockAspect,
          },
        });

        onResizeStart?.(policy.mode);
      },
      [id, onNodeResizeStart, onResizeStart],
    );

    const handleResizeEnd = useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ) => {
        if (!resizeGesture.current) return;
        resizeGesture.current = null;
        setResizing(false);
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

        // A Frame cascade may refit/move its ancestors and compensate its
        // local position. The flushed result is already in the current parent
        // space; replaying the gesture-start local proposal would shift it.
        const committedFramePosition =
          type === 'frame'
            ? useCanvasStore.getState().nodes.find((node) => node.id === id)
                ?.position
            : undefined;
        setNodeGeometry([
          {
            nodeId: id,
            size: resizeEndClearHeight
              ? { width: finalSize.width, height: 'auto' }
              : finalSize,
            position:
              committedFramePosition ??
              (positionChanged ? finalLocalPos : undefined),
          },
        ]);

        endSnapSession();
        // Paired with the `suspendHeightCommits` in `onNodeResizeStart`.
        // Released after the geometry commit so a queued correction is
        // evaluated against the node's final width.
        resumeHeightCommits('node-resize');
      },
      [
        endResizePreview,
        setNodeGeometry,
        id,
        type,
        onResizeEnd,
        resizeEndClearHeight,
      ],
    );

    // Native XYFlow drag remains the owner. Interruptions commit its last
    // proposal through the same history/height path, then release its listeners.
    useEffect(() => {
      if (!resizing) return;
      const body = document.body;
      body.style.setProperty(
        '--node-resize-cursor',
        resizeGesture.current?.cursor ?? 'default',
      );
      body.classList.add('node-resize-active');
      const finish = () => {
        const active = resizeGesture.current;
        if (!active) return;
        handleResizeEnd(undefined, active.params);
        window.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, view: window }),
        );
        setResizeEpoch((epoch) => epoch + 1);
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      };
      const visibility = () => {
        if (document.hidden) finish();
      };
      window.addEventListener('pointercancel', finish, true);
      window.addEventListener('blur', finish);
      window.addEventListener('keydown', key, true);
      document.addEventListener('visibilitychange', visibility);
      return () => {
        window.removeEventListener('pointercancel', finish, true);
        window.removeEventListener('blur', finish);
        window.removeEventListener('keydown', key, true);
        document.removeEventListener('visibilitychange', visibility);
        body.classList.remove('node-resize-active');
        body.style.removeProperty('--node-resize-cursor');
      };
    }, [resizing, handleResizeEnd]);

    const isMinimal = renderMode === 'minimal';
    const frameSuppressed = useFrameSuppressed(id);
    const supportsMinimalLOD =
      !keepsOverviewCard &&
      SEMANTIC_ZOOM_CONFIG.nodeLOD[type]?.minimal === 'minimal';

    // Per-node resize handles are only ever shown when this is the *sole*
    // selected node (multi-selection draws a single bounding-box resizer
    // via `MultiSelectResizer` instead). Mounting `<NodeResizer>` only
    // when that holds — rather than keeping it permanently mounted and
    // toggling `isVisible` — keeps it off the first paint for every
    // unselected node on a freshly loaded canvas. Selecting a node already
    // re-renders this component, so the handles still mount in the same
    // commit as the selection highlight (no perceptible delay).
    // A node collapsed to its takeover mark has no visible card to resize,
    // and the handles would sit on the faded footprint's corners — far from
    // the mark, framing nothing. Zooming back in restores them.
    const isCollapsedToMark = useNodeCollapseStore(
      (s) => s.marks[id] !== undefined,
    );
    // Holding the multi-select modifier (Ctrl / Cmd) is an explicit "I'm
    // reaching for another node" intent. The corner resize handles frame
    // this node and reach outward past its edges, so they occlude whatever
    // sits next to it — stand them down for the duration of the hold, just
    // like the floating toolbar.
    const multiSelectModifierHeld = useMultiSelectModifierHeld();
    const showResizer =
      selected &&
      resizable &&
      !data.locked &&
      selectedCount === 1 &&
      !isCollapsedToMark &&
      !multiSelectModifierHeld;

    // While a stroke-level (sketch) selection exists, its own toolbar (or,
    // on desktop, none) owns the surface — suppress this node's floating
    // toolbar so a mixed lasso never shows the node toolbar. Boolean
    // selector so this only re-renders when the flag flips.
    const hasStrokeSelection = useGesturePreviewStore(
      (s) => Object.keys(s.sketchStrokeSelection).length > 0,
    );

    // While a create-connected gesture is pending, the picker asks "what
    // kind of node goes on the end of this edge?" — a different question
    // from "what does the selected node look like?". Showing both toolbars
    // at once puts two unrelated control clusters on screen for one
    // gesture, so every node's toolbar stands down until the pick is
    // committed or cancelled (including the source node's own).
    const hasPendingConnect = useConnectPortStore((s) => s.pending !== null);

    // Derive accent-tinted tokens once so border/shadow stay in sync with
    // the rest of the canvas (PreviewCard, SemanticPlaceholder, ...).
    // Stored value is a palette token (or legacy hex); resolve to CSS color.
    const accent = resolveNodeAccent(type, data.style?.accent);
    const accentTokens =
      type !== 'frame' && accent ? getAccentTokens(accent) : null;
    const shellRadius =
      borderRadius ?? nodeMetricsForSize(nodeWidth, nodeHeight).radius;
    const hasMediaBorderOverlay = type === 'image' || type === 'video';
    // Media borders overlay the content; Sketch has no layout border.
    const borderInset = nodeLayoutBorderInset(type);
    const innerRadius = Math.max(0, shellRadius - borderInset);
    // Accent controls colour only. Elevation is interaction-driven and only
    // applies to card-like content nodes; text, sketch, question, and frame
    // nodes retain their deliberately flat visual language.
    const hasCardSurface =
      type !== 'text' &&
      type !== 'sketch' &&
      type !== 'question' &&
      type !== 'frame';
    const isDocumentReading =
      (type === 'pdf' || type === 'web') && presentation.mode === 'reading';
    const paintsCardChrome = hasCardSurface && !isDocumentReading;
    // Every card shares one boundary policy; media paint it as an overlay
    // rather than reserving layout space inside the shell.
    const cardBoundaryStyle = paintsCardChrome
      ? {
          ...nodeBoundaryForAccent(accent),
          ...((type === 'image' || type === 'video') &&
            !accent && { borderColor: 'transparent' }),
          ...(hasMediaBorderOverlay && { borderWidth: 0 }),
        }
      : undefined;

    const [toolbarGestureActive, setToolbarGestureActive] = useState(false);
    const toolbarDragEnabled = !data.locked;

    return (
      <>
        {!frameSuppressed && (showResizer || resizing) && (
          <NodeResizeControls
            key={resizeEpoch}
            type={type}
            isNotMouse={isNotMouse}
            minWidth={minWidth}
            minHeight={minHeight}
            keepAspectRatio={keepAspectRatio}
            onResizeStart={handleResizeStart}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
          />
        )}
        {selected &&
          !frameSuppressed &&
          selectedCount === 1 &&
          (!isDragging || toolbarGestureActive) &&
          !resizing &&
          !hasStrokeSelection &&
          !hasPendingConnect && (
            <NodeFloatingToolbar
              id={id}
              type={type}
              data={data}
              toolbar={toolbar}
              actions={actions}
              dragEnabled={toolbarDragEnabled}
              dragActive={toolbarGestureActive}
              onDragActiveChange={setToolbarGestureActive}
            />
          )}

        {/* Zoom-invariant overlay portal — isolated component to avoid re-rendering the entire NodeWrapper on pan/zoom */}
        {overlayContent && !frameSuppressed && (
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
            fontSize={takeover.fontSize}
            forceCollapsed={takeover.forceCollapsed}
            nodeRoot={nodeRoot}
            suppressed={frameSuppressed && type !== 'question'}
          />
        )}

        <SurfaceRoot
          ref={setNodeRoot}
          data-node-surface={id}
          onKeyDown={handleCanvasFocusEscape}
          frameAppearance={
            type === 'frame' ? { accent, borderRadius } : undefined
          }
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
            'semantic-lod-node group relative flex h-full w-full flex-col transition duration-120',
            paintsCardChrome && 'border-solid',

            paintsCardChrome && 'hover:shadow-sm',
            paintsCardChrome && editing && 'shadow-sm',
            paintsCardChrome && isDragging && 'shadow-md',
            type !== 'frame' &&
              type !== 'note' &&
              !accentTokens &&
              !fillColor &&
              'bg-transparent',
            // Selection outline is rendered as a screen-space HUD overlay
            // by `<SelectionOutlines />` (Canvas-level), not as a ring on
            // the node DOM. Canvas temporarily elevates the sole selection
            // and its controls without changing persisted stacking order.

            // Text keeps this transparent inset for stable wrapping/auto-size,
            // but does not receive the accent border color below.
            type !== 'sketch' &&
              type !== 'frame' &&
              !hasCardSurface &&
              'border-transparent',
            type !== 'sketch' &&
              !hasMediaBorderOverlay &&
              type !== 'frame' &&
              !hasCardSurface &&
              'border-3',
            // Question nodes need visible overflow for status badges and progress bar
            type === 'question' && 'overflow-visible',
            className,
          )}
          style={{
            // Fill priority: explicit override (`fillColor`, used by
            // QuestionNode) > subdued Note/Text surface > accent tint > transparent.
            ...(type !== 'frame' &&
              (fillColor
                ? { backgroundColor: fillColor }
                : type === 'note' ||
                    ((type === 'text' || type === 'web' || type === 'pdf') &&
                      accent)
                  ? noteSurfaceStyle(accent)
                  : accentTokens
                    ? { backgroundColor: accentTokens.bg }
                    : {})),
            ...(type !== 'frame' &&
              type !== 'text' &&
              !hasCardSurface &&
              accentTokens && { borderColor: accentTokens.border }),
            ...(type === 'question' && {
              borderColor: 'transparent',
            }),
            ...cardBoundaryStyle,
            // Preserve the shared tint, attenuating fill and border independently.
            ...(frameSuppressed &&
              frameRegionSurfaceStyle(
                accent,
                cardBoundaryStyle?.borderColor ??
                  (type !== 'text' && type !== 'question' && accentTokens
                    ? accentTokens.border
                    : 'transparent'),
                type === 'frame',
              )),
            ...(isDocumentReading && {
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderWidth: 0,
            }),
            ...(type !== 'frame' && { borderRadius: shellRadius }),
          }}
          data-lod={renderMode}
          data-frame-suppressed={frameSuppressed || undefined}
          data-presentation={presentation.mode}
          onDoubleClick={onDoubleClick}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        >
          {/*
            Keep the lightweight text inside the existing shell without
            changing geometry or introducing another surface style.
          */}
          {supportsMinimalLOD && (
            <ViewportSemanticPlaceholder
              type={type}
              data={data}
              active={isMinimal && !frameSuppressed}
              width={nodeWidth}
              height={nodeHeight}
              label={farLabel}
              borderRadius={innerRadius}
            />
          )}

          {showIngestionOverlay && !frameSuppressed && (
            <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-10">
              <Loading layout="inline" size="xs" className="text-fg-subtle" />
            </div>
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
          {data.contentDuplicate && !frameSuppressed && (
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
            inert={isMinimal || frameSuppressed || undefined}
            aria-hidden={isMinimal || frameSuppressed || undefined}
            className={clsx(
              'semantic-lod-content p-0',

              hasLayoutHeight ? 'min-h-0 flex-1' : 'min-h-0',

              allowOverflow ? 'overflow-visible' : 'overflow-hidden',
            )}
            style={
              type === 'frame'
                ? { borderRadius: 'inherit' }
                : ({
                    borderRadius: innerRadius,
                    '--node-inner-radius': `${innerRadius}px`,
                  } as React.CSSProperties)
            }
          >
            {children}
          </div>

          {/* Paint media borders above the content without shrinking its aspect-ratio box. */}
          {hasMediaBorderOverlay && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-1 rounded-[inherit] border-3 border-[inherit]"
              data-node-media-border
              data-node-image-border={type === 'image' || undefined}
            />
          )}

          <NodeConnectionHandles
            nodeId={id}
            hovered={hovered}
            selected={!!selected && selectedCount === 1}
            isNotMouse={isNotMouse}
            dragging={isDragging}
            resizing={resizing || frameSuppressed}
          />
        </SurfaceRoot>
      </>
    );
  },
);
