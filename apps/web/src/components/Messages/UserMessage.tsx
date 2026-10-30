// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PenLine, Shapes } from 'lucide-react';
import { memo, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isCanvasIntent } from '@huabu/shared';

import { cn } from '@/components/Common/cn';
import { NodeRef } from '@/components/Nodes/NodeRef/NodeRef';
import { useOptionalChatSession } from '@/hooks/useChatSession';
import { useSearchSource } from '@/hooks/useSearchSource';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { QuotedCommentCard } from './QuotedCommentCard';

import type {
  AgentInputKind,
  ChatAttachment,
  InkInterpretation,
  SelectedStrokeSubset,
  QuotedComment,
} from '@huabu/shared';

interface UserMessageProps {
  content: string;
  isFirst?: boolean;
  quotedComments?: QuotedComment[];
  inputKind?: AgentInputKind;
  inkInterpretation?: InkInterpretation;
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

export const UserMessage = memo(function UserMessage({
  content,
  isFirst = false,
  quotedComments,
  inputKind,
  inkInterpretation,
  attachments,
  selectedNodeIds,
  selectedStrokeIds,
  invokedSkills,
}: UserMessageProps) {
  const { t } = useTranslation();
  const session = useOptionalChatSession();
  const remote = session && session.ownerCanvasId !== session.canvasId;
  const contentRef = useRef<HTMLSpanElement>(null);
  const interpretationRef = useRef<HTMLSpanElement>(null);
  useSearchSource(contentRef, content, 'text');
  useSearchSource(
    interpretationRef,
    inkInterpretation?.state === 'reported' ? inkInterpretation.text : '',
    'text',
  );
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
  const canvasIntent = isCanvasIntent(inputKind);
  const RequestIcon = inputKind === 'selection-intent' ? Shapes : PenLine;
  const interpretationKey =
    inputKind === 'selection-intent'
      ? 'messages.selectionInterpretation'
      : 'messages.inkInterpretation';

  return (
    <div
      data-chat-user-message
      className={cn('my-3 flex flex-col items-end', isFirst && 'mt-0')}
    >
      <div
        className={cn(
          'flex max-w-[80%] min-w-0 flex-col items-end gap-1',
          !isFirst && 'mt-2',
          quotedComments?.length && 'w-full',
        )}
      >
        {quotedComments?.length ? (
          <div className="flex w-full min-w-0 flex-col gap-2">
            {quotedComments.map((comment, index) => (
              <QuotedCommentCard key={index} comment={comment} />
            ))}
          </div>
        ) : null}
        {content || canvasIntent || hasSkills || !quotedComments?.length ? (
          <div className="bg-bg-default text-fg-default overflow-hidden rounded-md border border-none px-4 py-2 text-sm">
            <div className="leading-relaxed wrap-anywhere whitespace-pre-wrap">
              {canvasIntent && (
                <RequestIcon
                  className="mr-1.5 inline-block size-3.5 align-text-bottom"
                  role="img"
                  aria-label={t(
                    inputKind === 'selection-intent'
                      ? 'messages.selectionRequest'
                      : 'messages.inkRequest',
                  )}
                />
              )}
              {canvasIntent && (
                <span
                  ref={interpretationRef}
                  data-ink-interpretation
                  aria-description={t(`${interpretationKey}.agent`)}
                  role={
                    inkInterpretation?.state === 'reported'
                      ? undefined
                      : 'status'
                  }
                >
                  {inkInterpretation?.state === 'reported'
                    ? inkInterpretation.text
                    : t(
                        `${interpretationKey}.${inkInterpretation?.state ?? 'legacy'}`,
                      )}
                </span>
              )}
              {canvasIntent && hasSkills ? ' ' : null}
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
              {canvasIntent && content ? ' ' : null}
              {content && (
                <span ref={contentRef} data-chat-prompt-content>
                  {content}
                </span>
              )}
            </div>
          </div>
        ) : null}
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
                  onMouseEnter={() => {
                    if (!remote) setStrokeHighlight({ [id]: strokeIds });
                  }}
                  onMouseLeave={() => {
                    if (!remote) clearStrokeHighlight();
                  }}
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
});
