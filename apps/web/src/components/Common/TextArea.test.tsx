// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TextArea } from './TextArea';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('TextArea', () => {
  it('preserves multiline values and forwards refs with shared small field styling', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const ref = createRef<HTMLTextAreaElement>();
    act(() =>
      root?.render(
        <TextArea
          ref={ref}
          defaultValue={'First\nSecond'}
          aria-label="Comment"
        />,
      ),
    );
    expect(ref.current?.value).toBe('First\nSecond');
    expect(ref.current?.classList.contains('border-edge-default')).toBe(true);
    expect(ref.current?.classList.contains('text-xs')).toBe(true);
    act(() =>
      root?.render(
        <TextArea ref={ref} size="md" mono className="rounded" disabled />,
      ),
    );
    expect(ref.current?.classList.contains('text-sm')).toBe(true);
    expect(ref.current?.classList.contains('font-mono')).toBe(true);
    expect(ref.current?.classList.contains('rounded-md')).toBe(false);
    expect(ref.current?.disabled).toBe(true);
  });
});
