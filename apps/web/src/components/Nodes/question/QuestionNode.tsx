import { clsx } from 'clsx';
import { MessageSquare, Pencil, Play, Square } from 'lucide-react';
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { StatusBadge } from '@/components/Common/StatusBadge.tsx';
import { useAcpAgents } from '@/hooks/useAcpAgents';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import useCanvasStore from '@/store/canvasStore.ts';
import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';

import { AgentMentionMenu } from './AgentMentionMenu';
import { NodeWrapper } from '../NodeWrapper';
import { TextNodeBody } from '../shared/TextNodeBody';

import type {
  AgentMentionMenuRef,
  AgentMentionOption,
} from './AgentMentionMenu';
import type { CanvasQuestionNodeData } from '../types';
import type { AgentBinding } from '@sediment/shared';
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

    // ------------------------------------------------------------------
    // Connected ACP agents — feeds the `@` mention picker.
    //
    // We deliberately do NOT mount-fetch on every QuestionNode render
    // because there may be many nodes per canvas; the hook already
    // does a one-shot fetch at mount and we expose `refreshAgents` on
    // explicit user intent (first `@` keystroke per session).
    // ------------------------------------------------------------------
    const { agents: connectedAgents, refresh: refreshAgents } = useAcpAgents();

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
      placeholder: 'Ask a question… type @ to pick an agent',
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
      // Forward the node's binding so the ChatInput mode selector
      // reflects the agent that actually answered this question
      // (defaults to internal when the node pre-dates `agentBinding`).
      openQuestionThread(id, data.threadId, data.agentBinding);
      requestOpenRightPanel();
      // Mark as viewed (persisted via autosave, no undo entry).
      if (!data.viewed) {
        patchNodeSilent(id, { viewed: true });
      }
    }, [
      id,
      data.threadId,
      data.agentBinding,
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

    // ------------------------------------------------------------------
    // `@` mention typeahead — pick the agent that will handle this
    // question. The picker activates when the draft starts with `@`
    // and the caret sits within that token. Selecting an option
    // rewrites the leading `@<filter>` to `@<alias> ` and persists
    // the binding choice on the node so `useQuestionRunner` can
    // dispatch to the right agent.
    // ------------------------------------------------------------------
    const mentionMenuRef = useRef<AgentMentionMenuRef | null>(null);
    const [caretPos, setCaretPos] = useState(0);
    // Esc-dismiss is keyed by the literal `@<token>` the user dismissed
    // for, so typing a different alias after Esc re-opens the menu
    // (vs. requiring an explicit interaction).
    const [mentionDismissedFor, setMentionDismissedFor] = useState<
      string | null
    >(null);

    /**
     * Activation rule for the mention menu. True when:
     *   - editing is active,
     *   - draft starts with `@`,
     *   - caret sits at or before the end of the first token,
     *   - the token isn't currently dismissed.
     */
    const mentionState = useMemo<{ filter: string } | null>(() => {
      if (!isEditing) return null;
      const draft = surface.draft;
      if (!draft.startsWith('@')) return null;
      const firstSpace = draft.search(/\s/);
      const tokenEnd = firstSpace === -1 ? draft.length : firstSpace;
      if (caretPos > tokenEnd) return null;
      const filter = draft.slice(1, tokenEnd);
      if (mentionDismissedFor === filter) return null;
      return { filter };
    }, [isEditing, surface.draft, caretPos, mentionDismissedFor]);

    // Clear the dismiss flag once the user starts a different `@token`
    // (typed `@cu` after dismissing `@cl`).
    useEffect(() => {
      if (mentionDismissedFor === null) return;
      if (!surface.draft.startsWith(`@${mentionDismissedFor}`)) {
        setMentionDismissedFor(null);
      }
    }, [surface.draft, mentionDismissedFor]);

    // Refresh the ACP agent list on the rising edge of "user wants the
    // mention menu" so a newly-connected agent shows up without
    // requiring the user to first open the ChatPanel's ModeSelector.
    const lastMentionWantedRef = useRef(false);
    useEffect(() => {
      const wants = mentionState !== null;
      if (wants && !lastMentionWantedRef.current) {
        void refreshAgents();
      }
      lastMentionWantedRef.current = wants;
    }, [mentionState, refreshAgents]);

    const syncCaret = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      setCaretPos(ta.selectionStart ?? 0);
    }, []);

    const handleDraftChange = useCallback(
      (next: string) => {
        surface.setDraft(next);
        // Re-read the caret AFTER React commits the new value so the
        // activation parser sees the just-typed character.
        requestAnimationFrame(syncCaret);
      },
      [surface, syncCaret],
    );

    const acceptMention = useCallback(
      (option: AgentMentionOption) => {
        const draft = surface.draft;
        const firstSpace = draft.search(/\s/);
        const tokenEnd = firstSpace === -1 ? draft.length : firstSpace;
        const rest = draft.slice(tokenEnd);
        const replacement = `@${option.alias} `;
        const next = replacement + rest.replace(/^\s+/, '');
        surface.setDraft(next);

        // Persist the binding via patchNodeSilent — picking an agent
        // is a metadata tweak, not a content edit, so it shouldn't
        // create a separate undo step or trigger ingestion.
        const binding: AgentBinding =
          option.kind === 'external'
            ? {
                kind: 'external',
                alias: option.alias,
                agentletAgentId: option.agentletAgentId,
              }
            : { kind: 'internal' };
        patchNodeSilent(id, {
          agentBinding: binding,
          agentMode: option.kind === 'internal' ? option.mode : undefined,
        });

        setMentionDismissedFor(null);
        // Restore focus + place caret right after the inserted `@alias `.
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          const pos = replacement.length;
          ta.selectionStart = pos;
          ta.selectionEnd = pos;
          setCaretPos(pos);
        });
      },
      [id, surface, patchNodeSilent],
    );

    const dismissMention = useCallback(() => {
      const draft = surface.draft;
      const firstSpace = draft.search(/\s/);
      const tokenEnd = firstSpace === -1 ? draft.length : firstSpace;
      const token = draft.startsWith('@') ? draft.slice(1, tokenEnd) : '';
      setMentionDismissedFor(token);
    }, [surface.draft]);

    /**
     * Intercept keys only while the mention menu is visible — the
     * textarea otherwise behaves identically to plain text input
     * (Enter inserts a newline; we never submit on Enter).
     */
    const handleTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!mentionState || !mentionMenuRef.current) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mentionMenuRef.current.moveHighlight(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mentionMenuRef.current.moveHighlight(-1);
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          const active = mentionMenuRef.current.getActive();
          if (active) {
            e.preventDefault();
            acceptMention(active);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          dismissMention();
          return;
        }
      },
      [mentionState, acceptMention, dismissMention],
    );

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
          onChange={handleDraftChange}
          onBlur={handleBlur}
          onKeyDown={handleTextareaKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          isEditing={isEditing}
          onRequestEdit={handleDoubleClick}
          placeholder="Ask a question… type @ to pick an agent"
          fontFamily={QUESTION_FONT_FAMILY}
          color="var(--question-fg)"
          textareaClassName="placeholder:text-fg-default/40"
        >
          {mentionState && (
            <AgentMentionMenu
              ref={mentionMenuRef}
              agents={connectedAgents}
              filter={mentionState.filter}
              onSelect={acceptMention}
            />
          )}
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
