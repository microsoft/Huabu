// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { isCurrentReachback } from './reachback-conversation.js';
import { mountTestWorkspace } from '../../storage/testing.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import { getWorkspaceHandle } from '../../workspace.js';
import { agenetes } from '../agenetes/drivers.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'huabu-reachback-'));
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  writeFileSync(
    join(dataDir, 'agentlet-owners.json'),
    JSON.stringify({ 'alice-device': 'alice', 'bob-device': 'bob' }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

it('accepts a reachback only for its live external conversation on its owner device', async () => {
  const opened = await mountTestWorkspace({
    structured: { kind: 'disk' },
    blobs: { kind: 'disk' },
  });
  try {
    const workspaceId = getWorkspaceHandle()!.workspaceId;
    const records = new Map<string, unknown>([
      [
        'space-a|thread-a',
        { spec: { kind: 'external', spec: { agentletId: 'alice-device' } } },
      ],
      [
        'space-a|thread-bob',
        { spec: { kind: 'external', spec: { agentletId: 'bob-device' } } },
      ],
      ['space-a|thread-builtin', { spec: { kind: 'internal', spec: {} } }],
    ]);
    vi.spyOn(agenetes, 'record').mockImplementation(
      async (namespace, threadId) =>
        // The conversation is looked up in its Space's own namespace.
        (namespace.ownerId === canvasAcpNamespace(namespace.name).ownerId
          ? records.get(`${namespace.name}|${threadId}`)
          : undefined) as never,
    );
    const claims = {
      aud: 'rfs' as const,
      principalId: 'alice',
      v: 0,
      workspaceId,
      canvasId: 'space-a',
      threadId: 'thread-a',
    };
    expect(await isCurrentReachback(claims)).toBe(true);
    for (const changed of [
      { threadId: 'deleted-thread' },
      { canvasId: 'space-b' },
      { threadId: 'thread-bob' },
      { threadId: 'thread-builtin' },
      { workspaceId: '00000000-0000-4000-8000-000000000000' },
    ])
      expect(await isCurrentReachback({ ...claims, ...changed })).toBe(false);
  } finally {
    await opened.close();
  }
});
