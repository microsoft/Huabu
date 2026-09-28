// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FRAME_DESIGN_CONFIG } from './frameDesign';
import { FrameHeader } from './FrameHeader.tsx';
import { FrameRegionLabel } from './FrameRegionLabel';
import { FrameSurface } from './FrameSurface.tsx';
import { farFrameRegionPresentation } from './frameZoom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Frame visual primitives', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it.each([1, 12, 120])(
    'keeps the %s child count outside the clamped title',
    (childCount) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <FrameRegionLabel
            title="Agent task orchestration IDE"
            childCount={childCount}
            accent={null}
            zoom={0.1}
            layout={farFrameRegionPresentation(44, 81.6, 0.1, true)}
            headerMetrics={{
              left: 20,
              top: 18,
              height: 29,
              fontSize: 24,
              maxWidth: 412,
            }}
          />,
        ),
      );
      const title = container.querySelector<HTMLElement>(
        '[data-frame-region-title]',
      );
      const count = container.querySelector<HTMLElement>(
        '[data-frame-region-label] > div:not([aria-hidden]) [data-frame-region-count]',
      );
      expect(count?.textContent).toBe(String(childCount));
      expect(count?.style.fontSize).toBe('7px');
      expect(count?.style.height).toBe('10px');
      expect(count?.style.minWidth).toBe('10px');
      expect(count?.style.marginBlock).toBe('3px');
      const label = container.querySelector<HTMLElement>(
        '[data-frame-region-label]',
      );
      expect(label?.style.left).toBe('50%');
      expect(label?.style.top).toBe('18px');
      expect(label?.style.transform).toBe('scale(10) translateX(-50%)');
      expect(label?.style.width).toBe('41.2px');
      expect(label?.style.fontSize).toBe('12px');
      expect(label?.style.lineHeight).toBe('16px');
      expect(
        container.querySelector<HTMLElement>(
          '[data-frame-region-label] > div:not([aria-hidden])',
        )?.style.columnGap,
      ).toBe('3px');
      expect(
        container.querySelector<HTMLElement>(
          '[data-frame-region-label] > [aria-hidden] > span:last-child',
        )?.style.marginLeft,
      ).toBe('3px');
      expect(title?.contains(count)).toBe(false);
      expect(title?.style.maxHeight).toBe('48px');
      expect(container.querySelector('[data-frame-region-marker]')).toBeNull();
      expect(
        container.querySelector(
          '[data-frame-region-label] > div:not([aria-hidden])',
        )?.textContent,
      ).toBe(`Agent task orchestration IDE ${childCount}`);
    },
  );

  it('renders the production surface independently of canvas state', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <FrameSurface accent={null} borderRadius={32}>
          Frame content
        </FrameSurface>,
      ),
    );

    const surface = container.firstElementChild as HTMLElement | null;
    expect(surface?.classList.contains('bg-surface')).toBe(true);
    expect(surface?.style.borderWidth).toBe(
      `${FRAME_DESIGN_CONFIG.appearance.borderWidth}px`,
    );
    expect(surface?.style.borderStyle).toBe(
      FRAME_DESIGN_CONFIG.appearance.borderStyle,
    );
    expect(surface?.style.borderRadius).toBe('32px');
  });

  it('keeps the title before the icon-free instruction badge', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <FrameHeader
          metrics={{
            left: 20,
            top: 10,
            height: 43,
            fontSize: 36,
            maxWidth: 800,
          }}
          accent="#ffffff"
          instructionKind="prompt"
        >
          <span data-frame-title>Prompt</span>
        </FrameHeader>,
      ),
    );

    const header = container.firstElementChild;
    expect(header?.children).toHaveLength(3);
    expect(header?.children[0].getAttribute('aria-hidden')).toBe('true');
    expect(
      header?.children[1].querySelector('[data-frame-title]'),
    ).not.toBeNull();
    expect(header?.children[2].textContent).toBe('node.promptFrameBadgeGlobal');
    expect(header?.classList.contains('pointer-events-none')).toBe(true);
    expect(header?.children[2].classList.contains('pointer-events-auto')).toBe(
      true,
    );
    expect(header?.children[2].getAttribute('title')).toBe(
      'node.promptFrameBadgeGlobalDescription',
    );
    expect(header?.querySelector('svg')).toBeNull();
  });
});
