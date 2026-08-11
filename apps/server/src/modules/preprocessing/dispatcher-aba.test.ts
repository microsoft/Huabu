// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const extractMock = vi.hoisted(() => vi.fn());

vi.mock('./stages/extract.js', () => ({ extract: extractMock }));

import { PreprocessDispatcher } from './dispatcher.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

describe('PreprocessDispatcher — same-type asynchronous baseline', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'huabu-preprocess-aba-'));
    setWorkspacePath(workspace);
    extractMock.mockReset();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('does not persist stale derived output over a newer same-type node', async () => {
    const store = getCanvasStore('canvas-aba');
    store.write({
      canvasId: 'canvas-aba',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'office-1',
            type: 'office',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('office-1', {
      nodeId: 'office-1',
      type: 'office',
      label: 'Old document',
      src: 'old.docx',
      content: 'old body',
    });

    let finishExtraction:
      | ((value: { title: string; content: string }) => void)
      | undefined;
    extractMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishExtraction = resolve;
      }),
    );

    const pending = new PreprocessDispatcher().preprocess({
      canvasId: 'canvas-aba',
      nodeId: 'office-1',
      nodeType: 'office',
      trigger: 'node_updated',
      snapshot: { src: 'new.docx' },
      options: { allowLLM: false },
    });
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledOnce());

    const before = store.read();
    if (!before) throw new Error('seed Space disappeared');
    store.write({ ...before, version: 2, updatedAt: Date.now() });
    store.writeNode('office-1', {
      nodeId: 'office-1',
      type: 'office',
      label: 'Recreated document',
      src: 'replacement.docx',
      content: 'replacement body',
    });

    finishExtraction?.({ title: 'Stale document', content: 'stale body' });
    const result = await pending;

    expect(result).toMatchObject({
      success: true,
      status: 'skipped',
      superseded: true,
      patch: {},
    });
    expect(result.commit).toBeUndefined();
    expect(store.read()).toMatchObject({ version: 2 });
    expect(store.readNode('office-1')).toMatchObject({
      type: 'office',
      label: 'Recreated document',
      src: 'replacement.docx',
      content: 'replacement body',
    });
    expect(store.readDeltaLogSince(1)).toEqual([]);
  });
});
