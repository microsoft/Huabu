// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefaultsSettings } from './AgentDefaultsSettings';

import type { AgentDefaultsResponse, AgentProfileView } from '@huabu/shared';
import type { Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  state: {
    profiles: [] as AgentProfileView[],
    loaded: true,
    error: null as Error | null,
    refresh: vi.fn(async () => {}),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { id?: string }) =>
      values?.id ? `${key}:${values.id}` : key,
  }),
}));
vi.mock('@/api/agentDefaults', () => ({
  getAgentDefaults: mocks.get,
  updateAgentDefaults: mocks.update,
}));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));
vi.mock('@/components/Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    ariaLabel,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Unconfigured</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const initial: AgentDefaultsResponse = {
  defaults: { profileId: 'external', functionalModel: 'fast' },
  selectionState: 'available',
  modelCapability: 'unknown',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(initial);
  mocks.update.mockResolvedValue(initial);
  mocks.state.profiles = [
    {
      id: 'external',
      alias: 'External Agent',
      agentletId: 'machine',
      workingDirPath: '/work',
      launch: { kind: 'acp-command', command: 'copilot --acp' },
    },
  ];
  mocks.state.loaded = true;
  mocks.state.error = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(<AgentDefaultsSettings />));
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'actions.save',
  ) as HTMLButtonElement;
}

async function editModel(value: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Agent defaults Settings', () => {
  it('loads shared Profiles and warns that model support is unknown', async () => {
    await render();
    expect(mocks.state.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain('External Agent');
    expect(container.textContent).toContain(
      'settings.agentDefaultsModelUnknown',
    );
    expect(saveButton().disabled).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('retains a missing selection and requires an explicit replacement', async () => {
    mocks.get.mockResolvedValue({
      ...initial,
      defaults: { profileId: 'deleted', functionalModel: '' },
      selectionState: 'deleted',
    });
    await render();
    expect(container.textContent).toContain(
      'settings.agentDefaultsMissing:deleted',
    );
    expect(container.textContent).toContain('settings.agentDefaultsDeleted');
    expect(saveButton().disabled).toBe(true);
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'external';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(mocks.update).toHaveBeenCalledWith({
      profileId: 'external',
      functionalModel: '',
    });
  });

  it('keeps drafts and displays server save errors', async () => {
    mocks.update.mockRejectedValue(new Error('disk is read-only'));
    await render();
    await editModel('other-model');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'disk is read-only',
    );
    expect(container.querySelector('input')?.value).toBe('other-model');
    expect(saveButton().disabled).toBe(false);
  });

  it('saves an empty model as inheritance and reports success', async () => {
    mocks.update.mockResolvedValue({
      ...initial,
      defaults: { profileId: 'external', functionalModel: '' },
    });
    await render();
    await editModel('');
    await act(async () => saveButton().click());
    expect(mocks.update).toHaveBeenCalledWith({
      profileId: 'external',
      functionalModel: '',
    });
    expect(container.textContent).toContain('settings.agentDefaultsSaved');
    expect(container.textContent).not.toContain(
      'settings.agentDefaultsModelUnknown',
    );
  });

  it('shows load errors rather than an editable fallback', async () => {
    mocks.get.mockRejectedValue(new Error('Invalid Agent defaults file'));
    await render();
    expect(container.textContent).toContain('Invalid Agent defaults file');
    expect(container.querySelector('input')).toBeNull();
  });

  it('does not treat an unloaded Profile catalogue as a deleted selection', async () => {
    mocks.state.loaded = false;
    mocks.state.profiles = [];
    await render();
    expect(container.textContent).not.toContain(
      'settings.agentDefaultsDeleted',
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('distinguishes known unsupported model selection from unknown support', async () => {
    mocks.get.mockResolvedValue({ ...initial, modelCapability: 'unsupported' });
    await render();
    expect(container.textContent).toContain(
      'settings.agentDefaultsModelUnsupported',
    );
    expect(container.textContent).not.toContain(
      'settings.agentDefaultsModelUnknown',
    );
  });

  it('treats a newly selected legacy command as custom despite known CLI metadata', async () => {
    mocks.get.mockResolvedValue({
      ...initial,
      defaults: { profileId: 'other', functionalModel: 'fast' },
      modelCapability: 'supported',
    });
    mocks.state.profiles[0].metadata = { cliId: 'copilot' };
    await render();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'external';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain(
      'settings.agentDefaultsModelUnsupported',
    );
  });

  it('honors separately reported runtime ACP model support for a custom Profile', async () => {
    mocks.get.mockResolvedValue({ ...initial, modelCapability: 'supported' });
    await render();
    expect(container.textContent).not.toContain(
      'settings.agentDefaultsModelUnsupported',
    );
    expect(container.textContent).not.toContain(
      'settings.agentDefaultsModelUnknown',
    );
  });
});
