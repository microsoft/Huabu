// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefaultsSettings } from './AgentDefaultsSettings';

import type {
  AgentDefaults,
  AgentDefaultsResponse,
  AgentProfileView,
} from '@huabu/shared';
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
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (
      state: typeof mocks.state & {
        loadDefaults: typeof mocks.get;
        saveDefaults: typeof mocks.update;
      },
    ) => unknown,
  ) =>
    selector({
      ...mocks.state,
      loadDefaults: mocks.get,
      saveDefaults: mocks.update,
    }),
}));
vi.mock('@/components/Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    disabled: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
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
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(initial);
  mocks.update.mockImplementation(async (defaults: AgentDefaults) => ({
    ...initial,
    defaults: { ...defaults, functionalModel: defaults.functionalModel.trim() },
  }));
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
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render() {
  await act(async () => root.render(<AgentDefaultsSettings />));
}

async function blurModel() {
  await act(async () => {
    container
      .querySelector('input')
      ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

async function selectProfile(value: string) {
  await act(async () => {
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
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
    expect(container.querySelector('button')).toBeNull();
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
    expect(container.querySelector('input')?.disabled).toBe(true);
    await selectProfile('external');
    expect(mocks.update).toHaveBeenCalledWith({
      profileId: 'external',
      functionalModel: '',
    });
  });

  it('keeps failed drafts, displays errors and retries on blur', async () => {
    mocks.update.mockRejectedValueOnce(new Error('disk is read-only'));
    await render();
    await editModel('other-model');
    await blurModel();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'disk is read-only',
    );
    expect(container.querySelector('input')?.value).toBe('other-model');
    expect(container.textContent).not.toContain('settings.agentDefaultsSaved');
    await blurModel();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('settings.agentDefaultsSaved');
  });

  it('saves an empty model as inheritance and reports success', async () => {
    mocks.update.mockResolvedValue({
      ...initial,
      defaults: { profileId: 'external', functionalModel: '' },
    });
    await render();
    await editModel('');
    await blurModel();
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
    expect(container.querySelector('select')?.disabled).toBe(true);
    expect(container.querySelector('input')?.disabled).toBe(true);
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
    mocks.update.mockResolvedValue({
      ...initial,
      modelCapability: 'unsupported',
    });
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

  it('debounces model edits for 600 ms and saves only the latest value', async () => {
    await render();
    await editModel('first');
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await editModel('  latest  ');
    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      profileId: 'external',
      functionalModel: '  latest  ',
    });
    expect(container.querySelector('input')?.value).toBe('latest');
  });

  it('flushes pending model edits on blur without another delayed save', async () => {
    await render();
    await editModel('latest');
    await blurModel();
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('flushes pending model edits when Settings closes', async () => {
    await render();
    await editModel('on-close');
    await act(async () => root.render(null));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      profileId: 'external',
      functionalModel: 'on-close',
    });
  });

  it('selecting a Profile includes pending model edits without a stale delayed write', async () => {
    mocks.state.profiles.push({ ...mocks.state.profiles[0], id: 'other' });
    await render();
    await editModel('new-model');
    await selectProfile('other');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      profileId: 'other',
      functionalModel: 'new-model',
    });
  });

  it('does not let an older response replace an edit made during saving', async () => {
    let finish!: (response: AgentDefaultsResponse) => void;
    mocks.update.mockImplementationOnce(
      () =>
        new Promise<AgentDefaultsResponse>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await editModel('first');
    await blurModel();
    expect(container.textContent).toContain('settings.saving');
    expect(container.querySelector('input')?.disabled).toBe(false);
    await editModel('latest');
    await act(async () =>
      finish({
        ...initial,
        defaults: { profileId: 'external', functionalModel: 'first' },
      }),
    );
    expect(container.querySelector('input')?.value).toBe('latest');
    expect(container.textContent).not.toContain('settings.agentDefaultsSaved');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.update).toHaveBeenLastCalledWith({
      profileId: 'external',
      functionalModel: 'latest',
    });
    expect(container.textContent).toContain('settings.agentDefaultsSaved');
  });
});
