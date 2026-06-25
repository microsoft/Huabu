import { clsx } from 'clsx';
import { MessageSquare, Pencil, Play, Square } from 'lucide-react';
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { StatusBadge } from '@/components/Common/StatusBadge.tsx';
import { useAcpProfiles } from '@/hooks/useAcpProfiles';
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

/** Sticky-note warm background colour (design token). */
const STICKY_BG = 'var(--question-bg)';

export const QuestionNode = memo(
  ({ id, data, selected, width }: NodeProps<QuestionNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const processingRef = useRef<AbortController>();
    const suppressBlurAutoRunRef = useRef(false);

    const input = (data as any).input;
    const inputContent = input?.kind === 'text' ? (input.content ?? '') : '';

    // ------------------------------------------------------------------
    // Configured external-agent profiles — feeds the `@` mention picker.
    //
    // We deliberately do NOT mount-fetch on every QuestionNode render
    // because there may be many nodes per canvas; the hook already
    // does a one-shot fetch at mount and we expose `refreshProfiles` on
    // explicit user intent (first `@` keystroke per session).
    // ------------------------------------------------------------------
    const { profiles, refresh: refreshProfiles } = useAcpProfiles();

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
    const fontOpts = useMemo(() => getQuestionFontOpts(), []);

    const surface = useTextNodeSurface({
      nodeId: id,
      width,
      isEditing,
      content: inputContent,
      baseFontSize: 16,
      padding: NODE_PADDING,
      fontOpts,
      placeholder: QUESTION_NODE_PLACEHOLDER,
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

    /**
     * Whether the chat panel can be opened to this question's thread.
     * True once a `threadId` exists AND the node is no longer being
     * edited / queued — i.e. running (so the user can watch the
     * assistant stream live) or finished. `useChatHistory` handles
     * the running case: it hydrates the persisted user message, then
     * calls `reconnectStream` to resume the live SSE feed.
     */
    const canOpenInChat = !!data.threadId && (hasRun || status === 'running');

    // ------------------------------------------------------------------
    // Open question thread in chat panel
    // ------------------------------------------------------------------
    const openQuestionThread = useChatStore((s) => s.openQuestionThread);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);
    // Read canvasId so we can persist the replay pointer per canvas;
    // omit it via `undefined` for the (rare) case where the node renders
    // outside an active canvas context.
    const canvasId = useCanvasStore((s) => s.canvasId);

    const openInChat = useCallback(() => {
      if (!data.threadId) return;
      // Forward the node's binding so the panel title + ACP selectors
      // reflect the agent that answered. The replay mode (ask/operate)
      // is derived from this node's `agentMode` inside ChatPanel, so
      // follow-up turns stay locked to the mode the question runs in
      // without us threading it through here. The trailing `canvasId`
      // lets chatStore record this replay in `questionReplayByCanvas`
      // so a refresh / canvas re-entry restores the view.
      openQuestionThread(
        id,
        data.threadId,
        data.agentBinding,
        canvasId || undefined,
      );
      requestOpenRightPanel();
      // Mark as viewed only once the run has finished — if we marked
      // it during `running` and the user navigated away before
      // completion, the "done · unread" glow would never appear. The
      // runner's `onComplete` checks `viewingQuestionThread` to apply
      // `viewed: true` when the user is still watching at completion.
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
    // Double-click:
    //   - running / done / error  → open the conversation in chat panel
    //   - idle / pending          → enter edit mode (cancelling the
    //                               pending countdown if any)
    // ------------------------------------------------------------------
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();

        if (canOpenInChat) {
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
      [id, status, canOpenInChat, patchNodeSilent, openInChat],
    );

    // ------------------------------------------------------------------
    // Toolbar
    // ------------------------------------------------------------------
    const questionToolbar = useMemo(
      () => (
        <>
          {/* View conversation — available once the run has started
              (running) or finished (done/error). For running threads the
              chat panel hydrates persisted messages and `useChatHistory`
              reconnects to the live SSE stream, so the user can watch
              the assistant reply tokens land in real time. */}
          {canOpenInChat ? (
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
          ) : status !== 'pending' ? (
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
      [id, status, canOpenInChat, patchNodeSilent, openInChat],
    );

    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLTextAreaElement>) => {
        // Clicking an option in the `@` mention menu briefly shifts focus
        // from the textarea to the menu button. That is NOT a real blur:
        // the user is still composing the prompt, so we must not tear
        // down edit mode or schedule the auto-run countdown. `acceptMention`
        // will restore caret position on the next animation frame.
        const next = e.relatedTarget as HTMLElement | null;
        if (next?.closest('[role="listbox"][aria-label="Mention agent"]')) {
          return;
        }

        setIsEditing(false);

        // Shift+Enter already committed + started the run; skip the
        // delayed auto-run schedule to avoid clobbering `runAt`.
        if (suppressBlurAutoRunRef.current) {
          suppressBlurAutoRunRef.current = false;
          return;
        }

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
      },
      [
        surface.draft,
        inputContent,
        id,
        data.autoRunDelay,
        updateNodeData,
        patchNodeSilent,
      ],
    );

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

    // Refresh the profile list on the rising edge of "user wants the
    // mention menu" so a freshly-added profile shows up without
    // requiring the user to first open the ChatPanel's NewChatMenu.
    const lastMentionWantedRef = useRef(false);
    useEffect(() => {
      const wants = mentionState !== null;
      if (wants && !lastMentionWantedRef.current) {
        void refreshProfiles();
      }
      lastMentionWantedRef.current = wants;
    }, [mentionState, refreshProfiles]);

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
                profileId: option.profileId,
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
     * Commit the current draft and start execution immediately.
     * Bypasses the auto-run countdown used on blur. Used by the
     * Shift+Enter shortcut.
     */
    const submitAndRunNow = useCallback(() => {
      const trimmed = surface.draft.trim();
      if (!trimmed) return;

      processingRef.current?.abort();
      suppressBlurAutoRunRef.current = true;
      setIsEditing(false);

      if (trimmed !== inputContent) {
        updateNodeData(id, {
          input: { kind: 'text', content: trimmed },
        });
      }

      patchNodeSilent(id, {
        status: 'pending',
        runAt: Date.now(),
      });
    }, [surface.draft, inputContent, id, updateNodeData, patchNodeSilent]);

    const handleTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          submitAndRunNow();
          return;
        }
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
      [mentionState, acceptMention, dismissMention, submitAndRunNow],
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
          onChange={handleDraftChange}
          onBlur={handleBlur}
          onKeyDown={handleTextareaKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          isEditing={isEditing}
          onRequestEdit={handleDoubleClick}
          placeholder={QUESTION_NODE_PLACEHOLDER}
          fontFamily={QUESTION_FONT_FAMILY}
          color="var(--question-fg)"
          textareaClassName="placeholder:text-fg-default/40"
        >
          {mentionState && (
            <AgentMentionMenu
              ref={mentionMenuRef}
              profiles={profiles}
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
