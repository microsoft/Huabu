// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Compartment, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { Popover } from '@/components/Common/Popover';
import { toast } from '@/components/Common/Toast';
import { FragmentSelectionActions } from '@/components/Messages/AIMessage/FragmentSelectionActions';
import {
  PreviewCommentEditor,
  type PreviewCommentCapture,
} from '@/components/Messages/PreviewCommentEditor';
import { useTrackAttention } from '@/hooks/useTrackAttention';
import useCanvasStore from '@/store/canvasStore';
import { useAnyGlobalModalOpen } from '@/store/globalModalUi';
import { copyToClipboard } from '@/utils/io/clipboard';
import { trackTextSelectionGesture } from '@/utils/textSelectionGesture';

import type { FileReadResult } from '@huabu/shared';
import type { RefObject } from 'react';

import '@/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css';

export function captureFileComment(
  view: EditorView,
  source: { canvasId: string; nodeId: string; agentletId: string },
  file: FileReadResult,
): PreviewCommentCapture | null {
  const { doc, selection } = view.state;
  if (doc.toString() !== file.text.replace(/\r\n?/g, '\n')) return null;
  if (selection.ranges.length !== 1 || selection.main.empty) return null;
  const { from, to } = selection.main;
  const text = doc.sliceString(from, to);
  if (!text.trim()) return null;
  const rect = view.coordsAtPos(selection.main.head);
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  if (!rect || !start || !end) return null;
  const left = Math.min(start.left, end.left);
  const top = Math.min(start.top, end.top);
  return {
    selection: {
      text,
      contextBefore: doc.sliceString(Math.max(0, from - 40), from),
      contextAfter: doc.sliceString(to, Math.min(doc.length, to + 40)),
      position: { x: rect.right, y: rect.bottom },
      selectionRect: new DOMRect(
        left,
        top,
        Math.max(start.right, end.right) - left,
        Math.max(start.bottom, end.bottom) - top,
      ),
    },
    source: {
      kind: 'file-reference',
      ...source,
      path: file.path,
      contentVersion: file.contentVersion,
      offsetUnit: 'utf-16',
      from,
      to,
      loadedLength: doc.length,
      complete: !file.nextCursor,
    },
  };
}

export function FileCommentActions({
  view,
  surfaceRef,
  canvasId,
  nodeId,
  agentletId,
  file,
  disabled,
}: {
  view: EditorView | null;
  surfaceRef: RefObject<HTMLElement | null>;
  canvasId: string;
  nodeId: string;
  agentletId: string;
  file: FileReadResult | null;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const compartment = useRef(new Compartment()).current;
  const [selection, setSelection] = useState<PreviewCommentCapture | null>(
    null,
  );
  const [capture, setCapture] = useState<PreviewCommentCapture | null>(null);
  const [engaged, setEngaged] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const modalOpen = useAnyGlobalModalOpen();
  const readSelection = () =>
    view && file && !disabled
      ? captureFileComment(view, { canvasId, nodeId, agentletId }, file)
      : null;
  const clearSelection = () => {
    if (view) {
      view.dispatch({ selection: { anchor: view.state.selection.main.head } });
    }
    setSelection(null);
  };
  useTrackAttention(
    (target) => surfaceRef.current?.contains(target) ?? false,
    setEngaged,
  );
  useEffect(() => {
    setSelection(null);
    if (!view || !file || disabled) return;
    let active = true;
    let selecting = false;
    const update = () => {
      view.requestMeasure({
        key: compartment,
        read: () =>
          active && !selecting
            ? captureFileComment(view, { canvasId, nodeId, agentletId }, file)
            : null,
        write: (next) => {
          if (active && !selecting) setSelection(next);
        },
      });
    };
    const listener = EditorView.updateListener.of((event) => {
      if (event.selectionSet || event.docChanged) setDismissed(false);
      if (event.selectionSet || event.docChanged || event.geometryChanged)
        update();
    });
    view.dispatch({
      effects:
        compartment.get(view.state) === undefined
          ? StateEffect.appendConfig.of(compartment.of(listener))
          : compartment.reconfigure(listener),
    });
    update();
    const stopGesture = trackTextSelectionGesture(
      view.dom,
      () => {
        selecting = true;
        setSelection(null);
      },
      () => {
        selecting = false;
        update();
      },
    );
    const onScroll = () => setSelection(null);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      active = false;
      stopGesture();
      view.dispatch({ effects: compartment.reconfigure([]) });
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [view, file, disabled, canvasId, nodeId, agentletId, compartment]);

  return (
    <>
      {selection &&
      !capture &&
      !disabled &&
      engaged &&
      !modalOpen &&
      !dismissed ? (
        <Popover
          position={selection.selection.position}
          referenceRect={selection.selection.selectionRect}
          placement="bottom-start"
          className="selection-context-toolbar border-0 bg-transparent p-0 shadow-none"
          boundary={surfaceRef.current}
          onDismiss={() => setDismissed(true)}
        >
          <FloatingToolbar className="canvas-context-toolbar">
            <FragmentSelectionActions
              onCopy={async () => {
                const next = readSelection();
                if (!next)
                  throw new Error(t('messages.commentSelectionUnavailable'));
                await copyToClipboard(next.selection.text);
              }}
              onCopied={clearSelection}
              onSaveAsNote={() => {
                const next = readSelection();
                if (!next) {
                  toast(t('messages.commentSelectionUnavailable'), {
                    tone: 'warning',
                  });
                  setSelection(null);
                  return;
                }
                useCanvasStore.getState().addNode({
                  nodeType: 'note',
                  data: {
                    content: next.selection.text,
                    origin: { type: 'user-excerpt', excerptFromNodeId: nodeId },
                  },
                });
                clearSelection();
              }}
            />
          </FloatingToolbar>
          <FloatingToolbar className="canvas-context-toolbar">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              title={t('messages.fragmentComment')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const next = readSelection();
                if (!next) {
                  toast(t('messages.commentSelectionUnavailable'), {
                    tone: 'warning',
                  });
                  setSelection(null);
                  return;
                }
                setCapture(next);
              }}
            >
              <MessageSquare />
            </Button>
          </FloatingToolbar>
        </Popover>
      ) : null}
      {capture ? (
        <PreviewCommentEditor
          capture={capture}
          onDismiss={() => {
            setCapture(null);
            setDismissed(true);
          }}
        />
      ) : null}
    </>
  );
}
