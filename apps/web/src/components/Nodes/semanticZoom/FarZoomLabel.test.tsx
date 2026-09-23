// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FarZoomLabel } from './FarZoomLabel';
import { FAR_ZOOM_DESIGN } from '../design/farZoomDesign';
import { NODE_TYPOGRAPHY } from '../design/nodeTypography';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('shared far-zoom renderer lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFonts: PropertyDescriptor | undefined;
  let finishFonts: () => void;
  let fonts: EventTarget & { ready: Promise<void> };
  let titleHeight: number;
  let measure: ReturnType<typeof vi.spyOn>;
  const observers: Array<{
    notify: (entries: ResizeObserverEntry[]) => void;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];

  beforeEach(() => {
    observers.length = 0;
    titleHeight = 21;
    measure = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(() => titleHeight);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(public notify: (entries: ResizeObserverEntry[]) => void) {
          observers.push(this);
        }
      },
    );
    originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    fonts = Object.assign(new EventTarget(), {
      ready: new Promise<void>((resolve) => {
        finishFonts = resolve;
      }),
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalFonts) {
      Object.defineProperty(document, 'fonts', originalFonts);
    } else {
      Reflect.deleteProperty(document, 'fonts');
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (visible: boolean, count = 1, zoom = 0.25) =>
    act(() => {
      root.render(
        Array.from({ length: count }, (_, index) => (
          <FarZoomLabel
            key={index}
            title="Huabu"
            description="Existing description"
            width={86}
            height={80}
            lines={3}
            zoom={zoom}
            visible={visible}
          />
        )),
      );
    });

  const description = () =>
    container.querySelector<HTMLElement>('[data-study-description]');

  const notify = (height: number) => {
    const target = container.querySelector('[data-title-probe]');
    act(() =>
      observers[0].notify([
        { target, contentRect: { height } } as ResizeObserverEntry,
      ]),
    );
  };

  it('does not measure or subscribe while hidden and resumes with current geometry', () => {
    const add = vi.spyOn(fonts, 'addEventListener');
    const remove = vi.spyOn(fonts, 'removeEventListener');
    render(false);
    expect(measure).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
    expect(add).not.toHaveBeenCalled();

    render(true);
    expect(description()?.style.maxHeight).toBe('55px');
    expect(observers).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(1);
    render(false);
    expect(description()).toBeNull();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    measure.mockClear();
    titleHeight = 63;
    act(() => {
      observers[0].notify([]);
      fonts.dispatchEvent(new Event('loadingdone'));
    });
    render(false, 1, 0.5);
    expect(measure).not.toHaveBeenCalled();

    render(true, 1, 0.5);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(description()).toBeNull();
    expect(observers).toHaveLength(2);
  });

  it('refreshes fit after resize, font readiness, and subsequent font loads', async () => {
    render(true);
    expect(description()?.style.maxHeight).toBe('55px');
    titleHeight = 42;
    measure.mockClear();
    notify(42);
    expect(measure).not.toHaveBeenCalled();
    expect(description()?.style.maxHeight).toBe('33px');
    titleHeight = 63;
    await act(async () => {
      finishFonts();
      await fonts.ready;
    });
    expect(description()).toBeNull();
    titleHeight = 21;
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(description()?.style.maxHeight).toBe('55px');
  });

  it('shares font observation and cleans up only after the last visible label', async () => {
    const add = vi.spyOn(fonts, 'addEventListener');
    const remove = vi.spyOn(fonts, 'removeEventListener');
    render(true, 2);
    expect(add).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(2);
    measure.mockClear();
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(measure).toHaveBeenCalledTimes(2);

    render(true, 1);
    expect(remove).not.toHaveBeenCalled();
    measure.mockClear();
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(measure).toHaveBeenCalledTimes(1);
    render(false);
    expect(remove).toHaveBeenCalledTimes(1);
    measure.mockClear();
    await act(async () => {
      finishFonts();
      await fonts.ready;
    });
    expect(measure).not.toHaveBeenCalled();
  });

  it('reuses observation and cached height across continuous zoom and bounds changes', () => {
    render(true);
    measure.mockClear();
    const add = vi.spyOn(fonts, 'addEventListener');
    for (let i = 0; i < 20; i++) {
      act(() =>
        root.render(
          <FarZoomLabel
            key={0}
            title="Huabu"
            description="Existing description"
            width={86 + i}
            height={80 + i}
            lines={3}
            zoom={0.2 + i * 0.001}
            visible
          />,
        ),
      );
    }
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnect).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(description()?.style.maxHeight).toBe('66px');
    notify(42);
    expect(description()?.style.maxHeight).toBe('44px');
    expect(measure).not.toHaveBeenCalled();
  });

  it.each([
    {
      visible: true,
      text: 'Summary',
      height: 80,
      divider: true,
      expected: true,
    },
    {
      visible: false,
      text: 'Summary',
      height: 80,
      divider: true,
      expected: false,
    },
    { visible: true, text: '', height: 80, divider: true, expected: false },
    {
      visible: true,
      text: 'Huabu',
      height: 80,
      divider: true,
      expected: false,
    },
    {
      visible: true,
      text: 'Summary',
      height: 25,
      divider: true,
      expected: false,
    },
    {
      visible: true,
      text: 'Summary',
      height: 80,
      divider: false,
      expected: false,
    },
  ])(
    'only separates an opted-in visible description: %j',
    ({ visible, text, height, divider, expected }) => {
      act(() =>
        root.render(
          <FarZoomLabel
            title="Huabu"
            description={text}
            width={86}
            height={height}
            lines={3}
            zoom={0.2}
            visible={visible}
            descriptionDivider={divider}
          />,
        ),
      );
      const line = container.querySelector('[data-far-description-divider]');
      expect(!!line).toBe(expected);
      if (expected) {
        expect(line?.parentElement?.getAttribute('aria-hidden')).toBe('true');
        expect(line?.parentElement?.style.height).toBe('4px');
        expect(description()?.style.marginTop).toBe('0px');
        expect(description()?.style.maxHeight).toBe('55px');
        expect(description()?.style.fontSize).toBe('8px');
      }
    },
  );

  it('remeasures changed text without reconnecting its observer', () => {
    render(true);
    titleHeight = 42;
    measure.mockClear();
    act(() =>
      root.render(
        <FarZoomLabel
          key={0}
          title="A different title"
          description="Existing description"
          width={86}
          height={80}
          lines={3}
          zoom={0.25}
          visible
        />,
      ),
    );
    expect(measure).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(1);
    expect(description()?.style.maxHeight).toBe('33px');
  });

  it.each([0.1, 0.25, 1])(
    'keeps screen metrics and title weight at zoom %s',
    (zoom) => {
      render(true, 1, zoom);
      const label = container.querySelector<HTMLElement>('[data-study-label]');
      const title = container.querySelector<HTMLElement>('[data-study-title]');
      const summary = description();
      if (!label || !title || !summary)
        throw new Error('Expected visible label');
      expect(parseFloat(label.style.width)).toBe(86);
      expect(parseFloat(label.style.maxHeight)).toBe(80);
      expect(label.style.transform).toBe(`scale(${1 / zoom})`);
      expect(parseFloat(label.style.left) * zoom).toBe(8);
      expect(parseFloat(title.style.fontSize)).toBe(10);
      expect(parseFloat(title.style.lineHeight)).toBe(14);
      expect(FAR_ZOOM_DESIGN.labelWeight).toBe(
        NODE_TYPOGRAPHY.cardTitle.weight,
      );
      expect(title.style.fontWeight).toBe(
        String(NODE_TYPOGRAPHY.cardTitle.weight),
      );
      expect(parseFloat(summary.style.fontSize)).toBe(8);
      expect(parseFloat(summary.style.lineHeight)).toBe(11);
      expect(parseFloat(summary.style.marginTop)).toBe(4);
    },
  );
});
