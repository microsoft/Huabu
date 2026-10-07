// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanaryRedeploySettings } from './CanaryRedeploySettings';

import type { ModalProps } from '@/components/Common/Modal';
import type { CanaryRedeployStatusResponse } from '@huabu/shared';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  check: vi.fn(),
  save: vi.fn(),
  redeploy: vi.fn(),
  toast: vi.fn(),
  t: (key: string) => key,
}));

vi.mock('@/api/deployment', () => ({
  getCanaryRedeployStatus: mocks.getStatus,
  checkCanaryRedeploy: mocks.check,
  updateCanaryRedeployConfig: mocks.save,
  requestCanaryRedeploy: mocks.redeploy,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mocks.t,
  }),
}));
vi.mock('@/components/Common/Modal', () => ({
  Modal: ({ isOpen, footer }: ModalProps) =>
    isOpen ? <div role="dialog">{footer}</div> : null,
}));

const availableStatus: CanaryRedeployStatusResponse = {
  available: true,
  reason: 'available',
  branch: 'alpha',
  configuredBranch: null,
  runningSha: 'a'.repeat(40),
  remoteSha: 'b'.repeat(40),
  updateAvailable: true,
  checkedAt: 1,
  redeploy: null,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getStatus.mockResolvedValue(availableStatus);
  mocks.check.mockResolvedValue(availableStatus);
  mocks.save.mockResolvedValue({
    ...availableStatus,
    branch: 'x/alpha',
    configuredBranch: 'x/alpha',
  });
  mocks.redeploy.mockResolvedValue({
    ...availableStatus,
    redeploy: { state: 'requested', branch: 'alpha', startedAt: 2 },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSettings() {
  await act(async () => {
    root.render(<CanaryRedeploySettings />);
  });
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(result).toBeDefined();
  return result as HTMLButtonElement;
}

describe('CanaryRedeploySettings', () => {
  it('stays hidden when Canary redeployment is disabled', async () => {
    mocks.getStatus.mockResolvedValueOnce({
      ...availableStatus,
      available: false,
      reason: 'disabled',
    });
    await renderSettings();
    expect(container.textContent).toBe('');
  });

  it('checks on mount and requires confirmation before redeploying', async () => {
    await renderSettings();
    expect(mocks.check).toHaveBeenCalledOnce();

    act(() => button('settings.canaryRedeployAction').click());
    await act(async () => {
      button('settings.canaryConfirmAction').click();
    });

    expect(mocks.redeploy).toHaveBeenCalledOnce();
    expect(mocks.redeploy).toHaveBeenCalledWith('alpha');
    expect(mocks.toast).toHaveBeenCalledWith('settings.canaryRedeployStarted', {
      tone: 'info',
      duration: 10_000,
    });
  });

  it('persists a configured branch and uses an empty value for the alpha default', async () => {
    await renderSettings();
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.placeholder).toBe('alpha');
    expect(input?.value).toBe('');

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue?.call(input, 'x/alpha');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('settings.canaryBranchSave').click());

    expect(mocks.save).toHaveBeenCalledWith({ branch: 'x/alpha' });
    expect(input?.value).toBe('x/alpha');

    act(() => button('settings.canaryRedeployAction').click());
    await act(async () => {
      button('settings.canaryConfirmAction').click();
    });
    expect(mocks.redeploy).toHaveBeenCalledWith('x/alpha');
  });
});
