import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observedFs = vi.hoisted(() => ({
  readdirPaths: [] as string[],
  readFilePaths: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualReaddir = actual['readdirSync'];
  const actualReadFile = actual['readFileSync'];
  if (
    typeof actualReaddir !== 'function' ||
    typeof actualReadFile !== 'function'
  ) {
    throw new Error('node:fs synchronous reads are unavailable');
  }
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      observedFs.readdirPaths.push(String(args[0]));
      return Reflect.apply(actualReaddir, actual, args);
    },
    readFileSync: (...args: unknown[]) => {
      observedFs.readFilePaths.push(String(args[0]));
      return Reflect.apply(actualReadFile, actual, args);
    },
  };
});

import {
  CanvasPersistenceRollbackError,
  runCanvasPersistenceTransaction,
} from './canvas-persistence-transaction.js';
import { getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasFile } from './persistence-types.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(
    path.join(tmpdir(), 'sediment-persistence-transaction-'),
  );
  setWorkspacePath(workspacePath);
  resetStorageCache();
  observedFs.readdirPaths.length = 0;
  observedFs.readFilePaths.length = 0;
});

afterEach(() => {
  resetStorageCache();
  rmSync(workspacePath, { recursive: true, force: true });
});

function canvasWithNodes(nodes: unknown[]): CanvasFile {
  return {
    canvasId: 'c1',
    title: null,
    version: 1,
    state: { nodes, edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('runCanvasPersistenceTransaction', () => {
  it('skips node enumeration and body reads for a zero-affected commit', () => {
    const store = getCanvasStore('c1');
    const before = canvasWithNodes([]);
    store.write(before);
    const nodesPath = path.join(workspacePath, 'c1', 'nodes');
    mkdirSync(nodesPath, { recursive: true });
    writeFileSync(
      path.join(nodesPath, 'Existing.md'),
      '---\nid: existing\ntype: note\nlabel: Existing\n---\nbefore\n',
      'utf8',
    );

    observedFs.readdirPaths.length = 0;
    observedFs.readFilePaths.length = 0;
    const originalError = new Error('order-only commit failed');
    let caught: unknown;
    try {
      runCanvasPersistenceTransaction({
        canvasId: 'c1',
        affectedNodeIds: new Set(),
        nodeIdForFilename: (filename) => store.nodeIdForFilename(filename),
        resetRecordState: () => store.write(before),
        commit: () => {
          // An unrelated editor can still land a sidecar while the structural
          // commit is in flight. With no affected ids, rollback must not scan
          // or classify either file.
          writeFileSync(
            path.join(nodesPath, 'External.md'),
            '---\nid: external\ntype: note\nlabel: External\n---\noutside\n',
            'utf8',
          );
          throw originalError;
        },
      });
    } catch (error) {
      caught = error;
    }

    const nodeDirectoryReads = observedFs.readdirPaths.filter(
      (readPath) => path.resolve(readPath) === path.resolve(nodesPath),
    );
    const nodeBodyReads = observedFs.readFilePaths.filter((readPath) =>
      path
        .resolve(readPath)
        .startsWith(`${path.resolve(nodesPath)}${path.sep}`),
    );
    expect(caught).toBe(originalError);
    expect(nodeDirectoryReads).toEqual([]);
    expect(nodeBodyReads).toEqual([]);

    expect(readdirSync(nodesPath).sort()).toEqual([
      'Existing.md',
      'External.md',
    ]);
  });

  it('aggregates component rollback failures and still restores the record last', () => {
    const store = getCanvasStore('c1');
    const before = canvasWithNodes([
      {
        id: 'n1',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: 'A' },
      },
    ]);
    store.write(before);
    store.writeNode('n1', {
      nodeId: 'n1',
      type: 'note',
      label: 'A',
      content: 'before',
    });
    store.appendDeltaLogEntry({
      version: 1,
      ts: 1,
      commands: [],
      deltas: [],
      originator: { source: 'ui' },
    });

    const recordPath = path.join(workspacePath, 'c1', 'space.json');
    const nodesPath = path.join(workspacePath, 'c1', 'nodes');
    const logPath = path.join(
      workspacePath,
      'c1',
      '.history',
      'delta-log.jsonl',
    );
    const beforeRecordBytes = readFileSync(recordPath);
    const originalError = new Error('commit failed after corrupting targets');
    let caught: unknown;

    try {
      runCanvasPersistenceTransaction({
        canvasId: 'c1',
        affectedNodeIds: new Set(['n1']),
        nodeIdForFilename: (filename) => store.nodeIdForFilename(filename),
        // This direct helper regression isolates raw component restoration;
        // executor callers supply the separate cache/tombstone reset.
        resetRecordState: () => undefined,
        commit: () => {
          store.write({ ...before, version: 2, updatedAt: 2 });

          // Make node restoration impossible.
          rmSync(nodesPath, { recursive: true, force: true });
          writeFileSync(nodesPath, 'node-directory blocker', 'utf8');

          // Independently make delta truncation impossible. Its failure must
          // be collected even though node restoration already failed.
          rmSync(logPath, { force: true });
          mkdirSync(logPath);
          throw originalError;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CanvasPersistenceRollbackError);
    const rollbackError = caught as CanvasPersistenceRollbackError;
    expect(rollbackError.originalError).toBe(originalError);
    expect(rollbackError.rollbackErrors).toHaveLength(2);

    // The record restore is the final independent attempt and succeeds even
    // after both earlier components reported rollback failures.
    expect(readFileSync(recordPath)).toEqual(beforeRecordBytes);
    expect(readFileSync(nodesPath, 'utf8')).toBe('node-directory blocker');
    expect(existsSync(logPath)).toBe(true);
    expect(statSync(logPath).isDirectory()).toBe(true);
  });
});
