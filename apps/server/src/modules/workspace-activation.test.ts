// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  activateWorkspacePath,
  runWorkspacePreparation,
  WorkspaceActivationInProgressError,
  WorkspaceActivationTimeoutError,
  WorkspaceRestartRequiredError,
} from './workspace-activation.js';
import {
  clearWorkspacePath,
  getWorkspacePath,
  isWorkspaceConfigured,
  setWorkspacePath,
} from './workspace.js';

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

  beforeEach(() => {
    // Every case decides for itself whether a workspace is already active,
    // because that is the branch under test.
    clearWorkspacePath();
  });

  afterAll(() => {
    clearWorkspacePath();
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

  it('leaves the process unconfigured when preparation times out', async () => {
    const next = tempDir('huabu-workspace-next-');
    const workerPath = worker(`setInterval(() => {}, 1_000);`);

    await expect(
      activateWorkspacePath(next, { workerPath, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(WorkspaceActivationTimeoutError);
    // Nothing half-activated: the client sees the same state it started from
    // and can pick again.
    expect(isWorkspaceConfigured()).toBe(false);
  });

  /**
   * The restart rule (issue #126). A process serves one workspace, so the
   * second choice is the client's to persist and the next process's to open —
   * and refusing it has to leave this process exactly as it was, including not
   * running preparation against the folder it was asked for.
   */
  it('refuses a different workspace once one is active, and touches nothing', async () => {
    const active = tempDir('huabu-workspace-active-');
    const other = tempDir('huabu-workspace-other-');
    setWorkspacePath(active);
    // A worker that would fail loudly if it ever ran.
    const workerPath = worker(`process.send({ ok: false, message: 'ran' });`);

    const refusal = activateWorkspacePath(other, { workerPath });
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceRestartRequiredError);
    await expect(refusal).rejects.toMatchObject({
      requestedPath: path.resolve(other),
    });
    expect(getWorkspacePath()).toBe(path.resolve(active));
  });

  it('accepts the active workspace again without reactivating it', async () => {
    const active = tempDir('huabu-workspace-idempotent-');
    setWorkspacePath(active);
    const workerPath = worker(`process.send({ ok: false, message: 'ran' });`);

    // The client re-sends its remembered path on every boot, and a second tab
    // must not be told to restart.
    await expect(
      activateWorkspacePath(active, { workerPath }),
    ).resolves.toBeUndefined();
    expect(getWorkspacePath()).toBe(path.resolve(active));
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
