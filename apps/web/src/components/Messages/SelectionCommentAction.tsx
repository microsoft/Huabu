// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { MessageSquare } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { InkAgentDestinationPicker } from '@/components/Panels/Canvas/FloatingToolbars/InkAgentDestinationPicker';
import { useAcpProfiles } from '@/hooks/useAcpProfiles';
import {
  resolveCommentDestination,
  useCommentDestination,
} from '@/hooks/useCommentDestination';
import { rememberConversationAgentBinding } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import {
  conversationViewForNode,
  resolveConversationOwnerSource,
} from '@/store/conversationOwner';
import { createConversation } from '@/store/conversationPreparation';
import { usePanelStore } from '@/store/panelStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { FragmentCommentPopover } from './AIMessage/FragmentCommentPopover';

import type { InkAgentConversationOption } from '@/components/Panels/Canvas/FloatingToolbars/InkAgentDestinationPicker';
import type { AgentChoice } from '@/components/Panels/ChatPanel/agentMenu';
import type { QuotedComment } from '@huabu/shared';

import '@/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css';

export function SelectionCommentAction({
  canvasId,
  threadId,
  capture,
  onDismiss,
  onEditingChange,
}: {
  canvasId: string;
  threadId?: string;
  capture: () => Omit<QuotedComment, 'comment'> | null;
  onDismiss: () => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{
    quote: Omit<QuotedComment, 'comment'>;
    position: { x: number; y: number };
  } | null>(null);
  const staged = useRef(false);
  const dismiss = () => {
    setSnapshot(null);
    onEditingChange(false);
    onDismiss();
  };
  if (snapshot) {
    const props = {
      selection: {
        text: snapshot.quote.quote,
        contextBefore: snapshot.quote.contextBefore,
        contextAfter: snapshot.quote.contextAfter,
        position: snapshot.position,
      },
      onDismiss: dismiss,
    };
    return threadId ? (
      <FragmentCommentPopover
        {...props}
        onAdd={(comment) => {
          if (!comment.trim() || staged.current) return;
          if (useCanvasStore.getState().pendingForkThreadIds[threadId]) {
            toast(t('messages.commentDestinationUnavailable'), {
              tone: 'warning',
            });
            return;
          }
          staged.current = true;
          useChatStore
            .getState()
            .addQuotedComment(threadId, { ...snapshot.quote, comment });
          dismiss();
          usePanelStore.getState().requestFocusChatInput(threadId);
        }}
      />
    ) : (
      <DocumentCommentEditor
        canvasId={canvasId}
        quote={snapshot.quote}
        position={snapshot.position}
        onDismiss={dismiss}
      />
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      title={t('messages.commentSelection')}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        const quote = capture();
        if (!quote) {
          toast(t('messages.commentSelectionUnavailable'), { tone: 'warning' });
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        staged.current = false;
        setSnapshot({ quote, position: { x: rect.left, y: rect.bottom } });
        onEditingChange(true);
      }}
    >
      <MessageSquare />
    </Button>
  );
}

function DocumentCommentEditor({
  canvasId,
  quote,
  position,
  onDismiss,
}: {
  canvasId: string;
  quote: Omit<QuotedComment, 'comment'>;
  position: { x: number; y: number };
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const target = useCommentDestination(canvasId);
  const staged = useRef(false);
  const [newChoice, setNewChoice] = useState<AgentChoice | null>(null);
  const profiles = useAcpProfiles();
  const nodes = useCanvasStore((state) => state.nodes);
  const [error, setError] = useState(false);
  const conversations: InkAgentConversationOption[] = target.candidates.flatMap(
    (item) => {
      const node = nodes.find((entry) => entry.id === item.nodeId);
      if (!node || node.type !== 'question') return [];
      const source = resolveConversationOwnerSource(
        canvasId,
        nodes,
        conversationViewForNode(node, canvasId),
      );
      return [
        {
          nodeId: item.nodeId,
          title: item.title || t('messages.commentUntitledDestination'),
          binding: source?.agentBinding ?? { kind: 'internal' },
          mode: source?.agentMode ?? 'ask',
          fallbackIcon: source?.agentIcon,
          disabledReason: item.available
            ? undefined
            : {
                kind: 'unavailable' as const,
                message: t('messages.commentDestinationUnavailable'),
              },
        },
      ];
    },
  );
  const unavailable = !!target.destination && !target.available;
  const issue = target.error || profiles.error;

  function rejectDestination() {
    setError(true);
    toast(t('messages.commentDestinationUnavailable'), { tone: 'warning' });
  }

  function stage(comment: string) {
    if (!comment.trim() || staged.current) return;
    const destination = target.destination;
    const agentChoice = newChoice;
    const canvas = useCanvasStore.getState();
    const profileId =
      agentChoice?.binding.kind === 'external'
        ? agentChoice.binding.profileId
        : null;
    if (
      canvas.canvasId !== canvasId ||
      (!destination &&
        (!agentChoice ||
          (profileId !== null &&
            (profiles.error ||
              !profiles.loaded ||
              !profiles.profiles.some((profile) => profile.id === profileId)))))
    ) {
      rejectDestination();
      return;
    }
    let threadId = destination?.threadId;
    const view = resolveCommentDestination(canvasId, destination);
    if (destination && !view) {
      rejectDestination();
      return;
    }
    if (!threadId) {
      if (!agentChoice) {
        rejectDestination();
        return;
      }
      threadId = createConversation({ canvasId, ...agentChoice });
      rememberConversationAgentBinding(agentChoice.binding);
    }
    useChatStore.getState().addQuotedComment(threadId, { ...quote, comment });
    staged.current = true;
    onDismiss();
    if (view) {
      usePanelStore.getState().requestOpenRightPanel();
      const preview = usePreviewWorkspaceStore.getState();
      const tabId = preview.openPreviewTarget(
        {
          kind: 'conversation',
          canvasId,
          nodeId: view.conversationOwner.nodeId,
          threadId,
        },
        { openToSide: true },
      );
      preview.requestChatOpen(tabId, 'bottom');
    } else {
      usePanelStore.getState().requestOpenRightPanel();
      usePreviewWorkspaceStore
        .getState()
        .openPreviewTarget(
          { kind: 'chat', canvasId, threadId },
          { openToSide: true },
        );
    }
    usePanelStore.getState().requestFocusChatInput(threadId);
  }

  return (
    <FragmentCommentPopover
      selection={{
        text: quote.quote,
        contextBefore: quote.contextBefore,
        contextAfter: quote.contextAfter,
        position,
      }}
      onDismiss={onDismiss}
      onAdd={stage}
      addDisabled={
        target.loading || unavailable || (!target.destination && !newChoice)
      }
    >
      <InkAgentDestinationPicker
        binding={newChoice?.binding ?? null}
        mode={newChoice?.mode ?? 'operate'}
        profiles={profiles.profiles}
        conversations={conversations}
        selectedNodeId={target.destination?.nodeId}
        unresolved={target.loading || (!target.destination && !newChoice)}
        loading={target.loading}
        builtInModes={['operate', 'ask']}
        menuLabel={t('messages.commentDestination')}
        unavailableReason={
          issue || unavailable || error
            ? {
                kind: 'unavailable',
                message: issue
                  ? t('messages.commentDestinationFailed')
                  : t('messages.commentDestinationUnavailable'),
              }
            : undefined
        }
        onNewConversation={(next) => {
          target.choose(null);
          setNewChoice(next);
          setError(false);
        }}
        onContinueConversation={(nodeId) => {
          const item = target.candidates.find(
            (entry) => entry.nodeId === nodeId,
          );
          if (item) {
            target.choose({ nodeId, threadId: item.threadId });
            setNewChoice(null);
            setError(false);
          } else rejectDestination();
        }}
        onRefreshProfiles={() => {
          if (target.error) target.retry();
          return profiles.refresh();
        }}
      />
    </FragmentCommentPopover>
  );
}
