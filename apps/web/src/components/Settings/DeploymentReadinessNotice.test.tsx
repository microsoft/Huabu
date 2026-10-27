// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

import { DeploymentReadinessNotice } from './DeploymentReadinessNotice';

import type { DeploymentReadinessResponse } from '@huabu/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useDeploymentReadinessStore.setState({ readiness: null, error: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDeploymentReadinessStore.setState({ readiness: null, error: null });
});

describe('deployment readiness notice', () => {
  it.each([true, false])(
    'shows the no-login warning only when reported: %s',
    async (disabled) => {
      const readiness: DeploymentReadinessResponse = {
        bind: { host: '0.0.0.0', scope: 'network' },
        access: {
          allowedHostsConfigured: true,
          basicAuthConfigured: !disabled,
        },
        owner: {
          policy: disabled ? 'unauthenticated' : 'loopback-or-basic-auth',
          allowedForRequest: true,
        },
        credentials: { writable: true, reason: 'available' },
        transport: { status: 'operator-unverified' },
        issues: disabled
          ? [{ code: 'REMOTE_LOGIN_DISABLED', severity: 'warning' }]
          : [],
      };
      useDeploymentReadinessStore.setState({ readiness });
      await act(async () => root.render(<DeploymentReadinessNotice />));
      expect(
        container.textContent?.includes('settings.remoteLoginDisabled'),
      ).toBe(disabled);
      expect(container.textContent).not.toContain(
        'settings.remoteTransportUnverified',
      );
      if (!disabled) expect(container.innerHTML).toBe('');
    },
  );
});
