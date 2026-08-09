// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { AgentThreadResolver } from './agent-thread-resolver.js';

import type { AgentThreadResolutionError } from './agent-thread-resolver.js';

function createResolver(
  nodes: Array<{
    id: string;
    type?: string;
    data?: Record<string, unknown>;
  }>,
  content = '',
) {
  return new AgentThreadResolver({
    readCanvasNodes: () => nodes,
    readNodeContent: () => content,
  });
}

const FIXED_NODE = {
  id: 'node-agent',
  type: 'question',
  data: {
    threadId: 'thread-a',
    agentBindingPolicy: 'fixed',
    agentBinding: {
      kind: 'external',
      profileId: 'profile-a',
      alias: 'Researcher',
    },
    agentLaunchOverrides: {
      workingDirPath: '/work/research',
      additionalInitialPreamble: 'Focus on primary sources.',
    },
    status: 'done',
  },
};

describe('AgentThreadResolver', () => {
  it('resolves a fixed external Agent Node from Canvas storage', () => {
    const target = createResolver(
      [FIXED_NODE],
      'Existing prompt',
    ).resolveFixedAgentNode('canvas-a', 'thread-a');

    expect(target).toEqual({
      canvasId: 'canvas-a',
      nodeId: 'node-agent',
      threadId: 'thread-a',
      agentBinding: {
        kind: 'external',
        profileId: 'profile-a',
        alias: 'Researcher',
      },
      launchOverrides: {
        workingDirPath: '/work/research',
        additionalInitialPreamble: 'Focus on primary sources.',
      },
      status: 'done',
      content: 'Existing prompt',
    });
  });

  it('falls back for selectable or unrelated threads', () => {
    const selectable = {
      ...FIXED_NODE,
      data: { ...FIXED_NODE.data, agentBindingPolicy: 'selectable' },
    };
    expect(
      createResolver([selectable]).resolveFixedAgentNode(
        'canvas-a',
        'thread-a',
      ),
    ).toBeNull();
    expect(
      createResolver([FIXED_NODE]).resolveFixedAgentNode(
        'canvas-a',
        'thread-other',
      ),
    ).toBeNull();
  });

  it('resolves any Question Node as a possible parent', () => {
    const selectable = {
      ...FIXED_NODE,
      data: { ...FIXED_NODE.data, agentBindingPolicy: 'selectable' },
    };
    expect(
      createResolver([selectable]).resolveAgentNodeId('canvas-a', 'thread-a'),
    ).toBe('node-agent');
  });

  it('resolves a Huabu Agent binding for invocation', () => {
    const internal = {
      ...FIXED_NODE,
      data: {
        ...FIXED_NODE.data,
        agentBinding: { kind: 'internal' },
      },
    };
    expect(
      createResolver([internal]).resolveFixedAgentNode('canvas-a', 'thread-a')
        ?.agentBinding,
    ).toEqual({ kind: 'internal' });
  });

  it('rejects duplicate threads and corrupt fixed-node metadata', () => {
    const duplicateResolver = createResolver([
      FIXED_NODE,
      { ...FIXED_NODE, id: 'node-agent-2' },
    ]);
    expect(() =>
      duplicateResolver.resolveFixedAgentNode('canvas-a', 'thread-a'),
    ).toThrowError(
      expect.objectContaining<Partial<AgentThreadResolutionError>>({
        code: 'duplicate_thread',
      }),
    );

    const corruptResolver = createResolver([
      { ...FIXED_NODE, data: { ...FIXED_NODE.data, agentBinding: null } },
    ]);
    expect(() =>
      corruptResolver.resolveFixedAgentNode('canvas-a', 'thread-a'),
    ).toThrowError(
      expect.objectContaining<Partial<AgentThreadResolutionError>>({
        code: 'invalid_binding',
      }),
    );
  });
});
