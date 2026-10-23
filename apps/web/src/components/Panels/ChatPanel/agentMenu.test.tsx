// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MENU_ITEM_CLASS,
  MENU_GROUP_CLASS,
  MENU_SECTION_LABEL_CLASS,
} from '@/components/Common/menuStyles';

import { AgentMenuOptions } from './agentMenu';
import { AgentSelector } from './AgentSelector';

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
    tooltipWrapperClassName: _tooltipWrapperClassName,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: string;
    variant?: string;
    size?: string;
    tooltipWrapperClassName?: string;
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
    expect(container.textContent).toContain('chat.modeChat');
    expect(container.textContent).toContain('chat.modeAgent');
    expect(container.textContent).toContain('chat.externalAgents');
    expect(container.textContent).toContain('External Command');
    const externalHeading = [
      ...container.querySelectorAll('[role="presentation"]'),
    ].find((element) => element.textContent === 'chat.externalAgents');
    expect(externalHeading?.className).toBe(MENU_SECTION_LABEL_CLASS);
    expect(externalHeading?.parentElement?.className).toBe(MENU_GROUP_CLASS);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="menuitem"]')[2]?.className).toBe(
      MENU_ITEM_CLASS,
    );
  });

  it('keeps a separator for the trailing Add agent action only', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <AgentMenuOptions
          heading="Agents"
          currentBinding={{ kind: 'internal' }}
          currentMode="ask"
          profiles={profiles}
          onSelect={vi.fn()}
          onAddAgent={vi.fn()}
        />,
      ),
    );
    const separators = container.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0].nextElementSibling?.textContent).toBe('chat.addAgent');
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

describe('AgentSelector', () => {
  it.each([true, false])(
    'omits the chevron while preserving editable=%s behavior',
    async (editable) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(() => {
        root?.render(
          <AgentSelector
            currentBinding={{
              kind: 'external',
              profileId: 'reviewer',
              alias: 'Reviewer',
            }}
            currentMode="operate"
            profiles={profiles}
            editable={editable}
            onSelect={vi.fn()}
          />,
        );
      });

      const trigger = container.querySelector('button');
      expect(trigger?.textContent).toBe('Reviewer');
      expect(container.querySelector('.lucide-chevron-down')).toBeNull();
      expect(trigger?.disabled).toBe(!editable);
      await act(() => trigger?.click());
      expect(trigger?.getAttribute('aria-expanded')).toBe(
        editable ? 'true' : null,
      );
      if (editable) {
        expect(document.body.textContent).toContain('External Command');
      }
    },
  );
});
