// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect } from 'react';

import {
  readPreviewScrollPosition,
  rememberPreviewScrollPosition,
} from '@/store/previewWorkspace/scrollMemory';

export function usePreviewScrollMemory(
  containerRef: React.RefObject<HTMLElement | null>,
  viewKey: string | undefined,
): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !viewKey) return;

    let desiredScrollTop = readPreviewScrollPosition(viewKey);
    const restore = () => {
      if (desiredScrollTop === undefined) return;
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      container.scrollTop = Math.min(desiredScrollTop, maxScrollTop);
    };
    const remember = () => {
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      if (
        desiredScrollTop !== undefined &&
        desiredScrollTop > maxScrollTop &&
        container.scrollTop === maxScrollTop
      ) {
        return;
      }
      desiredScrollTop = container.scrollTop;
      rememberPreviewScrollPosition(viewKey, container.scrollTop);
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

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      container.removeEventListener('scroll', remember);
      remember();
    };
  }, [containerRef, viewKey]);
}
