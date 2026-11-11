// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { updateNode, withCanvasMutex } from './write-coordinator.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
} from '../storage/testing.js';
import {
  commitWorkspaceIdentity,
  getWorkspaceHandle,
  getWorkspaceKey,
  isWorkspaceLeased,
  WorkspaceOperationInProgressError,
} from '../workspace.js';

forEachProductProfile((profile, label) => {
  describe(`standalone node write scope (${label})`, () => {
    it('prevents a Workspace switch while a standalone node write is queued', async () => {
      const mounted = await mountTestWorkspace(profile, 'huabu-node-scope-');
      try {
        const canvasId = 'space-queued-content';
        const nodeId = 'node-queued-content';
        const created = await mounted.storage.structured.spaces().create({
          canvasId,
          title: 'Queued content',
        });
        if (!created.ok) throw new Error('Expected to create fixture Space');
        const handle = mounted.storage.space(canvasId);
        expect(
          await handle.write({
            expectedVersion: 0,
            nextRecord: {
              ...created.record,
              version: 1,
              state: {
                nodes: [
                  {
                    id: nodeId,
                    type: 'note',
                    position: { x: 0, y: 0 },
                    data: {},
                  },
                ],
                edges: [],
              },
            },
            nodeMutations: [
              {
                kind: 'put',
                nodeId,
                record: {
                  nodeId,
                  type: 'note',
                  label: 'Note',
                  content: 'original',
                },
              },
            ],
          }),
        ).toEqual({ ok: true });
        const nodes = handle.nodes;
        const workspace = getWorkspaceHandle();
        if (!workspace) throw new Error('Missing fixture Workspace');
        const workspaceKey = getWorkspaceKey();
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const blocker = withCanvasMutex(canvasId, async () => {
          enter();
          await gate;
        });
        await entered;
        const pending = updateNode(nodes, nodeId, {
          apply: (current) => {
            if (!current) throw new Error('Missing fixture node');
            return { ...current, content: 'leased update' };
          },
        });
        try {
          expect(isWorkspaceLeased(workspaceKey)).toBe(true);
          expect(() =>
            commitWorkspaceIdentity({
              ...workspace,
              workspaceId: `${workspace.workspaceId}-other`,
            }),
          ).toThrow(WorkspaceOperationInProgressError);
          expect(getWorkspaceKey()).toBe(workspaceKey);
          expect((await nodes.read(nodeId))?.record.content).toBe('original');
        } finally {
          release();
          await blocker;
          await pending;
        }
        expect(isWorkspaceLeased(workspaceKey)).toBe(false);
        expect((await nodes.read(nodeId))?.record.content).toBe(
          'leased update',
        );
      } finally {
        await mounted.close();
      }
    });
  });
});
