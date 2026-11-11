// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleInspectNodes } from './canvas-query.js';
import { handleRead } from './fs-read.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { prepareAgentCanvasCommands } from '../../../canvas/agent-command-preparation.js';
import { executeOnServer } from '../../../canvas/canvas-executor.js';
import { getCanvasStore } from '../../../storage/index.js';
import * as storage from '../../../storage/index.js';
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
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

describe('handleRead node projection', () => {
  it('refreshes metadata freshness after inspect, a remote edit, and a full read', async () => {
    const store = getCanvasStore(canvasId);
    store.write({
      canvasId,
      title: null,
      version: 1,
      state: {
        nodes: [{ id: 'pdf', type: 'pdf', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const record = {
      nodeId: 'pdf',
      type: 'pdf',
      label: 'Paper',
      content: 'Extracted',
      noteContent: 'Old notes',
      properties: { Venue: 'CHI' },
    };
    store.writeNode('pdf', record);
    const readSet = new Map<string, string>();
    await handleInspectNodes({ canvasId, ids: ['pdf'] }, readSet);
    const inspected = readSet.get('metadata:pdf');
    const originalSpace = storage.space;
    vi.spyOn(storage, 'space').mockImplementationOnce((id) => {
      // Simulate a remote edit between the file read and canonical record lookup.
      store.writeNode('pdf', { ...record, noteContent: 'New notes' });
      return originalSpace(id);
    });
    const read = parseResult(
      await handleRead(
        {
          canvasId,
          path: `nodes/${toSafeFilename('Paper', 'pdf')}.md`,
        },
        readSet,
      ),
    );
    expect(read.frontmatter?.noteContent).toBe('New notes');
    expect(read.rev).not.toBe(inspected);
    expect(readSet.get('metadata:pdf')).toBe(read.rev);
    const result = await executeOnServer({
      canvasId,
      originator: { source: 'agent' },
      commands: prepareAgentCanvasCommands(
        [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              { nodeId: 'pdf', patch: { properties: { Status: 'Read' } } },
            ],
          },
        ],
        { readSet },
      ),
    });
    expect(result.results[0].applied).toBe(true);
    expect(store.readNode('pdf')?.properties).toEqual({
      Venue: 'CHI',
      Status: 'Read',
    });
  });

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
