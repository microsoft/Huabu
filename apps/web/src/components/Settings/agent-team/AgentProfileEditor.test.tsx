import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentProfileEditor } from './AgentProfileEditor';

import type { ManifestMemberGroup } from './useUnifiedAgents';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createCommand: vi.fn(),
  createManifest: vi.fn(),
  setupManifest: vi.fn(),
  listClis: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  createAcpProfile: apiMocks.createCommand,
  listAcpAgentClis: apiMocks.listClis,
  updateAcpProfile: vi.fn(),
}));

vi.mock('@/api/agent-team', () => ({
  createAgentTeamProfile: apiMocks.createManifest,
  setupAgentTeamProfile: apiMocks.setupManifest,
  patchAgentTeamProfile: vi.fn(),
  updateAgentTeamConfigs: vi.fn(),
}));

vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="path"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/components/Common/Select', () => ({
  Select: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: { value: string; label: string; disabled?: boolean }[];
    onChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option
          key={option.value || 'none'}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

const agents = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    binary: 'copilot',
    acpArgs: ['--acp'],
    autoApprove: null,
    installed: true,
    installHint: 'Install Copilot',
  },
  {
    id: 'claude',
    displayName: 'Claude Agent',
    binary: 'claude-agent-acp',
    acpArgs: [],
    autoApprove: null,
    installed: false,
    installHint: 'Install Claude',
  },
];

const members: ManifestMemberGroup[] = [
  {
    member: {
      machine: 'machine-a',
      manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
      name: 'Reviewer',
      description: 'Reviews a project',
      harnesses: ['copilot', 'claude'],
      env: [],
      discoveredBy: [],
      status: 'active',
    },
    config: {
      machine: 'machine-a',
      manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
      fields: [],
      missingRequired: [],
      ready: true,
    },
    profiles: [],
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderFlow() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AgentProfileEditor
        mode="create"
        members={members}
        manifestError={null}
        detectedClis={agents}
        detectionLoaded
        onClose={vi.fn()}
        onCommandCreated={vi.fn()}
        onManifestCreated={vi.fn()}
        applyMemberDetail={vi.fn()}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe('AgentProfileEditor (create)', () => {
  it('defaults to no Template and keeps Custom command last', () => {
    renderFlow();

    const selects = container?.querySelectorAll('select');
    expect(selects?.[0]?.value).toBe('');
    const agentOptions = [...(selects?.[1]?.options ?? [])];
    expect(agentOptions.map((option) => option.value)).toEqual([
      'copilot',
      'custom',
    ]);
  });

  it('filters a Template to supported Agents and disables missing ones', async () => {
    renderFlow();
    const templateSelect = container?.querySelector('select');
    await act(async () => {
      if (!templateSelect) return;
      templateSelect.value =
        'machine-a\u0000C:\\templates\\reviewer\\agentlet.yaml';
      templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const agentSelect = container?.querySelectorAll('select')[1];
    const options = [...(agentSelect?.options ?? [])];
    expect(options.map((option) => option.value)).toEqual([
      'copilot',
      'claude',
    ]);
    expect(options[1]?.disabled).toBe(true);
    expect(container?.textContent).not.toContain('Manual setup');
  });

  it('creates a manifest Profile and kicks off setup', async () => {
    apiMocks.listClis.mockResolvedValue({ agents });
    apiMocks.createManifest.mockResolvedValue({ id: 'profile-1' });
    apiMocks.setupManifest.mockResolvedValue({ id: 'profile-1' });
    renderFlow();
    const templateSelect = container?.querySelector('select');
    await act(async () => {
      if (!templateSelect) return;
      templateSelect.value =
        'machine-a\u0000C:\\templates\\reviewer\\agentlet.yaml';
      templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const path = container?.querySelector<HTMLInputElement>(
      '[aria-label="path"]',
    );
    await act(async () => {
      if (!path) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(path, 'C:\\work\\project');
      path.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const buttons = [...(container?.querySelectorAll('button') ?? [])];
    const create = buttons.at(-1);
    expect(create?.disabled).toBe(false);
    await act(async () => {
      create?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.createManifest).toHaveBeenCalledWith({
      alias: 'Reviewer (project)',
      agentletId: 'machine-a',
      workingDirPath: 'C:\\work\\project',
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
        harness: 'copilot',
      },
    });
    expect(apiMocks.setupManifest).toHaveBeenCalledWith('profile-1');
  });
});
