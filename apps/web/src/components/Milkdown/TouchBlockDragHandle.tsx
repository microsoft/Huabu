// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { canDropOnCanvas, dropOnCanvas } from '@/utils/io/canvasDropTargets';

import type { MilkdownInstance } from './createMilkdown';
import type { DragPayload } from '@/utils/io/dragDrop';

export type GetTouchDragPayload = (markdown: string) => DragPayload | null;

interface Props {
  root: HTMLElement;
  instance: MilkdownInstance;
  getPayload: GetTouchDragPayload;
}

const DRAG_THRESHOLD = 8;

export function TouchBlockDragHandle({ root, instance, getPayload }: Props) {
  const { t } = useTranslation();
  const selectedRef = useRef<HTMLElement | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    payload: DragPayload;
    text: string;
    moved: boolean;
  } | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [preview, setPreview] = useState<{
    x: number;
    y: number;
    text: string;
    accepted: boolean;
  } | null>(null);

  useEffect(() => {
    let tap: { pointerId: number; x: number; y: number } | null = null;
    let frame = 0;
    const refresh = () => {
      frame = 0;
      if (!selectedRef.current || !root.contains(selectedRef.current)) {
        selectedRef.current = root.querySelector('.ProseMirror > *');
      }
      const block = selectedRef.current;
      if (!block) {
        setPosition(null);
        return;
      }
      const box = block.getBoundingClientRect();
      const host = root.getBoundingClientRect();
      setPosition({
        left: box.left - host.left + root.scrollLeft - 44,
        top: box.top - host.top + root.scrollTop,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh);
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.ProseMirror')) return;
      tap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const up = (event: PointerEvent) => {
      const start = tap;
      tap = null;
      if (!start || start.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        DRAG_THRESHOLD
      )
        return;
      if (!document.getSelection()?.isCollapsed) return;
      if (!(event.target instanceof Node)) return;
      const range = instance.getDragRangeAtDOM(event.target);
      if (!range) return;
      const block = instance.getDragPayload(range)?.blockElements[0];
      if (!block) return;
      selectedRef.current = block;
      refresh();
    };
    const cancel = () => {
      tap = null;
      gestureRef.current = null;
      setPreview(null);
    };
    const anotherPointer = (event: PointerEvent) => {
      if (
        gestureRef.current &&
        event.pointerId !== gestureRef.current.pointerId
      )
        cancel();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('pointerdown', anotherPointer, true);
    document.addEventListener('keydown', keydown);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    const unsubscribe = instance.onMarkdownUpdated(schedule);
    root.addEventListener('load', schedule, true);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      gestureRef.current = null;
      observer.disconnect();
      unsubscribe();
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', cancel);
      root.removeEventListener('load', schedule, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('pointerdown', anotherPointer, true);
      document.removeEventListener('keydown', keydown);
    };
  }, [root, instance]);

  return (
    <>
      {position
        ? createPortal(
            <button
              type="button"
              className="milkdown-touch-block-grip"
              style={position}
              aria-label={t('editor.dragParagraphToCanvas')}
              title={t('editor.touchParagraphHint')}
              onContextMenu={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (
                  !event.isPrimary ||
                  event.button !== 0 ||
                  !selectedRef.current
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                const range =
                  instance.getMultiBlockSelectionRange() ??
                  instance.getDragRangeAtDOM(selectedRef.current);
                if (!range) return;
                const block = instance.getDragPayload(range);
                if (!block) return;
                const payload = getPayload(block.markdown);
                if (!payload) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                gestureRef.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  payload,
                  text: block.markdown,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const gesture = gestureRef.current;
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                event.stopPropagation();
                gesture.moved ||=
                  Math.hypot(
                    event.clientX - gesture.x,
                    event.clientY - gesture.y,
                  ) >= DRAG_THRESHOLD;
                if (!gesture.moved) return;
                const point = { x: event.clientX, y: event.clientY };
                setPreview({
                  ...point,
                  text: gesture.text,
                  accepted: canDropOnCanvas(point),
                });
              }}
              onPointerUp={(event) => {
                const gesture = gestureRef.current;
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                event.preventDefault();
                event.stopPropagation();
                gestureRef.current = null;
                setPreview(null);
                if (gesture.moved)
                  dropOnCanvas(gesture.payload, {
                    x: event.clientX,
                    y: event.clientY,
                  });
              }}
              onLostPointerCapture={() => {
                gestureRef.current = null;
                setPreview(null);
              }}
            >
              <span className="milkdown-touch-block-grip-icon">
                <GripVertical size={16} />
              </span>
            </button>,
            root,
          )
        : null}
      {preview
        ? createPortal(
            <div
              className="milkdown-touch-drag-preview"
              data-drop-accepted={preview.accepted}
              style={{
                left: Math.max(
                  0,
                  Math.min(preview.x + 16, window.innerWidth - 260),
                ),
                top: Math.max(
                  0,
                  Math.min(preview.y + 16, window.innerHeight - 100),
                ),
              }}
              aria-hidden
            >
              <strong>
                {t(
                  preview.accepted
                    ? 'editor.releaseParagraph'
                    : 'editor.dragParagraphToCanvas',
                )}
              </strong>
              <div>{preview.text.slice(0, 180)}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
