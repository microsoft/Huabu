// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { cn } from '@/components/Common/cn';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { Popover } from '@/components/Common/Popover';
import { copyToClipboard } from '@/utils/io/clipboard';

import { FragmentSelectionActions } from './AIMessage/FragmentSelectionActions';
import { SelectionCommentAction } from './SelectionCommentAction';

import type { QuotedComment } from '@huabu/shared';
import type { ReactNode } from 'react';

export function TextSelectionToolbar({
  canvasId,
  threadId,
  quote,
  position,
  selectionRect,
  boundary,
  onDismiss,
  onSaveAsNote,
  saveAsNoteDisabled,
  children,
  onBegin,
  onEditingChange,
}: {
  canvasId: string;
  threadId?: string;
  quote: Omit<QuotedComment, 'comment'>;
  position: { x: number; y: number };
  selectionRect?: DOMRect;
  boundary?: HTMLElement | null;
  onDismiss: () => void;
  onSaveAsNote?: () => void;
  saveAsNoteDisabled?: boolean;
  children?: ReactNode;
  onBegin?: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editingComment, setEditingComment] = useState(false);
  return (
    <Popover
      position={position}
      referenceRect={selectionRect}
      placement="bottom-start"
      offset={{ x: 0, y: 8 }}
      boundary={boundary}
      onDismiss={onDismiss}
      className="selection-context-toolbar border-0 bg-transparent p-0 shadow-none"
    >
      <div
        role="presentation"
        className="contents"
        onPointerDown={onBegin}
        onKeyDown={onBegin}
      >
        <FloatingToolbar
          className={cn(
            'canvas-context-toolbar',
            editingComment && 'invisible',
          )}
          onMouseDown={(event) => event.preventDefault()}
        >
          {children}
          {quote.quote && onSaveAsNote ? (
            <FragmentSelectionActions
              onCopy={() => copyToClipboard(quote.quote)}
              onCopied={onDismiss}
              onSaveAsNote={onSaveAsNote}
              saveAsNoteDisabled={saveAsNoteDisabled}
            />
          ) : null}
        </FloatingToolbar>
        {quote.quote ? (
          <FloatingToolbar
            className={cn(
              'canvas-context-toolbar',
              editingComment && 'invisible',
            )}
          >
            <SelectionCommentAction
              canvasId={canvasId}
              threadId={threadId}
              capture={() => quote}
              onDismiss={onDismiss}
              onEditingChange={(editing) => {
                setEditingComment(editing);
                onEditingChange?.(editing);
              }}
            />
          </FloatingToolbar>
        ) : null}
      </div>
    </Popover>
  );
}
