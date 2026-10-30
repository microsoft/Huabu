// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { toast } from '@/components/Common/Toast';
import { FragmentSelectionActions } from '@/components/Messages/AIMessage/FragmentSelectionActions';
import {
  PreviewCommentEditor,
  type PreviewCommentCapture,
} from '@/components/Messages/PreviewCommentEditor';
import { MilkdownFloatingToolbar } from '@/components/Milkdown/MilkdownFloatingToolbar';
import useCanvasStore from '@/store/canvasStore';
import { copyToClipboard } from '@/utils/io/clipboard';

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
  const { t } = useTranslation();
  const [capture, setCapture] = useState<PreviewCommentCapture | null>(null);
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
        disabled={capture !== null}
      >
        <FragmentSelectionActions
          onCopy={async () => {
            const captured = readSelection();
            if (!captured)
              throw new Error(t('messages.commentSelectionUnavailable'));
            await copyToClipboard(captured.selection.text);
          }}
          onCopied={() => window.getSelection()?.removeAllRanges()}
          onSaveAsNote={() => {
            const captured = readSelection();
            if (!captured) {
              toast(t('messages.commentSelectionUnavailable'), {
                tone: 'warning',
              });
              return;
            }
            useCanvasStore.getState().addNode({
              nodeType: 'note',
              data: {
                content: captured.selection.markdown,
                origin: { type: 'user-excerpt', excerptFromNodeId: nodeId },
              },
            });
            window.getSelection()?.removeAllRanges();
          }}
          onComment={() => {
            const captured = readSelection();
            if (!captured) {
              toast(t('messages.commentSelectionUnavailable'), {
                tone: 'warning',
              });
              return;
            }
            setCapture(captured);
          }}
        />
      </MilkdownFloatingToolbar>
      {capture ? (
        <PreviewCommentEditor
          capture={capture}
          onDismiss={() => setCapture(null)}
        />
      ) : null}
    </>
  );
}
