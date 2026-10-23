// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeBoundaryForAccent } from '@/components/Nodes/design/nodeBoundary';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { CONVERSATION_CARD_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';

import SpacePreviewDesignPlaygroundPage from './SpacePreviewDesignPlaygroundPage';

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    'spacePreview.shortcutLabel': 'Shortcut',
    'toolbar.size.width': '宽度（画布单位）',
    'toolbar.size.switchFixedWidth': '切换为固定宽度',
    'toolbar.size.fitWidth': '适应内容宽度',
  };
  return {
    useTranslation: () => ({
      t: (key: string, values?: { count?: number; time?: string }) => {
        if (key === 'spacePreview.nodeCount') return `${values?.count} nodes`;
        if (key === 'spacePreview.updatedRelative')
          return `Updated ${values?.time}`;
        return labels[key] ?? key;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('lottie-react', () => ({ default: () => null }));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: { profiles: never[]; init: () => void }) => unknown,
  ) => selector({ profiles: [], init: vi.fn() }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SpacePreviewDesignPlaygroundPage />
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function choose(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (entry) =>
      entry.textContent === label || entry.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`Missing control: ${label}`);
  await act(async () => button.click());
}

async function setWidthInput(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="宽度（画布单位）"]',
  );
  if (!input) throw new Error('Missing width input');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Missing native input setter');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

function shell(specimen = 'reference') {
  const element = card(specimen).closest('.sp-design-movable');
  if (!(element instanceof HTMLDivElement))
    throw new Error('Missing shortcut shell');
  return element;
}

function card(specimen = 'primary') {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-specimen="${specimen}"] .sp-design-shortcut`,
  );
  if (!button) throw new Error(`Missing shortcut: ${specimen}`);
  return button;
}

function entryButton() {
  const button = container.querySelector<HTMLButtonElement>(
    '.sp-design-toolbar-slot button[aria-label="进入空间（演示）"]',
  );
  if (!button) throw new Error('Missing toolbar entry');
  return button;
}

describe('Space shortcut design playground', () => {
  it('renders the shortcut playground even with the retired snapshot query', async () => {
    await act(async () =>
      root.render(
        <MemoryRouter
          key="retired-snapshot"
          initialEntries={['/playground/space-previews?snapshot-source']}
        >
          <SpacePreviewDesignPlaygroundPage />
        </MemoryRouter>,
      ),
    );
    expect(container.querySelectorAll('.sp-design-shortcut')).toHaveLength(2);
    expect(container.querySelector('.sp-snapshot-fixture')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows compact references without images or preview controls', () => {
    expect(container.querySelectorAll('.sp-design-shortcut')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="application"]')).toBeNull();
    expect(
      card().querySelector('[data-space-type-icon] svg')?.getAttribute('width'),
    ).toBe('22');
    expect(card().querySelector('.lucide-arrow-up-right')).not.toBeNull();
    expect(card().getAttribute('aria-pressed')).toBe('false');
    expect(card('reference').getAttribute('aria-pressed')).toBe('true');
    expect(card().querySelector('button, a')).toBeNull();
    expect(container.querySelector('button[aria-label="尺寸"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="宽度设置"]'),
    ).not.toBeNull();
    expect(shell().style.width).toBe('400px');
    expect(container.textContent).not.toContain('重试快照');
    expect(container.querySelectorAll('.nt-toolbar')).toHaveLength(1);
    expect(entryButton().disabled).toBe(false);
  });

  it('edits only one reference and preserves width on rename without an automatic toggle', async () => {
    await choose('宽度设置');
    expect(document.querySelector('[aria-label="切换为固定宽度"]')).toBeNull();
    expect(document.querySelector('[aria-label="适应内容宽度"]')).toBeNull();
    await setWidthInput('320');
    expect(shell().style.width).toBe('320px');
    expect(shell('primary').style.width).toBe('400px');
    await choose('测试长标题');
    expect(shell().style.width).toBe('320px');
    expect(document.querySelector('input[aria-label*="高度"]')).toBeNull();
  });

  it('shares relative update time without changing width ownership', async () => {
    const summaries = container.querySelectorAll(
      '[data-space-shortcut-summary]',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0].textContent).toBe('2d ago');
    expect(summaries[1].textContent).toBe(summaries[0].textContent);
    expect(summaries[0].getAttribute('aria-label')).not.toContain('nodes');
    expect(summaries[0].getAttribute('aria-label')).not.toContain('days ago');
    expect(
      card().querySelector('.sp-design-copy .sp-design-title'),
    ).not.toBeNull();
    await choose('测试短标题');
    expect(shell().style.width).toBe('400px');
    expect(summaries[0].textContent).toBe('2d ago');
    await choose('空间失效');
    expect(container.querySelector('[data-space-shortcut-summary]')).toBeNull();
    expect(shell().style.width).toBe('400px');
    await choose('正常');
    expect(
      container.querySelectorAll('[data-space-shortcut-summary]'),
    ).toHaveLength(2);
  });

  it('uses the shared picker clamping, rounding and invalid-draft restoration', async () => {
    await choose('宽度设置');
    await setWidthInput('320');
    for (const value of ['', 'invalid', 'Infinity', '1e309']) {
      await setWidthInput(value);
      expect(shell().style.width).toBe('320px');
    }
    await setWidthInput('239');
    expect(shell().style.width).toBe('240px');
    await setWidthInput('300.5');
    expect(shell().style.width).toBe('301px');
    for (const value of ['240', '720', '721', '1200', '2400']) {
      await setWidthInput(value);
      expect(shell().style.width).toBe(`${value}px`);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
  });

  it('uses live geometry for keyboard resizing before the observer catches up', async () => {
    const node = card('reference').parentElement;
    const stage = shell().parentElement;
    const grip = node?.querySelector<HTMLButtonElement>('[data-side="right"]');
    if (!node || !stage || !grip) throw new Error('Missing resize surface');
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 720, 74),
    );
    Object.defineProperty(stage, 'clientWidth', {
      configurable: true,
      value: 800,
    });
    stage.style.paddingLeft = '24px';
    stage.style.paddingRight = '24px';
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(shell().style.width).toBe('736px');
    expect(card('reference').style.fontSize).toBe('24px');
  });

  it('keeps width controls usable for missing targets and records the experiment contract', async () => {
    await choose('空间失效');
    await choose('宽度设置');
    await setWidthInput('360');
    expect(shell().style.width).toBe('360px');
    expect(entryButton().disabled).toBe(true);
    expect(container.querySelectorAll('.sp-design-width-grip')).toHaveLength(2);
    expect(container.querySelector('.sp-design-rules')?.textContent).toContain(
      '最多两行',
    );
    expect(container.querySelector('.sp-design-rules')?.textContent).toContain(
      '宽度持久化',
    );
    await choose('重置样例');
    expect(shell().style.width).toBe('400px');
  });

  it('uses production boundary, radius, spacing, and typography values', async () => {
    // Happy DOM drops color-mix border values; inspect the assigned CSS.
    const borderColor = vi.spyOn(
      CSSStyleDeclaration.prototype,
      'borderColor',
      'set',
    );
    await act(async () =>
      root.render(
        <MemoryRouter key="boundary">
          <SpacePreviewDesignPlaygroundPage />
        </MemoryRouter>,
      ),
    );
    const boundary = nodeBoundaryForAccent(null);
    const typography = SPACE_CARD_TYPOGRAPHY.title;
    expect(card().style.borderWidth).toBe(`${boundary.borderWidth}px`);
    expect(
      borderColor.mock.calls.filter(
        (_, index) => borderColor.mock.contexts[index] === card().style,
      ),
    ).toEqual([[boundary.borderColor]]);
    borderColor.mockRestore();
    expect(card().style.padding).toBe(`${CONVERSATION_CARD_SPACING.padding}px`);
    expect(card().style.fontSize).toBe(`${typography.size}px`);
    expect(card().style.fontWeight).toBe(`${typography.weight}`);
    expect(card().style.lineHeight).toBe(`${typography.lineHeight}`);
    const height =
      2 * (CONVERSATION_CARD_SPACING.padding + boundary.borderWidth) +
      typography.size * typography.lineHeight +
      CONVERSATION_CARD_SPACING.rowGap +
      CONVERSATION_CARD_SPACING.footerHeight;
    expect(card().parentElement?.style.borderRadius).toBe(
      `${nodeMetricsForSize(420, height).radius}px`,
    );
  });

  it('keeps the title visible after deselection and preserves title gestures', async () => {
    await act(async () =>
      card('reference').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(container.querySelector('.nt-toolbar')).toBeNull();
    const marker = card().querySelector('.sp-design-title');
    if (!marker) throw new Error('Missing Space title');
    expect(marker.querySelector('button')).toBeNull();
    await act(async () =>
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(card().getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      marker.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('selects without navigating, opens on double-click, and deselects with Escape', async () => {
    await act(async () => card().click());
    expect(card().getAttribute('aria-pressed')).toBe('true');
    expect(card('reference').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      card().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '完整画布',
    );
    await choose('返回对比');
    await act(async () =>
      card().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(container.querySelector('.nt-toolbar')).toBeNull();
  });

  it('opens from the selected toolbar', async () => {
    await choose('进入空间（演示）');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await choose('返回对比');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('blocks every entry path only when the target is unavailable', async () => {
    await choose('空间失效');
    expect(entryButton().disabled).toBe(true);
    expect(container.querySelectorAll('.sp-design-unavailable')).toHaveLength(
      2,
    );
    await act(async () => card().click());
    expect(card().getAttribute('aria-pressed')).toBe('true');
    await act(async () =>
      card().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    await act(async () =>
      card().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await choose('正常');
    await act(async () =>
      card().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('updates the target title in both references and resets the demonstration', async () => {
    await choose('测试长标题');
    const titles = container.querySelectorAll('.sp-design-title');
    expect(titles[0].textContent).toBe(titles[1].textContent);
    expect(titles[0].textContent).toContain('下一阶段');
    await choose('空间失效');
    await choose('重置样例');
    expect(card().querySelector('.sp-design-title')?.textContent).toBe(
      'Design notebook',
    );
    expect(
      card().querySelector('[data-space-shortcut-summary]')?.textContent,
    ).toBe('2d ago');
    expect(entryButton().disabled).toBe(false);
    expect(card('reference').getAttribute('aria-pressed')).toBe('true');
  });
});
