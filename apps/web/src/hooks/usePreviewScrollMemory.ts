// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect } from 'react';

import {
  readPreviewScrollPosition,
  rememberPreviewScrollPosition,
} from '@/store/previewWorkspace/scrollMemory';

const SCROLL_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
]);

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches('input, textarea, select, [role="textbox"]'))
  );
}

export function usePreviewScrollMemory(
  containerRef: React.RefObject<HTMLElement | null>,
  viewKey: string | undefined,
): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !viewKey) return;

    let desiredScrollTop = readPreviewScrollPosition(viewKey);
    let isRestoring = desiredScrollTop !== undefined;
    const isActive = () =>
      container.closest('[data-preview-active="false"]') === null;
    const restore = () => {
      if (!isRestoring || desiredScrollTop === undefined || !isActive()) return;
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      const nextScrollTop = Math.min(desiredScrollTop, maxScrollTop);
      container.scrollTop = nextScrollTop;
      if (nextScrollTop === desiredScrollTop) isRestoring = false;
    };
    const remember = () => {
      if (!isActive()) return;
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      if (isRestoring) return;
      if (
        desiredScrollTop !== undefined &&
        desiredScrollTop > maxScrollTop &&
        container.scrollTop === maxScrollTop
      ) {
        return;
      }
      desiredScrollTop = container.scrollTop;
      isRestoring = false;
      rememberPreviewScrollPosition(viewKey, container.scrollTop);
    };
    const takeOverRestore = () => {
      if (!isRestoring || !isActive()) return;
      isRestoring = false;
      desiredScrollTop = container.scrollTop;
      rememberPreviewScrollPosition(viewKey, container.scrollTop);
    };
    const takeOverRestoreFromKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !isEditableTarget(event.target)) {
        takeOverRestore();
      }
    };
    const takeOverRestoreFromPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.target === container) {
        takeOverRestore();
      }
    };

    restore();
    const frame = requestAnimationFrame(restore);
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(restore);
    resizeObserver?.observe(container);
    if (container.firstElementChild) {
      resizeObserver?.observe(container.firstElementChild);
    }
    const mutationObserver = new MutationObserver(() => {
      restore();
      if (container.firstElementChild) {
        resizeObserver?.observe(container.firstElementChild);
      }
    });
    mutationObserver.observe(container, { childList: true });
    container.addEventListener('scroll', remember, { passive: true });
    container.addEventListener('wheel', takeOverRestore, { passive: true });
    container.addEventListener('pointerdown', takeOverRestoreFromPointer, {
      passive: true,
    });
    container.addEventListener('keydown', takeOverRestoreFromKey);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      container.removeEventListener('scroll', remember);
      container.removeEventListener('wheel', takeOverRestore);
      container.removeEventListener('pointerdown', takeOverRestoreFromPointer);
      container.removeEventListener('keydown', takeOverRestoreFromKey);
      remember();
    };
  }, [containerRef, viewKey]);
}
