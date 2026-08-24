// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('adopts a legacy managed Workspace without exposing its host path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-managed-workspace-'));
  roots.push(root);
  vi.stubEnv('HUABU_WORKSPACE', root);
  vi.resetModules();

  const workspace = await import('./workspace.js');
  workspace.initWorkspaceFromEnv();

  expect(workspace.isManagedMode()).toBe(true);
  expect(workspace.getWorkspaceHandle()).toMatchObject({
    name: path.basename(root),
  });
  expect(workspace.getWorkspacePath()).toBe(path.resolve(root));
  expect(existsSync(path.join(root, '.workspace.json'))).toBe(true);
});
