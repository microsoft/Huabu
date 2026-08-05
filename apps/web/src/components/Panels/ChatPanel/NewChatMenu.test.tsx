import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewChatMenu } from './NewChatMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'chat.startChatWith' ? 'Start chat with…' : key,
  }),
}));

vi.mock('./agentMenu', () => ({
  AgentMenuOptions: () => null,
  useAddAgentEditor: () => ({ openEditor: vi.fn(), editor: null }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('NewChatMenu', () => {
  it('keeps the menu trigger at least 24px wide', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <NewChatMenu
          currentMode="ask"
          currentBinding={{ kind: 'internal' }}
          profiles={[]}
          onSelect={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start chat with…"]',
    );
    expect(trigger?.classList.contains('min-w-6')).toBe(true);
  });
});
