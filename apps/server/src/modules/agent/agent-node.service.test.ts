// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { AgentNodeService } from './agent-node.service.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';
import type { CanvasNodeId } from '@huabu/shared';

const NOTE_ID = 'node-note' as CanvasNodeId;
const PARENT_ID = 'node-parent' as CanvasNodeId;

function output(applied: boolean): ExecuteOnServerOutput {
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

function createHarness(options?: {
  nodes?: Array<{ id: string; type?: string }> | null;
  selectableIds?: string[];
  nodeApplied?: boolean;
  edgeApplied?: boolean;
  edgeError?: Error;
}) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(output(options?.nodeApplied ?? true));
  if (options?.edgeError) {
    execute.mockRejectedValueOnce(options.edgeError);
  } else {
    execute.mockResolvedValueOnce(output(options?.edgeApplied ?? true));
  }
  const service = new AgentNodeService({
    getProfileRegistry: () => ({
      getProfile: (profileId) =>
        profileId === 'profile-a'
          ? {
              id: 'profile-a',
              alias: 'Researcher',
              customData: {
                icon: { shape: 'diamond', color: 'green' },
              },
            }
          : null,
      listSelectableProfileIds: () => options?.selectableIds ?? ['profile-a'],
    }),
    readCanvasNodes: async () =>
      options?.nodes === undefined
        ? [
            { id: NOTE_ID, type: 'note' },
            {
              id: PARENT_ID,
              type: 'question',
              data: { threadId: 'thread-parent' },
            },
          ]
        : options.nodes,
    execute,
  });
  return { service, execute };
}

describe('AgentNodeService', () => {
  it('creates one external Question Node and then its lineage edge', async () => {
    const { service, execute } = createHarness();

    const result = await service.create({
      canvasId: 'canvas-a',
      profileId: 'profile-a',
      position: { x: 120, y: 240 },
      anchor: { kind: 'task-root', taskNoteNodeId: NOTE_ID },
      launchOverrides: {
        workingDirPath: '/work/research',
        additionalInitialPreamble: 'Focus on primary sources.',
      },
    });

    expect(result.canvasId).toBe('canvas-a');
    expect(result.nodeId).toMatch(/^node-/);
    expect(result.threadId).toMatch(/^thread-/);
    expect(result.profileId).toBe('profile-a');
    expect(result.parentConnection).toBe('connected');
    expect(execute).toHaveBeenCalledTimes(2);
    const call = execute.mock.calls[0]?.[0];
    expect(call.originator).toEqual({ source: 'system' });
    expect(call.commands).toEqual([
      {
        type: 'CREATE_NODES',
        nodes: [
          expect.objectContaining({
            id: result.nodeId,
            nodeType: 'question',
            position: { x: 120, y: 240 },
            data: expect.objectContaining({
              content: '',
              threadId: result.threadId,
              agentBinding: {
                kind: 'external',
                profileId: 'profile-a',
                alias: 'Researcher',
              },
              agentBindingPolicy: 'fixed',
              agentIcon: { shape: 'diamond', color: 'green' },
              agentLaunchOverrides: {
                workingDirPath: '/work/research',
                additionalInitialPreamble: 'Focus on primary sources.',
              },
            }),
          }),
        ],
      },
    ]);
    expect(execute.mock.calls[1]?.[0].commands).toEqual([
      {
        type: 'CONNECT_NODES',
        edges: [
          expect.objectContaining({
            source: NOTE_ID,
            target: result.nodeId,
          }),
        ],
      },
    ]);
  });

  it('accepts a Question Node as an optional parent', async () => {
    const { service, execute } = createHarness();

    await service.create({
      canvasId: 'canvas-a',
      profileId: 'profile-a',
      position: { x: 1, y: 2 },
      anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
    });

    expect(execute.mock.calls[1]?.[0].commands[0]).toEqual({
      type: 'CONNECT_NODES',
      edges: [
        expect.objectContaining({
          source: PARENT_ID,
        }),
      ],
    });
  });

  it('rejects unavailable Profiles but not an unavailable parent', async () => {
    const unavailable = createHarness({ selectableIds: [] });
    await expect(
      unavailable.service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'task-root', taskNoteNodeId: NOTE_ID },
      }),
    ).rejects.toMatchObject({ code: 'profile_not_selectable' });
    expect(unavailable.execute).not.toHaveBeenCalled();

    const threadlessParent = createHarness({
      nodes: [{ id: PARENT_ID, type: 'question' }],
    });
    const result = await threadlessParent.service.create({
      canvasId: 'canvas-a',
      profileId: 'profile-a',
      position: { x: 1, y: 2 },
      anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
    });
    expect(result.parentConnection).toBe('failed');
    expect(threadlessParent.execute).toHaveBeenCalledOnce();
  });

  it('validates launch overrides before execution', async () => {
    const { service, execute } = createHarness();

    await expect(
      service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'task-root', taskNoteNodeId: NOTE_ID },
        launchOverrides: { workingDirPath: 'relative/path' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_launch_overrides' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a created Agent when its optional parent edge is rejected', async () => {
    const { service } = createHarness({ edgeApplied: false });

    await expect(
      service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
      }),
    ).resolves.toMatchObject({
      nodeId: expect.stringMatching(/^node-/),
      parentConnection: 'failed',
    });
  });

  it('returns a created Agent when parent edge execution throws', async () => {
    const { service } = createHarness({
      edgeError: new Error('Canvas edge write failed'),
    });

    await expect(
      service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
      }),
    ).resolves.toMatchObject({ parentConnection: 'failed' });
  });

  it('creates the Huabu Agent without an external Profile registry lookup', async () => {
    const { service, execute } = createHarness({ selectableIds: [] });

    const result = await service.create({
      canvasId: 'canvas-a',
      position: { x: 1, y: 2 },
      launchOverrides: {
        additionalInitialPreamble: 'Review before editing.',
      },
    });

    expect(result).toMatchObject({
      profileId: 'huabu',
      parentConnection: 'not_requested',
    });
    expect(execute.mock.calls[0]?.[0].commands[0]).toEqual(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            data: expect.objectContaining({
              agentBinding: { kind: 'internal' },
              agentLaunchOverrides: {
                additionalInitialPreamble: 'Review before editing.',
              },
            }),
          }),
        ],
      }),
    );
  });
});
