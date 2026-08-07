// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { NodeRef } from '../Common/NodeRef';

import type { ChatAttachment, SelectedStrokeSubset } from '@huabu/shared';

interface UserMessageProps {
  content: string;
  attachments?: ChatAttachment[];
  selectedNodeIds?: string[];
  /**
   * Per-sketch-node partial stroke selections sent with this message.
   * Used to annotate the matching node chip with its stroke count so it
   * reads as a subset rather than the whole node.
   */
  selectedStrokeIds?: SelectedStrokeSubset[];
  /**
   * Skill ids the user explicitly invoked via leading `/<id>` tokens.
   * The tokens are stripped from `content` at submit time (see
   * `parseSlashInvocations`) so the message body stays clean for the
   * agent; we re-render them here as chips so the invocation remains
   * visible in the chat history.
   */
  invokedSkills?: string[];
}

export const UserMessage = ({
  content,
  attachments,
  selectedNodeIds,
  selectedStrokeIds,
  invokedSkills,
}: UserMessageProps) => {
  const { t } = useTranslation();
  const setStrokeHighlight = useGesturePreviewStore(
    (s) => s.setSketchStrokeHighlight,
  );
  const clearStrokeHighlight = useGesturePreviewStore(
    (s) => s.clearSketchStrokeHighlight,
  );
  const strokeIdsByNode = useMemo(
    () =>
      new Map((selectedStrokeIds ?? []).map((s) => [s.nodeId, s.strokeIds])),
    [selectedStrokeIds],
  );
  const hasRefs =
    (attachments && attachments.length > 0) ||
    (selectedNodeIds && selectedNodeIds.length > 0);
  const hasSkills = !!invokedSkills && invokedSkills.length > 0;

  return (
    <div data-chat-user-message className="my-3 flex flex-col items-end">
      <div className="mt-2 flex max-w-[80%] flex-col items-end gap-1">
        <div className="bg-bg-default text-fg-default overflow-hidden rounded-md border border-none px-4 py-2 text-sm">
          <div className="leading-relaxed wrap-anywhere whitespace-pre-wrap">
            {hasSkills &&
              invokedSkills.map((id) => (
                <span
                  key={id}
                  className="mr-1 font-mono"
                  title={t('messages.invokedSkill', { id })}
                >
                  /{id}
                </span>
              ))}
            {content}
          </div>
        </div>
      </div>

      {hasRefs && (
        <div className="mt-1 flex w-full items-stretch justify-end gap-2">
          {/* Left: node refs */}
          <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
            {attachments?.map((att, i) => (
              <NodeRef key={att.url ?? `att-${i}`} attachment={att} />
            ))}
            {selectedNodeIds?.map((id) => {
              const strokeIds = strokeIdsByNode.get(id);
              if (!strokeIds) return <NodeRef key={id} nodeId={id} />;
              // Hovering a partial-stroke chip highlights just those
              // strokes on the canvas (best-effort: SketchNode only paints
              // ids still present, so erased strokes / deleted nodes no-op).
              return (
                <span
                  key={id}
                  onMouseEnter={() => setStrokeHighlight({ [id]: strokeIds })}
                  onMouseLeave={() => clearStrokeHighlight()}
                >
                  <NodeRef nodeId={id} strokeCount={strokeIds.length} />
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
