// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedSave } from './utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

describe('useDebouncedSave', () => {
  it('flushes the latest pending value when its owner unmounts', () => {
    vi.useFakeTimers();
    const save = vi.fn();

    function Harness() {
      const debouncedSave = useDebouncedSave(save);
      return (
        <button onClick={() => debouncedSave('latest')}>Schedule save</button>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));
    act(() => container?.querySelector('button')?.click());
    expect(save).not.toHaveBeenCalled();

    act(() => root?.unmount());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('latest');
    root = undefined;
  });
});
