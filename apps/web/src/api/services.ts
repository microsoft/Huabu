// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  ServiceConfig,
  ServiceConfigUpdate,
  ServiceListResponse,
} from '@huabu/shared';

export function getServices(): Promise<ServiceListResponse> {
  return apiFetch(routes.services, {
    fallbackMessage: 'Failed to load Services',
  });
}

export function getService(id: string): Promise<ServiceConfig> {
  return apiFetch(routes.service(id), {
    fallbackMessage: 'Failed to load Service configuration',
  });
}

export function putService(
  id: string,
  update: ServiceConfigUpdate,
): Promise<ServiceConfig> {
  return apiFetch(routes.service(id), {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update Service configuration',
  });
}
