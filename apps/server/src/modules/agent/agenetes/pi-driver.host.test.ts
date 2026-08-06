// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveModelForRoleAsync, ensureApiKeyForRole } = vi.hoisted(() => ({
  resolveModelForRoleAsync: vi.fn(),
  ensureApiKeyForRole: vi.fn(),
}));

vi.mock('../llm.js', () => ({
  resolveModelForRoleAsync,
  ensureApiKeyForRole,
}));

vi.mock('../session-read-set.js', () => ({
  getSessionReadSet: () => new Map(),
}));

vi.mock('../tools/index.js', () => ({
  buildAgentToolsByNames: () => [],
}));

import { buildHuabuPiWorkloadSpec, huabuPiDriverPorts } from './pi-driver.js';

const modelRef = { type: 'host', id: 'active' } as const;
const baseContext = {
  workloadType: 'Job' as const,
  namespace: { name: 'test' },
  threadId: 'thread-1',
};

describe('Huabu pi-driver model routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveModelForRoleAsync.mockResolvedValue({ id: 'resolved-model' });
    ensureApiKeyForRole.mockResolvedValue('resolved-key');
  });

  it('routes Memory and Skill workloads through their model roles', async () => {
    await huabuPiDriverPorts.resolveModel(modelRef, {
      ...baseContext,
      hostContext: { modelRole: 'memory' },
    });
    await huabuPiDriverPorts.getApiKey(modelRef, {
      ...baseContext,
      hostContext: { modelRole: 'skill', hasImage: true },
    });

    expect(resolveModelForRoleAsync).toHaveBeenCalledWith('memory', {
      hasImage: undefined,
    });
    expect(ensureApiKeyForRole).toHaveBeenCalledWith('skill', {
      hasImage: true,
    });
  });

  it('defaults untagged workloads to Chat', async () => {
    await huabuPiDriverPorts.resolveModel(modelRef, baseContext);

    expect(resolveModelForRoleAsync).toHaveBeenCalledWith('chat', {
      hasImage: undefined,
    });
  });

  it('serializes model routing hints into host context', () => {
    const spec = buildHuabuPiWorkloadSpec({
      kind: 'internal',
      workloadType: 'Job',
      namespace: baseContext.namespace,
      threadId: 'thread-1',
      toolNames: [],
      modelRole: 'skill',
      hasImage: true,
    });

    expect(spec.spec.hostContext).toMatchObject({
      modelRole: 'skill',
      hasImage: true,
    });
  });
});
