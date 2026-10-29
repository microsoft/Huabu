// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';
import { TextArea } from '@/components/Common/TextArea';
import { useAutoSizeTextArea } from '@/hooks/useAutoSizeTextArea';

import { FragmentSelectionActions } from './FragmentSelectionActions';

import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';
import type { ReactNode } from 'react';

export type FragmentCommentSelection = Pick<
  MilkdownPreviewSelection,
  'text' | 'contextBefore' | 'contextAfter' | 'position'
>;

interface FragmentCommentPopoverProps {
  selection: FragmentCommentSelection;
  onBegin: () => void;
  onAdd: (comment: string) => void;
  onCopy: () => Promise<void>;
  onSaveAsNote: () => void;
  onDismiss: () => void;
  initialMode?: 'actions' | 'comment';
  children?: ReactNode;
  addDisabled?: boolean;
  canvasActionsDisabled?: boolean;
}

export function FragmentCommentPopover({
  selection,
  onBegin,
  onAdd,
  onCopy,
  onSaveAsNote,
  onDismiss,
  initialMode = 'actions',
  children,
  addDisabled = false,
  canvasActionsDisabled = false,
}: FragmentCommentPopoverProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(initialMode === 'comment');
  const [comment, setComment] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoSizeTextArea(inputRef, comment, editing);

  return (
    <Popover
      position={selection.position}
      offset={{ x: 4, y: 8 }}
      onDismiss={onDismiss}
      className={editing ? 'w-80 rounded-lg p-3' : 'p-1'}
      onOpenAutoFocus={
        editing
          ? () => inputRef.current?.focus({ preventScroll: true })
          : undefined
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim() && !addDisabled) onAdd(comment);
          }}
        >
          <figure className="bg-hover/60 min-w-0 rounded-md px-2 py-1.5">
            <figcaption className="sr-only">
              {t('messages.fragmentQuotedPassage')}
            </figcaption>
            <blockquote className="border-edge-default text-fg-muted max-h-24 min-w-0 overflow-auto overscroll-contain border-l-2 pl-2 text-xs wrap-anywhere whitespace-pre-wrap">
              {selection.text.trim()}
            </blockquote>
          </figure>
          {children}
          <div className="relative">
            <TextArea
              ref={inputRef}
              rows={2}
              className="focus:border-info block max-h-[calc(6lh+0.875rem)] min-h-[calc(2lh+0.875rem)] w-full resize-none overflow-y-auto overscroll-contain pr-9 focus:ring-0"
              aria-label={t('messages.fragmentComment')}
              placeholder={t('messages.fragmentCommentPlaceholder')}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.shiftKey) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              shape="pill"
              iconOnly
              type="submit"
              title={t('messages.addCommentToInput')}
              tooltipWrapperClassName="absolute right-1 bottom-1"
              disabled={!comment.trim() || addDisabled}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
        </form>
      ) : (
        <FragmentSelectionActions
          onCopy={() => {
            onBegin();
            return onCopy();
          }}
          onCopied={onDismiss}
          onSaveAsNote={onSaveAsNote}
          saveAsNoteDisabled={canvasActionsDisabled}
          saveAsNoteTitle={
            canvasActionsDisabled
              ? t('remoteConversation.canvasAction')
              : undefined
          }
          onComment={() => {
            onBegin();
            setEditing(true);
          }}
        />
      )}
    </Popover>
  );
}
