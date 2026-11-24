// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { getElectronBridge } from '@/hooks/useElectron';

import type { PagePreviewRect } from '@/hooks/useElectron';

/**
 * Whether the desktop app can show another site's page in a view of its own.
 * Elsewhere such a page is an `<iframe>`, which the site may refuse.
 */
export function canIsolatePages(): boolean {
  return Boolean(getElectronBridge()?.pagePreview);
}

/**
 * The address as the desktop app would show it: another site's web page.
 * `null` for anything else, which stays a frame of this page.
 */
export function isolatedPageUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === window.location.origin) return null;
  return url.href;
}

/** How far a press must travel before it is a drag the page would swallow. */
const DRAG_THRESHOLD_PX = 4;
/** How many animation frames pass between checks for something on top. */
const COVER_CHECK_FRAMES = 3;

/**
 * Whether something of this page is drawn over `host`. The desktop app draws
 * the previewed page above everything here, so a menu or dialog that reaches
 * over it would be hidden.
 */
export function isCovered(host: Element, rect: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  for (const across of [0.1, 0.5, 0.9]) {
    for (const down of [0.1, 0.5, 0.9]) {
      const top = document.elementFromPoint(
        rect.left + rect.width * across,
        rect.top + rect.height * down,
      );
      if (top && top !== host && !host.contains(top)) return true;
    }
  }
  return false;
}

/**
 * Whether a press lands on a handle that resizes a panel. Such a drag moves
 * this element's edge, not anything across it, so the page stays live and
 * follows.
 */
export function isResizeHandle(target: EventTarget | null): boolean {
  let element = target instanceof Element ? target : null;
  for (let depth = 0; element && depth < 3; depth += 1) {
    if (/resize/.test(getComputedStyle(element).cursor)) return true;
    element = element.parentElement;
  }
  return false;
}

const sameRect = (a: PagePreviewRect, b: PagePreviewRect) =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

interface IsolatedPageProps {
  url: string;
  /** Reloads the page each time it changes. */
  reloadNonce?: number;
}

/**
 * Another site's web page in the desktop app. This element only marks where
 * the page goes: the app shows it there in a view of its own, in another
 * process and session. While something here needs that space — a menu, a
 * dialog, something dragged across — the page steps aside and a picture of it
 * stands in, at the size it was taken. Resizing a panel is not such a case:
 * the page stays live and follows its edge.
 */
export function IsolatedPage({ url, reloadNonce = 0 }: IsolatedPageProps) {
  const { t } = useTranslation();
  const bridge = getElectronBridge()?.pagePreview;
  const hostRef = useRef<HTMLDivElement>(null);
  const [id] = useState(
    () => `page-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  );
  const [error, setError] = useState<string | null>(null);
  const [picture, setPicture] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);
  // Something is being dragged across: the picture is shown as set aside.
  const [setAside, setSetAside] = useState(false);
  const errorRef = useRef(error);
  errorRef.current = error;

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    setError(null);
    void bridge.show(id, url).then((result) => {
      if (!cancelled && !result.ok) setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, id, url]);

  useEffect(() => {
    if (!bridge) return;
    return () => bridge.close(id);
  }, [bridge, id]);

  const reloaded = useRef(reloadNonce);
  useEffect(() => {
    if (!bridge || reloaded.current === reloadNonce) return;
    reloaded.current = reloadNonce;
    bridge.reload(id);
  }, [bridge, id, reloadNonce]);

  useEffect(() => {
    if (!bridge) return;
    const stopState = bridge.onState((state) => {
      if (state.id === id) setError(state.error);
    });
    const stopFocus = bridge.onFocus((focused) => {
      // The click went to the page. Tell this document as a click here
      // would have, so an open menu closes and this Preview group is the
      // focused one.
      if (focused !== id || !hostRef.current) return;
      for (const type of ['pointerdown', 'mousedown'] as const)
        hostRef.current.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true }),
        );
    });
    return () => {
      stopState();
      stopFocus();
    };
  }, [bridge, id]);

  // Keep the page over this element, and out of the way when it must be.
  useEffect(() => {
    const host = hostRef.current;
    if (!bridge || !host) return;
    let frame = 0;
    let alive = true;
    let placed: PagePreviewRect | null = null;
    let press: { x: number; y: number } | null = null;
    let dragging = false;

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && host.contains(event.target)) return;
      if (isResizeHandle(event.target)) return;
      press = { x: event.clientX, y: event.clientY };
    };
    const setDragging = (value: boolean) => {
      if (dragging === value) return;
      dragging = value;
      setSetAside(value);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!press || dragging) return;
      setDragging(
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >
          DRAG_THRESHOLD_PX,
      );
    };
    const endPress = () => {
      press = null;
      setDragging(false);
    };
    const onDragStart = () => setDragging(true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', endPress, true);
    window.addEventListener('pointercancel', endPress, true);
    window.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('dragend', endPress, true);
    window.addEventListener('drop', endPress, true);

    // Hit-testing every frame would cost more than a menu appearing a
    // moment late is worth.
    let ticks = 0;
    let covered = false;
    const wanted = (): PagePreviewRect | null => {
      if (dragging || errorRef.current) return null;
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      if (ticks++ % COVER_CHECK_FRAMES === 0) covered = isCovered(host, rect);
      if (covered) return null;
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const next = wanted();
      if (next) {
        if (!placed || !sameRect(placed, next)) {
          placed = next;
          bridge.place(id, next);
        }
      } else if (placed) {
        // The picture keeps the size the page had, whatever this element
        // becomes while the page is away: stretched, it would read as a blur.
        const { width, height } = placed;
        placed = null;
        void bridge.hide(id).then((taken) => {
          if (alive && taken) setPicture({ src: taken, width, height });
        });
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', endPress, true);
      window.removeEventListener('pointercancel', endPress, true);
      window.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('dragend', endPress, true);
      window.removeEventListener('drop', endPress, true);
    };
  }, [bridge, id]);

  return (
    <div
      ref={hostRef}
      className="bg-surface relative h-full min-h-0 w-full flex-1 overflow-hidden"
      data-isolated-page={url}
    >
      {error ? (
        <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
          <span role="status">{t('node.failedLoadPage')}</span>
          <p className="text-xs">{error}</p>
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={() => {
              setError(null);
              bridge?.reload(id);
            }}
          >
            {t('messages.retry')}
          </Button>
        </div>
      ) : picture ? (
        <img
          src={picture.src}
          alt=""
          draggable={false}
          data-set-aside={setAside || undefined}
          style={{ width: picture.width, height: picture.height }}
          className={`pointer-events-none absolute top-0 left-0 max-w-none transition-[filter,opacity] duration-150 select-none ${setAside ? 'opacity-60 blur-sm' : ''}`}
        />
      ) : null}
    </div>
  );
}
