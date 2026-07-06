import { useStore } from '@xyflow/react';
import { clsx } from 'clsx';
import { AlertTriangle, MessageSquare } from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';

import { createId } from '@sediment/shared';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { StatusBadge } from '@/components/Common/StatusBadge.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';
import {
  getQuestionFontOpts,
  QUESTION_FONT_FAMILY,
  QUESTION_NODE_PADDING as NODE_PADDING,
  QUESTION_NODE_PLACEHOLDER,
} from '@/utils/node/nodeFontConfig';

import { NodeWrapper } from '../NodeWrapper';
import { enterQuestionCompose } from './questionCompose.ts';
import { TextNodeBody } from '../shared/TextNodeBody';

import type { CanvasQuestionNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type QuestionNodeType = Node<CanvasQuestionNodeData, 'question'>;

/** Sticky-note warm background colour (design token). */
const STICKY_BG = 'var(--question-bg)';

/**
 * Max characters of the first message shown on the node while the
 * generated `label` is still pending. Bounds the auto-sized footprint
 * so a very long first message doesn't blow the node up (and so the
 * later swap to the shorter label barely changes size).
 */
const PREVIEW_MAX_CHARS = 80;

/** Trim the first-message fallback to a short, single-block preview. */
function truncatePreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`;
}

/**
 * Question node — a canvas anchor for a chat thread.
 *
 * It no longer hosts an inline editor or an auto-run countdown. Instead:
 *   - Double-clicking a not-yet-run node opens the chat panel into
 *     *compose* mode for this node's thread (focus the input, pick the
 *     agent inline, type, send). The first send authors `data.content`
 *     and drives the node's status.
 *   - Double-clicking a running / finished node opens its conversation
 *     (live or replay) in the chat panel.
 *
 * The node body just renders the authored question read-only.
 */
export const QuestionNode = memo(
  ({ id, data, selected, width }: NodeProps<QuestionNodeType>) => {
    const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const inputContent = typeof data.content === 'string' ? data.content : '';
    const label = typeof data.label === 'string' ? data.label.trim() : '';

    // On-canvas anchor text. Prefer the generated `label` (a concise
    // title) once preprocessing produced one; fall back to a truncated
    // preview of the first message while the label is still pending
    // (compose / mid-generation). Truncating the fallback keeps the
    // auto-sized footprint bounded, so the eventual swap to the (usually
    // shorter) label is at most a small, `transition-all`-animated size
    // change rather than a large jump from a very long first message.
    const displayText = label || truncatePreview(inputContent);

    // ------------------------------------------------------------------
    // Shared surface (auto-size + read-only body prop bundles).
    // `isEditing` is always false: the body is display-only and the
    // double-click overlay routes to `handleActivate`.
    // ------------------------------------------------------------------
    const fontOpts = useMemo(() => getQuestionFontOpts(), []);
    const surface = useTextNodeSurface({
      nodeId: id,
      width,
      isEditing: false,
      content: displayText,
      baseFontSize: 16,
      padding: NODE_PADDING,
      fontOpts,
      placeholder: QUESTION_NODE_PLACEHOLDER,
    });

    const status = data.status ?? 'idle';
    const viewed = data.viewed ?? false;

    // Count of this thread's agent changes that were SKIPPED because the
    // user was mid-editing the target node. Drives
    // a warning chip on the "done" badge so a partially-applied run is not
    // silently reported as fully done. Reactive: recomputes as records or
    // conflict flags change, but only re-renders on a count change.
    const conflictCount = useAcpThreadChangesStore((s) => {
      const threadId = data.threadId;
      if (!threadId) return 0;
      const conflicted = s.conflictedByThread[threadId];
      if (!conflicted || conflicted.length === 0) return 0;
      const recs = s.byThread[threadId];
      if (!recs) return 0;
      const ids = new Set(conflicted);
      return recs.filter((r) => r.nodeId && ids.has(r.nodeId)).length;
    });

    // True while this node is a freshly-pasted copy whose conversation
    // history is still being forked server-side. Until that settles the
    // thread has no persisted messages, so opening it would show an empty
    // conversation — we hold the node in a transient "running" state and
    // block opening instead.
    const isForkPending = useCanvasStore((s) =>
      data.threadId ? s.pendingForkThreadIds[data.threadId] === true : false,
    );

    /** Whether this node has been executed at least once. */
    const hasRun = status === 'done' || status === 'error';

    /**
     * Whether the chat panel can be opened to this question's thread —
     * true once a `threadId` exists AND the node is running (watch live)
     * or finished (replay). A pending paste-fork blocks opening until its
     * history has finished copying.
     */
    const canOpenInChat =
      !!data.threadId && (hasRun || status === 'running') && !isForkPending;

    const openQuestionThread = useChatStore((s) => s.openQuestionThread);
    const showChatAnchor = useChatStore(
      (s) => s.viewingQuestionThread?.nodeId === id,
    );
    const isRightPanelCollapsed = usePanelStore((s) => s.isRightCollapsed);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);
    const canvasId = useCanvasStore((s) => s.canvasId);

    // ------------------------------------------------------------------
    // Open an already-run question's conversation (live or replay).
    // ------------------------------------------------------------------
    const openInChat = useCallback(() => {
      if (!data.threadId) return;
      openQuestionThread(
        id,
        data.threadId,
        data.agentBinding,
        canvasId || undefined,
      );
      requestOpenRightPanel();
      // Mark as viewed only once the run has finished.
      if (hasRun && !data.viewed) {
        patchNodeSilent(id, { viewed: true });
      }
    }, [
      id,
      data.threadId,
      data.agentBinding,
      data.viewed,
      hasRun,
      canvasId,
      openQuestionThread,
      requestOpenRightPanel,
      patchNodeSilent,
    ]);

    // ------------------------------------------------------------------
    // Open this node for composition: switch the chat panel to the
    // node's (empty) thread, expand it, and focus the input. Mints a
    // thread id on first use so the node + its conversation are bound.
    // ------------------------------------------------------------------
    const openInCompose = useCallback(() => {
      let threadId = data.threadId;
      if (!threadId) {
        threadId = createId('thread');
        patchNodeSilent(id, { threadId });
      }
      enterQuestionCompose(id, threadId, canvasId);
    }, [id, data.threadId, canvasId, patchNodeSilent]);

    // ------------------------------------------------------------------
    // Double-click:
    //   - running / done / error → open conversation in chat panel
    //   - idle (not yet asked)    → open compose in chat panel
    //   - fork still copying      → no-op (history not ready yet)
    // ------------------------------------------------------------------
    const handleActivate = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isForkPending) return;
        if (canOpenInChat) {
          openInChat();
        } else {
          openInCompose();
        }
      },
      [isForkPending, canOpenInChat, openInChat, openInCompose],
    );

    // ------------------------------------------------------------------
    // Toolbar — a single action that opens the conversation or compose.
    // While a paste-fork is still copying its history the node has no
    // openable conversation yet, so no action is offered.
    // ------------------------------------------------------------------
    const questionToolbar = useMemo(
      () =>
        isForkPending ? null : canOpenInChat ? (
          <FloatingToolbar.ActionButton
            title={
              status === 'running'
                ? 'Watch live conversation'
                : 'View conversation'
            }
            onClick={openInChat}
          >
            <MessageSquare size={14} />
          </FloatingToolbar.ActionButton>
        ) : (
          <FloatingToolbar.ActionButton title="Ask" onClick={openInCompose}>
            <MessageSquare size={14} />
          </FloatingToolbar.ActionButton>
        ),
      [isForkPending, canOpenInChat, status, openInChat, openInCompose],
    );

    const isDoneUnviewed = status === 'done' && !viewed;

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'question'}
        selected={selected}
        actions={questionToolbar}
        keepAspectRatio={false}
        allowOverflow
        fillColor={STICKY_BG}
        className={clsx(
          'question-sticky rounded-lg transition-all duration-200',
          isDoneUnviewed && 'question-node-done-unviewed',
        )}
        {...surface.nodeWrapperProps}
      >
        {showChatAnchor && !isRightPanelCollapsed && <ChatAnchorCorners />}
        <TextNodeBody
          ref={textareaRef}
          {...surface.bodyProps}
          draft={surface.draft}
          onChange={() => {}}
          onBlur={() => {}}
          isEditing={false}
          onRequestEdit={handleActivate}
          placeholder={QUESTION_NODE_PLACEHOLDER}
          fontFamily={QUESTION_FONT_FAMILY}
          color="var(--question-fg)"
          textareaClassName="placeholder:text-fg-default/40"
        >
          {status !== 'idle' && (
            <StatusBadge
              status={isForkPending ? 'running' : status}
              offset={{ top: -22, left: -2 }}
              shake={!isForkPending && status === 'error'}
              className={isDoneUnviewed ? 'question-done-pill' : undefined}
              tooltip={
                status === 'error' && data.errorMessage
                  ? data.errorMessage
                  : undefined
              }
              onClick={canOpenInChat ? openInChat : undefined}
              title={
                canOpenInChat
                  ? status === 'running'
                    ? 'Watch live conversation'
                    : 'Open conversation'
                  : undefined
              }
              trailing={
                status === 'done' && conflictCount > 0 ? (
                  <ConflictBadge count={conflictCount} />
                ) : undefined
              }
            />
          )}
        </TextNodeBody>
      </NodeWrapper>
    );
  },
);

/**
 * Small warning chip rendered next to a question node's "Done" badge when
 * one or more of the run's canvas writes were skipped because the user
 * was mid-editing the target node. Signals a
 * partially-applied run without a global toast; clicking the badge itself
 * opens the conversation where the skipped rows are listed.
 */
function ConflictBadge({ count }: { count: number }) {
  return (
    <Tooltip
      content={`${count} agent ${count === 1 ? 'change was' : 'changes were'} skipped because you were editing.`}
    >
      <span className="bg-warning-bg text-warning pointer-events-auto inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold shadow-sm">
        <AlertTriangle size={12} />
        {count}
      </span>
    </Tooltip>
  );
}

function ChatAnchorCorners() {
  const zoom = useStore((s) => s.transform[2]);
  const { containerStyle, cornerStyle, corners } = useMemo(() => {
    // Keep the marker mostly screen-space stable, but let it shrink at far
    // zooms so it does not overpower tiny nodes in overview mode.
    const inverseZoom = zoom > 0 ? Math.min(1 / zoom, 5) : 1;
    const px = (value: number) => value * inverseZoom;

    const cornerSize = px(14);
    const cornerThickness = px(2);
    const outset = px(12);
    const radius = px(14);
    const glowSoft = px(3);
    const glowWide = px(7);
    const gradientHotspot = px(8);
    const gradientMidpoint = px(16);
    const gradientEdge = px(34);
    const shadowBlur = px(16);
    const cornerStyle = {
      position: 'absolute',
      width: cornerSize,
      height: cornerSize,
      borderColor: 'color-mix(in srgb, var(--question-border) 78%, white 8%)',
      filter: `drop-shadow(0 0 ${glowSoft}px color-mix(in srgb, var(--question-border) 95%, transparent)) drop-shadow(0 0 ${glowWide}px color-mix(in srgb, var(--question-border) 58%, transparent)) drop-shadow(0 0 ${px(14)}px color-mix(in srgb, var(--question-bg) 45%, transparent))`,
    } as const;
    const cornerGlow = `color-mix(in srgb, var(--question-border) 22%, transparent) 0 ${gradientHotspot}px, color-mix(in srgb, var(--question-border) 12%, transparent) ${gradientMidpoint}px, transparent ${gradientEdge}px`;
    const corners = [
      {
        top: 0,
        left: 0,
        borderTopWidth: cornerThickness,
        borderLeftWidth: cornerThickness,
        borderTopLeftRadius: radius,
      },
      {
        top: 0,
        right: 0,
        borderTopWidth: cornerThickness,
        borderRightWidth: cornerThickness,
        borderTopRightRadius: radius,
      },
      {
        right: 0,
        bottom: 0,
        borderRightWidth: cornerThickness,
        borderBottomWidth: cornerThickness,
        borderBottomRightRadius: radius,
      },
      {
        bottom: 0,
        left: 0,
        borderBottomWidth: cornerThickness,
        borderLeftWidth: cornerThickness,
        borderBottomLeftRadius: radius,
      },
    ] as const;
    const containerStyle = {
      inset: -outset,
      borderRadius: radius,
      background: `radial-gradient(circle at 0 0, ${cornerGlow}), radial-gradient(circle at 100% 0, ${cornerGlow}), radial-gradient(circle at 100% 100%, ${cornerGlow}), radial-gradient(circle at 0 100%, ${cornerGlow}), color-mix(in srgb, var(--question-border) 6%, transparent)`,
      boxShadow: `0 0 ${shadowBlur}px color-mix(in srgb, var(--question-border) 18%, transparent)`,
    } as const;

    return { containerStyle, cornerStyle, corners };
  }, [zoom]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-0"
      style={containerStyle}
    >
      {corners.map((corner, index) => (
        <div key={index} style={{ ...cornerStyle, ...corner }} />
      ))}
    </div>
  );
}
