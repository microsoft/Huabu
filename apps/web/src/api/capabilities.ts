// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  CapabilityConfig,
  CapabilityConfigUpdate,
  CapabilityListResponse,
} from '@huabu/shared';

export function getCapabilities(): Promise<CapabilityListResponse> {
  return apiFetch(routes.capabilities, {
    fallbackMessage: 'Failed to load Capabilities',
  });
}

export function getCapability(id: string): Promise<CapabilityConfig> {
  return apiFetch(routes.capability(id), {
    fallbackMessage: 'Failed to load Capability configuration',
  });
}

export function putCapability(
  id: string,
  update: CapabilityConfigUpdate,
): Promise<CapabilityConfig> {
  return apiFetch(routes.capability(id), {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update Capability configuration',
  });
}
