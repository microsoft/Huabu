import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SplitSelect } from './SplitSelect';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SplitSelect', () => {
  it('hides the menu button without disabling the primary action', () => {
    const onPrimaryAction = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <SplitSelect
          options={[{ value: 'lasso', label: 'Lasso' }]}
          value="lasso"
          onChange={vi.fn()}
          onPrimaryAction={onPrimaryAction}
          hideMenuButton
          primaryTitle="Lasso"
        />,
      ),
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();

    act(() => buttons[0].click());
    expect(onPrimaryAction).toHaveBeenCalledWith('lasso');
  });
});
