// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { memo, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { AttentionDot } from '@/components/Common/AttentionDot';
import { cn } from '@/components/Common/cn';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  markSeen,
  useTrackUnseenChanges,
  useUnseenMarks,
} from '@/hooks/useUnseenChanges';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  getConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
import { openConversationThread } from '@/store/previewWorkspace/actions';

import { selectionOutlineSize } from '../SelectionOutlines';
import { useRenderedNodeGeometry } from '../useRenderedNodeGeometry';

import type { CanvasNode } from '@/components/Nodes/types';
import type { UnseenMark } from '@/utils/unseenChanges';

/** Side of the square around the dot that takes the pointer. */
const HIT = 14;
/**
 * The least distance of the dot from the node's top and right edges once it
 * has moved inside, for a node whose corner is barely rounded.
 */
const INSIDE = 14;
/** How far a press may travel, in px, and still count as a click. */
const CLICK_SLOP = 3;
/** Joins titles into one string; a title cannot contain it. */
const TITLE_SEPARATOR = '\u0000';

interface MarkProps {
  nodeId: string;
  mark: UnseenMark;
  /** Whether the change arrived while this page was open. */
  arriving: boolean;
  canvasId: string;
  domNode: HTMLDivElement;
  zoom: number;
  viewportX: number;
  viewportY: number;
}

const Mark = memo(function Mark({
  nodeId,
  mark,
  arriving,
  canvasId,
  domNode,
  zoom,
  viewportX,
  viewportY,
}: MarkProps) {
  const { t } = useTranslation();
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const internalNode = useInternalNode<CanvasNode>(nodeId);
  // One string, so the selector's result is stable while nothing changed.
  const titles = useConversationTitleStore((state) =>
    mark.sources
      .map(
        (source) =>
          getConversationTitle(canvasId, source.threadId, state).title ?? '',
      )
      .join(TITLE_SEPARATOR),
  ).split(TITLE_SEPARATOR);
  const position = internalNode?.internals.positionAbsolute;
  const size = internalNode
    ? selectionOutlineSize(internalNode, internalNode)
    : { width: 0, height: 0 };
  const visible = internalNode !== undefined && !internalNode.hidden;
  // The measured border box the selection outline follows, so the mark
  // sits on the corner of the node as it is actually drawn.
  const { geometry } = useRenderedNodeGeometry(
    nodeId,
    domNode,
    false,
    {
      nodeX: position?.x ?? 0,
      nodeY: position?.y ?? 0,
      nodeWidth: size.width,
      nodeHeight: size.height,
      viewportX,
      viewportY,
      zoom,
    },
    visible,
  );
  const [first] = mark.sources;
  if (!visible || !position || !first) return null;
  const width = geometry ? geometry.width : size.width * zoom;
  const height = geometry ? geometry.height : size.height * zoom;
  const right = geometry
    ? geometry.x + geometry.width
    : (position.x + size.width) * zoom + viewportX;
  const top = geometry ? geometry.y : position.y * zoom + viewportY;
  // On the node's outline where the corner's rounding turns, at 45 degrees:
  // the dot straddles the border like a badge, on a square corner and on a
  // round one alike.
  const radius = Math.min(geometry?.radius ?? 0, width / 2, height / 2);
  const inset = radius * (1 - Math.SQRT1_2);
  // While the node is selected the resize grip has that place, so the dot
  // moves in to the centre of the corner's rounding: inside the node it is
  // still plainly the node's, and the grip is neither covered nor blocked.
  const inward = internalNode.selected
    ? Math.min(Math.max(INSIDE, radius), width / 4, height / 4) - inset
    : 0;
  // One line per conversation that touched the node.
  const sources = mark.sources
    .map((source, index) =>
      t(`unseenChanges.${source.kind}`, {
        conversation: titles[index] || t('chat.newConversation'),
      }),
    )
    .join('\n');
  // Then what the dot does: it looks like a status light, and beside the
  // resize grips like one more handle.
  const label = `${sources}\n${t('unseenChanges.open')}`;
  return (
    // In screen space, so the dot keeps its size however far the canvas is
    // zoomed out.
    <span
      data-canvas-grounding-exclude
      className="absolute z-1000 transition-transform duration-150 motion-reduce:transition-none"
      style={{
        left: right - inset - HIT / 2,
        top: top + inset - HIT / 2,
        width: HIT,
        height: HIT,
        transform: `translate(${-inward}px, ${inward}px)`,
        // The gap around the dot matches what the dot sits on.
        ['--attention-gap' as string]: internalNode.selected
          ? 'var(--bg-surface)'
          : 'var(--bg-default)',
      }}
    >
      <Tooltip
        content={label}
        wrapperClassName="size-full"
        contentClassName="whitespace-pre-line"
      >
        <button
          type="button"
          data-unseen-mark={nodeId}
          aria-label={label}
          className="nodrag nopan relative size-full cursor-pointer"
          // The canvas must not take the press for a pan or a selection.
          onPointerDown={(event) => {
            event.stopPropagation();
            pressedAt.current = { x: event.clientX, y: event.clientY };
          }}
          onClick={(event) => {
            event.stopPropagation();
            // A press that travelled was a drag that happened to start on
            // the dot, not a click on it, and must not open anything.
            const from = pressedAt.current;
            pressedAt.current = null;
            if (
              from &&
              Math.hypot(event.clientX - from.x, event.clientY - from.y) >
                CLICK_SLOP
            )
              return;
            // Going to see what was done is seeing it.
            markSeen(mark);
            void openConversationThread(canvasId, first.threadId).catch(
              (error: unknown) => {
                console.error(
                  '[unseen] Could not open the conversation:',
                  error,
                );
                toast(error instanceof Error ? error.message : String(error), {
                  tone: 'danger',
                });
              },
            );
          }}
        >
          <AttentionDot
            kind="done"
            className={cn(
              'attention-halo top-1/2 right-auto left-1/2 size-[9px] -translate-1/2',
              arriving && 'attention-arrive',
            )}
          />
        </button>
      </Tooltip>
    </span>
  );
});

