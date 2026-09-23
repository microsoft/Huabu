// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePanelStore } from '@/store/panelStore';

import { MainLayout } from './MainLayout';

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
const InspectableLeftPanel = ({
  isContentMounted,
}: {
  isContentMounted?: boolean;
}) => (isContentMounted ? <div data-testid="layer-content" /> : null);
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
  <div data-testid="mounted-canvas" data-canvas-main-toolbar />
);
const InspectableRightPanel = ({
  onToggleFullscreen,
}: {
  onToggleFullscreen?: () => void;
}) => <button data-testid="restore-preview" onClick={onToggleFullscreen} />;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return {
        width: this.hasAttribute('data-canvas-main-toolbar') ? 800 : 1200,
      } as DOMRect;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MainLayout Chat motion', () => {
  it.each(['left', 'right'] as const)(
    'moves focus out of the %s panel before collapse makes it inert',
    (side) => {
      usePanelStore.setState({
        isLeftCollapsed: false,
        isRightCollapsed: false,
      });
      act(() =>
        root?.render(
          <MainLayout
            header={<InspectableHeader />}
            leftPanel={<LayoutChild />}
            rightPanel={<InspectableHeader />}
          >
            <MountedCanvas />
          </MainLayout>,
        ),
      );
      const panel = container?.querySelector<HTMLElement>(
        `[data-canvas-panel="${side}"]`,
      );
      const control = panel?.querySelector('button');
      const center = container?.querySelector<HTMLElement>(
        '[data-center-editor]',
      );
      if (!panel || !control || !center)
        throw new Error('Expected layout controls');
      const onFocus = vi.fn(() => {
        expect(panel.querySelector('[inert]')).toBeNull();
      });
      center.addEventListener('focus', onFocus);
      act(() => control.focus());
      act(() => control.click());
      expect(document.activeElement).toBe(center);
      expect(onFocus).toHaveBeenCalledOnce();
      expect(panel.querySelector('[inert]')).not.toBeNull();
    },
  );

  it.each(['left', 'right'] as const)(
    'restores focus when %s collapses in fullscreen',
    (side) => {
      usePanelStore.setState({
        isLeftCollapsed: false,
        isRightCollapsed: false,
        isPreviewFullscreen: true,
      });
      act(() =>
        root?.render(
          <MainLayout
            header={<InspectableHeader />}
            leftPanel={<LayoutChild />}
            rightPanel={<InspectableHeader />}
          >
            <MountedCanvas />
          </MainLayout>,
        ),
      );
      const control = container?.querySelector<HTMLButtonElement>(
        `[data-canvas-panel="${side}"] button`,
      );
      const destination = container?.querySelector(
        side === 'left'
          ? '[data-canvas-panel="right"]'
          : '[data-overlay-layout]',
      );
      if (!control || !destination)
        throw new Error('Expected fullscreen panels');
      act(() => control.focus());
      act(() => {
        if (side === 'left') usePanelStore.getState().toggleLeftPanel();
        else usePanelStore.getState().toggleRightPanel();
      });
      expect(document.activeElement).toBe(destination);
    },
  );

  it('does not steal outside focus when a panel collapses', () => {
    usePanelStore.setState({ isLeftCollapsed: false, isRightCollapsed: false });
    act(() =>
      root?.render(
        <MainLayout
          header={<InspectableHeader />}
          leftPanel={<LayoutChild />}
          rightPanel={<InspectableHeader />}
        >
          <MountedCanvas />
        </MainLayout>,
      ),
    );
    const center = container?.querySelector<HTMLElement>(
      '[data-center-editor]',
    );
    if (!center) throw new Error('Expected Canvas focus target');
    act(() => center.focus());
    const focus = vi.spyOn(center, 'focus');
    act(() => {
      usePanelStore.getState().toggleLeftPanel();
      usePanelStore.getState().toggleRightPanel();
    });
    expect(document.activeElement).toBe(center);
    expect(focus).not.toHaveBeenCalled();
  });

  it('mounts Layers on demand and retains content until its slide transition ends', () => {
    act(() => {
      root?.render(
        <MainLayout
          header={<LayoutChild />}
          leftPanel={<InspectableLeftPanel />}
          rightPanel={<LayoutChild />}
        >
          <LayoutChild />
        </MainLayout>,
      );
    });
    const content = () =>
      container?.querySelector('[data-testid="layer-content"]');
    expect(content()).toBeNull();
    act(() => usePanelStore.getState().setLeftCollapsed(false));
    expect(content()).not.toBeNull();
    act(() => usePanelStore.getState().setLeftCollapsed(true));
    expect(content()).not.toBeNull();
    act(() => {
      const event = new Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'transform' });
      container
        ?.querySelector('[data-canvas-panel="left"]')
        ?.dispatchEvent(event);
    });
    expect(content()).toBeNull();
  });

  it('cancels stale Layers removal on reopen and falls back when motion events are absent', () => {
    act(() => {
      root?.render(
        <MainLayout
          header={<LayoutChild />}
          leftPanel={<InspectableLeftPanel />}
          rightPanel={<LayoutChild />}
        >
          <LayoutChild />
        </MainLayout>,
      );
    });
    act(() => usePanelStore.getState().setLeftCollapsed(false));
    act(() => usePanelStore.getState().setLeftCollapsed(true));
    act(() => vi.advanceTimersByTime(100));
    act(() => usePanelStore.getState().setLeftCollapsed(false));
    act(() => vi.advanceTimersByTime(500));
    expect(
      container?.querySelector('[data-testid="layer-content"]'),
    ).not.toBeNull();
    act(() => usePanelStore.getState().setLeftCollapsed(true));
    act(() => vi.advanceTimersByTime(300));
    expect(
      container?.querySelector('[data-testid="layer-content"]'),
    ).toBeNull();
  });

  it.each([
    { width: 1600, leftHidden: false, rightHidden: false },
    { width: 1200, leftHidden: false, rightHidden: true },
  ])(
    'only hides for the overlapping focused panel at width $width',
    ({ width, leftHidden, rightHidden }) => {
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      ).mockImplementation(function (this: HTMLElement) {
        return {
          width: this.hasAttribute('data-canvas-main-toolbar') ? 400 : width,
        } as DOMRect;
      });
      usePanelStore.setState({
        isLeftCollapsed: false,
        isRightCollapsed: false,
      });
      act(() =>
        root?.render(
          <MainLayout
            header={<LayoutChild />}
            leftPanel={<LayoutChild />}
            rightPanel={<LayoutChild />}
          >
            <MountedCanvas />
          </MainLayout>,
        ),
      );
      const host = container?.querySelector('[data-canvas-toolbar-layer]');
      act(() =>
        container
          ?.querySelector<HTMLElement>('[data-canvas-panel="left"]')
          ?.focus(),
      );
      expect(host?.hasAttribute('inert')).toBe(leftHidden);
      act(() =>
        container
          ?.querySelector<HTMLElement>('[data-canvas-panel="right"]')
          ?.focus(),
      );
      expect(host?.hasAttribute('inert')).toBe(rightHidden);
    },
  );

  it('hides the toolbar for either panel and restores it outside or on collapse', () => {
    usePanelStore.setState({ isLeftCollapsed: false, isRightCollapsed: false });
    act(() =>
      root?.render(
        <MainLayout
          header={<LayoutChild />}
          leftPanel={<LayoutChild />}
          rightPanel={<LayoutChild />}
        >
          <MountedCanvas />
        </MainLayout>,
      ),
    );
    const host = container!.querySelector<HTMLElement>(
      '[data-canvas-toolbar-layer]',
    )!;
    const left = container!.querySelector<HTMLElement>(
      '[data-canvas-panel="left"]',
    )!;
    const right = container!.querySelector<HTMLElement>(
      '[data-canvas-panel="right"]',
    )!;
    const center = container!.querySelector<HTMLElement>(
      '[data-center-editor]',
    )!;
    act(() => left.focus());
    expect(host.hasAttribute('inert')).toBe(true);
    act(() => right.focus());
    expect(host.dataset.hidden).toBe('true');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    document.body.appendChild(menu);
    act(() => menu.focus());
    expect(host.dataset.hidden).toBe('true');
    act(() =>
      center.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    );
    expect(host.hasAttribute('inert')).toBe(false);
    act(() => left.focus());
    expect(host.dataset.hidden).toBe('true');
    act(() => usePanelStore.getState().toggleLeftPanel());
    expect(host.hasAttribute('inert')).toBe(false);
    menu.remove();
  });

  it('keeps fixed panel widths and a full-size canvas while toggling overlays', () => {
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
    const center = container?.querySelector<HTMLElement>(
      '[data-center-editor]',
    );
    const left = container?.querySelector<HTMLElement>(
      '[data-canvas-panel="left"]',
    );

    expect(slot?.style.width).toBe('420px');
    expect(content?.hasAttribute('inert')).toBe(true);
    expect(slot?.classList.contains('overflow-hidden')).toBe(true);
    expect(center?.classList.contains('inset-0')).toBe(true);
    expect(content?.style.width).toBe('100%');

    act(() => usePanelStore.getState().toggleRightPanel());

    expect(slot?.style.width).toBe('420px');
    expect(content?.hasAttribute('inert')).toBe(false);
    expect(nextFrame).toBeNull();
    act(() => usePanelStore.getState().toggleLeftPanel());
    expect(left?.firstElementChild?.hasAttribute('inert')).toBe(false);
    expect(left?.style.width).toBe('260px');
    expect(center?.classList.contains('inset-0')).toBe(true);
    act(() => usePanelStore.getState().toggleRightPanel());
    expect(content?.hasAttribute('inert')).toBe(true);
    expect(slot?.style.width).toBe('420px');
    expect(center?.dataset.rightPanelMotion).toBeUndefined();
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

  it.each([
    ['left', 'pointerup'],
    ['left', 'pointercancel'],
    ['left', 'blur'],
    ['right', 'pointerup'],
    ['right', 'pointercancel'],
    ['right', 'blur'],
  ])(
    'resizes %s only with the owning pointer and stops on %s',
    (side, endType) => {
      usePanelStore.setState({
        isLeftCollapsed: false,
        isRightCollapsed: false,
      });
      act(() =>
        root?.render(
          <MainLayout
            header={<LayoutChild />}
            leftPanel={<LayoutChild />}
            rightPanel={<LayoutChild />}
          >
            <LayoutChild />
          </MainLayout>,
        ),
      );
      const panel = container?.querySelector<HTMLElement>(
        `[data-canvas-panel="${side}"]`,
      );
      const handle = panel?.querySelector<HTMLElement>('[role="separator"]');
      if (!panel || !handle) throw new Error('Expected panel resize handle');
      const initialWidth = side === 'left' ? 260 : 420;
      const direction = side === 'left' ? 1 : -1;
      panel.getBoundingClientRect = () => ({ width: initialWidth }) as DOMRect;
      Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
      act(() =>
        handle.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: 500,
          }),
        ),
      );
      act(() => {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 2,
            clientX: 500 + direction * 50,
          }),
        );
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
      });
      expect(panel.style.width).toBe(`${initialWidth}px`);
      act(() =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 500 + direction * 50,
          }),
        ),
      );
      expect(panel.style.width).toBe(`${initialWidth + 50}px`);
      act(() =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 500 + direction * 2000,
          }),
        ),
      );
      expect(panel.style.width).toBe(side === 'left' ? '360px' : '840px');
      act(() =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 500 - direction * 2000,
          }),
        ),
      );
      const minimum = side === 'left' ? '200px' : '264px';
      expect(panel.style.width).toBe(minimum);
      act(() =>
        window.dispatchEvent(
          endType === 'blur'
            ? new Event('blur')
            : new PointerEvent(endType, { pointerId: 1 }),
        ),
      );
      act(() =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 500 + direction * 50,
          }),
        ),
      );
      expect(panel.style.width).toBe(minimum);
    },
  );

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
    expect(slot?.style.width).toBe('calc(100% - 48px)');
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

    expect(slot?.style.width).toBe('calc(100% - 260px)');
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
