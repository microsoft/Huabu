// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, MessageSquare, Quote } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';
import { TextInput } from '@/components/Common/TextInput';
import { NODE_ICON } from '@/config/nodeIcons';

import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';

interface FragmentCommentPopoverProps {
  selection: MilkdownPreviewSelection;
  onBegin: () => void;
  onAdd: (comment: string) => void;
  onCopy: () => Promise<void>;
  onSaveAsNote: () => void;
  onDismiss: () => void;
}

export function FragmentCommentPopover({
  selection,
  onBegin,
  onAdd,
  onCopy,
  onSaveAsNote,
  onDismiss,
}: FragmentCommentPopoverProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [copyError, setCopyError] = useState(false);
  const [copying, setCopying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const NoteIcon = NODE_ICON.note;

  return (
    <Popover
      position={selection.position}
      offset={{ x: 4, y: 8 }}
      onDismiss={onDismiss}
      className={editing ? 'w-80 p-3' : 'p-1'}
      onOpenAutoFocus={
        editing
          ? () => inputRef.current?.focus({ preventScroll: true })
          : undefined
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) onAdd(comment);
          }}
        >
          <figure className="bg-hover flex min-w-0 items-start gap-2 rounded-md p-2">
            <figcaption className="text-fg-subtle mt-0.5 shrink-0">
              <Quote aria-hidden="true" className="h-3 w-3" />
              <span className="sr-only">
                {t('messages.fragmentQuotedPassage')}
              </span>
            </figcaption>
            <blockquote className="text-fg-muted max-h-24 min-w-0 flex-1 overflow-auto overscroll-contain text-xs wrap-anywhere whitespace-pre-wrap">
              {selection.text.trim()}
            </blockquote>
          </figure>
          <TextInput
            ref={inputRef}
            aria-label={t('messages.fragmentComment')}
            placeholder={t('messages.fragmentCommentPlaceholder')}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) {
                event.preventDefault();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {t('actions.cancel')}
            </Button>
            <Button size="sm" type="submit" disabled={!comment.trim()}>
              {t('messages.addCommentToInput')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={t('messages.copy')}
              disabled={copying}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onBegin();
                setCopyError(false);
                setCopying(true);
                void onCopy()
                  .then(onDismiss)
                  .catch(() => setCopyError(true))
                  .finally(() => setCopying(false));
              }}
            >
              <Copy />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={t('messages.addAsNote')}
              disabled={copying}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onSaveAsNote}
            >
              <NoteIcon />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={t('messages.fragmentComment')}
              disabled={copying}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onBegin();
                setEditing(true);
              }}
            >
              <MessageSquare />
            </Button>
          </div>
          {copyError ? (
            <p role="alert" className="text-danger px-2 py-1 text-xs">
              {t('messages.fragmentCopyFailed')}
            </p>
          ) : null}
        </>
      )}
    </Popover>
  );
}
