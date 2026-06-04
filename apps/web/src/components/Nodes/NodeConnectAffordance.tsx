/**
 * Connection-related affordances that float around every NodeWrapper:
 */

import {
  Handle,
  Position,
  useInternalNode,
  useStore,
  useViewport,
} from '@xyflow/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createId, type EdgeStyle } from '@sediment/shared';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import { Button } from '@/components/Common/Button.tsx';
import { cn } from '@/components/Common/cn.ts';
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

const NEW_NODE_DEFAULTS: Record<'note' | 'question', { w: number; h: number }> =
  {
    note: { w: 400, h: 56 },
    question: { w: 200, h: 78 },
  };

/** Flow-space gap between the source node and the newly-created node. */
const NEW_NODE_GAP = 80;

/** How long the handles / arrows stay visible after the pointer leaves. */
const HOVER_LINGER_MS = 400;

function useHoverLinger(hovered: boolean, delayMs = HOVER_LINGER_MS): boolean {
  const [lingering, setLingering] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hovered) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setLingering(true);
      return;
    }
    timerRef.current = setTimeout(() => {
      setLingering(false);
      timerRef.current = null;
    }, delayMs);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [hovered, delayMs]);

  return lingering;
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
      const srcAbs = createAbsolutePositionGetter(byId)(id);
      if (!self || !srcAbs) return;

      const srcW =
        (self.style?.width as number | undefined) ??
        self.measured?.width ??
        200;
      const srcH =
        (self.style?.height as number | undefined) ??
        self.measured?.height ??
        120;
      const { w: newW, h: newH } = NEW_NODE_DEFAULTS[kind];

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

      const newId = createId('node');
      const data =
        kind === 'note'
          ? { content: '', origin: { type: 'user-created' as const } }
          : {
              input: { kind: 'text' as const, content: '' },
              origin: { type: 'user-created' as const },
            };
      addNode({
        id: newId,
        nodeType: kind,
        placementPoint,
        data,
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
    const handleStyle: React.CSSProperties = useStore((s) => {
      const factor = Math.max(1 / s.transform[2], 1);
      const size = baseHandleSize * factor;
      return { width: size, height: size };
    });

    const lingering = useHoverLinger(hovered);

    return (
      <>
        {HANDLE_DEFS.map((h) => (
          <Handle
            key={h.id}
            type={h.type}
            id={h.id}
            position={h.position}
            style={handleStyle}
            className={cn(
              'bg-info! z-20 border-none! transition-opacity',
              // 抵消外层 div 固有的 border-3，让圆点贴在节点边缘上
              h.position === Position.Top && '!-top-[3.5px]',
              h.position === Position.Bottom && '!-bottom-[3.5px]',
              h.position === Position.Left && '!-left-[3.5px]',
              h.position === Position.Right && '!-right-[3.5px]',
              isNotMouse
                ? selected
                  ? 'opacity-40 active:opacity-100'
                  : 'pointer-events-none opacity-0'
                : // Mouse mode: shared linger window with the side
                  // affordance so both fade out together.
                  lingering
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0',
            )}
          />
        ))}
      </>
    );
  },
);
NodeConnectionHandles.displayName = 'NodeConnectionHandles';

interface NodeSideAffordanceProps {
  nodeId: string;
  hovered: boolean;
  selected: boolean;
  editing: boolean;
  isNotMouse: boolean;
  onCreate: (side: Side, kind: 'note' | 'question') => void;
}

export const NodeSideAffordance = memo(
  ({
    nodeId,
    hovered,
    selected,
    editing,
    isNotMouse,
    onCreate,
  }: NodeSideAffordanceProps) => {
    const domNode = useStore((state) => state.domNode);
    const rendererEl = useMemo(
      () => domNode?.querySelector('.react-flow__renderer') ?? null,
      [domNode],
    );
    const internalNode = useInternalNode(nodeId);
    const { zoom, x: vpX, y: vpY } = useViewport();

    const [openSide, setOpenSide] = useState<Side | null>(null);

    const [affordanceHovered, setAffordanceHovered] = useState(false);
    const lingering = useHoverLinger(hovered);
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
      !editing &&
      (lingering ||
        affordanceHovered ||
        (isNotMouse && selected) ||
        openSide !== null);

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
                title="Create connected node"
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
                    title="New note"
                    onClick={() => {
                      onCreate(side, 'note');
                      setOpenSide(null);
                    }}
                  >
                    <NODE_ICON.note />
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    size="sm"
                    title="New question"
                    onClick={() => {
                      onCreate(side, 'question');
                      setOpenSide(null);
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
