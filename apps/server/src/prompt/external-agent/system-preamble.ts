// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { HUABU_REQUIRED_RESOURCE_IDS } from '@huabu/shared';

import { renderPromptFile } from '../agents/loader.js';

const SYSTEM_TEMPLATE = 'external-agent/system_prompt.md';
export const DEFAULT_HUABU_RESOURCE_IDS = HUABU_REQUIRED_RESOURCE_IDS;

/** Render the host-authored bootstrap delivered to every external agent. */
export function renderExternalAgentSystemPreamble(
  resourceIds: readonly string[] = DEFAULT_HUABU_RESOURCE_IDS,
): string {
  return renderPromptFile(SYSTEM_TEMPLATE, {
    resourceIds: resourceIds.map((id) => `\`${id}\``).join(', '),
  });
}