/**
 * A dot on the top right corner of each node an Agent created or changed that the person has not
 * been on since, drawn as a screen-space layer portalled into the
 * `.react-flow` container like the selection and presence outlines.
 * Hovering a dot names the conversations that touched the node; clicking it
 * opens the conversation, where the change can be kept or reverted.
 *
 * Mounted inside `<ReactFlow>`. See `docs/architecture/desktop-tabs.md`,
 * "Attention and notices", for what the dot means across the app.
 */
export function UnseenNodeMarks() {
  const domNode = useStore((state) => state.domNode);
  const canvasId = useCanvasStore((state) => state.canvasId);
  useTrackUnseenChanges(canvasId ?? undefined);
  const marks = useUnseenMarks();
  const liveThreads = useAcpThreadChangesStore((state) => state.liveThreads);
  const { x: viewportX, y: viewportY, zoom } = useViewport();
  // A mark arrives once: when it first shows, and only if a conversation
  // that touched the node spoke while this page was open. What it was
  // decided as then, it stays, so the animation is not cut short or replayed
  // by a later render.
  const decided = useRef(new Map<string, boolean>());
  const arrivals = useMemo(() => {
    const next = new Map<string, boolean>();
    for (const [nodeId, mark] of marks)
      next.set(
        nodeId,
        decided.current.get(nodeId) ??
          mark.sources.some((source) => liveThreads[source.threadId]),
      );
    decided.current = next;
    return next;
  }, [marks, liveThreads]);
  if (!domNode || !canvasId || marks.size === 0) return null;
  return createPortal(
    <>
      {[...marks].map(([nodeId, mark]) => (
        <Mark
          key={nodeId}
          nodeId={nodeId}
          mark={mark}
          arriving={arrivals.get(nodeId) === true}
          canvasId={canvasId}
          domNode={domNode}
          zoom={zoom}
          viewportX={viewportX}
          viewportY={viewportY}
        />
      ))}
    </>,
    domNode,
  );
}
