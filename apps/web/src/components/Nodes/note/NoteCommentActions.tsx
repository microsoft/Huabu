// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { SelectionCommentAction } from '@/components/Messages/SelectionCommentAction';
import { MilkdownFloatingToolbar } from '@/components/Milkdown/MilkdownFloatingToolbar';

import type { MilkdownInstance } from '@/components/Milkdown';
import type { RefObject } from 'react';

export function NoteCommentActions({
  editor,
  surfaceRef,
  canvasId,
  nodeId,
  mode,
}: {
  editor: MilkdownInstance | null;
  surfaceRef: RefObject<HTMLElement | null>;
  canvasId: string;
  nodeId: string;
  mode: 'edit' | 'selection';
}) {
  const [editingComment, setEditingComment] = useState(false);
  const readSelection = () => {
    const selection = editor?.getTextSelection();
    const rect = editor?.getSelectionClientRect();
    if (!editor || !selection || !rect) return null;
    return {
      selection: {
        ...selection,
        position: { x: rect.right, y: rect.bottom },
      },
      source: {
        kind: 'note' as const,
        canvasId,
        nodeId,
        snapshotRevision: nodeRevisionOf({ content: editor.getMarkdown() }),
      },
    };
  };
  return (
    <>
      <MilkdownFloatingToolbar
        instance={editor}
        surfaceRef={surfaceRef}
        mode={mode}
        suspended={editingComment}
        conversationActions={
          <SelectionCommentAction
            canvasId={canvasId}
            onEditingChange={setEditingComment}
            capture={() => {
              const captured = readSelection();
              return captured
                ? {
                    quote: captured.selection.text,
                    contextBefore: captured.selection.contextBefore,
                    contextAfter: captured.selection.contextAfter,
                    source: captured.source,
                  }
                : null;
            }}
            onDismiss={() => window.getSelection()?.removeAllRanges()}
          />
        }
      />
    </>
  );
}
