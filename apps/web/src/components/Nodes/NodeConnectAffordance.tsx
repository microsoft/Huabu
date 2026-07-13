/**
 * Connection-related affordances that float around every NodeWrapper:
 */

import {
  Handle,
  Position,
  useConnection,
  useInternalNode,
  useStore,
  useViewport,
} from '@xyflow/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { createId, type EdgeStyle } from '@sediment/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
  getNodeDefaultSize,
  getNodeSize,
} from '@sediment/shared/canvas-engine';

import { Button } from '@/components/Common/Button.tsx';
import { cn } from '@/components/Common/cn.ts';
import { createQuestionNodeAndCompose } from '@/components/Nodes/question/questionCompose.ts';
import { NODE_ICON } from '@/config/nodeIcons.ts';
import useCanvasStore from '@/store/canvasStore.ts';

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

/** Cardinal sides used by the connected-add arrow affordances. */
export type Side = 'top' | 'right' | 'bottom' | 'left';

const SIDE_ARROW_ICON: Record<Side, typeof ArrowUp> = {
  top: ArrowUp,
  right: ArrowRight,
  bottom: ArrowDown,
  left: ArrowLeft,
};

const SIDE_ARROW_OFFSET_PX = 32;

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

export function useCreateConnectedNode(id: string) {
  const addNode = useCanvasStore((state) => state.addNode);
  const dispatchUiIntent = useCanvasStore((state) => state.dispatchUiIntent);

  return useCallback(
    (side: Side, kind: 'note' | 'question') => {
      const state = useCanvasStore.getState();
      const nodes = state.nodes as NestableNode[];
      const byId = indexById(nodes);
      const self = byId.get(id);
      const getAbs = createAbsolutePositionGetter(byId);
      const srcAbs = getAbs(id);
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

      let placementPoint: { x: number; y: number };
      switch (side) {
        case 'top':
          placementPoint = {
            x: srcAbs.x + srcW / 2 - newW / 2,
            y: srcAbs.y - newH - NEW_NODE_GAP,
          };
          break;
        case 'bottom':
          placementPoint = {
            x: srcAbs.x + srcW / 2 - newW / 2,
            y: srcAbs.y + srcH + NEW_NODE_GAP,
          };
          break;
        case 'left':
          placementPoint = {
            x: srcAbs.x - newW - NEW_NODE_GAP,
            y: srcAbs.y + srcH / 2 - newH / 2,
          };
          break;
        case 'right':
        default:
          placementPoint = {
            x: srcAbs.x + srcW + NEW_NODE_GAP,
            y: srcAbs.y + srcH / 2 - newH / 2,
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
      placementPoint = avoidOverlap(
        placementPoint,
        { w: newW, h: newH },
        side,
        obstacles,
        maxAvoidDistance,
      );

      if (kind === 'question') {
        const { nodeId } = createQuestionNodeAndCompose({
          addNode,
          placementPoint,
          canvasId: state.canvasId,
        });
        dispatchUiIntent({
          type: 'CONNECT_EDGE',
          source: id,
          target: nodeId,
          style: { direction: 'forward' } satisfies EdgeStyle,
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
        source: id,
        target: newId,
        style: { direction: 'forward' } satisfies EdgeStyle,
      });
    },
    [id, addNode, dispatchUiIntent],
  );
}

// ---------------------------------------------------------------------------
// NodeConnectionHandles
// ---------------------------------------------------------------------------

interface NodeConnectionHandlesProps {
  /** Whether the parent node is currently hovered (mouse-only). */
  hovered: boolean;
  /** Whether the node is the unique selected node (touch/pen mode). */
  selected: boolean;
  /** True for touch / pen input; otherwise we treat as mouse. */
  isNotMouse: boolean;
}

export const NodeConnectionHandles = memo(
  ({ hovered, selected, isNotMouse }: NodeConnectionHandlesProps) => {
    const baseHandleSize = isNotMouse ? 14 : 8;
    const dotSize = useStore((s) => {
      const factor = Math.max(1 / s.transform[2], 1);
      return baseHandleSize * factor;
    });
    // While a connection drag is in progress, promote every exposed dot
    // from its idle hollow state to a filled + glowing state so the user
    // gets a strong "drop it here" affordance on valid endpoints.
    const connecting = useConnection((c) => c.inProgress);

    return (
      <>
        {HANDLE_DEFS.map((h) => {
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
          // Dot is centred on the (collapsed) bbox; `pointer-events:
          // auto` makes the dot the actual click target.
          //
          // State progression:
          //   - idle (node hovered, NOT selected): hollow – surface fill
          //     + info ring, visually light so four dots don't clutter
          //     the card.
          //   - selected: filled info. The selection outline (a z-998
          //     HUD line drawn by `<SelectionOutlines />`) sits above the
          //     node DOM and would otherwise slice a hollow dot's white
          //     centre in two ("cut apart" look). Filling the dot with
          //     the same `--color-info` makes that line blend into the
          //     dot instead of bisecting it.
          //   - connecting (drag in progress): filled info + glow, a
          //     strong endpoint affordance mirroring the selected-edge
          //     glow used elsewhere.
          const solid = connecting || selected;
          const dotStyle: React.CSSProperties = {
            width: dotSize,
            height: dotSize,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            boxSizing: 'border-box',
            borderWidth: 2.5,
            borderStyle: 'solid',
            borderColor: 'var(--color-info)',
            backgroundColor: solid ? 'var(--color-info)' : 'var(--bg-surface)',
            boxShadow: connecting
              ? '0 0 3px var(--color-info-light)'
              : undefined,
          };
          return (
            <Handle
              key={h.id}
              type={h.type}
              id={h.id}
              position={h.position}
              style={{
                ...edgeAlign,
                background: 'transparent',
                border: 'none',
              }}
              className={cn(
                'z-20 transition-opacity',
                isNotMouse
                  ? selected
                    ? 'opacity-40 active:opacity-100'
                    : 'pointer-events-none opacity-0'
                  : hovered
                    ? 'opacity-100'
                    : 'pointer-events-none opacity-0',
              )}
            >
              <span
                aria-hidden
                className="pointer-events-auto absolute rounded-full transition-colors"
                style={dotStyle}
              />
            </Handle>
          );
        })}
      </>
    );
  },
);
NodeConnectionHandles.displayName = 'NodeConnectionHandles';

interface NodeSideAffordanceProps {
  nodeId: string;
  selected: boolean;
  editing: boolean;
  onCreate: (side: Side, kind: 'note' | 'question') => void;
}

export const NodeSideAffordance = memo(
  ({ nodeId, selected, editing, onCreate }: NodeSideAffordanceProps) => {
    const { t } = useTranslation();
    const domNode = useStore((state) => state.domNode);
    const rendererEl = useMemo(
      () => domNode?.querySelector('.react-flow__renderer') ?? null,
      [domNode],
    );
    const internalNode = useInternalNode(nodeId);
    const { zoom, x: vpX, y: vpY } = useViewport();

    const [openSide, setOpenSide] = useState<Side | null>(null);

    const [affordanceHovered, setAffordanceHovered] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!openSide) return;
      const onDown = (event: PointerEvent) => {
        if (!rootRef.current?.contains(event.target as Node)) {
          setOpenSide(null);
        }
      };
      document.addEventListener('pointerdown', onDown);
      return () => document.removeEventListener('pointerdown', onDown);
    }, [openSide]);

    // Close any open picker the moment the node enters edit mode so a
    // stale popover doesn't hover over an active editor.
    useEffect(() => {
      if (editing) setOpenSide(null);
    }, [editing]);

    // When the node loses selection (e.g. after creating a connected
    // child node that steals focus), clear any sticky hover state — the
    // popover may have unmounted under a stationary pointer, in which
    // case the browser never fires onPointerLeave on the affordance.
    useEffect(() => {
      if (!selected) {
        setAffordanceHovered(false);
        setOpenSide(null);
      }
    }, [selected]);

    if (!rendererEl || !internalNode?.internals.positionAbsolute) return null;

    const absX = internalNode.internals.positionAbsolute.x;
    const absY = internalNode.internals.positionAbsolute.y;
    const nodeW =
      (internalNode.measured?.width as number | undefined) ??
      (internalNode.style?.width as number | undefined) ??
      0;
    const nodeH =
      (internalNode.measured?.height as number | undefined) ??
      (internalNode.style?.height as number | undefined) ??
      0;
    const left = absX * zoom + vpX;
    const top = absY * zoom + vpY;
    const widthPx = nodeW * zoom;
    const heightPx = nodeH * zoom;

    const showArrows =
      !editing && (selected || affordanceHovered || openSide !== null);

    return createPortal(
      <div
        ref={rootRef}
        style={{
          position: 'absolute',
          left,
          top,
          width: widthPx,
          height: heightPx,
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        {(['top', 'right', 'bottom', 'left'] as const).map((side) => {
          const ArrowIcon = SIDE_ARROW_ICON[side];
          const isOpen = openSide === side;

          const wrapStyle: React.CSSProperties = { position: 'absolute' };
          const popStyle: React.CSSProperties = { position: 'absolute' };
          if (side === 'top') {
            wrapStyle.left = '50%';
            wrapStyle.top = -SIDE_ARROW_OFFSET_PX;
            wrapStyle.transform = 'translate(-50%, -50%)';
            popStyle.left = '50%';
            popStyle.bottom = '100%';
            popStyle.marginBottom = 8;
            popStyle.transform = 'translateX(-50%)';
          } else if (side === 'bottom') {
            wrapStyle.left = '50%';
            wrapStyle.bottom = -SIDE_ARROW_OFFSET_PX;
            wrapStyle.transform = 'translate(-50%, 50%)';
            popStyle.left = '50%';
            popStyle.top = '100%';
            popStyle.marginTop = 8;
            popStyle.transform = 'translateX(-50%)';
          } else if (side === 'left') {
            wrapStyle.top = '50%';
            wrapStyle.left = -SIDE_ARROW_OFFSET_PX;
            wrapStyle.transform = 'translate(-50%, -50%)';
            popStyle.top = '50%';
            popStyle.right = '100%';
            popStyle.marginRight = 8;
            popStyle.transform = 'translateY(-50%)';
          } else {
            wrapStyle.top = '50%';
            wrapStyle.right = -SIDE_ARROW_OFFSET_PX;
            wrapStyle.transform = 'translate(50%, -50%)';
            popStyle.top = '50%';
            popStyle.left = '100%';
            popStyle.marginLeft = 8;
            popStyle.transform = 'translateY(-50%)';
          }

          return (
            <div
              key={`affordance-${side}`}
              style={{
                ...wrapStyle,
                pointerEvents: showArrows ? 'auto' : 'none',
                opacity: showArrows ? 1 : 0,
                transition: 'opacity 150ms ease',
              }}
              onPointerEnter={() => setAffordanceHovered(true)}
              onPointerLeave={() => setAffordanceHovered(false)}
            >
              <Button
                variant="ghost"
                iconOnly
                size="md"
                title={t('node.createConnectedNode')}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenSide(isOpen ? null : side);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                className={cn(
                  'hover:text-info hover:bg-info-bg text-[var(--color-info-light)] opacity-40 hover:opacity-100 [&_svg]:!h-5 [&_svg]:!w-5',
                  isOpen && 'text-info bg-info-bg opacity-100',
                )}
              >
                <ArrowIcon strokeWidth={4} />
              </Button>

              {isOpen && (
                <div
                  style={popStyle}
                  className="bg-surface shadow-bottom text-fg-muted flex items-center gap-1 rounded-lg p-1.5"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    iconOnly
                    size="sm"
                    title={t('node.newNote')}
                    onClick={() => {
                      onCreate(side, 'note');
                      setOpenSide(null);
                      setAffordanceHovered(false);
                    }}
                  >
                    <NODE_ICON.note />
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    size="sm"
                    title={t('node.newQuestion')}
                    onClick={() => {
                      onCreate(side, 'question');
                      setOpenSide(null);
                      setAffordanceHovered(false);
                    }}
                  >
                    <NODE_ICON.question />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>,
      rendererEl,
    );
  },
);
NodeSideAffordance.displayName = 'NodeSideAffordance';
