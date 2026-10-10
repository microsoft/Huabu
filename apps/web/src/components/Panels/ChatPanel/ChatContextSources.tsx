// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pin, Plus, X } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { Button } from '@/components/Common/Button';
import { NodeRef } from '@/components/Common/NodeRef';
import { Tooltip } from '@/components/Common/Tooltip';
import { useChatSession } from '@/hooks/useChatSession';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadPendingAttachments,
  useChatStore,
} from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { ChatAttachment, WireSelectionNode } from '@huabu/shared';

const chipSurfaceClassName =
  'bg-hover text-fg-muted group-focus-within/composer:bg-info-bg group-focus-within/composer:text-info transition-colors';
const chipActionClassName =
  'text-inherit group-focus-within/composer:enabled:hover:bg-info-bg-hover [&_svg]:h-3 [&_svg]:w-3';

function AttachmentSource({
  attachment,
  canvasId,
  onPin,
  onRemove,
}: {
  attachment: ChatAttachment;
  canvasId: string | null;
  onPin?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const isExcerpt = attachment.source === 'excerpt' && !!attachment.content;
  const preview = isExcerpt
    ? attachment.content
    : attachment.label || attachment.filename || attachment.content;
  const previewText = preview || t('chat.attachmentFallbackFile');
  const tooltipText = attachment.content || previewText;
  const previewContent = (
    <>
      {attachment.type === 'image' && attachment.url ? (
        <img
          src={resolveArtifactUrl(attachment.url, canvasId ?? undefined)}
          alt={attachment.label ?? t('chat.attachedImageAlt')}
          className="h-4 w-4 shrink-0 rounded object-contain"
        />
      ) : null}
      <span className="max-w-32 min-w-0 truncate text-xs">{previewText}</span>
    </>
  );

  return (
    <div
      data-context-attachment
      className={`${chipSurfaceClassName} flex h-6 max-w-40 min-w-0 shrink-0 items-center rounded-md`}
    >
      {!onPin ? (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          title={t('chat.removeAttachment')}
          tooltipWrapperClassName="shrink-0"
          className={chipActionClassName}
          onClick={onRemove}
        >
          <X />
        </Button>
      ) : null}
      <Tooltip
        wrapperClassName="min-w-0"
        content={
          <div className="flex max-w-80 flex-col gap-1">
            {attachment.originNodeId ? (
              <div className="flex items-center gap-1">
                <span>{t('chat.attachmentSource')}</span>
                <span className="[&_[role=button]]:text-fg-inverse [&_[role=button]]:border-fg-inverse/30">
                  <NodeRef nodeId={attachment.originNodeId} />
                </span>
              </div>
            ) : null}
            <span className="break-words whitespace-pre-wrap">
              {tooltipText.length > 240
                ? `${tooltipText.slice(0, 240)}…`
                : tooltipText}
            </span>
            {isExcerpt ? (
              <span className="opacity-70">
                {t(
                  onPin ? 'chat.lockSelectionAttachment' : 'chat.pinnedExcerpt',
                )}
              </span>
            ) : null}
          </div>
        }
      >
        {onPin ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('chat.lockSelectionAttachment')}
            className={`${chipActionClassName} h-6 max-w-full min-w-0 justify-start gap-1 px-1.5 py-0`}
            onClick={onPin}
          >
            <Pin aria-hidden className="rotate-45" />
            {previewContent}
          </Button>
        ) : (
          <div className="flex h-6 min-w-0 items-center gap-1 pr-1.5">
            {previewContent}
          </div>
        )}
      </Tooltip>
    </div>
  );
}

