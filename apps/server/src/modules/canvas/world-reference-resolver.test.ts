// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '', leases: 0 }));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
  acquireWorkspaceOperationLease: () => {
    const workspacePath = workspaceState.path;
    workspaceState.leases += 1;
    let released = false;
    return {
      workspacePath,
      release: () => {
        if (released) return;
        released = true;
        workspaceState.leases -= 1;
      },
    };
  },
}));

import {
  resolveWorldReferences,
  WorldReferenceResolutionError,
} from './world-reference-resolver.js';
import { refreshCanvasDirIndex } from '../storage/canvas-dirs.js';

function writeCanvasAt(
  workspacePath: string,
  directory: string,
  canvasId: string,
  nodes: unknown[],
): string {
  const root = path.join(workspacePath, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title: directory,
      version: 0,
      state: { nodes, edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
  return root;
}

function writeCanvas(
  directory: string,
  canvasId: string,
  nodes: unknown[],
): string {
  return writeCanvasAt(workspaceState.path, directory, canvasId, nodes);
}

function switchWorkspace(nextPath: string): void {
  if (workspaceState.leases > 0) {
    throw new Error('Workspace operation in progress');
  }
  workspaceState.path = nextPath;
  refreshCanvasDirIndex();
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(
    path.join(tmpdir(), 'huabu-world-references-'),
  );
  workspaceState.leases = 0;
  writeCanvas('.world', 'canvas-world', [
    {
      id: 'node-portal-a',
      type: 'canvasRef',
      position: { x: 0, y: 0 },
      data: { targetCanvasId: 'canvas-a' },
    },
    {
      id: 'node-ref-ok',
      type: 'nodeRef',
      position: { x: 0, y: 0 },
      parentId: 'node-portal-a',
      data: { target: { canvasId: 'canvas-a', nodeId: 'node-source' } },
    },
    {
      id: 'node-ref-missing',
      type: 'nodeRef',
      position: { x: 0, y: 0 },
      parentId: 'node-portal-a',
      data: { target: { canvasId: 'canvas-a', nodeId: 'node-gone' } },
    },
    {
      id: 'node-frame-ref',
      type: 'frameRef',
      position: { x: 0, y: 0 },
      parentId: 'node-portal-a',
      data: { target: { canvasId: 'canvas-a', nodeId: 'node-frame' } },
    },
    {
      id: 'node-portal-gone',
      type: 'canvasRef',
      position: { x: 0, y: 0 },
      data: { targetCanvasId: 'canvas-gone' },
    },
  ]);
  const sourceRoot = writeCanvas('Project A', 'canvas-a', [
    {
      id: 'node-source',
      type: 'question',
      position: { x: 10, y: 20 },
      data: {
        threadId: 'thread-source',
        status: 'running',
        viewed: false,
        agentMode: 'operate',
        agentBinding: {
          kind: 'external',
          profileId: 'profile-source',
          alias: 'Source Agent',
        },
        hasAuthoredContent: true,
      },
    },
    {
      id: 'node-frame',
      type: 'frame',
      position: { x: 100, y: 100 },
      data: { type: 'frame' },
    },
  ]);
  mkdirSync(path.join(sourceRoot, 'nodes'));
  writeFileSync(
    path.join(sourceRoot, 'nodes', 'Source note.md'),
    [
      '---',
      'id: node-source',
      'type: question',
      'label: Source note',
      'summary: Source summary',
      '---',
      'Source body',
    ].join('\n'),
    'utf8',
  );
  refreshCanvasDirIndex();
});

afterEach(() => {
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('World reference resolution', () => {
  it('batch resolves live, missing-node, and missing-canvas references', async () => {
    const response = await resolveWorldReferences('canvas-world');

    expect(response.references).toContainEqual({
      kind: 'canvasRef',
      referenceNodeId: 'node-portal-a',
      targetCanvasId: 'canvas-a',
      status: 'ok',
      title: 'Project A',
    });
    expect(response.references).toContainEqual(
      expect.objectContaining({
        kind: 'nodeRef',
        referenceNodeId: 'node-ref-ok',
        status: 'ok',
        source: expect.objectContaining({
          type: 'question',
          label: 'Source note',
          summary: 'Source summary',
          preview: 'Source body',
          threadId: 'thread-source',
          status: 'running',
          viewed: false,
          agentMode: 'operate',
          agentBinding: {
            kind: 'external',
            profileId: 'profile-source',
            alias: 'Source Agent',
          },
        }),
      }),
    );
    expect(response.references).toContainEqual(
      expect.objectContaining({
        referenceNodeId: 'node-ref-missing',
        status: 'node-missing',
      }),
    );
    expect(response.references).toContainEqual(
      expect.objectContaining({
        kind: 'frameRef',
        referenceNodeId: 'node-frame-ref',
        status: 'ok',
        source: expect.objectContaining({ type: 'frame' }),
      }),
    );
    expect(response.references).toContainEqual(
      expect.objectContaining({
        referenceNodeId: 'node-portal-gone',
        status: 'canvas-missing',
      }),
    );
  });

  it('rejects resolution outside World', async () => {
    await expect(resolveWorldReferences('canvas-a')).rejects.toBeInstanceOf(
      WorldReferenceResolutionError,
    );
  });

  it('surfaces a question without a thread as malformed source data', async () => {
    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-source',
        type: 'question',
        position: { x: 10, y: 20 },
        data: {},
      },
    ]);

    const response = await resolveWorldReferences('canvas-world');
    const reference = response.references.find(
      (candidate) => candidate.referenceNodeId === 'node-ref-ok',
    );

    expect(reference).toMatchObject({
      kind: 'nodeRef',
      status: 'ok',
      source: {
        type: 'question',
        status: 'idle',
        viewed: false,
        agentMode: 'ask',
        agentBinding: { kind: 'internal' },
        hasAuthoredContent: true,
      },
    });
    expect(
      reference?.kind === 'nodeRef' ? reference.source?.threadId : undefined,
    ).toBeUndefined();
  });

  it('surfaces a malformed source Space record', async () => {
    writeFileSync(
      path.join(workspaceState.path, 'Project A', 'space.json'),
      '{',
      'utf8',
    );

    await expect(resolveWorldReferences('canvas-world')).rejects.toThrow();
  });

  it('still resolves a reference whose node record is hand-broken', async () => {
    const sourceRoot = writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-source',
        type: 'note',
        position: { x: 10, y: 20 },
        data: {},
      },
    ]);
    writeFileSync(
      path.join(sourceRoot, 'nodes', 'Source note.md'),
      '---\ninvalid: "\n---\nbody',
      'utf8',
    );

    // Broken frontmatter is not a read failure — the storage port keeps such
    // a node readable so it stays repairable through the content PUT. This
    // resolver used to read source nodes strictly and 500 the whole World
    // view for one hand-edited file; now the reference resolves with whatever
    // survived the parse.
    const { references } = await resolveWorldReferences('canvas-world');
    const resolved = references.find(
      (reference) => reference.referenceNodeId === 'node-ref-ok',
    );
    expect(resolved?.status).toBe('ok');
  });

  it('keeps World authorization and referenced records in one Workspace', async () => {
    const originalWorkspace = workspaceState.path;
    const otherWorkspace = mkdtempSync(
      path.join(tmpdir(), 'huabu-world-references-other-'),
    );
    writeCanvasAt(otherWorkspace, '.world', 'canvas-world', [
      {
        id: 'node-portal-a',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        data: { targetCanvasId: 'canvas-a' },
      },
      {
        id: 'node-ref-ok',
        type: 'nodeRef',
        position: { x: 0, y: 0 },
        data: { target: { canvasId: 'canvas-a', nodeId: 'node-source' } },
      },
    ]);
    const otherSource = writeCanvasAt(
      otherWorkspace,
      'Other Project',
      'canvas-a',
      [
        {
          id: 'node-source',
          type: 'note',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    );
    mkdirSync(path.join(otherSource, 'nodes'));
    writeFileSync(
      path.join(otherSource, 'nodes', 'Other note.md'),
      [
        '---',
        'id: node-source',
        'type: note',
        'label: Other note',
        '---',
        'Other body',
      ].join('\n'),
      'utf8',
    );

    let switchError: unknown;
    queueMicrotask(() => {
      try {
        switchWorkspace(otherWorkspace);
      } catch (error) {
        switchError = error;
      }
    });

    try {
      const response = await resolveWorldReferences('canvas-world');
      const resolved = response.references.find(
        (reference) => reference.referenceNodeId === 'node-ref-ok',
      );

      expect(switchError).toBeInstanceOf(Error);
      expect(workspaceState.path).toBe(originalWorkspace);
      expect(resolved).toMatchObject({
        status: 'ok',
        source: { label: 'Source note', preview: 'Source body' },
      });
    } finally {
      workspaceState.path = originalWorkspace;
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});
