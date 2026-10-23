// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedOnPointerDown = useRef(false);
  const active = editor?.active ?? false;
  useEffect(() => {
    if (!active) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [active]);
  const text = (
    <span
      className={clamp ? 'line-clamp-2 min-w-0 wrap-anywhere' : 'min-w-0'}
      title={title}
    >
      {title}
    </span>
  );
  return (
    <div
      className="max-w-full min-w-0"
      onPointerDownCapture={() => {
        selectedOnPointerDown.current = !!selected;
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {editor?.active ? (
        <TextInput
          ref={inputRef}
          value={editor.draft}
          readOnly={editor.saving}
          maxLength={editor.maxLength}
          aria-label={renameLabel}
          aria-invalid={!!editor.error}
          className="nodrag nopan w-full min-w-0 p-0"
          style={{ font: 'inherit', lineHeight: 'inherit' }}
          onChange={(event) => editor.onChange(event.target.value)}
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
      ) : selected && editor ? (
        <Button
          variant="ghost"
          className="nodrag nopan text-fg-default h-auto min-w-0 justify-start p-0 text-left"
          tooltipWrapperClassName="min-w-0 max-w-full"
          style={{
            font: 'inherit',
            lineHeight: 'inherit',
            whiteSpace: 'inherit',
          }}
          title={renameLabel}
          aria-label={renameLabel}
          onClick={(event) => {
            if (selectedOnPointerDown.current || event.detail === 0)
              editor.onStart();
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
