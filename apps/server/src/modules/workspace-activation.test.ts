// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  activateWorkspacePath,
  prepareWorkspacePath,
  runWorkspacePreparation,
  WorkspaceActivationInProgressError,
  WorkspaceActivationTimeoutError,
} from './workspace-activation.js';
import { getWorkspacePath, setWorkspacePath } from './workspace.js';

describe('workspace activation isolation', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  function worker(source: string): string {
    const dir = tempDir('huabu-workspace-worker-');
    const file = path.join(dir, 'worker.mjs');
    writeFileSync(file, source, 'utf8');
    return file;
  }

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves when the preparation child reports success', async () => {
    const workerPath = worker(`process.send({ ok: true });`);
    await expect(
      runWorkspacePreparation(tempDir('huabu-workspace-target-'), {
        workerPath,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('terminates and rejects an unresponsive preparation child', async () => {
    const workerPath = worker(`setInterval(() => {}, 1_000);`);
    await expect(
      runWorkspacePreparation(tempDir('huabu-workspace-target-'), {
        workerPath,
        timeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(WorkspaceActivationTimeoutError);
  });

  it('keeps the previous workspace active after preparation times out', async () => {
    const previous = tempDir('huabu-workspace-previous-');
    const next = tempDir('huabu-workspace-next-');
    const workerPath = worker(`setInterval(() => {}, 1_000);`);
    setWorkspacePath(previous);

    await expect(
      activateWorkspacePath(next, { workerPath, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(WorkspaceActivationTimeoutError);
    expect(getWorkspacePath()).toBe(path.resolve(previous));
  });

  it('prepares a Workspace without changing the active Workspace', async () => {
    const previous = tempDir('huabu-workspace-previous-');
    const next = tempDir('huabu-workspace-prepared-');
    const workerPath = worker(`process.send({ ok: true });`);
    setWorkspacePath(previous);

    await expect(
      prepareWorkspacePath(next, { workerPath, timeoutMs: 1_000 }),
    ).resolves.toBe(path.resolve(next));
    expect(getWorkspacePath()).toBe(path.resolve(previous));
  });

  it('adopts a legacy path after an isolated worker succeeds', async () => {
    const target = tempDir('huabu-workspace-adopted-');
    const workerPath = worker(`process.send({ ok: true });`);

    await activateWorkspacePath(target, { workerPath, timeoutMs: 1_000 });

    expect(existsSync(path.join(target, '.huabu', 'workspace.json'))).toBe(
      true,
    );
    expect(getWorkspacePath()).toBe(path.resolve(target));
  });

  it('rejects a concurrent activation while preparation is running', async () => {
    const workerPath = worker(`setInterval(() => {}, 1_000);`);
    const first = activateWorkspacePath(tempDir('huabu-workspace-first-'), {
      workerPath,
      timeoutMs: 50,
    });

    await expect(
      activateWorkspacePath(tempDir('huabu-workspace-second-'), {
        workerPath,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(WorkspaceActivationInProgressError);
    await expect(first).rejects.toBeInstanceOf(WorkspaceActivationTimeoutError);
  });
});
