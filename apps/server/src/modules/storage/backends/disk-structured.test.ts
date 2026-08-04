import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { DiskStructuredStore } from './disk-structured.js';
import { resetStorageCache } from '../canvas-store-cache.js';
import { describeStructuredStoreContract } from '../ports/structured-store.contract.js';

describeStructuredStoreContract('DiskStructuredStore', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-structured-'));
  workspaceState.path = root;
  resetStorageCache();
  return {
    store: new DiskStructuredStore(),
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});
