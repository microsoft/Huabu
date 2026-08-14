// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleRead } from './fs-read.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { getCanvasStore } from '../../../storage/index.js';
import { setWorkspacePath } from '../../../workspace.js';

interface ReadResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
  frontmatter?: Record<string, unknown>;
  rev?: string;
  content: string;
}

let workspace: string;
const canvasId = 'canvas-read-test';

function parseResult(
  result: Awaited<ReturnType<typeof handleRead>>,
): ReadResult {
  if (typeof result !== 'string') throw new Error('Expected a text response');
  return JSON.parse(result) as ReadResult;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'huabu-fs-read-'));
  setWorkspacePath(workspace);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('handleRead node projection', () => {
  it('returns node frontmatter once and paginates over the body', async () => {
    const store = getCanvasStore(canvasId);
    store.write({
      canvasId,
      title: null,
      version: 1,
      state: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('node-1', {
      nodeId: 'node-1',
      type: 'note',
      label: 'Example',
      summary: 'Short summary',
      content: 'first line\nsecond line\nthird line',
    });
    const readSet = new Map<string, string>();

    const result = parseResult(
      await handleRead(
        {
          canvasId,
          path: `nodes/${toSafeFilename('Example', 'node-1')}.md`,
          offset: 2,
          limit: 1,
        },
        readSet,
      ),
    );

    expect(result).toMatchObject({
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
      content: 'second line',
      frontmatter: {
        id: 'node-1',
        type: 'note',
        label: 'Example',
        summary: 'Short summary',
      },
      rev: expect.any(String),
    });
    expect(result.content).not.toContain('---');
    expect(readSet.get('node-1')).toBe(result.rev);
  });

  it('preserves raw frontmatter for a non-node text file', async () => {
    const canvasDir = join(workspace, canvasId);
    mkdirSync(canvasDir, { recursive: true });
    writeFileSync(
      join(canvasDir, 'reference.md'),
      '---\ntitle: Reference\n---\nbody',
      'utf8',
    );

    const result = parseResult(
      await handleRead({ canvasId, path: 'reference.md' }),
    );

    expect(result.frontmatter).toEqual({ title: 'Reference' });
    expect(result).not.toHaveProperty('rev');
    expect(result.content).toBe('---\ntitle: Reference\n---\nbody');
  });
});
