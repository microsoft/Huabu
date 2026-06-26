import { clsx } from 'clsx';
import { MessageSquare } from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';

import { createId } from '@sediment/shared';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { StatusBadge } from '@/components/Common/StatusBadge.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
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
import { TextNodeBody } from '../shared/TextNodeBody';

import type { CanvasQuestionNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type QuestionNodeType = Node<CanvasQuestionNodeData, 'question'>;

/** Sticky-note warm background colour (design token). */
const STICKY_BG = 'var(--question-bg)';

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
      content: inputContent,
      baseFontSize: 16,
      padding: NODE_PADDING,
      fontOpts,
      placeholder: QUESTION_NODE_PLACEHOLDER,
    });

    const status = data.status ?? 'idle';
    const viewed = data.viewed ?? false;

    /** Whether this node has been executed at least once. */
    const hasRun = status === 'done' || status === 'error';

    /**
     * Whether the chat panel can be opened to this question's thread —
     * true once a `threadId` exists AND the node is running (watch live)
     * or finished (replay).
     */
    const canOpenInChat = !!data.threadId && (hasRun || status === 'running');

    const openQuestionThread = useChatStore((s) => s.openQuestionThread);
    const openQuestionCompose = useChatStore((s) => s.openQuestionCompose);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);
    const requestFocusChatInput = usePanelStore((s) => s.requestFocusChatInput);
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
      openQuestionCompose(id, threadId, canvasId || undefined);
      requestOpenRightPanel();
      requestFocusChatInput();
    }, [
      id,
      data.threadId,
      canvasId,
      patchNodeSilent,
      openQuestionCompose,
      requestOpenRightPanel,
      requestFocusChatInput,
    ]);

    // ------------------------------------------------------------------
    // Double-click:
    //   - running / done / error → open conversation in chat panel
    //   - idle (not yet asked)    → open compose in chat panel
    // ------------------------------------------------------------------
    const handleActivate = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (canOpenInChat) {
          openInChat();
        } else {
          openInCompose();
        }
      },
      [canOpenInChat, openInChat, openInCompose],
    );

    // ------------------------------------------------------------------
    // Toolbar — a single action that opens the conversation or compose.
    // ------------------------------------------------------------------
    const questionToolbar = useMemo(
      () =>
        canOpenInChat ? (
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
      [canOpenInChat, status, openInChat, openInCompose],
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
              status={status}
              offset={{ top: -22, left: -2 }}
              shake={status === 'error'}
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
            />
          )}
        </TextNodeBody>
      </NodeWrapper>
    );
  },
);
