// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { TextArea } from '@/components/Common/TextArea';

export interface CardTitleEditor {
  active: boolean;
  draft: string;
  saving: boolean;
  error?: string | null;
  maxLength?: number;
  onStart: () => void;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function CardTitle({
  title,
  selected,
  renameLabel,
  clamp = false,
  editor,
}: {
  title: string;
  selected?: boolean;
  renameLabel: string;
  clamp?: boolean;
  editor?: CardTitleEditor;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const selectedOnPointerDown = useRef(false);
  const selectedBeforeDoubleClick = useRef(false);
  const active = editor?.active ?? false;
  useEffect(() => {
    if (!active) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [active]);
  const text = (
    <span
      ref={textRef}
      className={clamp ? 'line-clamp-2 min-w-0 wrap-anywhere' : 'min-w-0'}
      title={title}
    >
      {title}
    </span>
  );
  return (
    <div
      className={cn('relative max-w-full min-w-0', active && 'flex-1')}
      onPointerDownCapture={() => {
        selectedOnPointerDown.current = !!selected;
      }}
      onClickCapture={(event) => {
        // Selection from the first click must not turn that same double-click into a rename.
        if (event.detail === 1)
          selectedBeforeDoubleClick.current = selectedOnPointerDown.current;
      }}
      onDoubleClick={(event) => {
        if (active) {
          event.stopPropagation();
          return;
        }
        const text = textRef.current;
        if (!editor || !selectedBeforeDoubleClick.current || !text) return;
        const range = document.createRange();
        range.selectNodeContents(text);
        const onText = [...range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        );
        if (!onText) return;
        event.preventDefault();
        event.stopPropagation();
        editor.onStart();
      }}
    >
      {editor?.active && (
        <TextArea
          ref={inputRef}
          rows={1}
          value={editor.draft}
          readOnly={editor.saving}
          maxLength={editor.maxLength}
          aria-label={renameLabel}
          aria-invalid={!!editor.error}
          className="nodrag nopan nowheel focus:border-info-light aria-invalid:focus:border-danger absolute inset-0 block h-full min-h-0 w-full min-w-0 resize-none overflow-x-hidden overflow-y-auto p-0 wrap-anywhere focus:ring-0"
          style={{ font: 'inherit', lineHeight: 'inherit' }}
          onChange={(event) =>
            editor.onChange(event.target.value.replace(/[\r\n]/g, ''))
          }
          onBlur={editor.onCommit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === 'Enter') {
              event.preventDefault();
              editor.onCommit();
            } else if (event.key === 'Escape' && !editor.saving) {
              event.preventDefault();
              editor.onCancel();
            }
          }}
        />
      )}
      {editor ? (
        <Button
          variant="ghost"
          className={cn(
            'text-fg-default h-auto min-w-0 justify-start p-0 text-left',
            active && 'invisible',
            selected
              ? 'nodrag nopan'
              : 'cursor-inherit enabled:hover:bg-transparent',
          )}
          tooltipWrapperClassName="min-w-0 max-w-full"
          style={{
            font: 'inherit',
            lineHeight: 'inherit',
            whiteSpace: 'inherit',
          }}
          title={renameLabel}
          aria-label={renameLabel}
          aria-hidden={active || undefined}
          tabIndex={selected && !active ? 0 : -1}
          onClick={(event) => {
            if (selected && event.detail === 0) editor.onStart();
          }}
        >
          {text}
        </Button>
      ) : (
        text
      )}
    </div>
  );
}
