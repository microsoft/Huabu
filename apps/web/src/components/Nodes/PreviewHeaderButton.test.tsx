// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bookmark } from 'lucide-react';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { PreviewHeaderButton } from './PreviewHeaderButton';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('forwards refs, actions, disabled and semantic state without changing header geometry', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  try {
    act(() =>
      root.render(
        <PreviewHeaderButton
          ref={ref}
          title="Save conversation"
          onClick={onClick}
        >
          <Bookmark />
        </PreviewHeaderButton>,
      ),
    );
    expect(ref.current).toBe(host.querySelector('button'));
    expect(ref.current?.getAttribute('aria-label')).toBe('Save conversation');
    act(() => ref.current?.click());
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <PreviewHeaderButton
          ref={ref}
          title="Save conversation"
          onClick={onClick}
          disabled
          aria-pressed
          className="bg-info-bg text-info"
        >
          <Bookmark />
        </PreviewHeaderButton>,
      ),
    );
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.getAttribute('aria-pressed')).toBe('true');
    expect(ref.current?.classList.contains('text-info')).toBe(true);
    expect(ref.current?.classList.contains('min-h-6')).toBe(true);
    expect(ref.current?.classList.contains('[&_svg]:h-3.25')).toBe(true);
    act(() => ref.current?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
