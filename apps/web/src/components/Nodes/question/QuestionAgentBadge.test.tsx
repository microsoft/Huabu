import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionAgentBadge } from './QuestionAgentBadge';

vi.mock('@xyflow/react', () => ({
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown,
  ) => selector({ transform: [0, 0, 2] }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('QuestionAgentBadge', () => {
  it('counter-scales its size and offset while rendering the Huabu identity', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <QuestionAgentBadge
          status="done"
          agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
          unread={false}
          conflictCount={0}
          offset={{ top: -22, left: -2 }}
        />,
      );
    });

    const badge = container.querySelector(
      'button[aria-label="Huabu · Done · viewed"]',
    );
    const wrapper = badge?.parentElement?.parentElement;
    const logo = badge?.querySelector('svg.question-agent-badge-icon');

    expect(wrapper?.style.transform).toBe('scale(0.5)');
    expect(wrapper?.style.top).toBe('-11px');
    expect(wrapper?.style.left).toBe('-1px');
    expect(logo).not.toBeNull();
  });

  it('keeps the Agent icon at 32px and shows the quiet viewed ring', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <QuestionAgentBadge
          status="done"
          agent={{
            kind: 'external',
            alias: 'External Agent',
            icon: { shape: 'spark', color: 'blue' },
          }}
          unread={false}
          conflictCount={0}
          offset={{ top: -22, left: -2 }}
        />,
      );
    });

    const badge = container.querySelector<HTMLButtonElement>(
      'button[aria-label="External Agent · Done · viewed"]',
    );
    const icon = badge?.querySelector('svg');

    expect(badge?.classList.contains('question-agent-badge')).toBe(true);
    expect(icon?.classList.contains('question-agent-badge-icon')).toBe(true);
    expect(badge?.style.borderColor).toBe('var(--question-agent-quiet-ring)');
  });

  it('renders approval as a static warning hold state', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <QuestionAgentBadge
          status="approval"
          agent={{ kind: 'internal', alias: 'Huabu', mode: 'operate' }}
          unread={false}
          conflictCount={0}
          offset={{ top: -22, left: -2 }}
        />,
      );
    });

    const badge = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Huabu · Approval required"]',
    );

    expect(badge?.classList.contains('question-agent-ring-approval')).toBe(
      true,
    );
    expect(badge?.classList.contains('question-agent-ring-running')).toBe(
      false,
    );
    expect(badge?.classList.contains('question-agent-attention')).toBe(false);
    expect(badge?.querySelector('span.bg-warning svg')).not.toBeNull();
  });
});
