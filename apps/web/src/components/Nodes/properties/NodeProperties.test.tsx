// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { NodeProperties } from './NodeProperties';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const save = vi.fn<(patch: unknown) => Promise<void>>();

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  save.mockReset().mockResolvedValue();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  readOnly = false,
  displayKeys = ['Venue'],
  properties: ComponentProps<typeof NodeProperties>['properties'] = {
    Venue: 'UIST',
    Score: 3,
  },
) {
  act(() =>
    root.render(
      <NodeProperties
        properties={properties}
        displayKeys={displayKeys}
        readOnly={readOnly}
        onSave={save}
      />,
    ),
  );
}
function click(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) =>
      item.getAttribute('aria-label') === label || item.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}
function input(label: string, value: string) {
  const element = container.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >(`input[aria-label="${label}"],textarea[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container.querySelector('form')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

it('opens the name menu and renames without making the value editable or changing its type', async () => {
  render();
  click('node.propertyOptions:Score');
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe(
    'node.renameProperty',
  );
  click('node.renameProperty');
  expect(
    container.querySelector('input[aria-label="node.propertyValue"]'),
  ).toBeNull();
  expect(container.querySelectorAll('input')).toHaveLength(1);
  input('node.propertyName', 'Conference');
  await submit();
  expect(save).toHaveBeenCalledWith({
    properties: { Score: null, Conference: 3 },
    propertyDisplayKeys: ['Venue', 'Conference'],
  });
  expect(container.querySelector('form')).toBeNull();
});

it('rejects duplicate names without submitting', async () => {
  render();
  click('node.propertyOptions:Score');
  click('node.renameProperty');
  input('node.propertyName', 'Venue');
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'node.propertiesNameError',
  );
  expect(save).not.toHaveBeenCalled();
});

it('edits only the value and rejects invalid numbers', async () => {
  render();
  click('node.editProperty:Score');
  expect(
    container.querySelector('input[aria-label="node.propertyName"]'),
  ).toBeNull();
  expect(container.querySelector('form')?.textContent).toContain('Score');
  input('node.propertyValue', 'Infinity');
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'node.propertiesNumberError',
  );
  expect(save).not.toHaveBeenCalled();
});

it('keeps the add entry in place but unavailable while editing an existing property', () => {
  render();
  const add = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'node.addProperty',
  );
  expect(add).toBeDefined();
  click('node.editProperty:Venue');
  expect(add?.isConnected).toBe(true);
  expect(add?.disabled).toBe(true);
  act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  );
  expect(add?.isConnected).toBe(true);
  expect(add?.disabled).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it('keeps the edited draft and surfaces save failures for retry', async () => {
  save.mockRejectedValueOnce(new Error('Revision conflict'));
  render();
  click('node.editProperty:Venue');
  input('node.propertyValue', 'DIS');
  await submit();
  expect(
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="node.propertyValue"]',
    )?.value,
  ).toBe('DIS');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Revision conflict',
  );
  await submit();
  expect(save).toHaveBeenCalledTimes(2);
  expect(container.querySelector('form')).toBeNull();
});

it('adds a property without resending the full record', async () => {
  render();
  click('node.addProperty');
  input('node.propertyName', 'Status');
  input('node.propertyValue', 'Reading');
  await submit();
  expect(save).toHaveBeenCalledWith({
    properties: { Status: 'Reading' },
    propertyDisplayKeys: ['Venue', 'Score', 'Status'],
  });
});

it.each(['blur', 'Enter'] as const)(
  'dismisses an empty new property on %s without saving or showing an error',
  async (trigger) => {
    render();
    click('node.addProperty');
    input('node.propertyName', '   ');
    input('node.propertyValue', '   ');
    if (trigger === 'Enter') await submit();
    else {
      await act(async () => {
        container.querySelector('input')?.dispatchEvent(
          new FocusEvent('focusout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
    }
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    click('node.addProperty');
    input('node.propertyName', 'Status');
    await submit();
    expect(save).toHaveBeenCalledWith({
      properties: { Status: '' },
      propertyDisplayKeys: ['Venue', 'Score', 'Status'],
    });
  },
);

it('retains a new value with a missing name, but dismisses it once both inputs are cleared', async () => {
  render();
  click('node.addProperty');
  input('node.propertyValue', 'Reading');
  await submit();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="node.propertyValue"]',
    )?.value,
  ).toBe('Reading');
  input('node.propertyValue', '');
  await submit();
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it('shows values without mutation controls in read-only Spaces', () => {
  render(true);
  expect(container.textContent).toContain('UIST');
  expect(container.querySelector('button, input, form')).toBeNull();
});

it('deletes from the name menu and removes the key from the saved order', async () => {
  render();
  click('node.propertyOptions:Venue');
  click('actions.delete');
  await act(async () => {});
  expect(save).toHaveBeenLastCalledWith({
    properties: { Venue: null },
    propertyDisplayKeys: ['Score'],
  });
});

it('has no separate options button or card visibility control', () => {
  render();
  click('node.propertyOptions:Venue');
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
  expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  expect(container.querySelectorAll('button')).toHaveLength(5);
});

it('renders persisted order and saves keyboard reordering without resending values', async () => {
  render(false, ['Score']);
  expect(
    [...container.querySelectorAll('[data-property-name]')].map((row) =>
      row.getAttribute('data-property-name'),
    ),
  ).toEqual(['Score', 'Venue']);
  const name = container.querySelector(
    '[aria-label="node.propertyOptions:Venue"]',
  );
  await act(async () => {
    name?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        altKey: true,
        bubbles: true,
      }),
    );
  });
  expect(save).toHaveBeenCalledWith({
    propertyDisplayKeys: ['Venue', 'Score'],
  });
});

it('reports reorder failures and never changes read-only order', async () => {
  save.mockRejectedValueOnce(new Error('Cannot save order'));
  render();
  const name = container.querySelector(
    '[aria-label="node.propertyOptions:Score"]',
  );
  await act(async () => {
    name?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        altKey: true,
        bubbles: true,
      }),
    );
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Cannot save order',
  );
  render(true);
  expect(container.querySelector('button')).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});

it('preserves commas within a tag and ignores a duplicate', async () => {
  render(false, [], { Topics: ['Old'] });
  click('node.editProperty:Topics');
  input('node.propertyValue', '  Canvas, Workspace ');
  await submit();
  expect(save).toHaveBeenCalledWith({
    properties: { Topics: ['Old', 'Canvas, Workspace'] },
  });
  save.mockClear();
  render(false, [], { Topics: ['Old'] });
  click('node.editProperty:Topics');
  input('node.propertyValue', 'Old');
  await submit();
  expect(save).toHaveBeenCalledWith({ properties: { Topics: ['Old'] } });
});

it('saves on leaving the editor without a button row or type selector', async () => {
  render();
  click('node.editProperty:Venue');
  expect(container.querySelector('form button')).toBeNull();
  input('node.propertyValue', 'DIS');
  const field = container.querySelector('textarea');
  await act(async () =>
    field?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
  );
  expect(save).toHaveBeenCalledWith({ properties: { Venue: 'DIS' } });
  expect(container.querySelector('form')).toBeNull();
});

it('does not resubmit on blur while an Enter save is pending', async () => {
  let finish: () => void = () => {};
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render();
  click('node.editProperty:Venue');
  input('node.propertyValue', 'DIS');
  await submit();
  await act(async () =>
    container
      .querySelector('input')
      ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
  );
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(container.querySelector('form')).toBeNull();
});

it('changes type from the name menu and rejects destructive conversions', async () => {
  render();
  click('node.propertyOptions:Venue');
  click('node.propertyType');
  click('node.propertyBoolean');
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'node.propertiesBooleanError',
  );
  click('node.propertyOptions:Score');
  click('node.propertyType');
  click('node.propertyText');
  await act(async () => {});
  expect(save).toHaveBeenCalledWith({ properties: { Score: '3' } });
  expect(container.querySelector('form')).toBeNull();
});

it('keeps Shift+Enter as a tag newline instead of submitting', () => {
  render(false, [], { Topics: ['Canvas'] });
  click('node.editProperty:Topics');
  const newline = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => container.querySelector('textarea')?.dispatchEvent(newline));
  expect(newline.defaultPrevented).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it('commits checkbox edits on Enter without refocusing on every change', async () => {
  render(false, [], { Reviewed: false });
  click('node.editProperty:Reviewed');
  const field = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(document.activeElement).toBe(field);
  act(() => field?.click());
  await submit();
  expect(save).toHaveBeenCalledWith({ properties: { Reviewed: true } });
});

it('keeps composition Enter and cancellation inside the inline editor', () => {
  render();
  click('node.editProperty:Venue');
  const field = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="node.propertyValue"]',
  );
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing: true,
  });
  act(() => field?.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  expect(save).not.toHaveBeenCalled();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  act(() => {
    field?.dispatchEvent(escape);
    field?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(container.querySelector('form')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it.each([true, false])(
  'shows each list value as its own tag and keeps text plain (readOnly=%s)',
  (readOnly) => {
    render(readOnly, ['Keywords'], {
      Keywords: ['canvas', 'shared context'],
      Venue: 'UIST',
    });
    const tags = (name: string) =>
      Array.from(
        container.querySelectorAll(
          `[data-property-name="${name}"] [data-property-tag]`,
        ),
      ).map((tag) => tag.textContent);
    expect(tags('Keywords')).toEqual(['canvas', 'shared context']);
    expect(tags('Venue')).toEqual([]);
  },
);

function option(text: string) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((item) => item.textContent === text);
}

it('picks known tags, creates new ones, and removes chosen ones in one save', async () => {
  act(() =>
    root.render(
      <NodeProperties
        properties={{ Keywords: ['canvas', 'ink'] }}
        displayKeys={[]}
        readOnly={false}
        tagOptions={(name) =>
          name === 'Keywords' ? ['agents', 'canvas', 'genui'] : []
        }
        onSave={save}
      />,
    ),
  );
  click('node.editProperty:Keywords');
  // Tags already chosen are not offered again.
  expect(
    Array.from(container.querySelectorAll('[role="option"]')).map(
      (item) => item.textContent,
    ),
  ).toEqual(['agents', 'genui']);
  act(() => option('genui')?.click());
  click('node.removePropertyTag:canvas');
  input('node.propertyValue', 'sketch');
  expect(option('node.createPropertyTagsketch')).toBeDefined();
  const field = container.querySelector<HTMLInputElement>('[role="combobox"]');
  const enter = () =>
    act(() => {
      field?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
  // The first Enter adds the typed tag; nothing is saved yet.
  enter();
  expect(save).not.toHaveBeenCalled();
  expect(field?.value).toBe('');
  // With nothing left to add, Enter saves the whole list once.
  enter();
  await act(async () => {});
  expect(save).toHaveBeenCalledExactlyOnceWith({
    properties: { Keywords: ['ink', 'genui', 'sketch'] },
  });
});

it('keeps text still in the tag field when the editor loses focus', async () => {
  render(false, [], { Venue: ['UIST'] });
  click('node.editProperty:Venue');
  input('node.propertyValue', ' CHI ');
  act(() => {
    container
      .querySelector('[role="combobox"]')
      ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  await act(async () => {});
  expect(save).toHaveBeenCalledExactlyOnceWith({
    properties: { Venue: ['UIST', 'CHI'] },
  });
});

it('edits text in a wrapping field and keeps pasted line breaks out of the value', async () => {
  render(false, [], { Question: 'How do people steer agents?' });
  click('node.editProperty:Question');
  const field = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="node.propertyValue"]',
  );
  expect(field?.value).toBe('How do people steer agents?');
  input('node.propertyValue', 'How do people\n  steer agents\nover time?');
  expect(field?.value).toBe('How do people steer agents over time?');
  await submit();
  expect(save).toHaveBeenCalledWith({
    properties: { Question: 'How do people steer agents over time?' },
  });
});

it('keeps numbers in a single-line field', () => {
  render();
  click('node.editProperty:Score');
  expect(container.querySelector('textarea')).toBeNull();
  expect(
    container.querySelector('input[aria-label="node.propertyValue"]'),
  ).not.toBeNull();
});

it('removes one of two repeated tags and lets Enter save once the pointer leaves the options', async () => {
  act(() =>
    root.render(
      <NodeProperties
        properties={{ Keywords: ['ink', 'ink', 'canvas'] }}
        displayKeys={[]}
        readOnly={false}
        tagOptions={() => ['agents']}
        onSave={save}
      />,
    ),
  );
  click('node.editProperty:Keywords');
  // Legacy lists may repeat a value: removing the first leaves the second.
  click('node.removePropertyTag:ink');
  const hovered = option('agents');
  act(() => {
    hovered?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  expect(hovered?.getAttribute('aria-selected')).toBe('true');
  act(() => {
    hovered?.parentElement?.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true }),
    );
  });
  expect(hovered?.getAttribute('aria-selected')).toBe('false');
  act(() => {
    container
      .querySelector('[role="combobox"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
  });
  await act(async () => {});
  expect(save).toHaveBeenCalledExactlyOnceWith({
    properties: { Keywords: ['ink', 'canvas'] },
  });
});
