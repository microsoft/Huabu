// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { DeploymentReadinessResponse } from '@huabu/shared';

export function getDeploymentReadiness(): Promise<DeploymentReadinessResponse> {
  return apiFetch<DeploymentReadinessResponse>(routes.deploymentReadiness, {
    fallbackMessage: 'Failed to load deployment readiness',
  });
}
