// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMenuOptions } from './agentMenu';

import type { AgentProfileView } from '@huabu/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../Common/Button', () => ({
  Button: ({
    children,
    tone: _tone,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: string;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));

const profiles: AgentProfileView[] = [
  {
    schemaVersion: 2,
    id: 'team-ready',
    alias: 'Ready Team',
    agentletId: 'machine-a',
    workingDirPath: '/work/ready',
    resourceIds: [],
    launch: {
      kind: 'agent-team-manifest',
      manifestPath: '/teams/ready/agentlet.yaml',
      harness: 'claude',
    },
    preparation: { status: 'ready', completedAt: 1 },
  },
  {
    schemaVersion: 2,
    id: 'team-pending',
    alias: 'Pending Team',
    agentletId: 'machine-a',
    workingDirPath: '/work/pending',
    resourceIds: [],
    launch: {
      kind: 'agent-team-manifest',
      manifestPath: '/teams/pending/agentlet.yaml',
      harness: 'claude',
    },
    preparation: { status: 'not_prepared' },
  },
  {
    schemaVersion: 2,
    id: 'command',
    alias: 'External Command',
    agentletId: 'machine-a',
    workingDirPath: '/work/command',
    resourceIds: [],
    launch: { kind: 'acp-command', command: 'copilot --acp' },
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('AgentMenuOptions', () => {
  it('groups ready template and command Profiles under External Agents', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentMenuOptions
          heading="Agents"
          currentBinding={{ kind: 'internal' }}
          currentMode="ask"
          profiles={profiles}
          onSelect={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain('chat.agentTeams');
    expect(container.textContent).toContain('Ready Team');
    expect(container.textContent).not.toContain('Pending Team');
    expect(container.textContent).toContain('chat.externalAgents');
    expect(container.textContent).toContain('External Command');
  });
});
