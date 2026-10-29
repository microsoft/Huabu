// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUpRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
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
  const key = conversationOwnerKey(
    target.canvasId,
    target.nodeId,
    target.threadId,
  );
  const entry = useRemoteConversationOwnerStore((state) => state.entries[key]);
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      await refreshConversationOwner(
        target.canvasId,
        target.nodeId,
        target.threadId,
      );
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
    owner?.spaceTitle?.trim() || t('spacePreview.untitledSpace');
  const errorMessage =
    entry?.errorCode === 'conversation_owner_missing' ||
    entry?.errorCode === 'missing_node_content'
      ? t('remoteConversation.sourceNodeUnavailable')
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
      {entry?.error ? (
        <div
          role="alert"
          className="text-danger flex flex-col items-start gap-2 p-3 text-sm"
        >
          <p>{errorMessage}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            {t('remoteConversation.retry')}
          </Button>
        </div>
      ) : null}
      {owner?.nodeId === target.nodeId && validatedKey === key ? (
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
      ) : !entry?.error ? (
        <div role="status" className="text-fg-muted p-3 text-sm">
          {t('remoteConversation.loading')}
        </div>
      ) : null}
    </div>
  );
}
