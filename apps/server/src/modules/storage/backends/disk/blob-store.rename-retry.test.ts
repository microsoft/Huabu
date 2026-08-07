// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DiskBlobStore } from './blob-store.js';

import type * as NodeFsPromises from 'node:fs/promises';

const testState = vi.hoisted(() => ({
  renameAsync: vi.fn(),
  workspacePath: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, rename: testState.renameAsync };
});

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => testState.workspacePath,
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename failed with ${code}`), { code });
}

describe('DiskBlobStore retry cleanup', () => {
  it('removes its temporary sibling when rename retries are exhausted', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'huabu-blob-retry-'));
    testState.workspacePath = root;
    const error = errno('EBUSY');
    testState.renameAsync.mockReset();
    testState.renameAsync.mockRejectedValue(error);

    try {
      const scope = new DiskBlobStore().scope({
        kind: 'canvas',
        canvasId: 'canvas-under-test',
      });

      await expect(scope.put('blocked.bin', Buffer.from('bytes'))).rejects.toBe(
        error,
      );

      expect(testState.renameAsync).toHaveBeenCalledTimes(6);
      expect(
        readdirSync(path.join(root, 'canvas-under-test', '.artifacts')),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      testState.workspacePath = '';
    }
  });
});