export const ChatContextSources = memo(function ChatContextSources({
  adjacentNodeSourceId,
  onCommit,
}: {
  adjacentNodeSourceId?: string;
  onCommit?: () => void;
}) {
  const { t } = useTranslation();
  const { threadId, canvasId, conversationView } = useChatSession();
  const nodes = useCanvasStore((s) => s.nodes);
  const activeCanvasId = useCanvasStore((s) => s.canvasId);
  const getAgentChatContext = useCanvasStore((s) => s.getAgentChatContext);
  const strokeSelection = useGesturePreviewStore(
    (s) => s.sketchStrokeSelection,
  );
  const pendingAttachments = useChatStore((s) =>
    selectThreadPendingAttachments(s, threadId),
  );
  const selectionAttachment = useChatStore((s) => s.selectionAttachment);
  const addPendingAttachment = useChatStore((s) => s.addPendingAttachment);
  const removePendingAttachment = useChatStore(
    (s) => s.removePendingAttachment,
  );
  const setSelectionAttachment = useChatStore((s) => s.setSelectionAttachment);
  const anchorNodeId = conversationView?.conversationOwner.nodeId;
  const selectedNodes = useMemo(() => {
    if (activeCanvasId !== canvasId) return [];
    const context = getAgentChatContext({
      nodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
      strokeSelection,
      excludeNodeIds: anchorNodeId ? [anchorNodeId] : [],
    });
    const unique = new Map<string, WireSelectionNode>();
    const visit = (selection: WireSelectionNode[]) => {
      for (const node of selection) {
        unique.set(node.id, node);
        if (node.children) visit(node.children);
      }
    };
    visit(context.selectedNodes);
    return [...unique.values()];
  }, [
    activeCanvasId,
    canvasId,
    getAgentChatContext,
    nodes,
    strokeSelection,
    anchorNodeId,
  ]);
  const adjacentNode =
    activeCanvasId === canvasId
      ? nodes.find((node) => node.id === adjacentNodeSourceId)
      : undefined;
  const adjacentNodeLabel =
    typeof adjacentNode?.data.label === 'string' && adjacentNode.data.label
      ? adjacentNode.data.label
      : t('node.untitled');
  const showCandidate =
    adjacentNode &&
    !selectedNodes.some((node) => node.id === adjacentNode.id) &&
    !pendingAttachments.some(
      (attachment) =>
        attachment.originNodeId === adjacentNode.id &&
        !attachment.content &&
        !attachment.url,
    );
  const hasAttachments = !!selectionAttachment || pendingAttachments.length > 0;
  const hasIncludedSources = hasAttachments || selectedNodes.length > 0;
  if (!hasIncludedSources && !showCandidate) return null;

  return (
    <div
      data-chat-context-sources
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1"
    >
      {hasAttachments ? (
        <div
          role="group"
          aria-label={t('chat.includedWithMessage')}
          className="contents"
        >
          {selectionAttachment ? (
            <AttachmentSource
              attachment={selectionAttachment}
              canvasId={canvasId}
              onPin={() => {
                addPendingAttachment(threadId, { ...selectionAttachment });
                setSelectionAttachment(null);
                onCommit?.();
              }}
              onRemove={() => setSelectionAttachment(null)}
            />
          ) : null}
          {pendingAttachments.map((attachment, index) => (
            <AttachmentSource
              key={index}
              attachment={attachment}
              canvasId={canvasId}
              onRemove={() => {
                removePendingAttachment(threadId, index);
                onCommit?.();
              }}
            />
          ))}
        </div>
      ) : null}
      {showCandidate ? (
        <Button
          variant="ghost"
          size="sm"
          title={t('chat.addNodeSource', { name: adjacentNodeLabel })}
          aria-label={t('chat.addNodeSource', { name: adjacentNodeLabel })}
          tooltipWrapperClassName="max-w-40 min-w-0"
          className={`${chipSurfaceClassName} group-focus-within/composer:enabled:hover:bg-info-bg-hover h-6 max-w-full justify-start gap-1 px-1.5 py-0 [&_svg]:h-3 [&_svg]:w-3`}
          onClick={() => {
            addPendingAttachment(threadId, {
              type: 'text',
              source: 'selection',
              originNodeId: adjacentNode.id,
              label:
                typeof adjacentNode.data.label === 'string'
                  ? adjacentNode.data.label
                  : t('chat.attachmentFallbackText'),
            });
            onCommit?.();
          }}
        >
          <Plus aria-hidden />
          <span className="max-w-32 truncate">{adjacentNodeLabel}</span>
        </Button>
      ) : null}
      {selectedNodes.length > 0 ? (
        <Tooltip
          wrapperClassName="inline-flex max-w-40 min-w-0"
          content={
            <div className="flex max-w-80 flex-col gap-0.5">
              {selectedNodes.map((node) => (
                <span key={node.id} className="truncate">
                  {node.label || node.type || t('node.untitled')}
                </span>
              ))}
            </div>
          }
        >
          <span
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label={t('chat.selectedSourcesLabel', {
              count: selectedNodes.length,
              sources: selectedNodes
                .map((node) => node.label || node.type)
                .join(', '),
            })}
            className={`${chipSurfaceClassName} inline-flex h-6 max-w-full items-center rounded-md px-1.5 text-xs whitespace-nowrap`}
          >
            <span className="truncate">
              {t('chat.selectedNodes', { count: selectedNodes.length })}
            </span>
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
});
