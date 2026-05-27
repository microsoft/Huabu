import { clsx } from 'clsx';
import { MessageSquare, Pencil, Play, Square } from 'lucide-react';
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { StatusBadge } from '@/components/Common/StatusBadge.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import useCanvasStore from '@/store/canvasStore.ts';
import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';

import { NodeWrapper } from '../NodeWrapper';
import { TextNodeBody } from '../shared/TextNodeBody';

import type { CanvasQuestionNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type QuestionNodeType = Node<CanvasQuestionNodeData, 'question'>;

/** Padding inside the node (px). */
const NODE_PADDING = 12;

/** Font family for the question sticky-note style. */
const QUESTION_FONT_FAMILY =
  '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive';

/** Sticky-note warm background colour (design token). */
const STICKY_BG = 'var(--question-bg)';

export const QuestionNode = memo(
  ({ id, data, selected, width }: NodeProps<QuestionNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const processingRef = useRef<AbortController>();

    const inputContent =
      data.input?.kind === 'text' ? (data.input.content ?? '') : '';

    // Focus textarea when entering edit mode, cursor at end.
    useEffect(() => {
      if (isEditing) {
        // Wait for the next frame so readOnly/pointer-events are updated.
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          const len = ta.value.length;
          ta.selectionStart = len;
          ta.selectionEnd = len;
        });
      }
    }, [isEditing]);

    // Abort any in-flight blur processing on unmount.
    useEffect(() => () => processingRef.current?.abort(), []);

    // ------------------------------------------------------------------
    // Shared surface (auto-size + draft state + wrapper/body prop bundles)
    // ------------------------------------------------------------------
    const fontOpts = useMemo(
      () => ({
        fontFamily: QUESTION_FONT_FAMILY,
        fontWeight: 'normal',
        fontStyle: 'normal',
        lineHeight: 1.5,
      }),
      [],
    );

    const surface = useTextNodeSurface({
      nodeId: id,
      width,
      isEditing,
      content: inputContent,
      baseFontSize: 16,
      padding: NODE_PADDING,
      fontOpts,
      placeholder: 'Ask a question...',
    });

    const status = data.status ?? 'idle';
    const viewed = data.viewed ?? false;

    // ------------------------------------------------------------------
    // Countdown seconds for pending label
    // ------------------------------------------------------------------
    const [countdownSecs, setCountdownSecs] = useState(0);

    useEffect(() => {
      if (status !== 'pending' || !data.runAt) {
        setCountdownSecs(0);
        return;
      }
      const tick = () => {
        const remaining = Math.max(0, (data.runAt ?? 0) - Date.now());
        setCountdownSecs(Math.ceil(remaining / 1000));
      };
      tick();
      const interval = setInterval(tick, 500);
      return () => clearInterval(interval);
    }, [status, data.runAt]);

    /** Whether this node has been executed at least once. */
    const hasRun = status === 'done' || status === 'error';

    // ------------------------------------------------------------------
    // Open question thread in chat panel
    // ------------------------------------------------------------------
    const openQuestionThread = useChatStore((s) => s.openQuestionThread);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);

    const openInChat = useCallback(() => {
      if (!data.threadId) return;
      openQuestionThread(id, data.threadId);
      requestOpenRightPanel();
      // Mark as viewed (persisted via autosave, no undo entry).
      if (!data.viewed) {
        patchNodeSilent(id, { viewed: true });
      }
    }, [
      id,
      data.threadId,
      data.viewed,
      openQuestionThread,
      requestOpenRightPanel,
      patchNodeSilent,
    ]);

    // ------------------------------------------------------------------
    // Double-click: edit (idle/pending) or open chat (done/error)
    // ------------------------------------------------------------------
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();

        // After execution, double-click opens the conversation in chat panel
        if (hasRun && data.threadId) {
          openInChat();
          return;
        }

        // Before execution: enter edit mode
        processingRef.current?.abort();
        if (status === 'pending') {
          patchNodeSilent(id, { status: 'idle', runAt: undefined });
        }
        setIsEditing(true);
      },
      [id, status, hasRun, data.threadId, patchNodeSilent, openInChat],
    );

    // ------------------------------------------------------------------
    // Toolbar
    // ------------------------------------------------------------------
    const questionToolbar = useMemo(
      () => (
        <>
          {/* Edit question (before execution) or View conversation (after execution) */}
          {hasRun && data.threadId ? (
            <FloatingToolbar.ActionButton
              title="View conversation"
              onClick={openInChat}
            >
              <MessageSquare size={14} />
            </FloatingToolbar.ActionButton>
          ) : status !== 'running' && status !== 'pending' ? (
            <FloatingToolbar.ActionButton
              title="Edit question"
              onClick={() => {
                processingRef.current?.abort();
                setIsEditing(true);
              }}
            >
              <Pencil size={14} />
            </FloatingToolbar.ActionButton>
          ) : null}

          {/* Cancel — only when pending/running */}
          {(status === 'pending' || status === 'running') && (
            <>
              <FloatingToolbar.ActionButton
                title="Cancel"
                onClick={() => {
                  processingRef.current?.abort();
                  patchNodeSilent(id, { status: 'idle', runAt: undefined });
                }}
              >
                <Square size={14} />
              </FloatingToolbar.ActionButton>
            </>
          )}

          {/* Run now — only when pending */}
          {status === 'pending' && (
            <FloatingToolbar.ActionButton
              title="Run now"
              onClick={() => patchNodeSilent(id, { runAt: Date.now() })}
            >
              <Play size={14} />
            </FloatingToolbar.ActionButton>
          )}
        </>
      ),
      [id, status, hasRun, data.threadId, patchNodeSilent, openInChat],
    );

    const handleBlur = useCallback(() => {
      setIsEditing(false);

      const trimmed = surface.draft.trim();
      const contentChanged = trimmed !== inputContent;

      // Commit input to store if changed.
      if (contentChanged) {
        updateNodeData(id, {
          input: { kind: 'text', content: trimmed },
        });
      }

      // Only schedule auto-run when content actually changed.
      if (!trimmed || !contentChanged) return;

      const delay = (data.autoRunDelay as number | undefined) ?? 10;
      patchNodeSilent(id, {
        status: 'pending',
        runAt: Date.now() + delay * 1000,
      });
    }, [
      surface.draft,
      inputContent,
      id,
      data.autoRunDelay,
      updateNodeData,
      patchNodeSilent,
    ]);

    const isDoneUnviewed = status === 'done' && !viewed;

    return (
      <NodeWrapper
        id={id}
        data={{ ...data, style: { ...data.style, backgroundColor: STICKY_BG } }}
        type={'question'}
        selected={selected}
        actions={questionToolbar}
        keepAspectRatio={false}
        allowOverflow
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
          onChange={surface.setDraft}
          onBlur={handleBlur}
          isEditing={isEditing}
          onRequestEdit={handleDoubleClick}
          placeholder="Ask a question..."
          fontFamily={QUESTION_FONT_FAMILY}
          color="var(--question-fg)"
          textareaClassName="placeholder:text-fg-default/40"
        >
          {status !== 'idle' && (
            <StatusBadge
              status={status}
              offset={{ top: -22, left: -2 }}
              label={
                status === 'pending' && countdownSecs > 0
                  ? `Starts in ${countdownSecs}s`
                  : undefined
              }
              shake={status === 'error'}
              className={isDoneUnviewed ? 'question-done-pill' : undefined}
              tooltip={
                status === 'error' && data.errorMessage
                  ? data.errorMessage
                  : undefined
              }
              onClick={hasRun && data.threadId ? openInChat : undefined}
              title={hasRun && data.threadId ? 'Open conversation' : undefined}
            />
          )}
        </TextNodeBody>
      </NodeWrapper>
    );
  },
);
