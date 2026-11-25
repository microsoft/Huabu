// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow, useStore, useViewport } from '@xyflow/react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/components/Common/cn';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  getFilterKeyLabelKey,
  type LayerFilterKey,
  type LayerFilterLabelKey,
} from '@/components/Panels/CanvasLayerPanel/layerFilterKey';
import { markSeen, useUnseenMarks } from '@/hooks/useUnseenChanges';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { ATTENTION_COLOR, type AttentionKind } from '@/utils/attention';
import { getCanvasVisibleArea } from '@/utils/canvasViewport';
import { readConversations } from '@/utils/turnNotices';
import {
  edgeTags,
  unseenPieces,
  viewportOnPiece,
  type EdgeTag,
  type MarkedAs,
  type MarkedNode,
  type Span,
} from '@/utils/unseenEdgeTags';

import { EDGE_TAG_CONFIG } from './edgeTagConfig';

import type { Rect } from '@huabu/shared';
import type { CSSProperties } from 'react';

/** How far the halo of a dot reaches past it, in px: see `.attention-halo`. */
const HALO = 5;
/**
 * The face of the number in a dot. Text is centred by the box of its glyphs,
 * and in the interface's own face a "1" stands off the middle of its box:
 * its flag is counted and its stem is not in the middle. In a dot this
 * small, under a pointer, it shows. The digits of a monospaced face are
 * drawn to sit in the middle of their boxes, the "1" with a foot.
 */
const DIGIT_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const NO_STANDALONE_THREADS: ReadonlySet<string> = new Set();
/** The most nodes a tag's tooltip names one by one. */
const NAMED_IN_HINT = 6;
/** How often, at most, the conversations are read: as often as the marks. */
const FOLLOW_MS = 150;
/** How a tag hangs from its anchor, so that it lies within the edge. */
const HANG: Record<EdgeTag['edge'], string> = {
  left: 'translate(0, -50%)',
  right: 'translate(-100%, -50%)',
  top: 'translate(-50%, 0)',
  bottom: 'translate(-50%, -100%)',
};

/**
 * The pointer beside a dot: a small wedge whose side toward the dot is an
 * arc about the dot's centre, so that it sits around the halo instead of
 * standing off it as a flat-backed triangle would.
 *
 * @returns The wedge's path and box, and the room to leave between it and
 *   the dot for the arc to be concentric.
 */
function pointerShape(
  edge: EdgeTag['edge'],
  dotSize: number,
  size: number,
  gap: number,
) {
  // The arc's radius, the wedge's breadth, and how far its tip stands out.
  const radius = dotSize / 2 + HALO + gap;
  // Whole pixels, and a breadth as even or as odd as the dot is wide: the
  // wedge is centred on the dot, and half a pixel off it is drawn smeared
  // to one side, which reads as a wedge that leans.
  let breadth = Math.round(size);
  if ((dotSize - breadth) % 2 !== 0) breadth += 1;
  // How far the arc swells past the wedge's two back corners.
  const swell = radius - Math.sqrt(radius ** 2 - (breadth / 2) ** 2);
  const length = Math.round(swell + size * 0.45);
  const half = breadth / 2;
  const arc = (sweep: 0 | 1, x: number, y: number) =>
    `A${radius} ${radius} 0 0 ${sweep} ${x} ${y}Z`;
  const d = {
    right: `M0 0L${length} ${half}L0 ${breadth}${arc(0, 0, 0)}`,
    left: `M${length} 0L0 ${half}L${length} ${breadth}${arc(1, length, 0)}`,
    bottom: `M0 0L${half} ${length}L${breadth} 0${arc(1, 0, 0)}`,
    top: `M0 ${length}L${half} 0L${breadth} ${length}${arc(0, 0, length)}`,
  }[edge];
  const upright = edge === 'top' || edge === 'bottom';
  return {
    d,
    width: upright ? breadth : length,
    height: upright ? length : breadth,
    gap: Math.round(radius - swell - dotSize / 2),
  };
}

/** The canvas's main toolbar, wherever it is mounted. */
const findToolbar = (domNode: HTMLDivElement): Element | null =>
  document.querySelector('[data-canvas-main-toolbar]') ??
  domNode.querySelector('.react-flow__panel.bottom.center');

