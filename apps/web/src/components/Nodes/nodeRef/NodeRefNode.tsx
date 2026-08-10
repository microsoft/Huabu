// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pin } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import useCanvasStore from '@/store/canvasStore';
import {
  ConversationIntegrityError,
  conversationViewFromWorldReference,
  patchConversationOwnerNode,
  refreshConversationPresentation,
} from '@/store/conversationOwner';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import type { NodeRefNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type NodeRefNodeType = Node<NodeRefNodeData, 'nodeRef'>;

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export const NodeRefNode = memo(
  ({ id, data, selected }: NodeProps<NodeRefNodeType>) => {
    const { t } = useTranslation();
    const resolved = useCanvasStore((state) => state.worldReferences[id]);
    const resolutionError = useCanvasStore(
      (state) => state.worldReferenceError,
    );
    const source = resolved?.kind === 'nodeRef' ? resolved.source : undefined;
    const status = resolved?.kind === 'nodeRef' ? resolved.status : undefined;
    const canvasId = useCanvasStore((state) => state.canvasId);
    const refreshWorldReferences = useCanvasStore(
      (state) => state.refreshWorldReferences,
    );
    const canOpenConversation = status === 'ok' && source?.type === 'question';

    const openConversation = useCallback(async () => {
      if (!canOpenConversation) return;
      const presentationCanvasId = canvasId;
      await refreshWorldReferences();
      const current = useCanvasStore.getState();
      const latest = current.worldReferences[id];
      if (
        current.canvasId !== presentationCanvasId ||
        latest?.kind !== 'nodeRef' ||
        latest.status !== 'ok' ||
        latest.target.canvasId !== data.target.canvasId ||
        latest.target.nodeId !== data.target.nodeId ||
        latest.source?.type !== 'question'
      ) {
        return;
      }
      let view;
      try {
        view = conversationViewFromWorldReference(
          presentationCanvasId,
          id,
          latest,
        );
      } catch (error) {
        if (error instanceof ConversationIntegrityError) {
          toast(t('world.conversationIntegrityError'), { tone: 'danger' });
          return;
        }
        throw error;
      }
      if (!view) return;
      openPreviewNode(id);

      if (
        (latest.source.status === 'done' || latest.source.status === 'error') &&
        !latest.source.viewed
      ) {
        try {
          await patchConversationOwnerNode(view, { viewed: true });
          await refreshConversationPresentation(view);
        } catch (error) {
          console.error(
            '[NodeRefNode] failed to mark conversation viewed',
            error,
          );
        }
      }
    }, [
      canOpenConversation,
      canvasId,
      data.target.canvasId,
      data.target.nodeId,
      id,
      refreshWorldReferences,
      t,
    ]);

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="nodeRef"
        selected={selected}
        onDoubleClick={() => void openConversation()}
      >
        <div className="flex h-full w-full flex-col justify-center gap-2 px-4">
          <div className="text-fg-muted flex items-center gap-2 text-sm font-medium">
            <Pin size={16} />
            {resolutionError
              ? t('world.loadFailed')
              : status === 'canvas-missing'
                ? t('world.missingSpace')
                : status === 'node-missing'
                  ? t('world.missingNode')
                  : source?.label || t('world.pinnedNode')}
          </div>
          <div className="text-fg-subtle truncate text-xs">
            {source
              ? `${source.type}${source.summary ? ` · ${source.summary}` : ''}`
              : shortId(data.target.nodeId)}
          </div>
          {canOpenConversation ? (
            <Button
              className="nodrag self-start"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                void openConversation();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {t('world.openConversation')}
            </Button>
          ) : null}
        </div>
      </NodeWrapper>
    );
  },
);

NodeRefNode.displayName = 'NodeRefNode';
