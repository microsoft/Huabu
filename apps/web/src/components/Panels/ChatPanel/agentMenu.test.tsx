// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMenuOptions } from './agentMenu';

import type { AgentProfileView } from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    id: 'reviewer',
    alias: 'Reviewer',
    agentletId: 'machine-a',
    workingDirPath: '/work/reviewer',
    launch: {
      kind: 'acp-command',
      command: 'copilot --acp',
    },
    metadata: { cliId: 'copilot' },
  },
  {
    id: 'command',
    alias: 'External Command',
    agentletId: 'machine-a',
    workingDirPath: '/work/command',
    launch: { kind: 'acp-command', command: 'copilot --acp' },
    metadata: { cliId: 'copilot' },
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
  it('lists separate Profiles that share an agentlet and CLI under External Agents', () => {
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

    expect(container.textContent).toContain('Reviewer');
    expect(container.textContent).toContain('chat.externalAgents');
    expect(container.textContent).toContain('External Command');
  });

  it('selects the chosen Profile identity without changing the current mode', () => {
    const onSelect = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentMenuOptions
          heading="Agents"
          currentBinding={{
            kind: 'external',
            profileId: 'reviewer',
            alias: 'Reviewer',
          }}
          currentMode="operate"
          profiles={profiles}
          onSelect={onSelect}
        />,
      );
    });
    const choice = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'External Command',
    );
    act(() => choice?.click());
    expect(onSelect).toHaveBeenCalledWith({
      mode: 'operate',
      binding: {
        kind: 'external',
        profileId: 'command',
        alias: 'External Command',
      },
    });
  });
});
