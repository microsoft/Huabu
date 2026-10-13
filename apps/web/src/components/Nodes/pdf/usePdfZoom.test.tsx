// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import {
  forgetPreviewScrollPosition,
  readPdfPreviewView,
  readPreviewScrollPosition,
  registerPreviewScrollTarget,
  forgetPreviewScrollTarget,
} from '@/store/previewWorkspace/scrollMemory';

import { usePdfZoom } from './usePdfZoom';

let root: Root;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
let zoom: ReturnType<typeof usePdfZoom>;
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const observers = new Map<Element, Set<ResizeObserverCallback>>();
const viewKey = 'node:canvas-zoom:pdf-zoom';

function Harness({
  embedded = false,
  source = 'paper.pdf',
  active = true,
  clampScroll = false,
}: {
  embedded?: boolean;
  source?: string;
  active?: boolean;
  clampScroll?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePreviewScrollMemory(ref, embedded ? undefined : viewKey);
  zoom = usePdfZoom({
    containerRef: ref,
    source,
    embedded,
    viewKey,
    naturalWidth: 600,
    aspectRatio: 0.75,
  });
  return (
    <div data-preview-active={active}>
      <div
        ref={(element) => {
          ref.current = element;
          if (!element) return;
          viewport = element;
          Object.defineProperties(element, {
            clientWidth: { configurable: true, value: 600 },
            clientHeight: { configurable: true, value: 800 },
            scrollHeight: {
              configurable: true,
              value: (zoom.pageWidth * 20) / 0.75,
            },
          });
          if (clampScroll) {
            element.scrollTop = Math.min(
              element.scrollTop,
              Math.max(0, element.scrollHeight - element.clientHeight),
            );
          }
        }}
      >
        <div
          style={{
            width: zoom.pageWidth,
            height: (zoom.pageWidth * 20) / 0.75,
          }}
        />
      </div>
    </div>
  );
}

function resize(width = 600, height = 800) {
  act(() => {
    for (const callbacks of observers.values()) {
      for (const callback of callbacks) {
        callback(
          [{ contentRect: { width, height } }] as ResizeObserverEntry[],
          {} as ResizeObserver,
        );
      }
    }
  });
}

function wheel(deltaY: number, ctrlKey = true, deltaMode = 0) {
  const event = new WheelEvent('wheel', {
    deltaY,
    deltaMode,
    clientX: 200,
    clientY: 100,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey },
    clientX: { value: 200 },
    clientY: { value: 100 },
  });
  act(() => viewport.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  observers.clear();
  forgetPreviewScrollPosition(viewKey);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        const callbacks = observers.get(element) ?? new Set();
        callbacks.add(this.callback);
        observers.set(element, callbacks);
      }
      disconnect() {
        for (const callbacks of observers.values()) {
          callbacks.delete(this.callback);
        }
      }
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
  resize();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetPreviewScrollPosition(viewKey);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PDF zoom', () => {
  it('fits width and whole page to the viewport and ignores hidden zero-size measurements', () => {
    expect(zoom.pageWidth).toBe(600);
    expect(zoom.scale).toBe(1);
    resize(600, 400);
    act(() => zoom.fit('page'));
    expect(zoom.pageWidth).toBe(300);
    expect(zoom.pageWidth / 0.75).toBe(400);
    resize(0, 0);
    expect(zoom.pageWidth).toBe(300);
    resize(450, 800);
    act(() => zoom.fit('width'));
    expect(zoom.pageWidth).toBe(450);
  });

  it('anchors toolbar zoom at the viewport centre and reserves final dimensions before re-rendering', () => {
    vi.useFakeTimers();
    viewport.scrollTop = 1000;
    act(() => zoom.zoomIn());
    expect(zoom.scale).toBe(1.25);
    expect(zoom.pageWidth).toBe(750);
    expect(zoom.renderedWidth).toBe(600);
    expect(zoom.scaleFactor).toBe(1.25);
    expect(viewport.scrollTop).toBe(1350);
    expect(viewport.scrollLeft).toBe(75);
    act(() => vi.advanceTimersByTime(399));
    expect(zoom.renderedWidth).toBe(600);
    act(() => vi.advanceTimersByTime(1));
    expect(zoom.renderedWidth).toBe(750);
    expect(zoom.scaleFactor).toBe(1);
    expect(viewport.scrollTop).toBe(1350);
    act(() => zoom.resetZoom());
    expect(zoom.scale).toBe(1);
    act(() => vi.advanceTimersByTime(400));
    expect(zoom.pageWidth).toBe(600);
  });

  it('contains pinch, anchors it at the pointer, and leaves ordinary scrolling alone', () => {
    const ancestor = vi.fn();
    host.addEventListener('wheel', ancestor);
    viewport.scrollTop = 1000;
    expect(wheel(-300 * Math.log(2)).defaultPrevented).toBe(true);
    expect(zoom.scale).toBeCloseTo(2);
    expect(viewport.scrollLeft).toBeCloseTo(200);
    expect(viewport.scrollTop).toBeCloseTo(2100);
    expect(ancestor).not.toHaveBeenCalled();
    expect(wheel(30, false).defaultPrevented).toBe(false);
    expect(zoom.scale).toBeCloseTo(2);
    expect(ancestor).toHaveBeenCalledOnce();
  });

  it('preserves the reading anchor when shrinking content clamps native scroll before layout effects', () => {
    act(() => root.render(<Harness clampScroll />));
    resize(600, 400);
    viewport.scrollTop = 13000;
    act(() => zoom.fit('page'));
    expect(zoom.pageWidth).toBe(300);
    expect(viewport.scrollTop).toBe(6400);
  });

  it('accumulates pinch events within a single render and clamps zoom to 25–400%', () => {
    act(() => {
      wheel(-300 * Math.log(2));
      wheel(-300 * Math.log(2));
    });
    expect(zoom.scale).toBe(4);
    expect(zoom.canZoomIn).toBe(false);
    expect(wheel(-10000).defaultPrevented).toBe(true);
    expect(zoom.scale).toBe(4);
    wheel(10000);
    expect(zoom.scale).toBe(0.25);
    expect(zoom.canZoomOut).toBe(false);
    act(() => zoom.zoomOut());
    expect(zoom.scale).toBe(0.25);
  });

  it('normalizes wheel line and page units', () => {
    wheel(-1, true, 1);
    expect(zoom.scale).toBeCloseTo(Math.exp(16 / 300));
    act(() => zoom.resetZoom());
    wheel(-0.1, true, 2);
    expect(zoom.scale).toBeCloseTo(Math.exp(80 / 300));
  });

  it('restores zoom and both scroll axes after a cold tab remount', () => {
    wheel(-300 * Math.log(2));
    viewport.scrollTop = 2500;
    viewport.scrollLeft = 250;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(readPreviewScrollPosition(viewKey)).toBe(2500);
    act(() => root.render(null));
    act(() => root.render(<Harness />));
    resize();
    expect(zoom.mode).toBe('custom');
    expect(zoom.scale).toBeCloseTo(2);
    expect(viewport.scrollTop).toBe(2500);
    expect(viewport.scrollLeft).toBe(250);
  });

  it('retains fit mode across remounts and resets zoom for a replacement PDF source', () => {
    act(() => zoom.fit('page'));
    act(() => root.render(null));
    act(() => root.render(<Harness />));
    resize();
    expect(zoom.mode).toBe('page');
    wheel(-300 * Math.log(2));
    act(() => root.render(<Harness source="replacement.pdf" />));
    expect(zoom.mode).toBe('width');
    expect(zoom.scale).toBe(1);
    expect(viewport.scrollLeft).toBe(0);
  });

  it('does not apply preview zoom to embedded readers or consume canvas pinch', () => {
    act(() => root.render(<Harness embedded />));
    resize();
    expect(zoom.mode).toBe('width');
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(zoom.scale).toBe(1);
  });

  it('reclaims PDF memory with the owning preview target', () => {
    const target = {
      kind: 'node',
      canvasId: 'canvas-zoom',
      nodeId: 'pdf-zoom',
    } as const;
    registerPreviewScrollTarget(target, viewKey);
    expect(readPdfPreviewView(viewKey)).toBeDefined();
    forgetPreviewScrollTarget(target);
    expect(readPdfPreviewView(viewKey)).toBeUndefined();
    expect(readPreviewScrollPosition(viewKey)).toBeUndefined();
  });
});
