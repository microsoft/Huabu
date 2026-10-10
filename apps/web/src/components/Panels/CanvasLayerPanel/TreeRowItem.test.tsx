// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeRowItem } from './TreeRowItem';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Layers row presentation', () => {
  it.each([false, true])(
    'retains selected backgrounds on hover (selected: %s)',
    (isSelected) => {
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Note"
            isSelected={isSelected}
          />,
        ),
      );
      const surface = container.querySelector('.group');
      expect(surface?.classList.contains('hover:bg-info-bg')).toBe(isSelected);
      expect(surface?.classList.contains('hover:bg-hover')).toBe(!isSelected);
    },
  );

  it.each([false, true])(
    'reveals row actions for keyboard focus (external: %s)',
    (isExternal) => {
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Note"
            isExternal={isExternal}
            onImport={vi.fn()}
            onToggleLock={vi.fn()}
          />,
        ),
      );
      const action = container.querySelector('button');
      expect(
        action?.classList.contains('group-focus-within/layer-row:opacity-100'),
      ).toBe(true);
      expect(
        action?.classList.contains('group-hover/layer-row:opacity-100'),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'outlines only a collapsed Frame drop target (collapsed: %s)',
    (isCollapsed) => {
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Frame"
            isCollapsible
            isCollapsed={isCollapsed}
            isDragActive
            dropIntent={isCollapsed ? 'into' : 'after'}
            isIntoFrameHighlight
          />,
        ),
      );
      const surface = container.querySelector('.group');
      expect(surface?.classList.contains('outline-solid')).toBe(isCollapsed);
      expect(surface?.classList.contains('outline-dashed')).toBe(false);
      expect(surface?.classList.contains('bg-info-bg')).toBe(false);
      expect(surface?.classList.contains('hover:bg-hover')).toBe(false);
    },
  );

  function renameInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      'input[name="layer-name"]',
    );
    if (!input) throw new Error('Missing inline rename input');
    return input;
  }

  function changeName(value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!setter) throw new Error('Missing input value setter');
    setter.call(renameInput(), value);
    renameInput().dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('uses normal text and focus chrome while editing a selected row without activating it', () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <TreeRowItem
          depth={0}
          icon={<span />}
          label="Note"
          editable
          isSelected
          onClick={onClick}
        />,
      ),
    );
    const row = container.firstElementChild;
    if (!row) throw new Error('Missing row');
    expect(container.querySelector('input')).toBeNull();
    act(() => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = renameInput();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Note');
    expect(input.classList.contains('text-sm')).toBe(true);
    expect(input.classList.contains('text-fg-default')).toBe(true);
    expect(input.classList.contains('text-info')).toBe(false);
    expect(input.classList.contains('bg-surface')).toBe(true);
    expect(input.classList.contains('border')).toBe(true);
    expect(input.classList.contains('focus:border-info')).toBe(true);
    expect(input.classList.contains('focus:ring-info/20')).toBe(true);
    expect(
      container
        .querySelector('span.pointer-events-none')
        ?.classList.contains('text-fg-subtle'),
    ).toBe(true);
    act(() => input.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps the type icon subtle unless selected (selected: %s)',
    (isSelected) => {
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Note"
            isSelected={isSelected}
          />,
        ),
      );
      const icon = container.querySelector('span.pointer-events-none');
      expect(
        icon?.classList.contains(isSelected ? 'text-info' : 'text-fg-subtle'),
      ).toBe(true);
      expect(icon?.classList.contains('text-fg-muted')).toBe(false);
      expect(
        container
          .querySelector('span.truncate')
          ?.classList.contains(isSelected ? 'text-info' : 'text-fg-default'),
      ).toBe(true);
    },
  );

  it.each(['Enter', 'Escape', 'blur'])(
    'preserves %s rename behavior',
    (action) => {
      const onRename = vi.fn();
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Note"
            editable
            onRename={onRename}
          />,
        ),
      );
      const row = container.firstElementChild;
      if (!row) throw new Error('Missing row');
      act(() =>
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
      );
      act(() => changeName('Renamed note'));
      act(() => {
        if (action === 'blur') renameInput().blur();
        else
          renameInput().dispatchEvent(
            new KeyboardEvent('keydown', { key: action, bubbles: true }),
          );
      });
      expect(container.querySelector('input')).toBeNull();
      if (action === 'Escape') expect(onRename).not.toHaveBeenCalled();
      else expect(onRename).toHaveBeenCalledExactlyOnceWith('Renamed note');
    },
  );

  it.each([false, Promise.resolve(false)])(
    'retains the persisted name after a rejected rename (%s)',
    async (result) => {
      const onRename = vi.fn(() => result);
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Note"
            editable
            onRename={onRename}
          />,
        ),
      );
      const row = container.firstElementChild;
      if (!row) throw new Error('Missing row');
      act(() =>
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
      );
      act(() => changeName('Rejected name'));
      await act(async () => {
        renameInput().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(onRename).toHaveBeenCalledExactlyOnceWith('Rejected name');
      expect(container.querySelector('span.truncate')?.textContent).toBe(
        'Note',
      );
      act(() =>
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
      );
      expect(renameInput().value).toBe('Note');
    },
  );

  it('draws keyboard focus on the inset rounded surface rather than the outer row', () => {
    act(() =>
      root.render(
        <TreeRowItem
          depth={0}
          icon={<span />}
          label="Selected note"
          isSelected
        />,
      ),
    );
    const row = container.firstElementChild;
    const surface = container.querySelector('.group.bg-info-bg');
    if (!row || !surface) throw new Error('Missing row or surface');
    expect(row.classList.contains('group/layer-row')).toBe(true);
    expect(row.classList.contains('h-8.5')).toBe(true);
    expect(surface.classList.contains('h-8')).toBe(true);
    expect(row.classList.contains('focus-visible:ring-2')).toBe(false);
    expect(surface.classList.contains('rounded-md')).toBe(true);
    expect(
      surface.classList.contains('group-focus-visible/layer-row:ring-2'),
    ).toBe(true);
    expect(
      surface.classList.contains('group-focus-visible/layer-row:ring-inset'),
    ).toBe(true);
    expect(surface.classList.contains('ring-1')).toBe(false);
  });

  it.each(['mousedown', 'touchstart'])(
    'starts %s dragging from the label and row whitespace, not controls',
    (eventType) => {
      const startDrag = vi.fn();
      act(() =>
        root.render(
          <TreeRowItem
            depth={0}
            icon={<span />}
            label="Frame"
            isCollapsible
            onToggleCollapse={vi.fn()}
            onToggleLock={vi.fn()}
            dndListeners={{ onMouseDown: startDrag, onTouchStart: startDrag }}
          />,
        ),
      );
      const row = container.firstElementChild;
      const label = container.querySelector('span.truncate');
      if (!row || !label) throw new Error('Missing row or label');
      for (const target of [row, label]) {
        act(() =>
          target.dispatchEvent(new Event(eventType, { bubbles: true })),
        );
      }
      expect(startDrag).toHaveBeenCalledTimes(2);
      for (const button of container.querySelectorAll('button')) {
        const target = button.querySelector('svg') ?? button;
        act(() =>
          target.dispatchEvent(new Event(eventType, { bubbles: true })),
        );
      }
      expect(startDrag).toHaveBeenCalledTimes(2);
      expect(row.classList.contains('touch-none')).toBe(false);
      expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
    },
  );

  it.each(['mousedown', 'touchstart'])(
    'does not start %s dragging while renaming or on external rows',
    (eventType) => {
      const startDrag = vi.fn();
      const props = {
        depth: 0,
        icon: <span />,
        label: 'Note',
        dndListeners: { onMouseDown: startDrag, onTouchStart: startDrag },
      };
      act(() => root.render(<TreeRowItem {...props} editable />));
      const row = container.firstElementChild;
      if (!row) throw new Error('Missing row');
      act(() =>
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
      );
      const input = container.querySelector('input');
      if (!input) throw new Error('Missing rename input');
      for (const target of [row, input]) {
        act(() =>
          target.dispatchEvent(new Event(eventType, { bubbles: true })),
        );
      }
      expect(startDrag).not.toHaveBeenCalled();

      act(() =>
        root.render(<TreeRowItem key="external" {...props} isExternal />),
      );
      const externalRow = container.firstElementChild;
      if (!externalRow) throw new Error('Missing external row');
      act(() =>
        externalRow.dispatchEvent(new Event(eventType, { bubbles: true })),
      );
      expect(startDrag).not.toHaveBeenCalled();
    },
  );

  it('keeps disclosure visible and separate from row activation', () => {
    const onClick = vi.fn();
    const onToggleCollapse = vi.fn();
    act(() =>
      root.render(
        <TreeRowItem
          depth={0}
          icon={<span />}
          label="Frame"
          isCollapsible
          onClick={onClick}
          onToggleCollapse={onToggleCollapse}
        />,
      ),
    );
    const disclosure =
      container.querySelector<HTMLButtonElement>('[aria-expanded]');
    if (!disclosure) throw new Error('Missing Frame disclosure');

    expect(disclosure.className).not.toContain('opacity-0');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    act(() => disclosure.click());
    expect(onToggleCollapse).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('indents content inside a full-width rounded selection surface', () => {
    act(() =>
      root.render(
        <TreeRowItem
          depth={2}
          icon={<span />}
          label="Nested note"
          isSelected
          dropIntent="after"
        />,
      ),
    );
    const row = container.firstElementChild;
    const surface =
      container.querySelector<HTMLDivElement>('.group.bg-info-bg');
    const caret = container.querySelector<HTMLSpanElement>('span.right-2');

    expect(row).toBeInstanceOf(HTMLDivElement);
    expect((row as HTMLDivElement).style.paddingLeft).toBe('');
    expect(surface?.classList.contains('w-full')).toBe(true);
    expect(surface?.classList.contains('rounded-md')).toBe(true);
    expect(surface?.style.paddingLeft).toBe('48px');
    expect(caret?.style.left).toBe('56px');
  });

  it('aligns the drop caret with the destination depth, not the source', () => {
    act(() =>
      root.render(
        <TreeRowItem
          depth={0}
          icon={<span />}
          label="Moved note"
          dropIntent="before"
          dropIntentDepth={3}
        />,
      ),
    );

    expect(
      container.querySelector<HTMLSpanElement>('span.right-2')?.style.left,
    ).toBe('76px');
  });
});
