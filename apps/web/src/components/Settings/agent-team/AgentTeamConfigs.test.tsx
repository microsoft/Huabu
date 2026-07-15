import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTeamConfigs } from './AgentTeamConfigs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/api/agent-team', () => ({
  updateAgentTeamConfigs: vi.fn(),
}));

vi.mock('@/components/Common/Button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));

vi.mock('@/components/Common/TextInput', () => ({
  TextInput: ({
    mono: _mono,
    size: _size,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    mono?: boolean;
    size?: 'sm' | 'md';
  }) => <input {...props} />,
}));

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AgentTeamConfigs', () => {
  it('marks required fields inline without a missing-Configs summary row', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentTeamConfigs
          config={{
            machine: 'machine-id',
            manifestPath: '/team/member/agentlet.yaml',
            fields: [
              {
                name: 'TOKEN',
                description: 'API token',
                required: true,
                secret: true,
                configured: false,
              },
            ],
            missingRequired: ['TOKEN'],
            ready: false,
          }}
          onDetailChange={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('TOKEN (*)');
    expect(container.textContent).not.toContain('missingRequired');
  });
});
