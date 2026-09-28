// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SemanticPlaceholder } from './SemanticPlaceholder';

import type { NodeData } from '@huabu/shared';

function render(data: NodeData, active = true) {
  return renderToStaticMarkup(
    <SemanticPlaceholder
      type={data.type}
      data={data}
      active={active}
      width={440}
      height={350}
      zoom={0.2}
    />,
  );
}

describe('Text-only minimal layer', () => {
  it.each(['中文标题', 'Long English title'])(
    'renders %s within reduced horizontal insets at 9.5%%',
    (title) => {
      const zoom = 0.095;
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        <SemanticPlaceholder
          type="note"
          data={{ type: 'note', label: title, content: '' }}
          active
          width={240}
          height={180}
          zoom={zoom}
        />,
      );
      const label = container.querySelector<HTMLElement>('[data-study-label]');
      if (!label) throw new Error('Missing far label');
      const left = parseFloat(label.style.left) * zoom;
      const width = parseFloat(label.style.width);
      expect(label.getAttribute('aria-hidden')).toBe('false');
      expect(left).toBeLessThan(6);
      expect(width).toBeGreaterThanOrEqual(12);
      expect(left * 2 + width).toBeCloseTo((240 - 6) * zoom);
      expect(container.querySelector('[data-study-title]')?.textContent).toBe(
        title,
      );
    },
  );

  it('renders a 12px title with 16px lines before measuring the Note description', () => {
    const html = renderToStaticMarkup(
      <SemanticPlaceholder
        type="note"
        data={{ type: 'note', label: 'Title', content: 'Existing body' }}
        label={{ title: 'Title', description: 'Existing body' }}
        active
        width={440}
        height={350}
        zoom={0.19}
      />,
    );
    expect(html).toContain('font-size:12px');
    expect(html).toContain('line-height:16px');
    expect(html).not.toContain('data-study-description');
    expect(html).not.toContain('Existing body');
  });

  it.each([
    [98, 3.5, true],
    [90, 2.5, true],
    [74, 0.5, true],
    [70, 0, true],
    [69, 0, false],
  ])(
    'uses reduced screen-space vertical inset for a %spx high Note',
    (height, inset, visible) => {
      const html = renderToStaticMarkup(
        <SemanticPlaceholder
          type="note"
          data={{ type: 'note', label: 'Title', content: '' }}
          active
          width={320}
          height={height}
          zoom={0.25}
        />,
      );
      const container = document.createElement('div');
      container.innerHTML = html;
      const label = container.querySelector<HTMLElement>('[data-study-label]')!;
      expect(parseFloat(label.style.top) * 0.25).toBeCloseTo(inset);
      expect(label.getAttribute('aria-hidden')).toBe(String(!visible));
    },
  );
  it.each([undefined, 'teal', 'white', 'grey', 'purple', '#008080'])(
    'inherits the existing shell instead of painting an accent surface (%s)',
    (accent) => {
      for (const active of [true, false]) {
        const html = render(
          {
            type: 'note',
            label: 'Readable Note',
            content: '',
            style: { accent },
          },
          active,
        );
        expect(html).not.toContain('background:');
        expect(html).toContain('text-fg-default');
        expect(html).not.toContain('color-mix');
        expect(html).toContain(`data-lod="${active ? 'minimal' : 'full'}"`);
      }
    },
  );

  it.each(['web', 'pdf', 'office', 'video'] as const)(
    'reuses %s shell styling and screen typography',
    (type) => {
      const html = render({
        type,
        format: 'docx',
        label: 'Other card',
        src: '',
        style: { accent: 'teal' },
      });
      expect(html).not.toContain('background:');
      expect(html).toContain('font-size:12px');
      expect(html).toContain('line-height:16px');
      expect(html).toContain('transform:scale(5)');
    },
  );
});
