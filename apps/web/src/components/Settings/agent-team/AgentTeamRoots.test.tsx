import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTeamRoots } from './AgentTeamRoots';

import type { AgentTeamMachineView } from '@sediment/shared';

const apiMocks = vi.hoisted(() => ({
  addRoot: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/api/agent-team', () => ({
  addAgentTeamRoot: apiMocks.addRoot,
  removeAgentTeamRoot: vi.fn(),
  rescanAgentTeamRoot: vi.fn(),
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

vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
    pickerEnabled,
    placeholder,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    pickerEnabled?: boolean;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <input
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      data-picker-enabled={String(pickerEnabled)}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/components/Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    ...props
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      {...props}
      value={value}
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

vi.mock('@/components/Common/SettingSection', () => ({
  SettingSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock('@/components/Common/SettingRow', () => ({
  SettingRow: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
}));

const machines: AgentTeamMachineView[] = [
  { machine: 'local-id', hostname: 'local', platform: 'linux' },
  { machine: 'remote-id', hostname: 'remote', platform: 'darwin' },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderRoots() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentTeamRoots
        machines={machines}
        localMachine="local-id"
        roots={[]}
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
  apiMocks.addRoot.mockReset();
});

describe('AgentTeamRoots', () => {
  it('only enables the native picker for the local machine', () => {
    const view = renderRoots();
    const path = view.querySelector('input');
    const machine = view.querySelector('select');

    expect(path?.dataset.pickerEnabled).toBe('true');
    act(() => {
      machine?.dispatchEvent(new Event('change', { bubbles: true }));
      if (machine) machine.value = 'remote-id';
      machine?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(path?.dataset.pickerEnabled).toBe('false');
  });

  it('retains the entered path when adding a root fails', async () => {
    apiMocks.addRoot.mockRejectedValueOnce(new Error('unavailable'));
    const view = renderRoots();
    const path = view.querySelector('input') as HTMLInputElement;
    const add = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent === 'add',
    );

    await act(async () => {
      path.value = '/agent-team';
      path.dispatchEvent(new Event('input', { bubbles: true }));
      path.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      add?.click();
    });

    expect(path.value).toBe('/agent-team');
  });
});
