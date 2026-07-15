import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTeamProfiles } from './AgentTeamProfiles';

import type {
  AgentTeamManifestProfileView,
  AgentTeamMemberView,
} from '@sediment/shared';

const apiMocks = vi.hoisted(() => ({
  setup: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/api/agent-team', () => ({
  cancelAgentTeamProfileSetup: vi.fn(),
  createAgentTeamProfile: vi.fn(),
  deleteAgentTeamProfile: vi.fn(),
  patchAgentTeamProfile: apiMocks.patch,
  setupAgentTeamProfile: apiMocks.setup,
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
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock('@/components/Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/components/Common/SettingRow', () => ({
  SettingRow: ({
    title,
    description,
    children,
  }: {
    title: React.ReactNode;
    description?: string;
    children: React.ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {children}
    </div>
  ),
}));

vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

const member: AgentTeamMemberView = {
  machine: 'machine-id',
  manifestPath: '/team/reviewer/agentlet.yaml',
  name: 'reviewer',
  description: '',
  harnesses: ['claude', 'copilot'],
  env: [],
  discoveredBy: [{ machine: 'machine-id', path: '/team' }],
  status: 'active',
};

const profile: AgentTeamManifestProfileView = {
  id: 'profile-id',
  alias: 'reviewer',
  agentletId: member.machine,
  workingDirPath: '/team/reviewer/workspaces/claude',
  launch: {
    kind: 'agent-team-manifest',
    manifestPath: member.manifestPath,
    harness: 'claude',
  },
  preparation: { status: 'not_prepared' },
  setupLog: [],
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(profiles: AgentTeamManifestProfileView[], configReady = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentTeamProfiles
        member={member}
        configReady={configReady}
        profiles={profiles}
        onProfilesChange={vi.fn()}
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
  apiMocks.setup.mockReset();
  apiMocks.patch.mockReset();
});

describe('AgentTeamProfiles', () => {
  it('shows harness selection only while creating a Profile', () => {
    const createView = render([]);
    expect(createView.querySelector('select')).not.toBeNull();

    act(() => root?.unmount());
    root = createRoot(createView);
    act(() => {
      root?.render(
        <AgentTeamProfiles
          member={member}
          configReady
          profiles={[profile]}
          onProfilesChange={vi.fn()}
        />,
      );
    });
    expect(createView.querySelector('select')).toBeNull();
    expect(createView.textContent).toContain(profile.workingDirPath);
  });

  it('blocks setup until required Configs are ready', () => {
    const view = render([profile], false);
    const setup = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('setup'),
    );
    expect(setup?.disabled).toBe(true);
  });

  it('starts setup for a prepared Profile action', async () => {
    apiMocks.setup.mockResolvedValue({
      ...profile,
      preparation: { status: 'setting_up', startedAt: 1 },
    });
    const view = render([profile]);
    const setup = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('setup'),
    );

    await act(async () => setup?.click());

    expect(apiMocks.setup).toHaveBeenCalledWith(profile.id);
  });
});
