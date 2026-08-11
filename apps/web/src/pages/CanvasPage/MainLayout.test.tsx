// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePanelStore } from '@/store/panelStore';

import { MainLayout } from './MainLayout';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let nextFrame: FrameRequestCallback | null = null;

const LayoutChild = () => <div />;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    nextFrame = null;
  });
  usePanelStore.setState({
    isLeftCollapsed: true,
    isRightCollapsed: true,
    rightPanelAnchorNodeId: null,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  nextFrame = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MainLayout Chat motion', () => {
  it('commits the final width once before animating compositor transforms', () => {
    act(() => {
      root?.render(
        <MainLayout
          header={<LayoutChild />}
          leftPanel={<LayoutChild />}
          rightPanel={<LayoutChild />}
        >
          <LayoutChild />
        </MainLayout>,
      );
    });

    const slot = container?.querySelector<HTMLElement>(
      '[data-right-panel-slot]',
    );
    const content = container?.querySelector<HTMLElement>(
      '[data-right-panel-content]',
    );
    const center = slot?.previousElementSibling?.previousElementSibling as
      | HTMLElement
      | undefined;

    expect(slot?.style.width).toBe('0px');
    expect(slot?.classList.contains('bg-surface')).toBe(true);
    expect(slot?.classList.contains('overflow-hidden')).toBe(false);
    expect(content?.dataset.visible).toBeUndefined();
    expect(slot?.dataset.moving).toBeUndefined();

    act(() => usePanelStore.getState().toggleRightPanel());

    expect(slot?.style.width).toBe('420px');
    expect(content?.dataset.visible).toBeUndefined();
    expect(center?.dataset.rightPanelMotion).toBe('true');
    // Promotion is committed before the transform changes so the slide does
    // not pay a layer-promotion frame.
    expect(slot?.dataset.moving).toBe('true');

    act(() => nextFrame?.(16));

    expect(content?.dataset.visible).toBe('true');

    act(() => {
      const event = new Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'transform' });
      content?.dispatchEvent(event);
    });

    expect(center?.dataset.rightPanelMotion).toBeUndefined();
    expect(slot?.dataset.moving).toBeUndefined();
  });
});
