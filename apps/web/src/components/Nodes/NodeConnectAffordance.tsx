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
  useUpdateNodeInternals,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { createId, type EdgeStyle } from '@huabu/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
  getNodeDefaultSize,
  getNodeSize,
} from '@huabu/shared/canvas-engine';

import { cn } from '@/components/Common/cn.ts';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { createQuestionNodeAndCompose } from '@/components/Nodes/question/questionCompose.ts';
import { localMarkRect } from '@/config/nodeTakeover.ts';
import { useMultiSelectModifierHeld } from '@/hooks/useMultiSelectModifier.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { useConnectPortStore } from '@/store/connectPortStore.ts';
import {
  blendedMarkRect,
  useNodeCollapseStore,
  type MarkAnchorRect,
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
 * The extra area is spent entirely *outward*, into empty canvas. The press
 * area's inner edge is lined up with the circle's own, so widening the
 * target costs the node body nothing — growing it inward would eat the
 * body the user is trying to click, which is the problem it exists to
 * avoid.
 */
const PORT_HIT_SIZE = { mouse: 20, touch: 28 } as const;

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

/** Flow-space gap between the source node and the newly-created node. */
const NEW_NODE_GAP = 80;

/**
 * Spacing (flow px) inserted between stacked nodes when the ideal
 * placement collides with an existing node and we have to nudge the new
 * node along the perpendicular axis to avoid overlap.
 */
const NEW_NODE_AVOID_GAP = 24;

/**
 * Minimum overlap-avoidance budget (flow px): how far the avoidance pass
 * may push a new node away from its ideal aligned position before giving
 * up and accepting an overlap.
 *
 * This is only the floor. The effective budget scales with the source
 * node's extent along the avoidance axis (see `useCreateConnectedNode`)
 * so that a very large source - whose neighbours are spread across its
 * full height/width - still gets a proportionally large search range
 * instead of bailing out just past its own edge.
 */
const NEW_NODE_MIN_AVOID_DISTANCE = 800;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned rectangle intersection test. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * Nudge an ideal top-left placement along the axis perpendicular to the
 * connection direction until the new node no longer overlaps any
 * existing node.
 *
 * - Connections on the left/right sides avoid vertically (up/down);
 *   top/bottom connections avoid horizontally (left/right) so the new
 *   node stays on the intended side of its source.
 * - Candidate offsets are tried nearest-first in an alternating order
 *   (0, +step, -step, +2*step, -2*step, ...) so the node lands as close
 *   to its aligned position as possible.
 * - If no free slot is found within `maxDistance` the
 *   ideal point is returned unchanged (overlap accepted on purpose).
 */
function avoidOverlap(
  ideal: { x: number; y: number },
  newSize: { w: number; h: number },
  side: Side,
  obstacles: readonly Rect[],
  maxDistance: number,
): { x: number; y: number } {
  const vertical = side === 'left' || side === 'right';
  const step = (vertical ? newSize.h : newSize.w) + NEW_NODE_AVOID_GAP;

  const fits = (pt: { x: number; y: number }): boolean => {
    const rect: Rect = { x: pt.x, y: pt.y, w: newSize.w, h: newSize.h };
    return !obstacles.some((o) => rectsOverlap(rect, o));
  };

  if (fits(ideal)) return ideal;

  const maxK = Math.floor(maxDistance / step);
  for (let k = 1; k <= maxK; k++) {
    for (const dir of [1, -1] as const) {
      const off = dir * k * step;
      const pt = vertical
        ? { x: ideal.x, y: ideal.y + off }
        : { x: ideal.x + off, y: ideal.y };
      if (fits(pt)) return pt;
    }
  }
  return ideal;
}

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
 * Auto-placement for a node attached to `side` of the source rect: the
 * aligned position one `NEW_NODE_GAP` away, nudged perpendicular until
 * it clears every existing node.
 */
function computeSidePlacement({
  nodes,
  getAbs,
  source,
  size,
  side,
}: {
  /** Every node on the canvas, used as collision obstacles. */
  nodes: NestableNode[];
  getAbs: ReturnType<typeof createAbsolutePositionGetter>;
  /** Absolute rect of the node the connection leaves. */
  source: Rect;
  /** Size of the node about to be created. */
  size: { w: number; h: number };
  side: Side;
}): { x: number; y: number } {
  const { x: srcX, y: srcY, w: srcW, h: srcH } = source;
  const { w: newW, h: newH } = size;
  let placementPoint: { x: number; y: number };
  switch (side) {
    case 'top':
      placementPoint = {
        x: srcX + srcW / 2 - newW / 2,
        y: srcY - newH - NEW_NODE_GAP,
      };
      break;
    case 'bottom':
      placementPoint = {
        x: srcX + srcW / 2 - newW / 2,
        y: srcY + srcH + NEW_NODE_GAP,
      };
      break;
    case 'left':
      placementPoint = {
        x: srcX - newW - NEW_NODE_GAP,
        y: srcY + srcH / 2 - newH / 2,
      };
      break;
    case 'right':
    default:
      placementPoint = {
        x: srcX + srcW + NEW_NODE_GAP,
        y: srcY + srcH / 2 - newH / 2,
      };
      break;
  }

  // Collision-avoidance: keep the ideal aligned position when it is
  // free, otherwise nudge perpendicular to the connection direction
  // so repeated "add connected node" gestures don't stack on the same
  // spot. Frames are ignored as obstacles (child nodes legitimately
  // sit inside them).
  const obstacles: Rect[] = [];
  for (const n of nodes) {
    if (n.type === 'frame') continue;
    const abs = getAbs(n.id);
    if (!abs) continue;
    const { width, height } = getNodeSize(n);
    const fallback = getNodeDefaultSize(n.type ?? '');
    obstacles.push({
      x: abs.x,
      y: abs.y,
      w: width > 0 ? width : fallback.width || 200,
      h: height > 0 ? height : fallback.height || 100,
    });
  }
  // Scale the avoidance budget with the source node's extent along
  // the avoidance axis: left/right connections avoid vertically (so
  // the source height matters), top/bottom avoid horizontally (source
  // width). A large source needs a proportionally larger search range
  // to clear neighbours spread across its full span.
  const avoidAxisExtent = side === 'left' || side === 'right' ? srcH : srcW;
  const maxAvoidDistance = NEW_NODE_MIN_AVOID_DISTANCE + avoidAxisExtent;
  return avoidOverlap(
    placementPoint,
    { w: newW, h: newH },
    side,
    obstacles,
    maxAvoidDistance,
  );
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
      const defaultSize = getNodeDefaultSize(kind);
      const newW = defaultSize.width || 200;
      const newH = defaultSize.height || 100;

      const placementPoint =
        placement.kind === 'point'
          ? placement.point
          : computeSidePlacement({
              nodes,
              getAbs,
              source: { x: srcAbs.x, y: srcAbs.y, w: srcW, h: srcH },
              size: { w: newW, h: newH },
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
function portCircleStyle(
  size: number,
  borderWidth: number,
): React.CSSProperties {
  return {
    width: size,
    height: size,
    boxSizing: 'border-box',
    borderWidth,
    borderStyle: 'solid',
    borderColor: 'var(--color-info)',
    backgroundColor: 'var(--color-info)',
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
 * Screen-space repaint of the aimed-at port, drawn above the selection
 * outline.
 *
 * `SelectionOutlines` is a HUD portalled into the React Flow container at
 * `z-998`, so nothing rendered inside the viewport can paint over it and a
 * selected node's border would slice straight through the `+`. Raising the
 * port's own z-index cannot help: the node is a stacking context nested
 * inside the renderer, so it is all-or-nothing against a sibling of the
 * renderer. The fix is the one `MultiSelectResizer` already uses — draw in
 * the same HUD layer. The in-flow port keeps hit-testing; this is paint
 * only, and it owns the `+` so the glyph is never rendered twice.
 */
function HotPortOverlay({
  nodeId,
  position,
  size,
}: {
  nodeId: string;
  position: Position;
  size: number;
}) {
  const node = useInternalNode(nodeId);
  const domNode = useStore((s) => s.domNode);
  const transform = useStore((s) => s.transform);
  const mark = useNodeCollapseStore((s) => s.marks[nodeId]);

  if (!node || !domNode) return null;

  const [tx, ty, zoom] = transform;
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  // Ports sit on the node's border box, centred on the side they name — easing
  // onto the takeover mark as the card fades into it.
  const { cx, cy } = portPointOnRect(
    position,
    mark ? blendedMarkRect(mark) : { x, y, width: w, height: h },
  );

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none absolute z-999 flex items-center justify-center rounded-full"
      style={{
        ...portCircleStyle(size, 2.5),
        left: cx * zoom + tx - size / 2,
        top: cy * zoom + ty - size / 2,
      }}
    >
      <Plus
        className="text-fg-inverse"
        strokeWidth={3.5}
        style={{ width: size * 0.6, height: size * 0.6 }}
      />
    </div>,
    domNode,
  );
}

/**
 * Screen-space paint of a collapsed node's four ports.
 *
 * The in-flow dots live inside the node card, which fades to zero opacity
 * once the node collapses to its takeover mark. Opacity is inherited through
 * compositing, so a child cannot opt out of it — the dots would be positioned
 * correctly on the mark and still be invisible, leaving only the `+` overlay
 * to appear out of nowhere when the pointer happened to cross a port. Painting
 * them here, in the same HUD layer `HotPortOverlay` already uses, is the same
 * split that layer established: the in-flow port keeps hit-testing and edge
 * geometry, this is paint only.
 */
function CollapsedPortDots({
  rect,
  hotPosition,
  size,
}: {
  rect: MarkAnchorRect;
  hotPosition: Position | null;
  size: number;
}) {
  const domNode = useStore((s) => s.domNode);
  const transform = useStore((s) => s.transform);

  if (!domNode) return null;

  const [tx, ty, zoom] = transform;

  return createPortal(
    <>
      {PORT_POSITIONS.map((position) => {
        // The aimed-at port is already painted at its grown size by
        // `HotPortOverlay`; drawing the idle dot under it would show a
        // ring of the smaller circle poking out from behind.
        if (position === hotPosition) return null;
        const { cx, cy } = portPointOnRect(position, rect);
        return (
          <div
            key={position}
            aria-hidden
            className="pointer-events-none absolute z-999 rounded-full"
            style={{
              ...portCircleStyle(size, 2.5),
              left: cx * zoom + tx - size / 2,
              top: cy * zoom + ty - size / 2,
            }}
          />
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
}

export function shouldExposeConnectionPorts({
  selected,
  connecting,
  hovered,
  dragging,
  multiSelectModifierHeld,
}: {
  selected: boolean;
  connecting: boolean;
  hovered: boolean;
  dragging: boolean;
  multiSelectModifierHeld: boolean;
}): boolean {
  return (
    (selected || (connecting && hovered)) &&
    !dragging &&
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
  }: NodeConnectionHandlesProps) => {
    const { t } = useTranslation();
    const node = useInternalNode(nodeId);
    // Only the pinned *side* matters here, and only when the pending
    // gesture belongs to this node — selecting that narrowly keeps a
    // gesture on one node from re-rendering every other node's ports.
    const pinnedSide = useConnectPortStore((s) =>
      s.pending?.sourceId === nodeId ? s.pending.side : null,
    );
    const mark = useNodeCollapseStore((s) => s.marks[nodeId]);
    // Committed edge endpoints are React Flow's cached handle bounds, and it
    // only re-measures them on demand. The handles below move onto the mark as
    // the card collapses, so without this the edges would keep terminating on
    // the border box of a card that is no longer drawn. Re-measuring instead
    // walks the endpoints in with the ports, onto the icon that replaced the
    // node. Skipped entirely for nodes that never collapse.
    const updateNodeInternals = useUpdateNodeInternals();
    const hadMark = useRef(false);
    useLayoutEffect(() => {
      if (!mark && !hadMark.current) return;
      hadMark.current = mark !== undefined;
      updateNodeInternals(nodeId);
    }, [mark, nodeId, updateNodeInternals]);

    const baseHandleSize = isNotMouse ? 14 : 8;
    const hitSize = isNotMouse ? PORT_HIT_SIZE.touch : PORT_HIT_SIZE.mouse;
    // Distance the press area is shifted outward so its inner edge lands
    // where the painted circle's already does. Everything the target gained
    // over the circle therefore sits outside the node.
    const hitOutwardShift = (hitSize - baseHandleSize) / 2;
    const zoom = useStore((s) => s.transform[2]);
    const inverseZoom = zoom > 0 ? 1 / zoom : 1;
    const dotSize = baseHandleSize * inverseZoom;
    const dotBorderWidth = 2.5 * inverseZoom;
    // A connection drag temporarily exposes the hovered target node's dots;
    // the source port remains pinned separately below.
    const connecting = useConnection((c) => c.inProgress);
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
      multiSelectModifierHeld,
    });
    const hotHandleSize = isNotMouse ? 22 : 20;

    const pinnedPosition = pinnedSide ? SIDE_POSITION[pinnedSide] : null;

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
    const hotPosition =
      pinnedPosition ??
      (originSide ? SIDE_POSITION[originSide] : null) ??
      (exposed && !connecting ? hotSide : null);

    // Once the card has collapsed into its takeover mark, the footprint the
    // handles are laid out against is invisible — ports pinned to its edges
    // would hang in empty canvas, and a connection dragged from one would
    // start nowhere near the thing the user aimed at. Rebase them onto the
    // mark.
    //
    // Only the glide `progress` is taken from the published mark. Its rect is
    // canvas-space and zoom-derived, so during a viewport animation it can be a
    // frame behind the zoom this render is laying out against — and because the
    // error is multiplicative, that briefly threw the handles clear off the
    // node. The rect is recomputed here from the live zoom instead.
    let collapsedRect: MarkAnchorRect | null = null;
    let collapsedLocalRect: PortRect | null = null;
    if (mark && node) {
      // `||`, not `??`: an unset `style.width` is not always `undefined`, and
      // the takeover hook this must agree with falls through on any falsy value.
      const nodeW = (node.style?.width as number) || node.measured.width || 0;
      const nodeH = (node.style?.height as number) || node.measured.height || 0;
      collapsedRect = blendedMarkRect(mark);
      collapsedLocalRect =
        nodeW > 0 && nodeH > 0 && zoom > 0
          ? localMarkRect(nodeW, nodeH, zoom, mark.progress)
          : null;
    }

    return (
      <>
        {collapsedRect && (exposed || pinnedPosition) && (
          <CollapsedPortDots
            rect={collapsedRect}
            hotPosition={hotPosition}
            size={baseHandleSize}
          />
        )}
        {hotPosition && (
          <HotPortOverlay
            nodeId={nodeId}
            position={hotPosition}
            size={hotHandleSize}
          />
        )}
        {HANDLE_DEFS.map((h) => {
          const side = sideFromHandleId(h.id);
          const keyboardReachable =
            selected && h.type === 'source' && side !== null;
          // Two flavours of "handle position" are consumed by React Flow:
          //   - `getHandlePosition(..., center=false)` returns the bbox's
          //     *outer edge* on the relevant axis (e.g. `bbox.y` for
          //     Position.Top). This drives committed-edge endpoints.
          //   - `getHandlePosition(..., center=true)` returns the bbox
          //     *centre*. This drives the connection-line preview that
          //     renders while the user drags from a handle.
          //
          // We want BOTH points to land exactly on the visible node
          // edge so the preview start, the dot, the corner resize
          // handles, the side-affordance triangles, and the committed
          // edge endpoint all align on a single line.
          //
          // A non-zero square bbox cannot satisfy both — its outer edge
          // and its centre are always `size/2` apart. So we collapse
          // the bbox to *zero thickness* on the perpendicular axis: for
          // top/bottom handles `width=dotSize, height=0`; for left/
          // right, `width=0, height=dotSize`. With height/width = 0 on
          // that axis, `bbox.y === bbox.y + height/2`, so the two
          // flavours of `getHandlePosition` return the same point.
          //
          // The visible circle is rendered as an absolutely-positioned
          // child centred on the bbox (50%/50% + translate). It has
          // `pointer-events: auto` so the click target is the dot, not
          // the 0-thickness bbox; events still bubble up to the Handle
          // so connection drags start correctly.
          //
          // The `-3px` perpendicular offset cancels the inner wrapper's
          // `border-3`: the Handle is positioned absolutely against its
          // containing block's *padding box* (inside the border), so
          // `top: 0` would land 3px inside the visible border.
          const edgeAlign: React.CSSProperties =
            h.position === Position.Top
              ? {
                  top: -3,
                  width: dotSize,
                  height: 0,
                  transform: 'translate(-50%, 0)',
                }
              : h.position === Position.Bottom
                ? {
                    bottom: -3,
                    width: dotSize,
                    height: 0,
                    transform: 'translate(-50%, 0)',
                  }
                : h.position === Position.Left
                  ? {
                      left: -3,
                      width: 0,
                      height: dotSize,
                      transform: 'translate(0, -50%)',
                    }
                  : {
                      right: -3,
                      width: 0,
                      height: dotSize,
                      transform: 'translate(0, -50%)',
                    };
          // Collapsed: same zero-thickness trick, but positioned absolutely
          // against the mark's local rect instead of the node's own edges.
          // `right` / `bottom` are reset because React Flow's per-side CSS
          // sets them, and a side offset left over from the readable layout
          // would fight the explicit `left` / `top`.
          const alignStyle: React.CSSProperties = collapsedLocalRect
            ? (() => {
                const { cx, cy } = portPointOnRect(
                  h.position,
                  collapsedLocalRect,
                );
                const horizontal =
                  h.position === Position.Top || h.position === Position.Bottom;
                return {
                  left: cx,
                  top: cy,
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
          // Handles stay solid in every visible state so the selection
          // outline cannot visually bisect them. Connection drag adds a
          // glow to strengthen the endpoint affordance.
          //
          // Neither the handle's bbox nor the painted circle grows on
          // hover — the aimed-at port is drawn at its grown size by
          // `HotPortOverlay` instead. Growing the bbox would move
          // `getHandlePosition`, which would drag committed edge endpoints
          // around under the pointer.
          const isHot = hotPosition === h.position;
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
          // Signed offset along the axis this side faces: negative towards
          // the node's top/left, positive towards its bottom/right.
          const isVerticalSide =
            h.position === Position.Top || h.position === Position.Bottom;
          const outwardSign =
            h.position === Position.Top || h.position === Position.Left
              ? -1
              : 1;
          const outward = hitOutwardShift * inverseZoom * outwardSign;
          const shiftAlongAxis = (distance: number) =>
            isVerticalSide
              ? `translateY(${distance}px)`
              : `translateX(${distance}px)`;
          // Painted circle. Purely decorative — the enclosing span owns
          // hit-testing, so this must not intercept anything itself. It is
          // centred in that span, which has been pushed outward, so the
          // same offset is subtracted again to put the circle back on the
          // node's border where the edge endpoints are.
          const circleStyle: React.CSSProperties = {
            ...portCircleStyle(baseHandleSize * inverseZoom, dotBorderWidth),
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) ${shiftAlongAxis(-outward)}`,
            pointerEvents: 'none',
            boxShadow: connecting
              ? '0 0 3px var(--color-info-light)'
              : undefined,
          };
          // Press area: bigger than the circle, and pushed outward so the
          // extra room comes out of empty canvas rather than out of the
          // node body the user is trying to click.
          const hitStyle: React.CSSProperties = {
            width: hitSize * inverseZoom,
            height: hitSize * inverseZoom,
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) ${shiftAlongAxis(outward)}`,
            // React Flow paints handles with `cursor: crosshair`, which only
            // describes half of what this control does. Clicking it creates a
            // node, so the pointer cursor matches the `+` the user sees.
            cursor: 'pointer',
          };
          // The aimed-at port is painted entirely by `HotPortOverlay`, in a
          // HUD layer above the selection outline. The in-flow circle stands
          // down rather than being drawn underneath it: the two are placed
          // by unrelated derivations — this one against the handle's own
          // box (offset to cancel the wrapper's border), the overlay from
          // `positionAbsolute` + `measured` — so any box-model discrepancy
          // shows up as a stray ring peeking out from behind. There is also
          // more than one in-flow circle per side, since each side stacks a
          // source and a target handle. One painter per state, no alignment
          // to keep.
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
                const { x, y } = node.internals.positionAbsolute;
                const width = node.measured.width ?? 0;
                const height = node.measured.height ?? 0;
                const anchor =
                  side === 'top'
                    ? { x: x + width / 2, y }
                    : side === 'bottom'
                      ? { x: x + width / 2, y: y + height }
                      : side === 'left'
                        ? { x, y: y + height / 2 }
                        : { x: x + width, y: y + height / 2 };
                useConnectPortStore.getState().setPending({
                  sourceId: nodeId,
                  side,
                  anchor,
                  kind: 'side',
                });
              }}
            >
              {!isHot && (
                <span
                  aria-hidden
                  className="rounded-full"
                  style={circleStyle}
                />
              )}
            </span>
          );
          return (
            <Handle
              key={h.id}
              type={h.type}
              id={h.id}
              position={h.position}
              style={{
                ...alignStyle,
                minWidth: 0,
                minHeight: 0,
                background: 'transparent',
                border: 'none',
              }}
              className={cn(
                'z-20 transition-opacity focus-within:opacity-100',
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

                The wrapper fills the (zero-thickness) handle bbox, whose
                centre is the dot's centre, so the tooltip stays aligned
                without knowing the dot's current size. The offset clears
                the grown dot.
              */}
              {isReachable ? (
                <Tooltip
                  content={t('node.createConnectedNode')}
                  wrapperClassName="absolute inset-0"
                  offset={hotHandleSize / 2 + 8}
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