/**
 * Where tags may go: the visible canvas within the React Flow container —
 * the container less what the side panels cover — and the span of its bottom
 * edge the main toolbar takes, both in the container's px.
 *
 * The toolbar is measured, not assumed: it is wider with a finger or a pen
 * than with a mouse, and wider again in some Spaces. Both are read again when
 * the container, a side panel or the toolbar changes size.
 */
function useCanvasRoom(domNode: HTMLDivElement | null): {
  area: Rect | null;
  toolbar: Span | null;
} {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [room, setRoom] = useState<{ area: Rect | null; toolbar: Span | null }>(
    { area: null, toolbar: null },
  );
  useLayoutEffect(() => {
    if (!domNode) {
      setRoom({ area: null, toolbar: null });
      return;
    }
    const resized =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => read());
    let watched: Element | null = null;
    const read = () => {
      const found = findToolbar(domNode);
      if (found !== watched) {
        if (watched) resized?.unobserve(watched);
        if (found) resized?.observe(found);
        watched = found;
      }
      const container = domNode.getBoundingClientRect();
      const box = found?.getBoundingClientRect();
      // A toolbar the layout has hidden, because a panel covers it, still
      // has its size, and takes no room.
      const hidden =
        found
          ?.closest('[data-canvas-toolbar-layer]')
          ?.getAttribute('data-hidden') === 'true';
      const toolbar =
        box && box.width > 0 && !hidden
          ? { from: box.left - container.left, to: box.right - container.left }
          : null;
      const area = getCanvasVisibleArea(domNode);
      // The same room is the same object, so nothing is drawn again for it.
      setRoom((current) =>
        current.area?.x === area.x &&
        current.area.width === area.width &&
        current.area.height === area.height &&
        current.toolbar?.from === toolbar?.from &&
        current.toolbar?.to === toolbar?.to
          ? current
          : { area, toolbar },
      );
    };
    read();
    // The panels' widths are custom properties on the layout's style, and
    // the toolbar is hidden and shown by an attribute on its layer.
    const layout = domNode.closest('[data-overlay-layout]');
    const restyled = layout ? new MutationObserver(read) : undefined;
    if (layout)
      restyled?.observe(layout, {
        attributes: true,
        attributeFilter: ['style'],
      });
    const layer = layout?.querySelector('[data-canvas-toolbar-layer]');
    if (layer)
      restyled?.observe(layer, {
        attributes: true,
        attributeFilter: ['data-hidden'],
      });
    return () => {
      resized?.disconnect();
      restyled?.disconnect();
    };
  }, [domNode, width, height]);
  return room;
}

/**
 * The conversations of the Space that hold something unseen and have a node:
 * the node and what the conversation holds.
 *
 * The stores behind this change on every pointer tick of a drag and every
 * token of a reply, so they are read at most every {@link FOLLOW_MS}, and
 * the layer is drawn again only when what was found differs.
 */
function useUnseenConversations(): [string, AttentionKind][] {
  const [found, setFound] = useState('[]');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      timer = undefined;
      const entries: [string, AttentionKind][] = [];
      for (const reading of readConversations(
        useCanvasStore.getState().nodes,
        useChatStore.getState().threadsById,
        // Only a conversation with a node can be pointed at.
        NO_STANDALONE_THREADS,
      ).values())
        if (reading.nodeId && reading.attention)
          entries.push([reading.nodeId, reading.attention]);
      setFound(JSON.stringify(entries));
    };
    const follow = () => {
      timer ??= setTimeout(read, FOLLOW_MS);
    };
    const unsubscribeCanvas = useCanvasStore.subscribe(follow);
    const unsubscribeChat = useChatStore.subscribe(follow);
    read();
    return () => {
      clearTimeout(timer);
      unsubscribeCanvas();
      unsubscribeChat();
    };
  }, []);
  return useMemo(() => JSON.parse(found) as [string, AttentionKind][], [found]);
}

interface TagProps {
  tag: EdgeTag;
  onGo: (tag: EdgeTag) => void;
  /** Mark what the tag points at as seen; absent where that cannot be done. */
  onDismiss?: (tag: EdgeTag) => void;
}

