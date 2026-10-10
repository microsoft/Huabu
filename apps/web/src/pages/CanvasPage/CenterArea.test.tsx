// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CenterArea } from './CenterArea';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../components/Panels/Canvas/Canvas', () => ({
  Canvas: () => <div data-testid="canvas" />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('CenterArea collapsed Preview controls', () => {
  it('creates a new conversation or expands Preview from the compact control', () => {
    const onNewChat = vi.fn();
    const onToggleRightPanel = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <CenterArea
          isRightPanelCollapsed
          onNewChat={onNewChat}
          onToggleRightPanel={onToggleRightPanel}
        />,
      ),
    );

    const newChat = container.querySelector<HTMLButtonElement>(
      '[aria-label="chat.newConversation"]',
    );
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="preview.expand"]',
    );
    expect(newChat).not.toBeNull();
    expect(expand).not.toBeNull();
    expect(newChat?.className).toBe(expand?.className);
    expect(newChat?.classList.contains('p-1.5')).toBe(true);
    expect(newChat?.querySelector('.lucide-sparkles')).not.toBeNull();
    expect(expand?.querySelector('.lucide-panel-right')).not.toBeNull();
    for (const button of [newChat, expand]) {
      expect(button?.classList.contains('text-fg-subtle')).toBe(true);
      expect(button?.classList.contains('enabled:hover:text-fg-default')).toBe(
        true,
      );
      expect(button?.classList.contains('[&_svg]:h-4')).toBe(true);
      expect(button?.classList.contains('[&_svg]:w-4')).toBe(true);
      expect(button?.querySelector('svg')?.matches('.lucide')).toBe(true);
    }

    act(() => newChat?.click());
    act(() => expand?.click());

    expect(onNewChat).toHaveBeenCalledExactlyOnceWith();
    expect(onToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('hides the compact control while Preview is expanded', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <CenterArea onNewChat={vi.fn()} onToggleRightPanel={vi.fn()} />,
      ),
    );

    expect(container.querySelector('button')).toBeNull();
  });
});
