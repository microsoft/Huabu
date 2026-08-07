// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { renderPromptFile } from '../agents/loader.js';

const SYSTEM_TEMPLATE = 'external-agent/system_prompt.md';

/** Render the host-authored bootstrap delivered to every external agent. */
export function renderExternalAgentSystemPreamble(): string {
  return renderPromptFile(SYSTEM_TEMPLATE, {});
}
