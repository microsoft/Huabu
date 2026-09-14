// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { AgentChangeReviewConfig } from '@huabu/shared';

export async function getAgentChangeReviewConfig(): Promise<AgentChangeReviewConfig> {
  return apiFetch<AgentChangeReviewConfig>(routes.agentChangeReviewConfig, {
    fallbackMessage: 'Failed to load Agent change-review settings',
  });
}

export async function updateAgentChangeReviewConfig(
  config: AgentChangeReviewConfig,
): Promise<AgentChangeReviewConfig> {
  return apiFetch<AgentChangeReviewConfig>(routes.agentChangeReviewConfig, {
    method: 'PUT',
    json: config,
    fallbackMessage: 'Failed to save Agent change-review settings',
  });
}
