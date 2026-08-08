// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  AgentNodeCreationError,
  AgentNodeService,
} from './agent-node.service.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';
import type { CanvasNodeId } from '@huabu/shared';

const NOTE_ID = 'node-note' as CanvasNodeId;
const PARENT_ID = 'node-parent' as CanvasNodeId;

function output(applied: [boolean, boolean]): ExecuteOnServerOutput {
  return {
    canvasId: 'canvas-a',
    fromVersion: 1,
    toVersion: 2,
    deltas: [],
    commands: [],
    results: applied.map((value) => ({
      command: { type: 'DELETE_NODES', nodeIds: [] },
      applied: value,
    })),
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
  applied?: [boolean, boolean];
}) {
  const execute = vi
    .fn()
    .mockResolvedValue(output(options?.applied ?? [true, true]));
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
    readCanvasNodes: () =>
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
  it('creates one fixed external Question Node and its root lineage edge', async () => {
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
    expect(execute).toHaveBeenCalledOnce();
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

  it('accepts a Question Node as a delegated anchor', async () => {
    const { service, execute } = createHarness();

    await service.create({
      canvasId: 'canvas-a',
      profileId: 'profile-a',
      position: { x: 1, y: 2 },
      anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
    });

    expect(execute.mock.calls[0]?.[0].commands[1]).toEqual({
      type: 'CONNECT_NODES',
      edges: [
        expect.objectContaining({
          source: PARENT_ID,
        }),
      ],
    });
  });

  it('rejects unavailable Profiles and invalid anchors before execution', async () => {
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

    const invalidAnchor = createHarness();
    await expect(
      invalidAnchor.service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'task-root', taskNoteNodeId: PARENT_ID },
      }),
    ).rejects.toMatchObject({ code: 'invalid_anchor' });
    expect(invalidAnchor.execute).not.toHaveBeenCalled();

    const threadlessParent = createHarness({
      nodes: [{ id: PARENT_ID, type: 'question' }],
    });
    await expect(
      threadlessParent.service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'delegated', parentAgentNodeId: PARENT_ID },
      }),
    ).rejects.toMatchObject({ code: 'invalid_anchor' });
    expect(threadlessParent.execute).not.toHaveBeenCalled();
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

  it('reports a created orphan explicitly when only the edge is rejected', async () => {
    const { service } = createHarness({ applied: [true, false] });

    let error: unknown;
    try {
      await service.create({
        canvasId: 'canvas-a',
        profileId: 'profile-a',
        position: { x: 1, y: 2 },
        anchor: { kind: 'task-root', taskNoteNodeId: NOTE_ID },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentNodeCreationError);
    expect(error).toMatchObject({
      code: 'lineage_edge_failed',
      createdNodeId: expect.stringMatching(/^node-/),
    });
  });
});
