// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { TextArea } from '@/components/Common/TextArea';
import { QuotedCommentCard } from '@/components/Messages/QuotedCommentCard';

import type { QuotedComment } from '@huabu/shared';

export function QuotedCommentDraft({
  comment,
  disabled,
  onChange,
  onRemove,
  onKeyboardEditEnd,
}: {
  comment: QuotedComment;
  disabled: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
  onKeyboardEditEnd: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const original = useRef(comment.comment);
  const settled = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const invalid = !comment.comment.trim();

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [editing]);

  const finishEditing = () => {
    if (settled.current || invalid) return;
    settled.current = true;
    const trimmed = comment.comment.trim();
    if (trimmed !== comment.comment) onChange(trimmed);
    setEditing(false);
  };

  return (
    <QuotedCommentCard
      comment={comment}
      action={
        <Button
          size="sm"
          variant="ghost"
          shape="pill"
          iconOnly
          className="bg-hover focus-visible:ring-info enabled:hover:bg-edge-default focus-visible:ring-1"
          title={t('messages.removeQuotedComment')}
          disabled={disabled}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      }
    >
      {editing ? (
        <>
          <TextArea
            ref={inputRef}
            aria-label={t('messages.fragmentComment')}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            autoComplete="off"
            name="quoted-comment"
            rows={Math.min(4, Math.max(2, comment.comment.split('\n').length))}
            className="w-full resize-y"
            placeholder={t('messages.fragmentCommentPlaceholder')}
            value={comment.comment}
            disabled={disabled}
            required
            onChange={(event) => onChange(event.target.value)}
            onBlur={finishEditing}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.shiftKey) return;
                event.preventDefault();
                finishEditing();
                if (!invalid) onKeyboardEditEnd();
              } else if (
                event.key === 'Escape' &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                settled.current = true;
                onChange(original.current);
                setEditing(false);
                onKeyboardEditEnd();
              }
            }}
          />
          {invalid ? (
            <p id={errorId} role="alert" className="text-danger text-xs">
              {t('messages.quotedCommentRequired')}
            </p>
          ) : null}
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('messages.editQuotedComment')}
          disabled={disabled}
          className="text-fg-default focus-visible:ring-info w-full justify-start px-0 py-0 text-left text-sm font-normal focus-visible:ring-1"
          onClick={() => {
            original.current = comment.comment;
            settled.current = false;
            setEditing(true);
          }}
        >
          <span className="min-w-0 wrap-anywhere whitespace-pre-wrap">
            {comment.comment || t('messages.fragmentCommentPlaceholder')}
          </span>
        </Button>
      )}
    </QuotedCommentCard>
  );
}
