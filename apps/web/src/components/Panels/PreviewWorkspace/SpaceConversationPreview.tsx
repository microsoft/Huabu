// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUpRight, Info } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import { EmptyState } from '@/components/Common/EmptyState';
import { NODE_ICON } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadHistoryLoaded,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import {
  conversationOwnerKey,
  retryConversationOwnerObservation,
  subscribeConversationOwner,
  useRemoteConversationOwnerStore,
} from '@/store/remoteConversationOwner';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { buildNodeDeepLink } from '@/utils/nodeDeepLink';

import { ChatPanel } from '../ChatPanel';

import type { ChatSession } from '@/hooks/useChatSession';
import type { PreviewTarget } from '@/store/previewWorkspace/model';
import type { ComponentProps } from 'react';

const SpaceIcon = NODE_ICON.spacePreview;

export function SpaceConversationPreview({
  target,
  ...props
}: Omit<ComponentProps<typeof ChatPanel>, 'session'> & {
  target: Extract<PreviewTarget, { kind: 'conversation' }>;
}) {
  const canvasId = useCanvasStore((state) => state.canvasId);
  const session = useMemo<ChatSession>(
    () => ({
      canvasId,
      ownerCanvasId: target.canvasId,
      threadId: target.threadId,
      conversationView: {
        presentationAnchor: {
          canvasId: target.canvasId,
          nodeId: target.nodeId,
        },
        conversationOwner: {
          canvasId: target.canvasId,
          nodeId: target.nodeId,
          threadId: target.threadId,
        },
      },
    }),
    [canvasId, target.canvasId, target.nodeId, target.threadId],
  );
  return <OwnedConversationPreview {...props} session={session} />;
}

export function OwnedConversationPreview({
  session,
  ...props
}: ComponentProps<typeof ChatPanel>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const target = session.conversationView?.conversationOwner;
  if (!target)
    throw new Error('Owned conversation preview requires an owner address');
  const canvasId = session.canvasId;
  const remote = target.canvasId !== canvasId;
  const localMissing = useCanvasStore(
    (state) =>
      !remote &&
      state.canvasId === canvasId &&
      !state.isLoading &&
      !state.nodes.some(
        (node) =>
          node.id === target.nodeId &&
          node.type === 'question' &&
          node.data.threadId === target.threadId,
      ),
  );
  const cachedSpaceTitle = useWorkspaceStore(
    (state) => state.spaceTitles[target.canvasId],
  );
  const key = conversationOwnerKey(
    target.canvasId,
    target.nodeId,
    target.threadId,
  );
  const entry = useRemoteConversationOwnerStore((state) => state.entries[key]);
  const hasHistory = useChatStore((state) =>
    selectThreadMessages(state, target.threadId).some(
      (message) => message.role === 'user' || message.role === 'assistant',
    ),
  );
  const historyLoaded = useChatStore((state) =>
    selectThreadHistoryLoaded(state, target.threadId),
  );
  const historyError = useChatStore(
    (state) => state.threadsById[target.threadId]?.historyError,
  );
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const refresh = useCallback(() => {
    try {
      retryConversationOwnerObservation(
        target.canvasId,
        target.nodeId,
        target.threadId,
      );
    } catch (error) {
      console.error('Unable to refresh the displayed Agent owner', error);
    }
  }, [target.canvasId, target.nodeId, target.threadId]);
  useEffect(
    () =>
      subscribeConversationOwner(
        target.canvasId,
        target.nodeId,
        target.threadId,
        () => setValidatedKey(key),
      ),
    [key, target.canvasId, target.nodeId, target.threadId],
  );
  const owner = entry?.owner ?? entry?.lastKnownOwner;
  const spaceTitle =
    owner?.spaceTitle?.trim() ||
    cachedSpaceTitle?.trim() ||
    (cachedSpaceTitle === undefined && !owner
      ? target.canvasId
      : t('spacePreview.untitledSpace'));
  const ownerMissing =
    localMissing || entry?.errorCode === 'conversation_owner_missing';
  const unavailable = localMissing || !!entry?.error;
  const validated = !remote || validatedKey === key;
  const showChat = unavailable
    ? hasHistory || (!localMissing && !!entry?.owner && validated)
    : hasHistory || (validated && (!remote || owner?.nodeId === target.nodeId));
  const loadMissingHistory =
    ownerMissing && !hasHistory && !historyLoaded && !historyError;
  const errorMessage =
    entry?.errorCode === 'missing_node_content'
      ? t('remoteConversation.sourceNodeContentUnavailable')
      : entry?.errorCode === 'canvas_not_found'
        ? t('remoteConversation.sourceSpaceUnavailable')
        : entry?.error;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {remote ? (
        <div className="flex min-w-0 px-3 py-1">
          <Button
            variant="ghost"
            size="sm"
            className="max-w-full justify-start"
            tooltipWrapperClassName="min-w-0 max-w-full"
            aria-label={`${spaceTitle}: ${t('remoteConversation.openSpace')}`}
            title={t('remoteConversation.openSpace')}
            onClick={() => {
              const url = new URL(
                buildNodeDeepLink(
                  window.location.origin,
                  target.canvasId,
                  target.nodeId,
                ),
              );
              navigate(`${url.pathname}${url.search}`, {
                state: {
                  returnToSpace: canvasId,
                  workspaceId: useWorkspaceStore.getState().workspaceId,
                },
              });
            }}
          >
            <SpaceIcon aria-hidden />
            <span className="truncate">{spaceTitle}</span>
            <ArrowUpRight aria-hidden />
          </Button>
        </div>
      ) : null}
      {!showChat || unavailable ? (
        <div
          role={entry?.error && !ownerMissing ? 'alert' : 'status'}
          className={
            showChat
              ? 'shrink-0 px-6 py-4'
              : 'grid min-h-0 flex-1 grid-rows-[1fr_auto_2fr] overflow-y-auto px-6 py-6'
          }
        >
          <EmptyState
            icon={<Info className="text-fg-muted size-4" />}
            message={
              ownerMissing
                ? t('remoteConversation.sourceNodeMissing')
                : (errorMessage ?? t('remoteConversation.loading'))
            }
            action={
              entry?.error && !ownerMissing ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  {t('remoteConversation.retry')}
                </Button>
              ) : undefined
            }
            className="[&_p]:text-fg-muted row-start-2 min-w-0 py-0 [overflow-wrap:anywhere]"
          />
        </div>
      ) : null}
      {showChat || loadMissingHistory ? (
        <div
          hidden={!showChat}
          className="min-h-0 flex-1"
          onDragStartCapture={(event) => {
            if (!remote && !unavailable) return;
            // Native image/link drags bypass individual Canvas action controls.
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <ChatPanel
            {...props}
            session={session}
            ownerUnavailable={unavailable}
          />
        </div>
      ) : null}
    </div>
  );
}
