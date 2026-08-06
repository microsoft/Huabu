// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  IntegrationsConfig,
  IntegrationsConfigUpdate,
} from '@huabu/shared';

/** Fetch the masked status of stored third-party API keys. */
export async function getIntegrationsConfig(): Promise<IntegrationsConfig> {
  return apiFetch<IntegrationsConfig>(routes.integrationsConfig, {
    fallbackMessage: 'Failed to get integrations config',
  });
}

/** Save third-party API keys. Empty fields keep the existing values. */
export async function putIntegrationsConfig(
  update: IntegrationsConfigUpdate,
): Promise<IntegrationsConfig> {
  return apiFetch<IntegrationsConfig>(routes.integrationsConfig, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update integrations config',
  });
}
