// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  AgentNodeLifecycle,
  AgentNodeLifecycleError,
} from './agent-node-lifecycle.js';

import type { FixedAgentNodeTarget } from './agent-thread-resolver.js';
import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';
import type { CanvasNodeId } from '@huabu/shared';

const TARGET: FixedAgentNodeTarget = {
  canvasId: 'canvas-a',
  nodeId: 'node-agent' as CanvasNodeId,
  threadId: 'thread-a',
  agentBinding: {
    kind: 'external',
    profileId: 'profile-a',
    alias: 'Researcher',
  },
  status: 'idle',
  content: '',
};

function output(applied = true): ExecuteOnServerOutput {
  return {
    canvasId: 'canvas-a',
    fromVersion: 1,
    toVersion: 2,
    deltas: [],
    commands: [],
    results: [
      {
        command: { type: 'DELETE_NODES', nodeIds: [] },
        applied,
      },
    ],
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  };
}

describe('AgentNodeLifecycle', () => {
  it('writes first content once and serializes lifecycle patches', async () => {
    const execute = vi.fn().mockResolvedValue(output());
    const lifecycle = new AgentNodeLifecycle({ execute });

    await Promise.all([
      lifecycle.start(TARGET, 'Initial task'),
      lifecycle.done(TARGET),
    ]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      {
        canvasId: 'canvas-a',
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-agent',
                patch: {
                  content: 'Initial task',
                  status: 'running',
                  errorMessage: '',
                },
              },
            ],
          },
        ],
        originator: { source: 'system' },
      },
      expect.objectContaining({
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-agent',
                patch: { status: 'done', errorMessage: '' },
              },
            ],
          },
        ],
      }),
    ]);
  });

  it('preserves first-turn content on follow-up starts', async () => {
    const execute = vi.fn().mockResolvedValue(output());
    const lifecycle = new AgentNodeLifecycle({ execute });

    await lifecycle.start(
      { ...TARGET, status: 'done', content: 'Initial task' },
      'Follow-up',
    );

    expect(
      execute.mock.calls[0]?.[0].commands[0].patches[0].patch,
    ).not.toHaveProperty('content');
  });

  it('surfaces rejected Canvas lifecycle updates', async () => {
    const lifecycle = new AgentNodeLifecycle({
      execute: vi.fn().mockResolvedValue(output(false)),
    });

    await expect(
      lifecycle.start(TARGET, 'Initial task'),
    ).rejects.toBeInstanceOf(AgentNodeLifecycleError);
  });
});
