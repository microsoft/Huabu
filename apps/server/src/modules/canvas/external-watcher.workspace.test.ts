// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import {
  openExternalNoteSession,
  resetExternalNoteSessions,
  takeExternalNote,
} from './external-watcher.js';
import { nodesDir } from '../storage/backends/disk/layout.js';
import { closeStorage, createSpace } from '../storage/index.js';
import { runInWorkspace } from '../workspace/context.js';
import { getProcessWorkspaceHandle, setWorkspacePath } from '../workspace.js';

import type { ExternalNoteEvent } from '@huabu/shared';

const roots: string[] = [];
afterEach(async () => {
  resetExternalNoteSessions();
  await closeStorage();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('preserves scoped watchers and discoveries across process folder changes, but resets process sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'huabu-scoped-watcher-'));
  roots.push(root);
  setWorkspacePath(root);
  await createSpace('shared-space', 'Shared');
  const nodes = nodesDir('shared-space');
  mkdirSync(nodes, { recursive: true });
  writeFileSync(join(nodes, 'before.md'), 'External before');
  const events: ExternalNoteEvent[] = [];
  const handle = getProcessWorkspaceHandle();
  if (!handle) throw new Error('Expected a configured Workspace');
  const scope = { handle, path: root };
  const scoped = await runInWorkspace(scope, () =>
    openExternalNoteSession('shared-space', (event) => events.push(event)),
  );
  const localEvents: ExternalNoteEvent[] = [];
  const local = await openExternalNoteSession('shared-space', (event) =>
    localEvents.push(event),
  );
  expect(scoped.snapshot.map((item) => item.fileName)).toEqual(['before.md']);
  const next = mkdtempSync(join(tmpdir(), 'huabu-next-watcher-'));
  roots.push(next);
  try {
    setWorkspacePath(next);
    expect(localEvents).toContainEqual({
      type: 'snapshot',
      data: { items: [] },
    });
    expect(events).toEqual([]);
    expect(
      runInWorkspace(scope, () =>
        takeExternalNote('shared-space', 'nodes/before.md'),
      ),
    ).not.toBeNull();
    writeFileSync(join(nodes, 'after.md'), 'External after');
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === 'added' && event.data.fileName === 'after.md',
        ),
      )
      .toBe(true);
    resetExternalNoteSessions();
    expect(events.at(-1)).toEqual({ type: 'snapshot', data: { items: [] } });
  } finally {
    scoped.close();
    local.close();
  }
});
