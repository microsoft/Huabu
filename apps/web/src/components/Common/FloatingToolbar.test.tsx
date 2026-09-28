// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/resources/en/common.json';
import zh from '@/i18n/resources/zh-CN/common.json';

import { FloatingToolbar } from './FloatingToolbar';

const translations = createInstance();
void translations.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
});

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function render(element: React.JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  act(() => {
    root.render(
      <I18nextProvider i18n={translations}>{element}</I18nextProvider>,
    );
  });
  return container;
}

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  for (const container of containers) {
    container.remove();
  }
  roots = [];
  containers = [];
  document.body.replaceChildren();
});

describe('FloatingToolbar.ColorPicker', () => {
  it('keeps portal swatch clicks alive after mousedown', () => {
    const picked: string[] = [];
    const container = render(
      <FloatingToolbar.ColorPicker
        colors={[{ token: 'red', name: 'Red', value: '#f00' }]}
        value={null}
        onSelect={(token) => picked.push(token)}
        title=""
      />,
    );

    const trigger = container.querySelector('button');
    expect(trigger).not.toBeNull();
    expect(trigger?.classList.contains('bg-bg-default')).toBe(true);
    expect(trigger?.classList.contains('rounded-md')).toBe(true);

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const redSwatch = document.body.querySelector(
      'button[aria-label="Red"]',
    ) as HTMLButtonElement | null;
    expect(redSwatch).not.toBeNull();
    expect(redSwatch?.closest('div.flex.gap-0')).not.toBeNull();
    expect(redSwatch?.classList.contains('h-6')).toBe(true);
    expect(redSwatch?.classList.contains('min-h-6')).toBe(true);
    expect(redSwatch?.classList.contains('w-6')).toBe(true);
    expect(redSwatch?.classList.contains('min-w-6')).toBe(true);
    expect(redSwatch?.classList.contains('enabled:hover:bg-transparent')).toBe(
      true,
    );
    expect(redSwatch?.classList.contains('enabled:hover:bg-hover')).toBe(false);

    const redDot = redSwatch?.querySelector('span[aria-hidden]');
    expect(redDot?.classList.contains('border-solid')).toBe(true);
    expect(redDot?.classList.contains('h-3.5')).toBe(true);
    expect(redDot?.classList.contains('w-3.5')).toBe(true);

    act(() => {
      redSwatch?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(picked).toEqual(['red']);
  });
});

describe('FloatingToolbar floating controls', () => {
  it('selects an option and closes the anchored menu', async () => {
    const onChange = vi.fn();
    const container = render(
      <FloatingToolbar.Select
        floating
        label="Line type"
        value="straight"
        options={[
          { value: 'straight', label: 'Straight' },
          { value: 'bezier', label: 'Curve' },
        ]}
        onChange={onChange}
      />,
    );
    await act(async () => container.querySelector('button')?.click());
    const items =
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('aria-current')).toBe('true');
    await act(async () => items[1].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('bezier');
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('keeps all alignment actions in an anchored panel and closes on selection', async () => {
    const onAlign = vi.fn();
    const container = render(
      <FloatingToolbar.AlignPicker
        floating
        onAlign={onAlign}
        onSpread={vi.fn()}
      />,
    );
    await act(async () => container.querySelector('button')?.click());
    const panel = document.querySelector('[data-floating-chrome]');
    const buttons = panel?.querySelectorAll('button');
    expect(buttons).toHaveLength(7);
    expect(
      panel?.querySelectorAll(
        '[role="separator"][aria-orientation="vertical"]',
      ),
    ).toHaveLength(2);
    await act(async () => buttons?.[0].click());
    expect(onAlign).toHaveBeenCalledExactlyOnceWith('left');
    expect(document.querySelector('[data-floating-chrome]')).toBeNull();
  });
});

describe('FloatingToolbar.NumberInput', () => {
  it.each(['Enter', 'Escape'])(
    'handles %s without a second blur commit',
    (key) => {
      const onApply = vi.fn();
      const container = render(
        <FloatingToolbar.NumberInput
          label="Width"
          ariaLabel="Width"
          name="width"
          value={320}
          applyUnchanged
          onApply={onApply}
        />,
      );
      const input = container.querySelector('input');
      if (!input) throw new Error('Missing width input');
      act(() => input.focus());
      act(() =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        ),
      );
      expect(onApply).toHaveBeenCalledTimes(key === 'Enter' ? 1 : 0);
      expect(input.value).toBe('320');
      act(() => input.focus());
      act(() => input.blur());
      expect(onApply).toHaveBeenCalledTimes(key === 'Enter' ? 2 : 1);
    },
  );

  it('can commit the displayed count and restore the resolved value', () => {
    const onApply = vi.fn(() => 4);
    const container = render(
      <FloatingToolbar.NumberInput
        label="Rows"
        ariaLabel="Rows"
        name="rows"
        value={4}
        applyUnchanged
        onApply={onApply}
      />,
    );
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing row input');
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(onApply).toHaveBeenCalledExactlyOnceWith(4);
    expect(input.value).toBe('4');
  });
});

describe('FloatingToolbar.SizePicker', () => {
  it.each([true, false])(
    'separates the both-axis toggle from individual input capsules when active=%s',
    (active) => {
      const container = render(
        <FloatingToolbar.SizePicker
          width={320}
          height={180}
          onApply={vi.fn()}
          autoSize={{
            dimensions: 'both',
            togglePosition: 'start',
            appearance: 'separate',
            active,
            onToggle: vi.fn(),
          }}
        />,
      );
      expect(container.querySelectorAll('.bg-bg-default')).toHaveLength(2);
      expect(
        container.querySelector('button')?.closest('.bg-bg-default'),
      ).toBeNull();
      expect(container.querySelector('.bg-edge-default')).toBeNull();
      expect(container.firstElementChild?.classList.contains('gap-2')).toBe(
        true,
      );
    },
  );

  it.each([undefined, 'start', 'end'] as const)(
    'positions the both-axis toggle at %s without changing its behavior',
    (togglePosition) => {
      const onToggle = vi.fn();
      const container = render(
        <FloatingToolbar.SizePicker
          width={320}
          height={180}
          onApply={vi.fn()}
          autoSize={{
            dimensions: 'both',
            active: false,
            togglePosition,
            onToggle,
          }}
        />,
      );
      const controls = Array.from(container.querySelectorAll('button, input'));
      expect(controls.map((control) => control.tagName)).toEqual(
        togglePosition === 'start'
          ? ['BUTTON', 'INPUT', 'INPUT']
          : ['INPUT', 'INPUT', 'BUTTON'],
      );
      act(() => container.querySelector('button')?.click());
      expect(onToggle).toHaveBeenCalledOnce();
    },
  );

  it('renders auto height as static text with a 24px mode target', () => {
    const onToggle = vi.fn();
    const container = render(
      <FloatingToolbar.SizePicker
        width={320}
        height={180}
        onApply={vi.fn()}
        autoSize={{ active: true, onToggle }}
      />,
    );

    expect(container.querySelector('input[aria-label="Height"]')).toBeNull();

    const autoValue = container.querySelector('span.text-fg-muted.italic');
    expect(autoValue?.tagName).toBe('SPAN');
    expect(autoValue?.classList.contains('h-6')).toBe(true);
    expect(autoValue?.classList.contains('text-fg-subtle')).toBe(false);

    const toggle = container.querySelector('button');
    expect(toggle?.classList.contains('h-6')).toBe(true);
    expect(toggle?.classList.contains('w-6')).toBe(true);

    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it.each([
    ['en', 'Width', 'Height'],
    ['zh-CN', '宽度', '高度'],
  ])(
    'localizes %s dimensions and keeps the 24px input target',
    async (language, widthLabel, heightLabel) => {
      await translations.changeLanguage(language);
      const container = render(
        <FloatingToolbar.SizePicker
          width={320}
          height={180}
          onApply={vi.fn()}
          autoSize={{ active: false, onToggle: vi.fn() }}
        />,
      );

      const heightInput = container.querySelector(
        `input[aria-label="${heightLabel}"]`,
      );
      const widthInput = container.querySelector(
        `input[aria-label="${widthLabel}"]`,
      );
      expect(widthInput?.getAttribute('name')).toBe('node-width');
      expect(heightInput?.getAttribute('name')).toBe('node-height');
      expect(heightInput?.classList.contains('h-6')).toBe(true);
      expect(container.querySelector('button')?.classList.contains('h-6')).toBe(
        true,
      );
    },
  );
});
