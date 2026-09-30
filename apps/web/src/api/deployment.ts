// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  CanaryRedeployStatusResponse,
  DeploymentReadinessResponse,
} from '@huabu/shared';

export function getDeploymentReadiness(): Promise<DeploymentReadinessResponse> {
  return apiFetch<DeploymentReadinessResponse>(routes.deploymentReadiness, {
    fallbackMessage: 'Failed to load deployment readiness',
  });
}

export function getCanaryRedeployStatus(): Promise<CanaryRedeployStatusResponse> {
  return apiFetch<CanaryRedeployStatusResponse>(routes.canaryRedeployStatus, {
    fallbackMessage: 'Failed to load Canary redeployment status',
  });
}

export function checkCanaryRedeploy(): Promise<CanaryRedeployStatusResponse> {
  return apiFetch<CanaryRedeployStatusResponse>(routes.canaryRedeployCheck, {
    method: 'POST',
    json: {},
    fallbackMessage: 'Failed to check origin/alpha',
  });
}

export function requestCanaryRedeploy(): Promise<CanaryRedeployStatusResponse> {
  return apiFetch<CanaryRedeployStatusResponse>(routes.canaryRedeploy, {
    method: 'POST',
    json: {},
    fallbackMessage: 'Failed to start Canary redeployment',
  });
}
