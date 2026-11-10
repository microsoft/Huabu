// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { runInWorkspace } from './context.js';
import {
  adoptWorkspaceDirectory,
  closeStorage,
  createSpace,
  openWorkspace,
  space,
} from '../storage/index.js';
import { getProcessWorkspaceHandle, setWorkspacePath } from '../workspace.js';

import type * as Activation from '../workspace-activation.js';

const preparation = vi.hoisted(() => ({ workerPath: '', calls: 0 }));
// Use the real worker by default; failure cases supply a worker that returns
// an error through the same child-process protocol.
vi.mock('../workspace-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Activation>();
  return {
    ...actual,
    runWorkspacePreparation: (path: string) => {
      preparation.calls++;
      return actual.runWorkspacePreparation(path, {
        workerPath: preparation.workerPath || undefined,
        timeoutMs: 5_000,
      });
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await closeStorage();
  preparation.calls = 0;
  preparation.workerPath = '';
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('prepares an inactive Disk Workspace once before concurrent scoped opens return', async () => {
  const root = mkdtempSync(join(tmpdir(), 'huabu-scoped-open-'));
  roots.push(root);
  const target = join(root, 'target');
  setWorkspacePath(target);
  await createSpace('legacy-space', 'Legacy');
  const chat = join(target, 'Legacy', '.history', 'chat');
  mkdirSync(chat, { recursive: true });
  const source = join(chat, 'legacy-thread.turns.jsonl');
  writeFileSync(
    source,
    JSON.stringify({
      envelope: {
        user: { text: 'old message', attachments: [] },
        skills: { invokedIds: [], resolved: [] },
        focus: {
          selection: {
            refs: [],
            selectedIds: [],
            imageAttachments: [],
            snapshotAttachments: [],
          },
        },
      },
      transcript: [
        { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
      ],
    }) + '\n',
  );
  renameSync(
    join(target, 'Legacy', 'space.json'),
    join(target, 'Legacy', 'canvas.json'),
  );
  const workspace = adoptWorkspaceDirectory(target);
  setWorkspacePath(join(root, 'process'));
  const processWorkspace = getProcessWorkspaceHandle();
  const scopes = await Promise.all([
    openWorkspace(workspace),
    openWorkspace(workspace),
  ]);
  expect(existsSync(source)).toBe(false);
  expect(existsSync(source + '.bak')).toBe(true);
  const turns = JSON.parse(
    readFileSync(
      join(
        target,
        'Legacy',
        '.history',
        'chat_v2',
        'legacy-thread.turns.jsonl',
      ),
      'utf8',
    ).trim(),
  );
  expect(turns.turn.request).toMatchObject({
    type: 'huabu.chat',
    content: { user: { text: 'old message' } },
  });
  await expect(
    runInWorkspace(scopes[0], () => space('legacy-space').read()),
  ).resolves.toMatchObject({ title: 'Legacy' });
  await openWorkspace(workspace);
  expect(preparation.calls).toBe(1);
  expect(getProcessWorkspaceHandle()).toEqual(processWorkspace);
});

it('rejects a failed preparation and retries after repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'huabu-scoped-open-retry-'));
  roots.push(root);
  setWorkspacePath(join(root, 'process'));
  const workspace = adoptWorkspaceDirectory(join(root, 'target'));
  preparation.workerPath = join(root, 'worker.mjs');
  const success = `process.send({ ok: true });`;
  writeFileSync(
    preparation.workerPath,
    `process.send({ ok: false, message: 'Preparation failed' });`,
  );
  await expect(openWorkspace(workspace)).rejects.toThrow('Preparation failed');
  writeFileSync(preparation.workerPath, success);
  await expect(openWorkspace(workspace)).resolves.toMatchObject({
    handle: workspace,
  });
  expect(preparation.calls).toBe(2);
});
