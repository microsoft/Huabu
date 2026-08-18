// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readPreviewScrollPosition,
  rememberPreviewScrollPosition,
} from '@/store/previewWorkspace/scrollMemory';

import { usePreviewScrollMemory } from './usePreviewScrollMemory';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Harness({
  viewKey,
  initialScrollHeight = 500,
  active = true,
}: {
  viewKey: string;
  initialScrollHeight?: number;
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  usePreviewScrollMemory(containerRef, viewKey);
  return (
    <div data-preview-active={active}>
      <div
        ref={(container) => {
          containerRef.current = container;
          if (!container) return;
          Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: {
              configurable: true,
              value: initialScrollHeight,
            },
          });
        }}
        data-testid="scroll-container"
      />
    </div>
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('usePreviewScrollMemory', () => {
  it('restores and remembers a target scroll position', () => {
    rememberPreviewScrollPosition('node:canvas-1:note-1', 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => root?.render(<Harness viewKey="node:canvas-1:note-1" />));
    const container = host.querySelector<HTMLElement>(
      '[data-testid="scroll-container"]',
    );
    if (!container) throw new Error('Expected scroll container');

    expect(container.scrollTop).toBe(240);
    container.scrollTop = 240;
    container.dispatchEvent(new Event('scroll'));

    expect(readPreviewScrollPosition('node:canvas-1:note-1')).toBe(240);
  });

  it('keeps the desired position until asynchronous content becomes tall enough', async () => {
    const viewKey = 'node:canvas-1:pdf-1';
    rememberPreviewScrollPosition(viewKey, 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() =>
      root?.render(<Harness viewKey={viewKey} initialScrollHeight={100} />),
    );
    const container = host.querySelector<HTMLElement>(
      '[data-testid="scroll-container"]',
    );
    if (!container) throw new Error('Expected scroll container');
    expect(container.scrollTop).toBe(0);

    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      value: 500,
    });
    await act(async () => {
      container.appendChild(document.createElement('div'));
      await Promise.resolve();
    });

    expect(container.scrollTop).toBe(240);
    expect(readPreviewScrollPosition(viewKey)).toBe(240);
  });

  it('ignores a delayed programmatic scroll while a hidden view is restoring', async () => {
    const viewKey = 'node:canvas-1:note-activity';
    rememberPreviewScrollPosition(viewKey, 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() =>
      root?.render(<Harness viewKey={viewKey} initialScrollHeight={100} />),
    );
    const container = host.querySelector<HTMLElement>(
      '[data-testid="scroll-container"]',
    );
    if (!container) throw new Error('Expected scroll container');
    expect(container.scrollTop).toBe(0);

    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      value: 500,
    });
    container.dispatchEvent(new Event('scroll'));
    await act(async () => {
      container.appendChild(document.createElement('div'));
      await Promise.resolve();
    });

    expect(container.scrollTop).toBe(240);
    expect(readPreviewScrollPosition(viewKey)).toBe(240);
  });

  it('lets user input take over an incomplete asynchronous restore', async () => {
    const viewKey = 'node:canvas-1:note-user-scroll';
    rememberPreviewScrollPosition(viewKey, 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() =>
      root?.render(<Harness viewKey={viewKey} initialScrollHeight={200} />),
    );
    const container = host.querySelector<HTMLElement>(
      '[data-testid="scroll-container"]',
    );
    if (!container) throw new Error('Expected scroll container');
    expect(container.scrollTop).toBe(100);

    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll'));

    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      value: 500,
    });
    await act(async () => {
      container.appendChild(document.createElement('div'));
      await Promise.resolve();
    });

    expect(container.scrollTop).toBe(0);
    expect(readPreviewScrollPosition(viewKey)).toBe(0);
  });

  it('does not overwrite a retained inactive preview position', () => {
    const viewKey = 'node:canvas-1:note-hidden';
    rememberPreviewScrollPosition(viewKey, 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => root?.render(<Harness viewKey={viewKey} active={false} />));
    const container = host.querySelector<HTMLElement>(
      '[data-testid="scroll-container"]',
    );
    if (!container) throw new Error('Expected scroll container');

    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll'));
    expect(readPreviewScrollPosition(viewKey)).toBe(240);
  });
});
