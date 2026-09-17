// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import { Button } from './Button';
import { cn } from './cn';
import { TextInput } from './TextInput';

interface InlineEditableTitleProps {
  title: string;
  placeholder: string;
  ariaLabel: string;
  /** Host layout adjustments, shared by display and editing states. */
  className?: string;
  /** Fill the host title slot, or size to content beside inline status controls. */
  width?: 'content' | 'fill';
  /** Omit for a non-interactive title. Persistence remains caller-owned. */
  editor?: {
    active: boolean;
    draft: string;
    disabled?: boolean;
    maxLength?: number;
    onStart: () => void;
    onChange: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  };
}

const TITLE_STYLE =
  'max-w-full min-w-0 shrink rounded border border-solid border-transparent px-1 py-0.5 text-sm font-normal';

/** Shared inline title presentation and input gestures, without data-store policy. */
export function InlineEditableTitle({
  title,
  placeholder,
  ariaLabel,
  className,
  width = 'content',
  editor,
}: InlineEditableTitleProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const active = editor?.active ?? false;

  useEffect(() => {
    settled.current = false;
    if (!active) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [active]);

  if (editor?.active) {
    const commit = () => {
      // Enter can be followed by blur before the controlled field unmounts.
      if (settled.current) return;
      settled.current = true;
      editor.onCommit();
    };
    return (
      <TextInput
        ref={inputRef}
        size="md"
        value={editor.draft}
        maxLength={editor.maxLength}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cn(
          TITLE_STYLE,
          'border-edge-default w-64 basis-auto truncate',
          width === 'fill' && 'w-full flex-1',
          className,
        )}
        onChange={(event) => editor.onChange(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            settled.current = true;
            editor.onCancel();
          }
        }}
      />
    );
  }

  if (!editor) {
    return (
      <span
        className={cn(
          TITLE_STYLE,
          'text-fg-muted truncate',
          width === 'fill' && 'w-full flex-1',
          className,
        )}
        title={title}
      >
        {title || placeholder}
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      title={title || placeholder}
      aria-label={ariaLabel}
      tooltipPlacement="bottom"
      tooltipWrapperClassName={cn(
        'inline-flex max-w-full min-w-0 shrink basis-auto',
        width === 'fill' && 'flex-1',
      )}
      className={cn(
        TITLE_STYLE,
        'hover:text-fg-default basis-auto cursor-text justify-start',
        width === 'fill' && 'w-full',
        className,
      )}
      disabled={editor.disabled}
      onClick={editor.onStart}
    >
      <span className="max-w-full min-w-0 truncate">
        {title || placeholder}
      </span>
    </Button>
  );
}
