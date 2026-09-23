// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Connection-related affordances that float around every NodeWrapper:
 */

import {
  Handle,
  Position,
  useConnection,
  useInternalNode,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { createId, type EdgeStyle } from '@huabu/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { cn } from '@/components/Common/cn.ts';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { nodeLayoutBorderInset } from '@/components/Nodes/design/nodeBoundary.ts';
import { FRAME_DESIGN_CONFIG } from '@/components/Nodes/frame/frameDesign.ts';
import { computeAdjacentNodePlacement } from '@/components/Nodes/nodePlacement.ts';
import { createQuestionNodeAndCompose } from '@/components/Nodes/question/questionCompose.ts';
import { useRenderedNodeGeometry } from '@/components/Panels/Canvas/useRenderedNodeGeometry.ts';
import {
  NODE_CONNECTION_CHROME,
  NODE_CONTROL_CHROME,
} from '@/config/nodeInteractionChrome';
import { useMultiSelectModifierHeld } from '@/hooks/useMultiSelectModifier.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { useConnectPortStore } from '@/store/connectPortStore.ts';
import {
  blendedMarkRect,
  useNodeCollapseStore,
} from '@/store/nodeCollapseStore.ts';

/** Connection handle definitions – source + target on each side. */
const HANDLE_DEFS = [
  { type: 'target' as const, id: 'top-target', position: Position.Top },
  { type: 'source' as const, id: 'top-source', position: Position.Top },
  { type: 'target' as const, id: 'right-target', position: Position.Right },
  { type: 'source' as const, id: 'right-source', position: Position.Right },
  { type: 'target' as const, id: 'bottom-target', position: Position.Bottom },
  { type: 'source' as const, id: 'bottom-source', position: Position.Bottom },
  { type: 'target' as const, id: 'left-target', position: Position.Left },
  { type: 'source' as const, id: 'left-source', position: Position.Left },
] as const;

/** The four sides a port is painted on, without the source/target pairing. */
const PORT_POSITIONS = [
  Position.Top,
  Position.Right,
  Position.Bottom,
  Position.Left,
] as const;

/** Cardinal sides a connection can leave a node from. */
export type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * Press area of a port (screen px), deliberately larger than the circle
 * painted inside it: the control has to be aimed at, but drawing something
 * this big would crowd a small node.
 *
 * Mouse targets are centered on the circle and remain outside the node.
 * Touch targets spend the extra area outward to preserve body click space.
 */
const PORT_HIT_SIZE = NODE_CONNECTION_CHROME.hitSize;

/** Painted port centres sit this far outside the boundary, in screen px. */
const PORT_OUTWARD_OFFSET = NODE_CONNECTION_CHROME.outwardOffset;

const pendingHandleRefreshes = new WeakMap<object, Map<string, object>>();

export function scheduleHandleRefresh(
  scope: object,
  nodeId: string,
  update: (nodeIds: string[]) => void,
): () => void {
  let pending = pendingHandleRefreshes.get(scope);
  if (!pending) {
    pending = new Map();
    pendingHandleRefreshes.set(scope, pending);
    const batch = pending;
    requestAnimationFrame(() => {
      pendingHandleRefreshes.delete(scope);
      if (batch.size > 0) update([...batch.keys()]);
    });
  }
  const ticket = {};
  pending.set(nodeId, ticket);
  const batch = pending;
  return () => {
    if (batch.get(nodeId) === ticket) batch.delete(nodeId);
  };
}

/** Visual/hit offset only; never apply this to React Flow's handle bounds. */
export function connectionPortOffset(
  position: Position,
  zoom: number,
  screenDistance: number = PORT_OUTWARD_OFFSET,
): { x: number; y: number } {
  const distance = screenDistance / (zoom > 0 ? zoom : 1);
  return {
    x:
      position === Position.Left
        ? -distance
        : position === Position.Right
          ? distance
          : 0,
    y:
      position === Position.Top
        ? -distance
        : position === Position.Bottom
          ? distance
          : 0,
  };
}

/** Cardinal side -> the React Flow `Position` it corresponds to. */
export const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * Style of the edge a port gesture creates.
 *
 * Named rather than inlined so the pending-edge preview can render the
 * exact line the user is about to commit instead of an approximation of
 * it — run this through `applyEdgeStyle` to get the rendering props.
 */
export const CONNECTED_NODE_EDGE_STYLE: EdgeStyle = { direction: 'forward' };

/** Node types the connect affordance can spawn. */
export type ConnectedNodeKind = 'note' | 'question';

/**
 * Where a newly created connected node should land.
 *
 * `'side'` auto-aligns it off one edge of the source node (what a click
 * on a port means), `'point'` drops it exactly where the gesture ended
 * (what dragging a port out to empty canvas means).
 */
export type ConnectedNodePlacement =
  | { kind: 'side'; side: Side }
  | { kind: 'point'; point: { x: number; y: number } };

/** Parse the cardinal side out of a handle id such as `top-source`. */
export function sideFromHandleId(
  handleId: string | null | undefined,
): Side | null {
  const side = handleId?.split('-')[0];
  return side === 'top' ||
    side === 'right' ||
    side === 'bottom' ||
    side === 'left'
    ? side
    : null;
}

/**
 * Create a node of `kind` positioned by `placement` and connect it to
 * `sourceId` with a forward edge.
 *
 * Both connect gestures funnel through here: clicking a port resolves to
 * a `'side'` placement, dragging a port out to empty canvas resolves to a
 * `'point'` placement. Geometry is the only difference — the node type
 * always comes from the picker.
 */
export function useCreateConnectedNode() {
  const addNode = useCanvasStore((state) => state.addNode);
  const dispatchUiIntent = useCanvasStore((state) => state.dispatchUiIntent);

  return useCallback(
    (
      sourceId: string,
      placement: ConnectedNodePlacement,
      kind: ConnectedNodeKind,
    ) => {
      const state = useCanvasStore.getState();
      const nodes = state.nodes as NestableNode[];
      const byId = indexById(nodes);
      const self = byId.get(sourceId);
      const getAbs = createAbsolutePositionGetter(byId);
      const srcAbs = getAbs(sourceId);
      if (!self || !srcAbs) return;

      const srcW =
        (self.style?.width as number | undefined) ??
        self.measured?.width ??
        200;
      const srcH =
        (self.style?.height as number | undefined) ??
        self.measured?.height ??
        120;
      const placementPoint =
        placement.kind === 'point'
          ? placement.point
          : computeAdjacentNodePlacement({
              nodes,
              source: {
                x: srcAbs.x,
                y: srcAbs.y,
                width: srcW,
                height: srcH,
              },
              nodeType: kind,
              side: placement.side,
            });

      if (kind === 'question') {
        const { nodeId } = createQuestionNodeAndCompose({
          addNode,
          placementPoint,
          canvasId: state.canvasId,
        });
        dispatchUiIntent({
          type: 'CONNECT_EDGE',
          source: sourceId,
          target: nodeId,
          style: CONNECTED_NODE_EDGE_STYLE,
        });
        return;
      }

      const newId = createId('node');
      addNode({
        id: newId,
        nodeType: kind,
        placementPoint,
        data: { content: '', origin: { type: 'user-created' } },
      });
      dispatchUiIntent({
        type: 'CONNECT_EDGE',
        source: sourceId,
        target: newId,
        style: CONNECTED_NODE_EDGE_STYLE,
      });
    },
    [addNode, dispatchUiIntent],
  );
}

// ---------------------------------------------------------------------------
// NodeConnectionHandles
// ---------------------------------------------------------------------------

/**
 * Painted circle of a port, in whatever unit the caller's coordinate
 * space uses — flow units inside the viewport, screen px in a HUD.
 */
function portCircleStyle(size: number, hot: boolean): React.CSSProperties {
  return {
    ...NODE_CONTROL_CHROME.style,
    width: size,
    height: size,
    ...(hot && { backgroundColor: 'var(--color-info)' }),
  };
}

/** A rectangle in whatever coordinate space the caller is working in. */
interface PortRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Centre of the port on one side of a rect — the midpoint of that edge.
 *
 * A collapsed mark is a circle inscribed in its bounding square, so the same
 * edge midpoints are also the circle's four cardinal points. One formula
 * therefore serves both the readable card and the collapsed mark.
 */
function portPointOnRect(
  position: Position,
  rect: PortRect,
): { cx: number; cy: number } {
  const cx =
    position === Position.Left
      ? rect.x
      : position === Position.Right
        ? rect.x + rect.width
        : rect.x + rect.width / 2;
  const cy =
    position === Position.Top
      ? rect.y
      : position === Position.Bottom
        ? rect.y + rect.height
        : rect.y + rect.height / 2;
  return { cx, cy };
}

/**
 * One screen-space painter for idle dots and the aimed-at Plus, above nodes
 * and selection outlines. Native handles retain hit-testing and edge geometry.
 *
 * `SelectionOutlines` is a HUD portalled into the React Flow container at
 * `z-998`, so nothing rendered inside the viewport can paint over it and a
 * selected node's border would slice straight through the `+`. Raising the
 * port's own z-index cannot help: the node is a stacking context nested
 * inside the renderer, so it is all-or-nothing against a sibling of the
 * renderer. The fix is the one `MultiSelectResizer` already uses — draw in
 * the same HUD layer. The in-flow port keeps hit-testing; this is paint
 * only, with exactly one painted circle per visible side.
 */
function ConnectionPortOverlay({
  nodeId,
  domNode,
  size,
  hotSize,
  hotPosition,
  exposed,
  connecting,
  rect,
}: {
  nodeId: string;
  domNode: HTMLDivElement | null;
  size: number;
  hotSize: number;
  hotPosition: Position | null;
  exposed: boolean;
  connecting: boolean;
  rect: PortRect;
}) {
  if (!domNode) return null;

  return createPortal(
    <>
      {PORT_POSITIONS.map((position) => {
        const hot = position === hotPosition;
        if (!exposed && !hot) return null;
        const diameter = hot ? hotSize : size;
        const { cx, cy } = portPointOnRect(position, rect);
        const outward = connectionPortOffset(position, 1);
        return (
          <div
            key={position}
            aria-hidden
            data-connection-port-dot={
              !hot ? `${nodeId}:${position}` : undefined
            }
            data-connection-port-icon={
              hot ? `${nodeId}:${position}` : undefined
            }
            className="pointer-events-none absolute z-999 flex items-center justify-center rounded-full"
            style={{
              ...portCircleStyle(diameter, hot),
              left: cx + outward.x - diameter / 2,
              top: cy + outward.y - diameter / 2,
              boxShadow:
                !hot && connecting
                  ? '0 0 3px var(--color-info-light)'
                  : undefined,
            }}
          >
            {hot && (
              <Plus
                className="text-fg-inverse"
                strokeWidth={3.5}
                style={{ width: diameter * 0.6, height: diameter * 0.6 }}
              />
            )}
          </div>
        );
      })}
    </>,
    domNode,
  );
}

interface NodeConnectionHandlesProps {
  /** Id of the node these handles belong to. */
  nodeId: string;
  /** Whether the pointer is currently over the node. */
  hovered: boolean;
  /** Whether the node is the unique selected node. */
  selected: boolean;
  /** True for touch / pen input; otherwise we treat as mouse. */
  isNotMouse: boolean;
  /**
   * Whether the node is currently being dragged. A move gesture keeps the
   * pointer inside the node (and the node selected), so hover/selection
   * alone would leave the ports lit for the whole drag — floating over the
   * drop placeholder and inviting a connection the gesture cannot start.
   */
  dragging: boolean;
  /** Hide and disable every port while the parent owns a resize gesture. */
  resizing?: boolean;
}

export function shouldExposeConnectionPorts({
  selected,
  connecting,
  hovered,
  dragging,
  resizing = false,
  multiSelectModifierHeld,
}: {
  selected: boolean;
  connecting: boolean;
  hovered: boolean;
  dragging: boolean;
  resizing?: boolean;
  multiSelectModifierHeld: boolean;
}): boolean {
  return (
    (selected || (connecting && hovered)) &&
    !dragging &&
    !resizing &&
    !multiSelectModifierHeld
  );
}

export const NodeConnectionHandles = memo(
  ({
    nodeId,
    hovered,
    selected,
    isNotMouse,
    dragging,
    resizing = false,
  }: NodeConnectionHandlesProps) => {
    const { t } = useTranslation();
    const node = useInternalNode(nodeId);
    const domNode = useStore((state) => state.domNode);
    const pinnedSide = useConnectPortStore((s) =>
      s.pending?.sourceId === nodeId ? s.pending.side : null,
    );
    const connecting = useConnection((c) => c.inProgress);
    const measurePorts =
      selected || (connecting && hovered) || pinnedSide !== null;
    const tx = useStore((state) => (measurePorts ? state.transform[0] : 0));
    const ty = useStore((state) => (measurePorts ? state.transform[1] : 0));
    const zoom = useStore((state) => (measurePorts ? state.transform[2] : 1));
    const x = node?.internals.positionAbsolute.x ?? 0;
    const y = node?.internals.positionAbsolute.y ?? 0;
    const width =
      (node?.style?.width as number | undefined) ?? node?.measured.width ?? 0;
    const height =
      (node?.style?.height as number | undefined) ?? node?.measured.height ?? 0;
    const { geometry: renderedGeometry } = useRenderedNodeGeometry(
      nodeId,
      domNode,
      node?.resizing === true,
      {
        nodeX: x,
        nodeY: y,
        nodeWidth: width,
        nodeHeight: height,
        viewportX: tx,
        viewportY: ty,
        zoom,
      },
      measurePorts,
    );
    // Match the shell's layout inset, not its painted overlay width.
    // Frame retains its separate surface policy.
    const borderInset =
      node?.type === 'frame'
        ? FRAME_DESIGN_CONFIG.appearance.borderWidth
        : nodeLayoutBorderInset(node?.type);
    const borderLeft = renderedGeometry?.borderLeft ?? borderInset;
    const borderTop = renderedGeometry?.borderTop ?? borderInset;
    // Only the pinned *side* matters here, and only when the pending
    // gesture belongs to this node — selecting that narrowly keeps a
    // gesture on one node from re-rendering every other node's ports.
    const mark = useNodeCollapseStore((s) => s.marks[nodeId]);
    const flow = useStoreApi();
    const updateNodeInternals = useUpdateNodeInternals();

    const baseHandleSize =
      NODE_CONNECTION_CHROME.dotSize[isNotMouse ? 'touch' : 'mouse'];
    const hitSize = isNotMouse ? PORT_HIT_SIZE.touch : PORT_HIT_SIZE.mouse;
    const hitOutwardShift = isNotMouse ? (hitSize - baseHandleSize) / 2 : 0;
    const inverseZoom = zoom > 0 ? 1 / zoom : 1;
    const dotSize = baseHandleSize * inverseZoom;
    // A connection drag temporarily exposes the hovered target node's dots;
    // the source port remains pinned separately below.
    const fromHandle = useConnection((c) => c.fromHandle);

    // Ports are the single control for both "connect" and "create": drag
    // one to link nodes, click one to spawn a connected node. Only the
    // port the pointer is actually aiming at grows and reveals the `+`,
    // so the idle state stays four quiet dots instead of four buttons.
    const [hotSide, setHotSide] = useState<Position | null>(null);
    // While the multi-select modifier (Ctrl / Cmd) is held the user is
    // reaching for another node, so keep this node's ports quiet: the
    // edge-endpoint handles stay mounted (they always map below), only the
    // outward-reaching `+` dots that would occlude the neighbour are hidden.
    const multiSelectModifierHeld = useMultiSelectModifierHeld();
    const exposed = shouldExposeConnectionPorts({
      selected,
      connecting,
      hovered,
      dragging,
      resizing,
      multiSelectModifierHeld,
    });
    const hotHandleSize =
      NODE_CONNECTION_CHROME.hotSize[isNotMouse ? 'touch' : 'mouse'];

    const pinnedPosition =
      !resizing && pinnedSide ? SIDE_POSITION[pinnedSide] : null;

    // Pressing a port starts a connection immediately (the canvas sets
    // `connectionDragThreshold` to 0), so without this the port would
    // visibly collapse the moment it is clicked. The hovered target node's
    // ports stay plain dots during a drag, where they mean "drop here", not
    // "add".
    const originSide =
      connecting && fromHandle?.nodeId === nodeId
        ? sideFromHandleId(fromHandle.id)
        : null;

    // At most one port of a node is ever hot, so resolve it once here
    // rather than per handle — each side renders two stacked handles
    // (a source and a target) that would otherwise both light up.
    const hotPosition = resizing
      ? null
      : (pinnedPosition ??
        (originSide ? SIDE_POSITION[originSide] : null) ??
        (exposed && !connecting ? hotSide : null));

    // Once the card has collapsed into its takeover mark, the footprint the
    // handles are laid out against is invisible — ports pinned to its edges
    // would hang in empty canvas, and a connection dragged from one would
    // start nowhere near the thing the user aimed at. Rebase them onto the
    // mark.
    const boundaryRect: PortRect = mark
      ? blendedMarkRect(mark)
      : renderedGeometry
        ? {
            x: (renderedGeometry.x - tx) * inverseZoom,
            y: (renderedGeometry.y - ty) * inverseZoom,
            width: renderedGeometry.width * inverseZoom,
            height: renderedGeometry.height * inverseZoom,
          }
        : { x, y, width, height };
    const localRect: PortRect | null =
      mark || renderedGeometry
        ? { ...boundaryRect, x: boundaryRect.x - x, y: boundaryRect.y - y }
        : null;

    const handleX = mark ? localRect?.x : 0;
    const handleY = mark ? localRect?.y : 0;
    const handleWidth = localRect?.width ?? width;
    const handleHeight = localRect?.height ?? height;
    useLayoutEffect(
      () => scheduleHandleRefresh(flow, nodeId, updateNodeInternals),
      [
        flow,
        nodeId,
        updateNodeInternals,
        handleX,
        handleY,
        handleWidth,
        handleHeight,
        borderLeft,
        borderTop,
        dotSize,
      ],
    );

    return (
      <>
        {(exposed || hotPosition) && (
          <ConnectionPortOverlay
            nodeId={nodeId}
            domNode={domNode}
            size={baseHandleSize}
            hotSize={hotHandleSize}
            hotPosition={hotPosition}
            exposed={exposed}
            connecting={connecting}
            rect={{
              x: boundaryRect.x * zoom + tx,
              y: boundaryRect.y * zoom + ty,
              width: boundaryRect.width * zoom,
              height: boundaryRect.height * zoom,
            }}
          />
        )}
        {HANDLE_DEFS.map((h) => {
          const side = sideFromHandleId(h.id);
          const keyboardReachable =
            !resizing && selected && h.type === 'source' && side !== null;
          // Two flavours of "handle position" are consumed by React Flow:
          //   - `getHandlePosition(..., center=false)` returns the bbox's
          //     *outer edge* on the relevant axis (e.g. `bbox.y` for
          //     Position.Top). This drives committed-edge endpoints.
          //   - `getHandlePosition(..., center=true)` returns the bbox
          //     *centre*. This drives the connection-line preview that
          //     renders while the user drags from a handle.
          //
          // BOTH points stay exactly on the visible node boundary. The
          // painted dot and its hit area move outward independently; that
          // presentation offset must never move either edge endpoint.
          //
          // A non-zero square bbox cannot satisfy both — its outer edge
          // and its centre are always `size/2` apart. So we collapse
          // the bbox to *zero thickness* on the perpendicular axis: for
          // top/bottom handles `width=dotSize, height=0`; for left/
          // right, `width=0, height=dotSize`. With height/width = 0 on
          // that axis, `bbox.y === bbox.y + height/2`, so the two
          // flavours of `getHandlePosition` return the same point.
          //
          // The transparent hit child moves outward from the bbox and has
          // `pointer-events: auto`; events still bubble up to the Handle.
          // ConnectionPortOverlay paints the circle in the HUD instead.
          //
          // The negative border inset cancels the shell's layout border:
          // the Handle is positioned absolutely against its
          // containing block's *padding box* (inside the border), so
          // `top: 0` would land inside a bordered shell's visible edge.
          const edgeAlign: React.CSSProperties =
            h.position === Position.Top
              ? {
                  top: -borderInset,
                  width: dotSize,
                  height: 0,
                  transform: 'translate(-50%, 0)',
                }
              : h.position === Position.Bottom
                ? {
                    bottom: -borderInset,
                    width: dotSize,
                    height: 0,
                    transform: 'translate(-50%, 0)',
                  }
                : h.position === Position.Left
                  ? {
                      left: -borderInset,
                      width: 0,
                      height: dotSize,
                      transform: 'translate(0, -50%)',
                    }
                  : {
                      right: -borderInset,
                      width: 0,
                      height: dotSize,
                      transform: 'translate(0, -50%)',
                    };
          const alignStyle: React.CSSProperties = localRect
            ? (() => {
                const { cx, cy } = portPointOnRect(h.position, localRect);
                const horizontal =
                  h.position === Position.Top || h.position === Position.Bottom;
                return {
                  left: cx - borderLeft,
                  top: cy - borderTop,
                  right: 'auto',
                  bottom: 'auto',
                  width: horizontal ? dotSize : 0,
                  height: horizontal ? 0 : dotSize,
                  transform: horizontal
                    ? 'translate(-50%, 0)'
                    : 'translate(0, -50%)',
                };
              })()
            : edgeAlign;
          // Hover changes only HUD paint, never the handle bbox or endpoints.
          // A port with a picker open stays visible and pressed until the
          // gesture resolves, even after the pointer has left the node.
          const isPinned = pinnedPosition === h.position;
          // Hit-testing must follow *visibility*, not focusability. The
          // parent `<Handle>` carries `pointer-events-none` while hidden,
          // but CSS lets a child turn pointer events back on regardless of
          // its ancestor, so a target that opts in unconditionally stays
          // live on every node on the canvas even at zero opacity — and
          // since `connectionDragThreshold` is 0, a press-and-release on one
          // creates a node. Keyboard reachability deliberately does not open
          // it: focus needs no pointer events, and a selected node the
          // pointer is not on must stay a plain click target.
          const isPinnedOrExposed = exposed || isPinned;
          const isReachable = isPinnedOrExposed || keyboardReachable;
          const hitOffset = connectionPortOffset(
            h.position,
            zoom,
            PORT_OUTWARD_OFFSET + hitOutwardShift,
          );
          // Both input modes keep the complete press area outside the node.
          const hitStyle: React.CSSProperties = {
            width: hitSize * inverseZoom,
            height: hitSize * inverseZoom,
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) translate(${hitOffset.x}px, ${hitOffset.y}px)`,
            // React Flow paints handles with `cursor: crosshair`, which only
            // describes half of what this control does. Clicking it creates a
            // node, so the pointer cursor matches the `+` the user sees.
            cursor: 'pointer',
          };
          // Native hit targets stay inside the node for connection bubbling
          // and side-aligned click creation; the HUD owns all visible paint.
          const dot = (
            // Role, tabIndex and label are applied together below; the
            // linter cannot see them through the spread.
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <span
              {...(keyboardReachable
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    'aria-label': t('node.createConnectedNode'),
                  }
                : { 'aria-hidden': true, tabIndex: -1 })}
              className={cn(
                'absolute',
                isPinnedOrExposed
                  ? 'pointer-events-auto'
                  : 'pointer-events-none',
              )}
              style={hitStyle}
              onPointerEnter={() => setHotSide(h.position)}
              onPointerLeave={() => setHotSide(null)}
              onFocus={() => setHotSide(h.position)}
              onBlur={() => setHotSide(null)}
              onKeyDown={(event) => {
                if (
                  !keyboardReachable ||
                  !side ||
                  !node ||
                  (event.key !== 'Enter' && event.key !== ' ')
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const { cx, cy } = portPointOnRect(h.position, boundaryRect);
                useConnectPortStore.getState().setPending({
                  sourceId: nodeId,
                  side,
                  anchor: { x: cx, y: cy },
                  kind: 'side',
                });
              }}
            />
          );
          return (
            <Handle
              key={h.id}
              type={h.type}
              id={h.id}
              position={h.position}
              isConnectable={!resizing}
              isConnectableStart={!resizing}
              isConnectableEnd={!resizing}
              style={{
                ...alignStyle,
                minWidth: 0,
                minHeight: 0,
                background: 'transparent',
                border: 'none',
                // Resize suppression is immediate, including a focused port;
                // do not leave it visible for the opacity transition.
                ...(resizing && { opacity: 0, pointerEvents: 'none' }),
              }}
              className={cn(
                'z-20 transition-opacity',
                !resizing && 'focus-within:opacity-100',
                isPinned
                  ? 'opacity-100'
                  : !exposed
                    ? 'pointer-events-none opacity-0'
                    : isNotMouse
                      ? 'opacity-40 active:opacity-100'
                      : 'opacity-100',
              )}
            >
              {/*
                Only mount a tooltip for ports that are actually reachable.
                A canvas holds many nodes × eight handles each, and every
                `<Tooltip>` carries its own Floating UI instance.

                The wrapper fills the zero-thickness boundary anchor;
                only its child hit area and dot translate outward. Keeping
                this wrapper unshifted avoids applying the offset twice.
                The tooltip gap must include the vertical paint offset so
                both its preferred placement and its flipped placement clear Plus.
              */}
              {isReachable ? (
                <Tooltip
                  content={t('node.createConnectedNode')}
                  wrapperClassName="absolute inset-0"
                  placement={h.position === Position.Bottom ? 'bottom' : 'top'}
                  offset={
                    Math.abs(connectionPortOffset(h.position, 1).y) +
                    hotHandleSize / 2 +
                    NODE_CONNECTION_CHROME.toolbarGap
                  }
                >
                  {dot}
                </Tooltip>
              ) : (
                dot
              )}
            </Handle>
          );
        })}
      </>
    );
  },
);
NodeConnectionHandles.displayName = 'NodeConnectionHandles';
