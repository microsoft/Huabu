// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerFilterBar } from './LayerFilterBar';

import type { LayerFilterKey } from './layerFilterKey';
import type * as DropdownMenuExports from '../../Common/DropdownMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { label?: string; count?: number }) =>
      values?.label
        ? `${key}:${values.label}`
        : values?.count
          ? `${key}:${values.count}`
          : key,
  }),
}));
vi.mock('../../Common/DropdownMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof DropdownMenuExports>()),
  DropdownMenu: ({
    trigger,
    children,
  }: {
    trigger: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {trigger}
      <div data-overflow-menu>{children}</div>
    </>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FILTER_KEYS: LayerFilterKey[] = [
  'note',
  'text',
  'image',
  'pdf',
  'office:docx',
  'office:xlsx',
  'question',
];
let container: HTMLDivElement;
let root: Root;
let rowWidth: number;
let measure: (() => void) | undefined;
const toggleAll = vi.fn();

function FilterHarness({
  keys = FILTER_KEYS,
  hasAnyFrame = true,
  isSearchActive = false,
}: {
  keys?: LayerFilterKey[];
  hasAnyFrame?: boolean;
  isSearchActive?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState(new Set<LayerFilterKey>());
  return (
    <LayerFilterBar
      availableKeys={keys}
      selectedKeys={selectedKeys}
      onToggleKey={(key) =>
        setSelectedKeys((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })
      }
      hasAnyFrame={hasAnyFrame}
      hasAnyExpandedFrame
      onToggleAllFrames={toggleAll}
      isSearchActive={isSearchActive}
    />
  );
}

function moreButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label^="layers.moreFilters"]',
  );
  if (!button) throw new Error('Missing overflow filter trigger');
  return button;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rowWidth = 150;
  measure = undefined;
  toggleAll.mockClear();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute('data-layer-filter-chips') ? rowWidth : 0;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('single-line Layers filters', () => {
  it('uses 14px subtle Lucide icons across filters and overflow', () => {
    act(() => root.render(<FilterHarness />));
    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.getAttribute('width')).toBe('14');
      expect(icon.getAttribute('height')).toBe('14');
      expect(icon.classList.contains('lucide')).toBe(true);
      expect(icon.classList.contains('h-3.5!')).toBe(true);
      expect(icon.classList.contains('w-3.5!')).toBe(true);
      expect(
        icon.classList.contains('text-fg-subtle') ||
          icon.closest('button')?.classList.contains('text-fg-subtle'),
      ).toBe(true);
    }
  });

  it.each([
    [24, 0],
    [50, 1],
    [76, 2],
    [102, 3],
    [128, 4],
    [154, 5],
    [179, 5],
    [180, 7],
  ])(
    'fits %s px with %s visible types, reserving More only when needed',
    (width, count) => {
      rowWidth = width;
      act(() => root.render(<FilterHarness />));

      expect(
        container.querySelectorAll('[data-layer-filter-key]'),
      ).toHaveLength(count);
      expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(
        FILTER_KEYS.length - count,
      );
      expect(
        container.querySelector('[data-layer-filter-chips]')?.className,
      ).not.toContain('flex-wrap');
      expect(
        container.querySelector('[aria-label^="layers.moreFilters"]') !== null,
      ).toBe(count < FILTER_KEYS.length);
    },
  );

  it('preserves hidden selections when widening and narrowing the panel', () => {
    act(() => root.render(<FilterHarness />));
    const question = container.querySelector<HTMLButtonElement>(
      '[aria-label="layers.filterBy:layers.filterLabels.question"]',
    );
    if (!question) throw new Error('Missing hidden Question filter');
    act(() => question.click());
    expect(moreButton().className).toContain('bg-info-bg');
    expect(moreButton().getAttribute('aria-label')).toBe(
      'layers.moreFiltersActive:1',
    );
    expect(
      container.querySelector(
        '[aria-label^="layers.stopFilteringBy"] svg.text-info',
      ),
    ).not.toBeNull();

    rowWidth = 180;
    act(() => measure?.());
    expect(
      container
        .querySelector('[data-layer-filter-key="question"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(container.querySelector('[data-overflow-menu]')).toBeNull();

    rowWidth = 50;
    act(() => measure?.());
    expect(moreButton().getAttribute('aria-label')).toBe(
      'layers.moreFiltersActive:1',
    );
    const activeQuestion = container.querySelector<HTMLButtonElement>(
      '[aria-label="layers.stopFilteringBy:layers.filterLabels.question"]',
    );
    act(() => activeQuestion?.click());
    expect(moreButton().getAttribute('aria-label')).toBe('layers.moreFilters');
  });

  it('retains separate Office-format keys in the overflow menu', () => {
    rowWidth = 50;
    act(() => root.render(<FilterHarness />));
    const word = container.querySelector<HTMLButtonElement>(
      '[aria-label="layers.filterBy:layers.filterLabels.office.docx"]',
    );
    const excel = container.querySelector<HTMLButtonElement>(
      '[aria-label="layers.filterBy:layers.filterLabels.office.xlsx"]',
    );
    if (!word || !excel) throw new Error('Missing Office-format filters');

    act(() => word.click());
    expect(moreButton().getAttribute('aria-label')).toBe(
      'layers.moreFiltersActive:1',
    );
    act(() => excel.click());
    expect(moreButton().getAttribute('aria-label')).toBe(
      'layers.moreFiltersActive:2',
    );
  });

  it('keeps the bulk-disclosure action outside the overflow menu', () => {
    rowWidth = 24;
    act(() => root.render(<FilterHarness />));
    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="layers.collapseAllFrames"]',
    );
    if (!collapse) throw new Error('Missing bulk-disclosure action');
    expect(collapse.closest('[data-layer-filter-chips]')).toBeNull();
    act(() => collapse.click());
    expect(toggleAll).toHaveBeenCalledOnce();

    act(() => root.render(<FilterHarness isSearchActive />));
    expect(
      container.querySelector('[aria-label="layers.collapseAllFrames"]'),
    ).toBeNull();
  });

  it('does not leave an empty toolbar when there is only one type and no Frames', () => {
    act(() =>
      root.render(<FilterHarness keys={['note']} hasAnyFrame={false} />),
    );
    expect(container.childElementCount).toBe(0);

    act(() => root.render(<FilterHarness />));
    expect(container.querySelector('[data-layer-filter-chips]')).not.toBeNull();
    expect(container.querySelectorAll('[data-layer-filter-key]')).toHaveLength(
      4,
    );
  });
});
