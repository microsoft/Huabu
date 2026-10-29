// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { toast } from '@/components/Common/Toast';
import { FragmentCommentPopover } from '@/components/Messages/AIMessage/FragmentCommentPopover';
import { FragmentSelectionActions } from '@/components/Messages/AIMessage/FragmentSelectionActions';
import { revealQuotedCommentDraft } from '@/components/Messages/quotedCommentNotification';
import { MilkdownFloatingToolbar } from '@/components/Milkdown/MilkdownFloatingToolbar';
import { useCommentDestination } from '@/hooks/useCommentDestination';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { conversationViewForNode } from '@/store/conversationOwner';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { MilkdownInstance } from '@/components/Milkdown';
import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';
import type { QuotedComment } from '@huabu/shared';
import type { RefObject } from 'react';

interface Capture {
  selection: MilkdownPreviewSelection;
  source: NonNullable<QuotedComment['source']>;
}

function NoteCommentEditor({
  capture,
  onDismiss,
}: {
  capture: Capture;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const target = useCommentDestination(capture.source.canvasId);
  const [stagingError, setStagingError] = useState(false);
  const [open, setOpen] = useState(false);
  const staged = useRef(false);
  const selected = target.candidates.find(
    (item) => item.nodeId === target.destination?.nodeId,
  );
  const label = selected
    ? selected.title || t('messages.commentUntitledDestination')
    : t(
        target.loading
          ? 'messages.commentDestinationLoading'
          : target.destination
            ? 'messages.commentDestinationUnavailable'
            : 'messages.commentChooseDestination',
      );
  return (
    <FragmentCommentPopover
      selection={capture.selection}
      initialMode="comment"
      onBegin={() => undefined}
      onCopy={() => copyToClipboard(capture.selection.text)}
      onSaveAsNote={() => undefined}
      onDismiss={onDismiss}
      addDisabled={!target.available || target.loading}
      onAdd={(comment) => {
        if (staged.current) return;
        const canvas = useCanvasStore.getState();
        const owner = target.destination;
        const node = canvas.nodes.find((item) => item.id === owner?.nodeId);
        const view = node
          ? conversationViewForNode(node, capture.source.canvasId)
          : null;
        if (
          canvas.canvasId !== capture.source.canvasId ||
          !view ||
          view.conversationOwner.threadId !== owner?.threadId ||
          canvas.pendingForkThreadIds[view.conversationOwner.threadId]
        ) {
          setStagingError(true);
          return;
        }
        staged.current = true;
        useChatStore
          .getState()
          .addQuotedComment(view.conversationOwner.threadId, {
            quote: capture.selection.text,
            contextBefore: capture.selection.contextBefore,
            contextAfter: capture.selection.contextAfter,
            comment,
            source: capture.source,
          });
        onDismiss();
        revealQuotedCommentDraft(view, label);
      }}
    >
      <DropdownMenu
        aria-label={t('messages.commentChooseDestination')}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-full"
            data-popover-dismiss-ignore=""
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      >
        {target.candidates.map((item) => (
          <DropdownMenuItem
            key={item.nodeId}
            disabled={!item.available}
            aria-current={
              target.destination?.nodeId === item.nodeId ? 'true' : undefined
            }
            onClick={() => {
              target.choose({ nodeId: item.nodeId, threadId: item.threadId });
              setStagingError(false);
              setOpen(false);
            }}
          >
            {item.title || t('messages.commentUntitledDestination')}
          </DropdownMenuItem>
        ))}
        {!target.candidates.length ? (
          <p role="status" className="text-fg-muted px-3 py-2 text-xs">
            {t('messages.commentNoDestinations')}
          </p>
        ) : null}
      </DropdownMenu>
      {target.error ? (
        <div role="alert" className="text-danger text-xs">
          {t('messages.commentDestinationFailed')}
          <Button variant="ghost" size="sm" onClick={target.retry}>
            {t('messages.commentRetry')}
          </Button>
        </div>
      ) : null}
      {stagingError || (target.destination && !target.available) ? (
        <p role="alert" className="text-danger text-xs">
          {t('messages.commentDestinationUnavailable')}
        </p>
      ) : null}
    </FragmentCommentPopover>
  );
}

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
  const [capture, setCapture] = useState<Capture | null>(null);
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
        <NoteCommentEditor
          capture={capture}
          onDismiss={() => setCapture(null)}
        />
      ) : null}
    </>
  );
}
