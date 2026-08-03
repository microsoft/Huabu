import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { DiskBlobStore } from './disk-blob.js';
import { describeBlobStoreContract } from '../ports/blob-store.contract.js';

describeBlobStoreContract('DiskBlobStore', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-blob-'));
  workspaceState.path = root;
  return {
    store: new DiskBlobStore(),
    ref: { kind: 'canvas', canvasId: 'canvas-under-test' },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});
