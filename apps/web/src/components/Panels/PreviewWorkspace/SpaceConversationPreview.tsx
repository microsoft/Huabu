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
  conversationOwnerKey,
  refreshConversationOwner,
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const cachedSpaceTitle = useWorkspaceStore(
    (state) => state.spaceTitles[target.canvasId],
  );
  const key = conversationOwnerKey(
    target.canvasId,
    target.nodeId,
    target.threadId,
  );
  const entry = useRemoteConversationOwnerStore((state) => state.entries[key]);
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const workspaceId = useWorkspaceStore.getState().workspaceId;
    try {
      const owner = await refreshConversationOwner(
        target.canvasId,
        target.nodeId,
        target.threadId,
      );
      const workspace = useWorkspaceStore.getState();
      if (
        workspace.workspaceId === workspaceId &&
        workspace.spaceTitles[target.canvasId] !== owner.spaceTitle
      ) {
        workspace.setSpaceTitle(target.canvasId, owner.spaceTitle);
      }
      setValidatedKey(key);
    } catch (error) {
      // Transport failures retain the last validated view; invalid ownership does not.
      console.error('Unable to refresh the displayed Agent owner', error);
    }
  }, [key, target.canvasId, target.nodeId, target.threadId]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
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

  const owner = entry?.owner;
  const spaceTitle =
    owner?.spaceTitle?.trim() ||
    cachedSpaceTitle?.trim() ||
    (cachedSpaceTitle === undefined && !owner
      ? target.canvasId
      : t('spacePreview.untitledSpace'));
  const ownerMissing = entry?.errorCode === 'conversation_owner_missing';
  const showChat = owner?.nodeId === target.nodeId && validatedKey === key;
  const errorMessage =
    entry?.errorCode === 'missing_node_content'
      ? t('remoteConversation.sourceNodeContentUnavailable')
      : entry?.errorCode === 'canvas_not_found'
        ? t('remoteConversation.sourceSpaceUnavailable')
        : entry?.error;
  return (
    <div className="flex h-full min-h-0 flex-col">
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
      {!showChat || entry?.error ? (
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
      {showChat ? (
        <div
          className="min-h-0 flex-1"
          onDragStartCapture={(event) => {
            // Native image/link drags bypass individual Canvas action controls.
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <ChatPanel
            {...props}
            session={session}
            ownerUnavailable={!!entry?.error}
          />
        </div>
      ) : null}
    </div>
  );
}
