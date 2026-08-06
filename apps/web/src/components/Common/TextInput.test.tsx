// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { TextInput } from './TextInput';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderTextInput(element: React.ReactElement): HTMLInputElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  const input = container.querySelector('input');
  if (!input) throw new Error('Expected TextInput to render an input');
  return input;
}

describe('TextInput', () => {
  it('applies the standard small text-field appearance by default', () => {
    const input = renderTextInput(<TextInput aria-label="Name" />);

    expect(input.type).toBe('text');
    expect(input.className).toContain('border-edge-default');
    expect(input.className).toContain('rounded-md');
    expect(input.className).toContain('px-2');
    expect(input.className).toContain('text-xs');
  });

  it('supports medium density and caller class overrides', () => {
    const input = renderTextInput(
      <TextInput
        type="url"
        size="md"
        mono
        className="w-56 rounded"
        aria-label="Endpoint"
      />,
    );

    expect(input.type).toBe('url');
    expect(input.className).toContain('px-2.5');
    expect(input.className).toContain('text-sm');
    expect(input.className).toContain('font-mono');
    expect(input.className).toContain('w-56');
    expect(input.className).toContain('rounded');
    expect(input.className).not.toContain('rounded-md');
  });
});
