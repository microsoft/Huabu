// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** These values are observations, never ordinary Canvas edit operands. */
export const AGENT_NODE_OWNED_DATA_KEYS = [
  'bindingState',
  'status',
  'errorMessage',
  'invocationToken',
  'viewed',
  'threadId',
  'conversationTitleSource',
] as const;

export const AGENT_NODE_PREPARATION_KEYS = [
  'agentBinding',
  'agentLaunchOverrides',
] as const;

export function hasAgentNodeOwnedData(data: Record<string, unknown>): boolean {
  return AGENT_NODE_OWNED_DATA_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(data, key),
  );
}

export function projectAgentNodeEditableData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const editable = { ...data };
  for (const key of AGENT_NODE_OWNED_DATA_KEYS) delete editable[key];
  return editable;
}

export function preserveAgentNodeOwnedData(
  incoming: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...incoming };
  for (const key of AGENT_NODE_OWNED_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current, key))
      result[key] = current[key];
    else delete result[key];
  }
  return result;
}

/** Apply only a recorded editable data effect, never an old complete snapshot. */
export function replayAgentNodeEditableData(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  const protectedKeys: ReadonlySet<string> = new Set(
    AGENT_NODE_OWNED_DATA_KEYS,
  );
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      protectedKeys.has(key) ||
      JSON.stringify(before[key]) === JSON.stringify(after[key])
    )
      continue;
    if (Object.prototype.hasOwnProperty.call(after, key))
      result[key] = after[key];
    else delete result[key];
  }
  return result;
}

function bindingIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object') return { kind: 'internal' };
  const binding = value as Record<string, unknown>;
  return binding.kind === 'external'
    ? { kind: 'external', profileId: binding.profileId }
    : { kind: 'internal' };
}

/** Display aliases and internal ask/operate mode are not execution identity. */
export function changesAgentNodePreparation(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  if (
    patch.agentBinding !== undefined &&
    JSON.stringify(bindingIdentity(current.agentBinding)) !==
      JSON.stringify(bindingIdentity(patch.agentBinding))
  )
    return true;
  if (patch.agentLaunchOverrides !== undefined) {
    const before = (current.agentLaunchOverrides ?? {}) as Record<
      string,
      unknown
    >;
    const after = (patch.agentLaunchOverrides ?? {}) as Record<string, unknown>;
    return (
      before.workingDirPath !== after.workingDirPath ||
      before.additionalInitialPreamble !== after.additionalInitialPreamble
    );
  }
  return false;
}
