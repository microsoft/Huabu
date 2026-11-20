// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentNodeProjectionSchema } from '../types/api/agent-node.js';

import type { AgentNodeProjection } from '../types/api/agent-node.js';

/** Applies an owner-authorized projection, never an editable node-data patch. */
export function projectAgentNodeTransition(
  current: Readonly<Record<string, unknown>>,
  transition: AgentNodeProjection,
): Record<string, unknown> | null {
  const parsed = agentNodeProjectionSchema.parse(transition);
  if (
    current.threadId !== parsed.threadId ||
    (parsed.expectedInvocationToken !== undefined &&
      current.invocationToken !== parsed.expectedInvocationToken)
  )
    return null;
  if (current.bindingState === 'bound' && parsed.bindingState === 'editing')
    throw new Error('An established Agent binding cannot be demoted');
  const {
    threadId: _threadId,
    expectedInvocationToken: _expected,
    initialContent,
    ...patch
  } = parsed;
  const next: Record<string, unknown> = { ...current, ...patch };
  if (
    initialContent !== undefined &&
    !current.invocationToken &&
    typeof current.content === 'string' &&
    current.content.trim().length === 0
  )
    next.content = initialContent;
  return next;
}