function Tag({ tag, onGo, onDismiss }: TagProps) {
  const { t } = useTranslation();
  /** A node as the tag's tooltip names it: its title and what happened. */
  const describe = (node: MarkedNode) => {
    // The layer panel's name for the type; none for a type it does not know.
    const typeName: LayerFilterLabelKey | undefined = node.type
      ? getFilterKeyLabelKey(node.type as LayerFilterKey)
      : undefined;
    const type = typeName ? t(typeName) : '';
    const title = node.label?.trim() || type || t('unseenChanges.untitled');
    const what = node.attention
      ? t(`attention.${node.attention}`)
      : [title === type ? '' : type, t(`unseenChanges.kind.${node.kind}`)]
          .filter(Boolean)
          .join(' · ');
    return { title, what };
  };
  // The tag itself is only a direction and a number: how many things lie
  // that way. Its colour says what kind; the tooltip names them.
  const hidden = tag.nodes.length - NAMED_IN_HINT;
  const hint = [
    ...tag.nodes.slice(0, NAMED_IN_HINT).map((node) => {
      const named = describe(node);
      return `${named.title} · ${named.what}`;
    }),
    ...(hidden > 0 ? [t('unseenChanges.others', { count: hidden })] : []),
    t('unseenChanges.go'),
    ...(onDismiss ? [t('unseenChanges.dismiss')] : []),
  ].join('\n');
  const upright = tag.edge === 'top' || tag.edge === 'bottom';
  const outward = tag.edge === 'right' || tag.edge === 'bottom';
  // A small wedge on the side of the edge: which way the things lie.
  const shape = pointerShape(
    tag.edge,
    EDGE_TAG_CONFIG.dotSize,
    EDGE_TAG_CONFIG.pointerSize,
    EDGE_TAG_CONFIG.pointerGap,
  );
  const pointer = (
    <svg
      aria-hidden
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      className="shrink-0 overflow-visible"
      style={{ width: shape.width, height: shape.height }}
    >
      <path
        d={shape.d}
        fill="currentColor"
        // A hair of outline in the same colour takes the point off the tip.
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
  return (
    <span
      data-canvas-grounding-exclude
      // A flex box, so that it is exactly as tall as the tag: as a line of
      // text it would be taller, and the tag would hang short of the edge.
      // A React Flow panel, so that the canvas's pointer router leaves a
      // touch or a pen stroke on it alone; a panel's own margin is undone.
      className="react-flow__panel absolute !z-1000 !m-0 flex"
      // On whole pixels, for the same reason the wedge is.
      style={{
        left: Math.round(tag.x),
        top: Math.round(tag.y),
        transform: HANG[tag.edge],
      }}
    >
      <Tooltip content={hint} contentClassName="whitespace-pre-line">
        <button
          type="button"
          data-unseen-edge-tag={tag.key}
          aria-label={hint}
          // The dot of the marks on the nodes, with a number in it: the same
          // sign for the same thing, here saying how many and which way.
          className={cn(
            'nodrag nopan flex cursor-pointer items-center hover:brightness-95',
            upright && 'flex-col',
          )}
          style={{ color: ATTENTION_COLOR[tag.attention], gap: shape.gap }}
          // The canvas must not take the press for a pan or a selection.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onGo(tag);
          }}
          // A right click says "seen" without going there. Where that
          // cannot be done the canvas's own menu is still kept away.
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss?.(tag);
          }}
        >
          {!outward && pointer}
          <span
            // The halo of the marks on the nodes: a gap in the canvas's
            // colour, then a faint ring of the dot's own.
            className="attention-halo text-fg-inverse flex items-center justify-center rounded-full px-1 leading-none font-bold tabular-nums"
            style={
              {
                minWidth: EDGE_TAG_CONFIG.dotSize,
                height: EDGE_TAG_CONFIG.dotSize,
                fontFamily: DIGIT_FONT,
                // Digits stand a little above the middle of their line.
                paddingTop: '0.08em',
                fontSize: EDGE_TAG_CONFIG.dotSize * 0.55,
                backgroundColor: ATTENTION_COLOR[tag.attention],
                '--attention-color': ATTENTION_COLOR[tag.attention],
              } as CSSProperties
            }
          >
            {tag.nodes.length}
          </span>
          {outward && pointer}
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * Tags along the edges of the visible canvas, each pointing at something out
 * of view that the person has not seen: a piece of content an Agent made or
 * changed, or a conversation that waits for approval, failed, or finished
 * and has not been opened since.
 *
 * A tag is a dot with a number, as on the nodes, and a pointer. Clicking it
 * takes the canvas there; that is not seeing it, so its marks stay. A right
 * click on a tag for content marks that content seen.
 *
 * Drawn as a screen-space layer portalled into the `.react-flow` container.
 * Mounted inside `<ReactFlow>`, after `UnseenNodeMarks`, which keeps the
 * marks true. The numbers it is laid out by are in `edgeTagConfig.ts`.
 */
