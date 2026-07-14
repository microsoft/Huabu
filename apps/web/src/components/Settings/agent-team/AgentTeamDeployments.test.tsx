import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTeamDeployments } from './AgentTeamDeployments';

import type {
  AgentTeamDeploymentView,
  AgentTeamMemberView,
} from '@sediment/shared';

const apiMocks = vi.hoisted(() => ({
  retry: vi.fn(),
}));
const translationMocks = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translationMocks.t }),
}));

vi.mock('@/api/agent-team', () => ({
  createAgentTeamDeployment: vi.fn(),
  deleteAgentTeamDeployment: vi.fn(),
  disableAgentTeamDeployment: vi.fn(),
  enableAgentTeamDeployment: vi.fn(),
  retryAgentTeamDeploymentSetup: apiMocks.retry,
  updateAgentTeamDeployment: vi.fn(),
}));

vi.mock('@/components/Common/Button', () => ({
  Button: ({
    children,
    iconOnly: _iconOnly,
    tone: _tone,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    iconOnly?: boolean;
    tone?: string;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/Common/Input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  TEXT_INPUT_CLASS: '',
}));

vi.mock('@/components/Common/Modal', () => ({
  Modal: () => null,
}));

vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <input
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/components/Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/components/Common/SettingRow', () => ({
  SettingRow: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/Common/Toggle', () => ({
  Toggle: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    label?: string;
    onChange: (checked: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  ),
}));

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
}));

const member: AgentTeamMemberView = {
  machine: 'machine-id',
  manifestPath: '/team/reviewer/agentlet.yaml',
  name: 'reviewer',
  description: '',
  harnesses: ['claude'],
  env: [],
  discoveredBy: [{ machine: 'machine-id', path: '/team' }],
  status: 'active',
};

function deployment(
  setup: AgentTeamDeploymentView['setup'],
  enabled = false,
): AgentTeamDeploymentView {
  return {
    id: 'deployment-id',
    alias: 'reviewer',
    revision: 1,
    enabled,
    machine: member.machine,
    manifestPath: member.manifestPath,
    harness: 'claude',
    workingDirPath: '/team/reviewer/workspaces/claude',
    setup,
    setupLog: [],
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderDeployment(item: AgentTeamDeploymentView, configReady: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentTeamDeployments
        member={member}
        configReady={configReady}
        deployments={[item]}
        pendingAction={null}
        mutate={async (_action, operation) => {
          await operation();
        }}
      />,
    );
  });
  return container;
}

function renderNewDeployment() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentTeamDeployments
        member={{
          ...member,
          harnesses: ['claude', 'copilot'],
        }}
        configReady
        deployments={[]}
        pendingAction={null}
        mutate={async (_action, operation) => {
          await operation();
        }}
      />,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  apiMocks.retry.mockReset();
});

describe('AgentTeamDeployments', () => {
  it('shows a labeled harness selector before the first deployment exists', () => {
    const view = renderNewDeployment();
    const harness = view.querySelector('select') as HTMLSelectElement;

    expect(view.textContent).toContain('harness');
    expect(Array.from(harness.options, (option) => option.value)).toEqual([
      'claude',
      'copilot',
    ]);
  });

  it('blocks enable until required Configs are ready', () => {
    const view = renderDeployment(deployment({ status: 'disabled' }), false);
    expect(
      (view.querySelector('[role="switch"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      root?.render(
        <AgentTeamDeployments
          member={member}
          configReady
          deployments={[deployment({ status: 'disabled' })]}
          pendingAction={null}
          mutate={async (_action, operation) => {
            await operation();
          }}
        />,
      );
    });
    expect(
      (view.querySelector('[role="switch"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows setup errors and retries an enabled deployment', async () => {
    apiMocks.retry.mockResolvedValue(undefined);
    const view = renderDeployment(
      deployment(
        {
          status: 'error',
          failedAt: Date.parse('2026-01-01T00:00:00.000Z'),
          error: { code: 'setup_failed', message: 'setup failed' },
        },
        true,
      ),
      true,
    );

    expect(view.textContent).toContain('setupStatusError');
    expect(view.textContent).toContain('setup failed');
    const retry = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('retrySetup'),
    );
    await act(async () => {
      retry?.click();
    });
    expect(apiMocks.retry).toHaveBeenCalledWith('deployment-id');
  });
});
