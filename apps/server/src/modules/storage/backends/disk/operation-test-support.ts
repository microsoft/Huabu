// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canvasRoot } from './layout.js';
import { nodeContentToMarkdown } from './legacy/canvas-store.js';
import { diskBytesDigest } from './operation-redo.js';
import { createDiskSpaceOperations } from './space-operations.js';
import { DiskStructuredStore } from './structured-store.js';
import { getWorkspaceHandle } from '../../../workspace.js';
import { mountTestWorkspace } from '../../testing.js';

import type { SpaceOperationSnapshot } from '../../ports/operations.js';
import type { CanvasNodeType, CanvasOperationRequest } from '@huabu/shared';

export async function createDiskOperationFixture(
  nodeType: CanvasNodeType,
  cleanup: Array<() => Promise<void>>,
) {
  const mount = await mountTestWorkspace(
    { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
    'huabu-disk-operations-',
  );
  cleanup.push(() => mount.close());
  const canvasId = 'operation-test';
  const store = new DiskStructuredStore();
  const handle = mount.storage.space(canvasId);
  const created = await store.spaces().create({ canvasId, title: null });
  if (!created.ok) throw new Error('Space fixture creation failed');
  const record = {
    ...created.record,
    state: {
      nodes: ['a', 'b'].map((id) => ({
        id,
        type: id === 'a' ? nodeType : 'note',
        position: { x: 0, y: 0 },
        data: {
          style: { accent: 'white' },
          ...(id === 'a' && nodeType === 'question'
            ? { threadId: 'thread-test' }
            : {}),
        },
      })),
      edges: [],
    },
  };
  const root = mount.workspacePath;
  const spaceDir = canvasRoot(canvasId);
  const statePath = path.relative(root, path.join(spaceDir, 'space.json'));
  const body = {
    nodeId: 'a',
    type: nodeType,
    label: 'A',
    content: 'Original body',
    ...(nodeType === 'video' ? { src: 'movie.mp4' } : {}),
  };
  const bodyBytes = nodeContentToMarkdown(body);
  const sidecarPath = path.relative(root, path.join(spaceDir, 'nodes', 'A.md'));
  mkdirSync(path.dirname(path.join(root, sidecarPath)), { recursive: true });
  writeFileSync(path.join(root, sidecarPath), bodyBytes);
  writeFileSync(path.join(root, statePath), JSON.stringify(record));
  const spaceEpoch = randomUUID();
  const metadata: SpaceOperationSnapshot['metadata'] = {
    modelVersion: 1,
    spaceEpoch,
    earliestReplayVersion: 0,
    reviewRevision: 0,
    siblingOrderVersions: [{ parentId: null, version: 0 }],
    nodes: Object.fromEntries(
      ['a', 'b'].map((id) => [
        id,
        {
          incarnation: randomUUID(),
          membershipVersion: 0,
          coordinateContext: `root:${spaceEpoch}`,
          fieldVersions: { position: 0, 'style.accent': 0 },
        },
      ]),
    ),
  };
  const operationDir = `.huabu-operations/${canvasId}`;
  mkdirSync(path.join(root, operationDir), { recursive: true });
  writeFileSync(
    path.join(root, operationDir, 'head.json'),
    JSON.stringify({
      workspaceId: getWorkspaceHandle()?.workspaceId,
      canvasId,
      metadata,
      recordDigest: diskBytesDigest(JSON.stringify(record)),
      sidecars: { a: { filename: 'A.md', digest: diskBytesDigest(bodyBytes) } },
      reviews: {},
    }),
  );
  const operations = createDiskSpaceOperations(canvasId, () => 1000);
  const session = await operations.createSession('owner');
  const meta = metadata.nodes['a'];
  if (!meta) throw new Error('Missing fixture metadata');
  const request: CanvasOperationRequest = {
    protocolVersion: 1,
    spaceEpoch,
    sessionId: session.sessionId,
    operationId: randomUUID(),
    observedVersion: 0,
    mode: 'atomic',
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 10, y: 20 } }],
      },
    ],
    preconditions: [
      {
        kind: 'coordinates',
        commandIndex: 0,
        nodeId: 'a',
        parentId: null,
        incarnation: meta.incarnation,
        membershipVersion: 0,
        coordinateContext: meta.coordinateContext,
      },
    ],
  };
  const snapshot = { record, metadata, sidecars: { a: body }, reviews: {} };
  return {
    mount,
    store,
    root,
    canvasId,
    operations,
    handle,
    request,
    snapshot,
    operationDir,
    statePath,
    sidecarPath,
  };
}
