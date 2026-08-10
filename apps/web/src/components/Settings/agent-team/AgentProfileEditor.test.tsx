// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  patchManifest: vi.fn(),
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
  patchAgentTeamProfile: apiMocks.patchManifest,
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

function renderManifestEditor(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AgentProfileEditor
        mode="edit-manifest"
        row={{
          member: members[0].member,
          config: members[0].config,
          profile: {
            id: 'profile-1',
            alias: 'Reviewer',
            agentletId: 'machine-a',
            workingDirPath: 'C:\\work\\project',
            launch: {
              kind: 'agent-team-manifest',
              manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
              harness: 'copilot',
            },
            preparation: { status: 'ready', completedAt: 1 },
            setupLog: [],
          },
        }}
        detectedClis={agents}
        onClose={onClose}
        applyMemberDetail={vi.fn()}
        onAliasSaved={vi.fn()}
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
  it('defaults to no Template and lists missing Agents before Custom command', () => {
    renderFlow();

    const selects = container?.querySelectorAll('select');
    expect(selects?.[0]?.value).toBe('');
    const agentOptions = [...(selects?.[1]?.options ?? [])];
    expect(agentOptions.map((option) => option.value)).toEqual([
      'copilot',
      'claude',
      'custom',
    ]);
    expect(agentOptions[1]?.disabled).toBe(true);
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
    const defaultWorkspace =
      container?.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      defaultWorkspace?.click();
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
      workingDirectory: {
        kind: 'custom',
        path: 'C:\\work\\project',
      },
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
        harness: 'copilot',
      },
      customData: {
        icon: {
          shape: expect.any(String),
          color: expect.any(String),
        },
      },
    });
    expect(apiMocks.setupManifest).toHaveBeenCalledWith('profile-1');
  });

  it('uses an isolated default workspace without requiring a path', async () => {
    apiMocks.listClis.mockResolvedValue({ agents });
    apiMocks.createManifest.mockResolvedValue({ id: 'profile-default' });
    apiMocks.setupManifest.mockResolvedValue({ id: 'profile-default' });
    renderFlow();
    const templateSelect = container?.querySelector('select');
    await act(async () => {
      if (!templateSelect) return;
      templateSelect.value =
        'machine-a\u0000C:\\templates\\reviewer\\agentlet.yaml';
      templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(
      container?.querySelector<HTMLInputElement>('[aria-label="path"]'),
    ).toBeNull();
    const buttons = [...(container?.querySelectorAll('button') ?? [])];
    const create = buttons.at(-1);
    expect(create?.disabled).toBe(false);
    await act(async () => {
      create?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.createManifest).toHaveBeenCalledWith({
      alias: 'Reviewer',
      agentletId: 'machine-a',
      workingDirectory: { kind: 'default' },
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: 'C:\\templates\\reviewer\\agentlet.yaml',
        harness: 'copilot',
      },
      customData: {
        icon: {
          shape: expect.any(String),
          color: expect.any(String),
        },
      },
    });
  });
});

describe('AgentProfileEditor (edit manifest)', () => {
  it('uses the shared editor fields and saves explicitly', async () => {
    apiMocks.patchManifest.mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderManifestEditor(onClose);

    expect(container?.textContent).toContain('Reviewer');
    expect(container?.textContent).toContain('GitHub Copilot');
    expect(container?.textContent).toContain('C:\\work\\project');

    const name = container?.querySelector<HTMLInputElement>('input');
    await act(async () => {
      if (!name) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(name, 'Project Reviewer');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      name.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    expect(apiMocks.patchManifest).not.toHaveBeenCalled();

    const save = [...(container?.querySelectorAll('button') ?? [])].at(-1);
    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.patchManifest).toHaveBeenCalledWith('profile-1', {
      alias: 'Project Reviewer',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