export function UnseenEdgeTags() {
  const domNode = useStore((state) => state.domNode);
  const marks = useUnseenMarks();
  const reactFlow = useReactFlow();
  const viewport = useViewport();
  const { area, toolbar } = useCanvasRoom(domNode);
  const conversations = useUnseenConversations();
  // What to point at, by node: the marked content, and the conversations.
  const wanted = useMemo(() => {
    const found = new Map<string, MarkedAs>();
    for (const [id, mark] of marks)
      found.set(id, {
        kind: mark.sources.some((source) => source.kind === 'create')
          ? 'create'
          : 'update',
      });
    // A conversation is pointed at for itself, whatever its content: one
    // "to review" out of view must not go unsaid because what it made is
    // in view, or is pointed at too.
    for (const [nodeId, attention] of conversations)
      found.set(nodeId, { attention });
    return found;
  }, [marks, conversations]);
  // Their boxes and names as one string: a node out of view is not rendered,
  // so nothing else says when one of them moved.
  const marked = useStore((state) => {
    const nodes: MarkedNode[] = [];
    for (const [id, what] of wanted) {
      const node = state.nodeLookup.get(id);
      if (!node || node.hidden) continue;
      const { label, type } = node.data as { label?: unknown; type?: unknown };
      nodes.push({
        id,
        rect: {
          ...node.internals.positionAbsolute,
          // A node out of view may never have been measured, and some
          // carry their size only in their style.
          width:
            node.measured.width ??
            node.width ??
            node.initialWidth ??
            (typeof node.style?.width === 'number' ? node.style.width : 0),
          height:
            node.measured.height ??
            node.height ??
            node.initialHeight ??
            (typeof node.style?.height === 'number' ? node.style.height : 0),
        },
        label: typeof label === 'string' ? label : undefined,
        type: typeof type === 'string' ? type : node.type,
        ...what,
      });
    }
    return JSON.stringify(nodes);
  });
  const nodes = useMemo(() => JSON.parse(marked) as MarkedNode[], [marked]);
  // Grouped when the nodes change, placed when the view does: grouping
  // compares every pair of nodes, and the view moves on every frame of a pan.
  const pieces = useMemo(
    () => unseenPieces(nodes, EDGE_TAG_CONFIG.clusterGap),
    [nodes],
  );
  const tags = useMemo(
    () =>
      area ? edgeTags(pieces, viewport, area, toolbar, EDGE_TAG_CONFIG) : [],
    [pieces, viewport, area, toolbar],
  );
  if (!domNode || !area || tags.length === 0) return null;
  const dismiss = (tag: EdgeTag) => {
    // One write per conversation, however many nodes the piece has: each
    // write copies and stores everything seen so far.
    const keys = new Map<string, string[]>();
    for (const node of tag.nodes)
      for (const source of marks.get(node.id)?.sources ?? [])
        keys.set(source.threadId, [
          ...(keys.get(source.threadId) ?? []),
          ...source.keys,
        ]);
    markSeen({
      sources: [...keys].map(([threadId, seen]) => ({
        threadId,
        kind: 'update',
        keys: seen,
      })),
    });
  };
  const go = (tag: EdgeTag) => {
    void reactFlow.setViewport(
      viewportOnPiece(
        tag.nodes,
        reactFlow.getViewport(),
        area,
        EDGE_TAG_CONFIG.flyPadding,
      ),
      {
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 0
          : EDGE_TAG_CONFIG.flyDurationMs,
      },
    );
  };
  return createPortal(
    <>
      {tags.map((tag) => (
        <Tag
          key={tag.key}
          tag={tag}
          onGo={go}
          // Only content can be waved away: a conversation is seen by
          // opening it, and one that waits or failed is to be dealt with.
          onDismiss={
            tag.nodes.some((node) => !node.attention) ? dismiss : undefined
          }
        />
      ))}
    </>,
    domNode,
  );
}
