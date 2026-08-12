// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/Common/Tooltip';
import { useChatSession } from '@/hooks/useChatSession';
import useCanvasStore from '@/store/canvasStore';
import { isHeadlessConversation } from '@/store/conversationOwner';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

/**
 * Compact indicator showing how many canvas nodes are currently selected.
 * Displayed next to the send button so the user knows which nodes will
 * be included as context in the conversation.
 * Hovering reveals the names of the selected nodes.
 */
export const SourceCount = () => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  // Stage-2 stroke selection lives outside ReactFlow node selection
  // (gesturePreviewStore). A sketch with a partial stroke selection is
  // still sent as a context source, so it must be counted here too.
  const strokeSelection = useGesturePreviewStore(
    (s) => s.sketchStrokeSelection,
  );
  // The question node whose conversation is currently open. That node is
  // the subject of this very thread, so selecting it should not add it as
  // a context source — exclude it from both the count and the tooltip.
  const session = useChatSession();
  const viewingQuestionNodeId =
    session.conversationView?.conversationOwner.nodeId;
  const headlessConversation = isHeadlessConversation(session.conversationView);

  const selectedNodes = useMemo(() => {
    if (headlessConversation) return [];
    const nodeSelected = nodes.filter(
      (n) => n.selected && n.id !== viewingQuestionNodeId,
    );
    const seen = new Set(nodeSelected.map((n) => n.id));
    const result = [...nodeSelected];
    // Fold in sketch nodes carrying a partial stroke selection.
    for (const [nodeId, strokeIds] of Object.entries(strokeSelection)) {
      if (!strokeIds || strokeIds.length === 0) continue;
      if (seen.has(nodeId) || nodeId === viewingQuestionNodeId) continue;
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        result.push(node);
        seen.add(nodeId);
      }
    }
    return result;
  }, [headlessConversation, nodes, strokeSelection, viewingQuestionNodeId]);

  const count = selectedNodes.length;

  if (count === 0) return null;

  const tooltipContent = (
    <div className="flex flex-col gap-0.5">
      {selectedNodes.map((n) => {
        const label = (n.data as Record<string, unknown> | undefined)?.label as
          | string
          | undefined;
        return (
          <span key={n.id} className="text-xs">
            {label || n.type || t('node.untitled')}
          </span>
        );
      })}
    </div>
  );

  const sourceNames = selectedNodes
    .map((n) => {
      const label = (n.data as Record<string, unknown> | undefined)?.label as
        | string
        | undefined;
      return label || n.type || t('node.untitled');
    })
    .join(', ');
  const accessibleLabel = t('chat.selectedSourcesLabel', {
    count,
    sources: sourceNames,
  });

  return (
    <Tooltip content={tooltipContent}>
      <span
        // Focusable, non-interactive tooltip target (Tooltip wires
        // aria-describedby) — the W3C tooltip pattern.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={accessibleLabel}
        className="text-fg-muted inline-flex cursor-default items-center gap-1 text-sm leading-tight focus:outline-none"
      >
        <span>{count}</span>
        <span>{t('chat.sourceLabel', { count })}</span>
      </span>
    </Tooltip>
  );
};
