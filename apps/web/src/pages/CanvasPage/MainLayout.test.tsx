// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePanelStore } from '@/store/panelStore';

import { MainLayout, resolveRightPanelVisible } from './MainLayout';

vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <div role="status" />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let nextFrame: FrameRequestCallback | null = null;

const LayoutChild = () => <div />;
const InspectableHeader = ({
  isCollapsed,
  vertical,
  onToggle,
}: {
  isCollapsed?: boolean;
  vertical?: boolean;
  onToggle?: () => void;
}) => (
  <button
    data-testid="inspectable-header"
    data-collapsed={isCollapsed ? 'true' : undefined}
    data-vertical={vertical ? 'true' : undefined}
    onClick={onToggle}
  />
);
const MountedCanvas = (_props: { onOpenChat?: unknown }) => (
  <div data-testid="mounted-canvas" />
);
const InspectableRightPanel = ({
  onToggleFullscreen,
}: {
  onToggleFullscreen?: () => void;
}) => <button data-testid="restore-preview" onClick={onToggleFullscreen} />;

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

  it('allows Preview to grow beyond half the layout width', () => {
    usePanelStore.setState({
      isLeftCollapsed: false,
      isRightCollapsed: false,
    });

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

    const layout = container?.firstElementChild as HTMLElement;
    layout.getBoundingClientRect = () => ({ width: 1200 }) as DOMRect;
    const handles =
      container?.querySelectorAll<HTMLElement>('[role="separator"]');
    const rightHandle = handles?.[handles.length - 1];
    Object.defineProperty(rightHandle, 'setPointerCapture', {
      value: vi.fn(),
    });

    act(() => {
      rightHandle?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 800,
          pointerId: 1,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 0,
          pointerId: 1,
        }),
      );
    });

    const slot = container?.querySelector<HTMLElement>(
      '[data-right-panel-slot]',
    );
    expect(slot?.style.width).toBe('840px');
  });

  it('unmounts Canvas while Preview and Layers occupy fullscreen', () => {
    usePanelStore.setState({
      isLeftCollapsed: true,
      isRightCollapsed: false,
      isPreviewFullscreen: true,
    });

    act(() => {
      root?.render(
        <MainLayout
          header={<InspectableHeader />}
          leftPanel={<LayoutChild />}
          rightPanel={<LayoutChild />}
        >
          <MountedCanvas />
        </MainLayout>,
      );
    });

    const layout = container?.querySelector('[data-preview-fullscreen]');
    const slot = container?.querySelector<HTMLElement>(
      '[data-right-panel-slot]',
    );
    const content = container?.querySelector<HTMLElement>(
      '[data-right-panel-content]',
    );

    expect(layout?.getAttribute('data-preview-fullscreen')).toBe('true');
    expect(container?.querySelector('[data-center-editor]')).toBeNull();
    expect(
      container?.querySelector('[data-testid="mounted-canvas"]'),
    ).toBeNull();
    expect(slot?.classList.contains('flex-1')).toBe(true);
    expect(slot?.classList.contains('overflow-hidden')).toBe(true);
    expect(content?.style.width).toBe('100%');
    const rail = container?.querySelector<HTMLElement>(
      '[data-fullscreen-header-rail]',
    );
    const collapsedHeader = rail?.querySelector<HTMLElement>(
      '[data-testid="inspectable-header"]',
    );
    expect(rail?.classList.contains('w-12')).toBe(true);
    expect(collapsedHeader?.dataset.collapsed).toBe('true');
    expect(collapsedHeader?.dataset.vertical).toBe('true');

    act(() => collapsedHeader?.click());

    expect(slot?.classList.contains('flex-1')).toBe(true);
    expect(
      container?.querySelector('[data-fullscreen-header-rail]'),
    ).toBeNull();

    act(() => usePanelStore.getState().togglePreviewFullscreen());

    expect(container?.querySelector('[data-center-editor]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="mounted-canvas"]'),
    ).not.toBeNull();
  });

  it('paints a restoring state before remounting Canvas', () => {
    usePanelStore.setState({
      isLeftCollapsed: true,
      isRightCollapsed: false,
      isPreviewFullscreen: true,
    });

    act(() => {
      root?.render(
        <MainLayout
          header={<InspectableHeader />}
          leftPanel={<LayoutChild />}
          rightPanel={<InspectableRightPanel />}
        >
          <MountedCanvas />
        </MainLayout>,
      );
    });

    act(() => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="restore-preview"]')
        ?.click();
    });

    const layout = container?.querySelector<HTMLElement>(
      '[data-canvas-restoring]',
    );
    expect(layout?.dataset.previewFullscreen).toBeUndefined();
    expect(layout?.dataset.canvasRestoring).toBe('true');
    expect(container?.querySelector('[role="status"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="mounted-canvas"]'),
    ).toBeNull();
    expect(usePanelStore.getState().isPreviewFullscreen).toBe(true);

    act(() => nextFrame?.(16));

    expect(usePanelStore.getState().isPreviewFullscreen).toBe(true);
    expect(
      container?.querySelector('[data-testid="mounted-canvas"]'),
    ).toBeNull();

    act(() => nextFrame?.(32));

    expect(usePanelStore.getState().isPreviewFullscreen).toBe(false);
    expect(
      container?.querySelector('[data-testid="mounted-canvas"]'),
    ).not.toBeNull();
  });
});
