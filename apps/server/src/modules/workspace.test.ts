// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Adopting the workspace a process was started on.
 *
 * The two env forms exist to differ in one place — what a failure means — so
 * every case here is about that difference, or about the state a client is
 * left in when a remembered workspace cannot be opened (issue #126).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  clearWorkspacePath,
  getWorkspacePath,
  getWorkspaceStartupError,
  initWorkspaceFromEnv,
  isManagedMode,
  isWorkspaceConfigured,
} from './workspace.js';

describe('startup workspace adoption', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  /** A path *inside a file*, so creating the directory fails with ENOTDIR. */
  function unopenable(): string {
    const blocker = path.join(tempDir('huabu-workspace-blocked-'), 'not-a-dir');
    writeFileSync(blocker, 'occupied', 'utf8');
    return path.join(blocker, 'workspace');
  }

  function worker(source: string): string {
    const file = path.join(tempDir('huabu-workspace-worker-'), 'worker.mjs');
    writeFileSync(file, source, 'utf8');
    return file;
  }

  function successfulWorker(): string {
    return worker(`process.send({ ok: true });`);
  }

  function failingWorker(message: string): string {
    return worker(
      `process.send({ ok: false, message: ${JSON.stringify(message)} });`,
    );
  }

  beforeEach(() => {
    delete process.env.HUABU_WORKSPACE;
    delete process.env.HUABU_WORKSPACE_STARTUP;
    clearWorkspacePath();
  });

  afterAll(async () => {
    delete process.env.HUABU_WORKSPACE;
    delete process.env.HUABU_WORKSPACE_STARTUP;
    await initWorkspaceFromEnv({ workerPath: successfulWorker() });
    clearWorkspacePath();
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts unconfigured when neither variable is set', async () => {
    await initWorkspaceFromEnv({ workerPath: successfulWorker() });

    expect(isManagedMode()).toBe(false);
    expect(isWorkspaceConfigured()).toBe(false);
    expect(getWorkspaceStartupError()).toBeNull();
  });

  it('locks the operator-named workspace and prepares it', async () => {
    const root = tempDir('huabu-workspace-managed-');
    process.env.HUABU_WORKSPACE = root;

    await initWorkspaceFromEnv({ workerPath: successfulWorker() });

    expect(isManagedMode()).toBe(true);
    expect(getWorkspacePath()).toBe(path.resolve(root));
  });

  it('adopts a shell-chosen workspace without locking it', async () => {
    const root = tempDir('huabu-workspace-startup-');
    process.env.HUABU_WORKSPACE_STARTUP = root;

    await initWorkspaceFromEnv({ workerPath: successfulWorker() });

    // Free mode: the path is the user's own choice, so the picker stays
    // available and the path stays visible.
    expect(isManagedMode()).toBe(false);
    expect(getWorkspacePath()).toBe(path.resolve(root));
    expect(getWorkspaceStartupError()).toBeNull();
  });

  it('prefers the operator variable when both are set', async () => {
    const managed = tempDir('huabu-workspace-both-managed-');
    const shell = tempDir('huabu-workspace-both-shell-');
    process.env.HUABU_WORKSPACE = managed;
    process.env.HUABU_WORKSPACE_STARTUP = shell;

    await initWorkspaceFromEnv({ workerPath: successfulWorker() });

    expect(isManagedMode()).toBe(true);
    expect(getWorkspacePath()).toBe(path.resolve(managed));
  });

  it('fails startup when the operator names a workspace it cannot open', async () => {
    const blocked = unopenable();
    process.env.HUABU_WORKSPACE = blocked;

    // A deployment misconfiguration. Coming up unconfigured instead would
    // offer a remote user a folder picker for the host filesystem.
    await expect(
      initWorkspaceFromEnv({
        workerPath: failingWorker('workspace cannot be prepared'),
      }),
    ).rejects.toThrow('workspace cannot be prepared');
    expect(existsSync(blocked)).toBe(false);
  });

  it('recovers to the picker when a shell-chosen workspace cannot be opened', async () => {
    process.env.HUABU_WORKSPACE_STARTUP = unopenable();

    await initWorkspaceFromEnv({
      workerPath: failingWorker('workspace cannot be prepared'),
    });

    // The user's folder moved, was renamed, or lives on a drive that is not
    // mounted today. The recovery for that is picking another one, so the
    // process serves nothing and says why rather than dying.
    expect(isWorkspaceConfigured()).toBe(false);
    expect(getWorkspaceStartupError()).toBeTruthy();
  });

  it('bounds a blocked shell-chosen workspace and recovers to the picker', async () => {
    process.env.HUABU_WORKSPACE_STARTUP = tempDir(
      'huabu-workspace-blocked-startup-',
    );

    await initWorkspaceFromEnv({
      workerPath: worker(`setInterval(() => {}, 1_000);`),
      timeoutMs: 30,
    });

    expect(isWorkspaceConfigured()).toBe(false);
    expect(getWorkspaceStartupError()).toMatch(/timed out/i);
  });

  it('rejects a relative path in either variable', async () => {
    process.env.HUABU_WORKSPACE_STARTUP = 'relative/path';
    await expect(initWorkspaceFromEnv()).rejects.toThrow(/absolute/);

    delete process.env.HUABU_WORKSPACE_STARTUP;
    process.env.HUABU_WORKSPACE = 'relative/path';
    await expect(initWorkspaceFromEnv()).rejects.toThrow(/absolute/);
  });
});
