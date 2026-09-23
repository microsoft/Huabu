// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { MessageSquare } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getQuestionNodeStatus } from '@huabu/shared';
import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import './QuestionNode.css';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { toast } from '@/components/Common/Toast';
import { useActivelyViewingQuestionNode } from '@/hooks/useActivelyViewingQuestion';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import { useAcpProfilesStore } from '@/store/acpProfilesStore.ts';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore.ts';
import useCanvasStore from '@/store/canvasStore.ts';
import {
  selectThreadBinding,
  selectThreadLastAction,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore.ts';
import { findPendingPermissionRequestId } from '@/store/chatTypes.ts';
import {
  acknowledgeConversationResult,
  resolveConversationAgentBinding,
} from '@/store/conversationOwner';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import {
  getQuestionFontOpts,
  QUESTION_NODE_DEFAULT_FONT_SIZE,
  QUESTION_NODE_HEADER_INSET,
  QUESTION_NODE_PADDING as NODE_PADDING,
  QUESTION_NODE_PADDING_Y,
  QUESTION_NODE_PLACEHOLDER,
} from '@/utils/node/nodeFontConfig';
import { getQuestionDisplayText } from '@/utils/node/questionDisplayText';
import { resolveQuestionAgentPresentation } from '@/utils/questionAgentPresentation.ts';

import { NODE_TYPOGRAPHY } from '../design/nodeTypography';
import { useFrameSuppressed } from '../frame/FrameZoomContext';
import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import {
  enterQuestionCompose,
  enterQuestionConversation,
  ensureQuestionThread,
} from './questionCompose.ts';
import { QuestionConversationCard } from './QuestionConversationCard';
import {
  QuestionTakeoverMark,
  resolveQuestionTakeoverTone,
} from './QuestionTakeoverMark.tsx';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome.ts';
import type { CanvasQuestionNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type QuestionNodeType = Node<CanvasQuestionNodeData, 'question'>;

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
    const { t } = useTranslation();
    const frameSuppressed = useFrameSuppressed(id);

    // On-canvas anchor text. Prefer the generated `label` (a concise
    // title) once preprocessing produced one; fall back to a truncated
    // preview of the first message while the label is still pending
    // (compose / mid-generation). Truncating the fallback keeps the
    // auto-sized footprint bounded, so the eventual swap to the (usually
    // shorter) label is at most a small, `transition-all`-animated size
    // change rather than a large jump from a very long first message.
    const displayText = getQuestionDisplayText(data);

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
      baseFontSize: QUESTION_NODE_DEFAULT_FONT_SIZE,
      fontSizing: 'proportional',
      minAutoWidth: getNodeDefaultSize('question').width,
      paddingX:
        NODE_PADDING *
        (QUESTION_NODE_DEFAULT_FONT_SIZE / NODE_TYPOGRAPHY.cardTitle.size),
      paddingY:
        (QUESTION_NODE_PADDING_Y + QUESTION_NODE_HEADER_INSET) *
        (QUESTION_NODE_DEFAULT_FONT_SIZE / NODE_TYPOGRAPHY.cardTitle.size),
      fontOpts,
      placeholder: QUESTION_NODE_PLACEHOLDER,
    });

    const status = getQuestionNodeStatus(data);
    const viewed = data.viewed ?? false;
    const isContentMissing = data.contentMissing === true;

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

    /** Whether this node has an explicit terminal execution state. */
    const hasRun = status === 'done' || status === 'error';
    const hasConversation =
      !!data.threadId &&
      (hasRun || status === 'running' || displayText.trim().length > 0);

    /**
     * Whether the chat panel can be opened to this question's thread —
     * true once a `threadId` exists AND the node is running (watch live)
     * or finished (replay). A pending paste-fork blocks opening until its
     * history has finished copying.
     */
    const canOpenInChat = hasConversation && !isForkPending;

    const needsApproval = useChatStore((s) => {
      if (!data.threadId) return false;
      return (
        findPendingPermissionRequestId(
          selectThreadMessages(s, data.threadId),
        ) !== null
      );
    });
    const showChatAnchor = usePreviewWorkspaceStore((state) =>
      Object.values(state.workspace.tabs).some(
        (tab) => tab.target.kind === 'node' && tab.target.nodeId === id,
      ),
    );
    // Composing = this node is the chat anchor AND it has never been
    // authored/run yet (`idle`). Derived from the node's status, not a stored
    // `compose` flag.
    const isOpenForQuestion = showChatAnchor && status === 'idle';
    // Compose-time binding lives on the node's own thread, so it stays correct
    // even while another Chat is mounted on a different thread.
    const composeAgentBinding = useChatStore((s) =>
      data.threadId ? selectThreadBinding(s, data.threadId) : undefined,
    );
    // While composing a brand-new question, the mode follows this thread's
    // inline Chat/Agent pick rather than the not-yet-written node field.
    const composeAgentMode = useChatStore((s) =>
      data.threadId ? selectThreadLastAction(s, data.threadId) : 'ask',
    );
    const agentProfiles = useAcpProfilesStore((s) => s.profiles);
    // Open styling is independent of lifecycle and never hides a running turn.
    const isChatAnchorActive = useActivelyViewingQuestionNode(id);
    const canvasId = useCanvasStore((s) => s.canvasId);

    // ------------------------------------------------------------------
    // Open an already-run question's conversation (live or replay).
    // ------------------------------------------------------------------
    const openInChat = useCallback(
      (transient = false) => {
        if (!data.threadId) return;
        enterQuestionConversation(
          {
            presentationAnchor: { canvasId, nodeId: id },
            conversationOwner: {
              canvasId,
              nodeId: id,
              threadId: data.threadId,
            },
          },
          data.agentBinding,
          canvasId,
          'bottom',
          { transient },
        );
        // Mark as viewed only once the run has finished.
        if (hasRun && !data.viewed) {
          void acknowledgeConversationResult(
            {
              presentationAnchor: { canvasId, nodeId: id },
              conversationOwner: {
                canvasId,
                nodeId: id,
                threadId: data.threadId,
              },
            },
            {
              status: data.status,
              viewed: data.viewed,
              invocationToken: data.invocationToken,
            },
          ).catch((error) =>
            console.error('Failed to acknowledge Agent result', error),
          );
        }
      },
      [
        id,
        data.threadId,
        data.agentBinding,
        data.viewed,
        hasRun,
        canvasId,
        data.invocationToken,
        data.status,
      ],
    );

    // ------------------------------------------------------------------
    // Open this node for composition: switch the chat panel to the
    // node's (empty) thread, expand it, and focus the input. Mints a
    // thread id on first use so the node + its conversation are bound.
    // ------------------------------------------------------------------
    const openInCompose = useCallback(
      (transient = false) => {
        void ensureQuestionThread(canvasId, id)
          .then((threadId) =>
            enterQuestionCompose(
              {
                presentationAnchor: { canvasId, nodeId: id },
                conversationOwner: { canvasId, nodeId: id, threadId },
              },
              canvasId,
              data.agentBinding,
              { transient },
            ),
          )
          .catch((error) =>
            toast(
              error instanceof Error
                ? error.message
                : 'Failed to open Agent conversation',
              { tone: 'danger' },
            ),
          );
      },
      [id, data.agentBinding, canvasId],
    );

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
          openInChat(true);
        } else {
          openInCompose(true);
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
                ? t('node.watchLiveConversation')
                : t('node.viewConversation')
            }
            onClick={() => openInChat(true)}
          >
            <MessageSquare size={14} />
          </FloatingToolbar.ActionButton>
        ) : (
          <FloatingToolbar.ActionButton
            title={t('node.ask')}
            onClick={() => openInCompose(true)}
          >
            <MessageSquare size={14} />
          </FloatingToolbar.ActionButton>
        ),
      [isForkPending, canOpenInChat, status, openInChat, openInCompose, t],
    );

    const isDoneUnviewed = status === 'done' && !viewed;
    const isErrorUnviewed = status === 'error' && !viewed;
    const effectiveBinding = resolveConversationAgentBinding(
      data,
      composeAgentBinding ?? { kind: 'internal' },
    );
    const agentPresentation = resolveQuestionAgentPresentation({
      binding: effectiveBinding,
      fallbackIcon: data.agentIcon,
      profiles: agentProfiles,
      agentMode:
        data.agentMode ?? (isOpenForQuestion ? composeAgentMode : 'ask'),
    });
    // Permission and pending forks retain their existing priority over stored status.
    const badgeStatus: QuestionAgentBadgeStatus | null = needsApproval
      ? 'approval'
      : isForkPending
        ? 'running'
        : status === 'idle'
          ? null
          : status;
    const tone = resolveQuestionTakeoverTone(
      badgeStatus ?? 'idle',
      isDoneUnviewed || isErrorUnviewed,
      status === 'done' ? conflictCount : 0,
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'question'}
        selected={selected}
        actions={isContentMissing ? undefined : questionToolbar}
        keepAspectRatio={false}
        allowOverflow
        fillColor="var(--question-fill)"
        borderRadius={
          12 *
          (surface.bodyProps.effectiveFontSize / NODE_TYPOGRAPHY.cardTitle.size)
        }
        className={[
          'question-compact',
          `question-tone-${tone}`,
          isChatAnchorActive ? 'question-open' : '',
        ].join(' ')}
        onDoubleClick={
          isContentMissing || isForkPending ? undefined : handleActivate
        }
        takeover={
          isContentMissing
            ? undefined
            : {
                fontSize: surface.bodyProps.effectiveFontSize,
                forceCollapsed: frameSuppressed,
                onActivate: isForkPending ? undefined : handleActivate,
                renderMark: (s) =>
                  (s.progress ?? 0) === 0 ? null : (
                    <QuestionTakeoverMark
                      state={{ ...s, stage: 'collapsed' }}
                      presentation={frameSuppressed ? 'dot' : 'avatar'}
                      status={badgeStatus ?? 'idle'}
                      isOpen={isChatAnchorActive}
                      agent={agentPresentation}
                      unread={isDoneUnviewed || isErrorUnviewed}
                      conflictCount={status === 'done' ? conflictCount : 0}
                      interactive={canOpenInChat}
                      onOpen={canOpenInChat ? openInChat : undefined}
                      accessibleLabel={
                        canOpenInChat
                          ? `${agentPresentation.alias} · ${t('node.openConversation')}`
                          : undefined
                      }
                      conflictTooltip={
                        conflictCount > 0
                          ? t('node.agentChangesSkipped', {
                              count: conflictCount,
                            })
                          : undefined
                      }
                      tooltip={
                        needsApproval
                          ? t('messages.permissionRequested')
                          : status === 'error' && data.errorMessage
                            ? data.errorMessage
                            : canOpenInChat
                              ? `${agentPresentation.alias} · ${
                                  status === 'running'
                                    ? t('node.watchLiveConversation')
                                    : t('node.openConversation')
                                }`
                              : agentPresentation.alias
                      }
                    />
                  ),
              }
        }
        {...surface.nodeWrapperProps}
      >
        {isContentMissing ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <QuestionConversationCard
            {...surface.bodyProps}
            agent={agentPresentation}
            status={badgeStatus ?? 'idle'}
            isOpen={isChatAnchorActive}
            unread={isDoneUnviewed || isErrorUnviewed}
            conflictCount={status === 'done' ? conflictCount : 0}
            errorMessage={data.errorMessage}
            text={surface.draft}
            placeholder={QUESTION_NODE_PLACEHOLDER}
          />
        )}
      </NodeWrapper>
    );
  },
);
