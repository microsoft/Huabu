// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePanelStore } from '@/store/panelStore';

import { MainLayout, resolveRightPanelVisible } from './MainLayout';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let nextFrame: FrameRequestCallback | null = null;

const LayoutChild = () => <div />;
const MountedCanvas = (_props: { onOpenChat?: unknown }) => (
  <div data-testid="mounted-canvas" />
);

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
    isPreviewFullscreen: false,
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
  it('uses persisted panel state after an interrupted startup motion settles', () => {
    expect(
      resolveRightPanelVisible({
        collapsed: false,
        moving: false,
        animatedVisible: false,
      }),
    ).toBe(true);
  });

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
    expect(slot?.classList.contains('bg-surface')).toBe(false);
    expect(slot?.classList.contains('overflow-hidden')).toBe(true);
    expect(content?.dataset.visible).toBeUndefined();
    expect(slot?.dataset.moving).toBeUndefined();

    act(() => usePanelStore.getState().toggleRightPanel());

    expect(slot?.style.width).toBe('420px');
    expect(slot?.classList.contains('overflow-hidden')).toBe(false);
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

  it('keeps Canvas mounted while Preview and Layers occupy fullscreen', () => {
    usePanelStore.setState({
      isLeftCollapsed: true,
      isRightCollapsed: false,
      isPreviewFullscreen: true,
    });

    act(() => {
      root?.render(
        <MainLayout
          header={<LayoutChild />}
          leftPanel={<LayoutChild />}
          rightPanel={<LayoutChild />}
        >
          <MountedCanvas />
        </MainLayout>,
      );
    });

    const layout = container?.querySelector('[data-preview-fullscreen]');
    const center = container?.querySelector<HTMLElement>(
      '[data-center-editor]',
    );
    const slot = container?.querySelector<HTMLElement>(
      '[data-right-panel-slot]',
    );
    const content = container?.querySelector<HTMLElement>(
      '[data-right-panel-content]',
    );

    expect(layout?.getAttribute('data-preview-fullscreen')).toBe('true');
    expect(center?.classList.contains('invisible')).toBe(true);
    expect(center?.inert).toBe(true);
    expect(
      center?.querySelector('[data-testid="mounted-canvas"]'),
    ).not.toBeNull();
    expect(slot?.classList.contains('flex-1')).toBe(true);
    expect(content?.style.width).toBe('100%');

    act(() => usePanelStore.getState().toggleLeftPanel());

    expect(slot?.classList.contains('flex-1')).toBe(true);
  });
});
