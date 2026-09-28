// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewCard, type PreviewCardProps } from './PreviewCard';
import { previewCardMetricsForSize } from './previewCardDesign';
import { FAR_ZOOM_DESIGN } from '../design/farZoomDesign';
import { resolveNodeAccent } from '../design/nodeAccentPolicy';
import { nodeContentSpacingForWidth } from '../design/nodeSpacing';
import { NODE_CARD_TYPOGRAPHY } from '../design/nodeTypography';
import { noteSurfaceStyle } from '../note/noteDesign';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <div data-loading />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(props: Partial<PreviewCardProps> = {}) {
  act(() =>
    root.render(
      <PreviewCard
        width={400}
        height={400}
        nodeType="pdf"
        source="PDF"
        title="A real document"
        {...props}
      />,
    ),
  );
}

function imageEvent(event: 'load' | 'error') {
  const image = container.querySelector('.preview-card__image');
  expect(image).not.toBeNull();
  act(() => image?.dispatchEvent(new Event(event)));
}

function cardElement(): HTMLElement {
  const card = container.querySelector<HTMLElement>('.preview-card');
  if (!card) throw new Error('Missing PreviewCard');
  return card;
}

describe('PreviewCard', () => {
  it('retains a single summary line and original typography outside far zoom', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
    render({ summary: 'Supporting details.' });
    const card = cardElement();
    expect(card.style.getPropertyValue('--card-summary-lines')).toBe('1');
    expect(card.style.getPropertyValue('--card-description')).toBe(
      `${NODE_CARD_TYPOGRAPHY.description}px`,
    );
    expect(
      container.querySelector<HTMLElement>('.preview-card__summary')?.style
        .display,
    ).not.toBe('none');
  });

  it.each([
    ['web', 400, 400, '/cover.jpg'],
    ['pdf', 400, 400, '/cover.jpg'],
    ['web', 800, 350, '/cover.jpg'],
    ['pdf', 800, 350, '/cover.jpg'],
    ['web', 240, 400, undefined],
    ['pdf', 240, 400, undefined],
  ] as const)(
    'requires two far-summary lines for %s at %sx%s with image %s',
    (nodeType, width, height, image) => {
      let availableHeight = 50;
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
        () =>
          availableHeight +
          (image && width / height < 1.5
            ? previewCardMetricsForSize(width, height).verticalCoverMinHeight *
              0.19
            : 0),
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(
        16,
      );
      for (const [budget, visible] of [
        [50, true],
        [49, false],
        [34, false],
        [50, true],
      ] as const) {
        availableHeight = budget;
        render({
          nodeType,
          width,
          height: height + budget,
          image,
          summary: 'Supporting details.',
          farZoom: 0.19,
        });
        const summary = container.querySelector<HTMLElement>(
          '.preview-card__summary',
        );
        expect(summary?.style.display === 'none').toBe(!visible);
        const card = cardElement();
        expect(card.style.getPropertyValue('--card-title')).toBe('12px');
        expect(card.style.getPropertyValue('--card-title-line')).toBe('16px');
        expect(card.style.getPropertyValue('--card-description')).toBe('10px');
        expect(card.style.getPropertyValue('--card-description-line')).toBe(
          '16px',
        );
      }
    },
  );

  it.each(['web', 'pdf'])(
    'reuses Note tint for %s information without tinting media',
    (nodeType) => {
      for (const farZoom of [undefined, 0.24]) {
        for (const image of ['/cover.jpg', undefined]) {
          render({
            nodeType,
            image,
            accent: 'teal',
            farZoom,
            imageFit: 'contain',
          });
          const card = cardElement();
          const expected = noteSurfaceStyle(
            resolveNodeAccent(nodeType, 'teal'),
          ) as Record<string, string>;
          expect(card.style.getPropertyValue('--note-surface-background')).toBe(
            expected['--note-surface-background'],
          );
          // Happy DOM drops nested var() colors; Chromium checks the resolved tint.
          const cover = container.querySelector<HTMLElement>(
            '.preview-card__cover',
          );
          if (image) {
            expect(cover?.style.backgroundColor).toBe('');
            expect(
              cover?.classList.contains(
                nodeType === 'pdf' ? 'bg-bg-default' : 'bg-surface',
              ),
            ).toBe(true);
          } else expect(cover).toBeNull();
        }
      }
      render({ nodeType, accent: null });
      const legacy = container
        .querySelector<HTMLElement>('.preview-card')
        ?.style.getPropertyValue('--note-surface-background');
      render({ nodeType, accent: 'white' });
      expect(legacy).toBe(
        container
          .querySelector<HTMLElement>('.preview-card')
          ?.style.getPropertyValue('--note-surface-background'),
      );
      expect(legacy).toContain('color-mix(');
    },
  );
  it('hides only the Web source row in far mode and restores it without replacing the cover', () => {
    const props = {
      nodeType: 'web',
      source: 'omarchy.us',
      favicon: '/favicon.png',
      image: '/cover.jpg',
    };
    render(props);
    imageEvent('load');
    const image = container.querySelector('.preview-card__image');
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('omarchy.us');
    render({ ...props, farZoom: 0.24 });
    expect(container.querySelector('.preview-card__metadata')).toBeNull();
    expect(container.querySelector('.preview-card__image')).toBe(image);
    expect(
      container
        .querySelector<HTMLElement>('.preview-card')
        ?.style.getPropertyValue('--card-title-gap'),
    ).toBe('0px');
    render(props);
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('omarchy.us');
    expect(container.querySelector('.preview-card__image')).toBe(image);
  });
  it.each(['web', 'pdf'])(
    'retains the %s image and orientation with screen-fixed far fonts',
    (nodeType) => {
      const props = { nodeType, width: 600, height: 300, image: '/cover.jpg' };
      render(props);
      imageEvent('load');
      const image = container.querySelector('.preview-card__image');
      const card = cardElement();
      const orientation = card.dataset.orientation;
      for (const farZoom of [0.24, 0.2, 0.27]) {
        render({ ...props, farZoom });
        expect(container.querySelector('.preview-card__image')).toBe(image);
        expect(card.dataset.orientation).toBe(orientation);
        expect(card.style.transform).toBe(`scale(${1 / farZoom})`);
        expect(card.style.width).toBe(`${farZoom * 100}%`);
        expect(card.style.getPropertyValue('--card-title')).toBe(
          `${FAR_ZOOM_DESIGN.labelFont}px`,
        );
        expect(card.style.getPropertyValue('--card-title-line')).toBe(
          `${FAR_ZOOM_DESIGN.labelLine}px`,
        );
        expect(card.style.getPropertyValue('--card-title-weight')).toBe(
          `${FAR_ZOOM_DESIGN.labelWeight}`,
        );
        expect(card.style.getPropertyValue('--card-description')).toBe(
          `${FAR_ZOOM_DESIGN.descriptionFont}px`,
        );
      }
      render(props);
      expect(card.style.transform).toBe('');
      expect(container.querySelector('.preview-card__image')).toBe(image);
      expect(card.style.getPropertyValue('--card-title')).toBe(
        `${NODE_CARD_TYPOGRAPHY.title}px`,
      );
    },
  );
  it.each([
    ['web', '/cover.jpg'],
    ['pdf', '/cover.jpg'],
    ['web', undefined],
    ['pdf', undefined],
  ] as const)(
    'allocates all fitting far %s title lines with image %s and restores normal clamping',
    (nodeType, image) => {
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
        200,
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(
        16,
      );
      const props = { nodeType, image, width: 400, height: 700 };
      render({ ...props, farZoom: 0.19 });
      const heading = container.querySelector<HTMLElement>(
        '.preview-card__title',
      );
      if (!heading) throw new Error('Missing heading');
      const coverBudget = image
        ? previewCardMetricsForSize(400, 700).verticalCoverMinHeight * 0.19
        : 0;
      expect(Number(heading.style.getPropertyValue('--card-title-lines'))).toBe(
        Math.floor((200 - coverBudget) / 16),
      );
      expect(
        Number(heading.style.getPropertyValue('--card-title-lines')),
      ).toBeGreaterThan(2);
      render(props);
      expect(heading.style.getPropertyValue('--card-title-lines')).toBe('');
      expect(heading.style.maxHeight).toBe('');
    },
  );

  it.each(['web', 'pdf'])(
    'allocates horizontal %s title lines before descriptions, even without a summary',
    (nodeType) => {
      let height = 200;
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
        () => height,
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(
        20,
      );
      const props = {
        nodeType,
        width: 400,
        height: 214,
        image: '/cover.jpg',
        title: 'A longer material title',
      };
      render(props);
      const title = () => {
        const heading = container.querySelector<HTMLElement>(
          '.preview-card__title',
        );
        if (!heading) throw new Error('Missing heading');
        return heading;
      };
      expect(
        Number(title().style.getPropertyValue('--card-title-lines')),
      ).toBeGreaterThan(2);
      height = 120;
      render({ ...props, height: 210 });
      expect(
        Number(title().style.getPropertyValue('--card-title-lines')),
      ).toBeLessThan(6);
      render({ ...props, height: 400 });
      expect(title().style.getPropertyValue('--card-title-lines')).toBe('');
      render({ ...props, image: undefined });
      expect(title().style.getPropertyValue('--card-title-lines')).toBe('');
    },
  );
  it.each([
    ['web', 400, 400, '/cover.jpg'],
    ['pdf', 400, 400, '/cover.jpg'],
    ['web', 400, 214, '/cover.jpg'],
    ['pdf', 400, 214, '/cover.jpg'],
    ['web', 400, 400, undefined],
    ['pdf', 400, 400, undefined],
  ] as const)(
    'hides descriptions behind a truncated %s title at %s x %s (%s)',
    (nodeType, width, height, image) => {
      let truncated = true;
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
        100,
      );
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains('preview-card__title') && truncated
            ? 150
            : 100;
        },
      );
      const props = {
        nodeType,
        width,
        height,
        image,
        summary: 'Secondary description',
      };
      render({ ...props, title: 'Long title' });
      expect(
        container.querySelector<HTMLElement>('.preview-card__summary')?.style
          .display,
      ).toBe('none');
      truncated = false;
      render({ ...props, title: 'Short title' });
      expect(
        container.querySelector<HTMLElement>('.preview-card__summary')?.style
          .display,
      ).not.toBe('none');
      truncated = true;
      render({ ...props, title: 'Another long title' });
      expect(
        container.querySelector<HTMLElement>('.preview-card__summary')?.style
          .display,
      ).toBe('none');
    },
  );
  it('fills the cover area without a gray mat, but can contain a generated PDF page', () => {
    render({ image: '/cover.jpg' });
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('data-fit'),
    ).toBe('cover');
    expect(
      container
        .querySelector('.preview-card__cover')
        ?.classList.contains('bg-bg-default'),
    ).toBe(false);
    render({ image: '/first-page.jpg', imageFit: 'contain' });
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('data-fit'),
    ).toBe('contain');
    expect(
      container
        .querySelector('.preview-card__cover')
        ?.classList.contains('bg-bg-default'),
    ).toBe(true);
    imageEvent('error');
    expect(container.querySelector('.preview-card__cover')).toBeNull();
  });
  it('keeps Web covers and manual PDF covers on the normal surface', () => {
    for (const nodeType of ['web', 'pdf']) {
      render({ nodeType, image: '/cover.jpg', imageFit: 'cover' });
      expect(
        container
          .querySelector('.preview-card__cover')
          ?.classList.contains('bg-surface'),
      ).toBe(true);
      expect(
        container
          .querySelector('.preview-card')
          ?.classList.contains('bg-surface'),
      ).toBe(true);
    }
  });
  it('orders metadata, title and optional summary without empty rows', () => {
    render({ summary: 'An extracted summary.' });
    const info = container.querySelector('.preview-card__info');
    if (!info) throw new Error('Missing preview information');
    expect(Array.from(info.children, (child) => child.textContent)).toEqual([
      'PDFA real document',
      'An extracted summary.',
    ]);
    render({ summary: '  ' });
    expect(info.children).toHaveLength(1);
    expect(container.querySelector('.preview-card__summary')).toBeNull();
    render({ title: '' });
    expect(container.querySelector('.preview-card__title')).toBeNull();
    expect(info.children).toHaveLength(1);
  });

  it.each([
    [400, 400, '8px'],
    [600, 600, '12px'],
    [900, 900, '16px'],
    [400, 214, '8px'],
  ])(
    'uses a compact PDF label at %s x %s without changing Web metadata',
    (width, height, webGap) => {
      for (const image of [undefined, '/cover.jpg']) {
        render({ width, height, image });
        expect(
          container.querySelector('.preview-card__metadata')?.textContent,
        ).toBe('PDF');
        expect(
          container.querySelector('.preview-card__metadata svg'),
        ).toBeNull();
        const heading = container.querySelector('.preview-card__heading');
        const labelParent = image
          ? container.querySelector('.preview-card__cover-label')
          : heading;
        expect(
          labelParent?.querySelector('.preview-card__type-label')?.textContent,
        ).toBe('PDF');
        const label = labelParent?.querySelector('.preview-card__type-label');
        expect(label?.classList.contains('bg-inverse')).toBe(!!image);
        expect(label?.classList.contains('text-fg-inverse')).toBe(!!image);
        expect(label?.classList.contains('border-fg-inverse/25')).toBe(!!image);
        expect(label?.classList.contains('bg-bg-default')).toBe(!image);
        expect(
          container.querySelectorAll('.preview-card__type-label'),
        ).toHaveLength(1);
        if (image) {
          expect(
            heading?.querySelector('.preview-card__type-label'),
          ).toBeNull();
        }
        expect(heading?.querySelector('h3')?.textContent).toBe(
          'A real document',
        );

        render({
          width,
          height,
          image,
          nodeType: 'web',
          source: 'example.com',
        });
        expect(
          container.querySelector('.preview-card__metadata')?.textContent,
        ).toBe('example.com');
        expect(
          container.querySelector('.preview-card__metadata svg'),
        ).not.toBeNull();
        expect(container.querySelector('.preview-card__heading')).toBeNull();
        expect(
          container
            .querySelector<HTMLElement>('.preview-card')
            ?.style.getPropertyValue('--card-title-gap'),
        ).toBe(webGap);
      }
    },
  );

  it('moves the PDF label from the preview to the heading on failure and back on retry', () => {
    render({ image: '/cover.jpg', summary: 'Document summary' });
    expect(
      container.querySelector('.preview-card__cover-label')?.textContent,
    ).toBe('PDF');
    imageEvent('error');
    expect(container.querySelector('.preview-card__cover-label')).toBeNull();
    expect(
      container.querySelector(
        '.preview-card__heading .preview-card__type-label',
      )?.textContent,
    ).toBe('PDF');
    act(() =>
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(
      container.querySelector('.preview-card__cover-label')?.textContent,
    ).toBe('PDF');
    expect(
      container.querySelector(
        '.preview-card__heading .preview-card__type-label',
      ),
    ).toBeNull();
  });

  it.each([
    [400, 400, 'S', 'vertical'],
    [600, 600, 'M', 'vertical'],
    [900, 900, 'L', 'vertical'],
    [1000, 300, 'S', 'horizontal'],
    [1600, 500, 'M', 'horizontal'],
    [2500, 800, 'L', 'horizontal'],
    [400, 214, 'S', 'horizontal'],
    [1000, 500, 'M', 'horizontal'],
  ])(
    'uses outer geometry %s × %s for tier %s and %s layout',
    (width, height, tier, orientation) => {
      render({ width, height, image: '/cover.jpg' });
      const card = container.querySelector<HTMLElement>('.preview-card');
      if (!card) throw new Error('Missing preview card');
      expect(card.dataset.tier).toBe(tier);
      expect(card.dataset.orientation).toBe(orientation);
      expect(
        parseFloat(card.style.getPropertyValue('--card-title')),
      ).toBeCloseTo(NODE_CARD_TYPOGRAPHY.title);
      expect(
        parseFloat(card.style.getPropertyValue('--card-padding')),
      ).toBeCloseTo(nodeContentSpacingForWidth(Number(width)).padding);
      expect(card.style.transform).toBe('');
      expect(card.style.borderRadius).toBe('');
    },
  );

  it('keeps metadata and title visible while the image loads', () => {
    render({ image: '/cover.jpg', imageAlt: 'First page' });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('A real document');
    expect(container.querySelector('img')?.alt).toBe('First page');
    imageEvent('load');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.preview-card__image')).not.toBeNull();
  });

  it('fits horizontal summaries to the remaining height, including more than six lines', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(650);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('preview-card__title') ? 48 : 18;
      },
    );
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          paddingTop: '0',
          paddingBottom: '0',
          marginTop: '0',
          marginBottom: '0',
        }) as CSSStyleDeclaration,
    );
    const props = {
      nodeType: 'web',
      width: 960,
      height: 300,
      image: '/cover.jpg',
      summary: 'A detailed summary.',
    };
    render(props);
    const card = () => {
      const element = container.querySelector<HTMLElement>('.preview-card');
      if (!element) throw new Error('Missing preview card');
      return element;
    };
    expect(card().style.getPropertyValue('--card-summary-lines')).toBe('22');
    render({ ...props, width: 400, height: 400 });
    expect(card().style.getPropertyValue('--card-summary-lines')).toBe('2');
    render({ ...props, image: undefined });
    expect(card().style.getPropertyValue('--card-summary-lines')).toBe('6');
  });

  it('replaces failed cached PDF covers with a translated fallback, not an endless loader', () => {
    render({ image: '/cached-cover.jpg', loading: true });
    imageEvent('error');
    expect(container.querySelector('.preview-card__image')).toBeNull();
    expect(container.querySelector('[data-loading]')).toBeNull();
    expect(container.textContent).toContain('node.previewFailed');
    expect(container.querySelector('.preview-card__metadata svg')).toBeNull();
    render({ image: '/replacement.jpg' });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    imageEvent('load');
    expect(container.querySelector('.preview-card__fallback')).toBeNull();
  });

  it('falls back from a web image to favicon and from failed favicons to the type icon', () => {
    render({
      nodeType: 'web',
      source: 'example.com',
      image: '/screenshot.jpg',
      favicon: '/favicon.ico',
    });
    imageEvent('error');
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('example.com');
    const favicons = container.querySelectorAll('img');
    expect(favicons).toHaveLength(1);
    act(() => {
      favicons.forEach((image) => image.dispatchEvent(new Event('error')));
    });
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    render({ nodeType: 'web', source: 'example.com', favicon: '/new.ico' });
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('shows unavailable and source-error states without hiding their details', () => {
    render({ loading: true });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render({ loading: true, error: 'The preview request failed' });
    expect(container.querySelector('[data-loading]')).toBeNull();
    expect(container.textContent).toContain('node.previewFailed');
    expect(
      container.querySelector('.preview-card__error')?.getAttribute('title'),
    ).toBe('The preview request failed');
  });

  it.each([
    [400, 214],
    [400, 400],
    [960, 300],
  ])(
    'uses a full-width text card at %s x %s without a missing-cover label',
    (width, height) => {
      render({ width, height, summary: 'Real summary' });
      expect(
        container
          .querySelector('.preview-card')
          ?.getAttribute('data-orientation'),
      ).toBe('text');
      expect(container.querySelector('.preview-card__cover')).toBeNull();
      expect(container.querySelector('.preview-card__error')).toBeNull();
      expect(container.textContent).not.toContain('node.noPreview');
      expect(
        container
          .querySelector<HTMLElement>('.preview-card')
          ?.style.getPropertyValue('--card-summary-lines'),
      ).toBe('6');
      expect(
        container
          .querySelector<HTMLElement>('.preview-card')
          ?.style.getPropertyValue('--card-padding'),
      ).toBe(`${nodeContentSpacingForWidth(width).padding}px`);
    },
  );

  it('retries an image without losing content or propagating the click', () => {
    const parentClick = vi.fn();
    document.body.addEventListener('click', parentClick);
    render({ image: '/same-cover.jpg', summary: 'Keep this summary' });
    imageEvent('error');
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    document.body.removeEventListener('click', parentClick);
    expect(parentClick).not.toHaveBeenCalled();
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('src'),
    ).toBe('/same-cover.jpg');
    expect(container.querySelector('[data-loading]')).not.toBeNull();
    imageEvent('load');
    expect(container.querySelector('.preview-card__error')).toBeNull();
    expect(container.textContent).toContain('Keep this summary');
  });

  it.each([
    ['pdf', 'source'],
    ['pdf', 'image'],
    ['web', 'source'],
    ['web', 'image'],
  ])(
    'isolates %s %s retry navigation without cancelling native defaults',
    (nodeType, failure) => {
      const retry = vi.fn();
      render({
        nodeType,
        ...(failure === 'source'
          ? { error: 'Source failed', onRetry: retry }
          : { image: '/failed-cover.jpg' }),
      });
      if (failure === 'image') imageEvent('error');
      const button = container.querySelector('button');
      expect(button).not.toBeNull();
      const ancestor = vi.fn();
      const keyup = vi.fn();
      document.body.addEventListener('keydown', ancestor);
      document.body.addEventListener('keyup', keyup);
      try {
        button?.focus();
        for (const key of [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          ' ',
        ]) {
          for (const shiftKey of [false, true]) {
            const event = new KeyboardEvent('keydown', {
              key,
              shiftKey,
              bubbles: true,
              cancelable: true,
            });
            act(() => button?.dispatchEvent(event));
            expect(ancestor).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
          }
        }
        expect(retry).not.toHaveBeenCalled();
        for (const key of ['Enter', 'Escape', 'Tab']) {
          ancestor.mockClear();
          const event = new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          });
          act(() => button?.dispatchEvent(event));
          expect(ancestor).toHaveBeenCalledOnce();
          expect(event.defaultPrevented).toBe(false);
        }
        act(() =>
          button?.dispatchEvent(
            new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
          ),
        );
        expect(keyup).toHaveBeenCalledOnce();
      } finally {
        document.body.removeEventListener('keydown', ancestor);
        document.body.removeEventListener('keyup', keyup);
      }
    },
  );

  it('requests a source retry only when the user asks', () => {
    const retry = vi.fn();
    render({ error: 'Source failed', onRetry: retry });
    expect(retry).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(retry).toHaveBeenCalledOnce();
  });
});
