// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  abortPreparedDiskTransaction,
  applyPreparedDiskTransaction,
  captureAppendLogPrefix,
  DiskTransactionIntegrityError,
  finalizeCommittedDiskTransaction,
  markPreparedDiskTransactionCommitted,
  prepareDiskTransaction,
  prepareDiskUndoJournal,
  recoverDiskTransactions,
  validatePreparedDiskTransactionUnapplied,
  withDiskTransactionWorkspaceLock,
} from './transaction-journal.js';
import {
  workspaceHuabuDir,
  workspaceTombstonesDir,
  workspaceTransactionsDir,
} from '../../../workspace/disk/paths.js';
import { prepareWorkspaceOnDisk } from '../../../workspace-prepare.js';

let workspace = '';

function spaceRoot(name = 'Original Space'): string {
  return path.join(workspace, name);
}

function target(relativePath: string, root = spaceRoot()): string {
  return path.join(root, ...relativePath.split('/'));
}

function write(
  relativePath: string,
  bytes: string | Buffer,
  root = spaceRoot(),
): void {
  const filePath = target(relativePath, root);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
}

function read(relativePath: string, root = spaceRoot()): Buffer {
  return readFileSync(target(relativePath, root));
}

function appendDeclaration(relativePath: string, bytes: Buffer) {
  return {
    relativePath,
    ...captureAppendLogPrefix(workspace, 'Original Space', relativePath),
    bytes,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'huabu-disk-transaction-'));
  mkdirSync(spaceRoot());
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('Disk transaction journal', () => {
  it('reaps a durable cleanup residue before admitting the next Workspace transaction', async () => {
    const before = Buffer.from('before');
    const firstAfter = Buffer.from('first-after');
    const secondAfter = Buffer.from('second-after');
    write('space.json', before);
    const first = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'committed-residue',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'space.json',
          before,
          after: firstAfter,
        },
      ],
    });
    applyPreparedDiskTransaction(first);
    markPreparedDiskTransactionCommitted(first);

    await withDiskTransactionWorkspaceLock(workspace, () => {
      expect(existsSync(first.directoryPath)).toBe(false);
      const second = prepareDiskTransaction({
        workspacePath: workspace,
        transactionId: 'after-cleanup-residue',
        directory: { kind: 'none', rootRelativePath: 'Original Space' },
        files: [
          {
            relativePath: 'space.json',
            before: firstAfter,
            after: secondAfter,
          },
        ],
      });
      applyPreparedDiskTransaction(second);
      markPreparedDiskTransactionCommitted(second);
      finalizeCommittedDiskTransaction(second);
    });

    expect(read('space.json')).toEqual(secondAfter);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('rolls an uncommitted mixed file, append, and rename transaction back', () => {
    const recordBefore = Buffer.from('{"version":0}\n');
    const recordAfter = Buffer.from('{"version":1}\n');
    const nodeBefore = Buffer.from('old node\n');
    const nodeAfter = Buffer.from('new node\n');
    const deltaBefore = Buffer.from('{"version":0}\n');
    const deltaBytes = Buffer.from('{"version":1}\n');
    write('space.json', recordBefore);
    write('nodes/note.md', nodeBefore);
    write('.history/delta-log.jsonl', deltaBefore);

    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'undo-after-crash',
      directory: {
        kind: 'rename',
        beforeRootRelativePath: 'Original Space',
        afterRootRelativePath: 'Renamed Space',
      },
      files: [
        {
          relativePath: 'nodes/note.md',
          before: nodeBefore,
          after: nodeAfter,
        },
        {
          relativePath: 'space.json',
          before: recordBefore,
          after: recordAfter,
        },
      ],
      append: appendDeclaration('.history/delta-log.jsonl', deltaBytes),
    });

    applyPreparedDiskTransaction(transaction);
    expect(existsSync(spaceRoot())).toBe(false);
    expect(read('space.json', spaceRoot('Renamed Space'))).toEqual(recordAfter);

    recoverDiskTransactions(workspace);

    expect(existsSync(spaceRoot('Renamed Space'))).toBe(false);
    expect(read('space.json')).toEqual(recordBefore);
    expect(read('nodes/note.md')).toEqual(nodeBefore);
    expect(read('.history/delta-log.jsonl')).toEqual(deltaBefore);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('redoes only declared before/after states after COMMITTED, including a partial append', () => {
    const recordBefore = Buffer.from('before-record');
    const recordAfter = Buffer.from('after-record');
    const nodeBefore = Buffer.from('before-node');
    const nodeAfter = Buffer.from('after-node');
    const prefix = Buffer.from('existing\n');
    const appended = Buffer.from('declared append\n');
    write('space.json', recordBefore);
    write('nodes/note.md', nodeBefore);
    write('.history/delta-log.jsonl', prefix);
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'redo-after-crash',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'nodes/note.md',
          before: nodeBefore,
          after: nodeAfter,
        },
        {
          relativePath: 'space.json',
          before: recordBefore,
          after: recordAfter,
        },
      ],
      append: appendDeclaration('.history/delta-log.jsonl', appended),
    });
    applyPreparedDiskTransaction(transaction);
    markPreparedDiskTransactionCommitted(transaction);

    // Simulate individually durable writes after a process crash: every state
    // is still one the immutable manifest can identify.
    write('nodes/note.md', nodeBefore);
    truncateSync(target('.history/delta-log.jsonl'), prefix.length + 4);

    recoverDiskTransactions(workspace);

    expect(read('nodes/note.md')).toEqual(nodeAfter);
    expect(read('space.json')).toEqual(recordAfter);
    expect(read('.history/delta-log.jsonl')).toEqual(
      Buffer.concat([prefix, appended]),
    );
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('refuses unexpected bytes before mutating any declared target', () => {
    const firstBefore = Buffer.from('first-before');
    const firstAfter = Buffer.from('first-after');
    const secondBefore = Buffer.from('second-before');
    const secondAfter = Buffer.from('second-after');
    write('nodes/first.md', firstBefore);
    write('nodes/second.md', secondBefore);
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'unexpected-live-bytes',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'nodes/first.md',
          before: firstBefore,
          after: firstAfter,
        },
        {
          relativePath: 'nodes/second.md',
          before: secondBefore,
          after: secondAfter,
        },
      ],
    });
    applyPreparedDiskTransaction(transaction);
    write('nodes/second.md', 'external bytes');

    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('nodes/first.md')).toEqual(firstAfter);
    expect(read('nodes/second.md').toString()).toBe('external bytes');
    expect(existsSync(transaction.directoryPath)).toBe(true);
  });

  it('does not overwrite an external same-filename edit made after prepare', () => {
    const before = Buffer.from('before');
    const after = Buffer.from('transaction after');
    const external = Buffer.from('external same-filename edit');
    write('nodes/note.md', before);
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'external-edit-after-prepare',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'nodes/note.md',
          before,
          after,
        },
      ],
    });
    validatePreparedDiskTransactionUnapplied(transaction);
    write('nodes/note.md', external);

    expect(() => validatePreparedDiskTransactionUnapplied(transaction)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('nodes/note.md')).toEqual(external);
    expect(existsSync(transaction.directoryPath)).toBe(true);
  });

  it('does not delete an external creation at an absent target after prepare', () => {
    const external = Buffer.from('external creation');
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'external-create-after-prepare',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'nodes/new.md',
          before: null,
          after: Buffer.from('transaction creation'),
        },
      ],
    });
    validatePreparedDiskTransactionUnapplied(transaction);
    write('nodes/new.md', external);

    expect(() => validatePreparedDiskTransactionUnapplied(transaction)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('nodes/new.md')).toEqual(external);
    expect(existsSync(transaction.directoryPath)).toBe(true);
  });

  it('refuses an append tail that is not a prefix of the declared bytes', () => {
    const prefix = Buffer.from('existing\n');
    write('.history/delta-log.jsonl', prefix);
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'unexpected-append',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      append: appendDeclaration(
        '.history/delta-log.jsonl',
        Buffer.from('declared\n'),
      ),
    });
    appendFileSync(target('.history/delta-log.jsonl'), 'different\n');

    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('.history/delta-log.jsonl')).toEqual(
      Buffer.concat([prefix, Buffer.from('different\n')]),
    );
    expect(existsSync(transaction.directoryPath)).toBe(true);
  });

  it('supports an undo-only journal around opaque legacy writes', () => {
    const before = Buffer.from('known before');
    const deltaBefore = Buffer.from('old delta\n');
    write('nodes/existing.md', before);
    write('.history/delta-log.jsonl', deltaBefore);
    prepareDiskUndoJournal({
      workspacePath: workspace,
      transactionId: 'legacy-undo',
      directory: {
        kind: 'rename',
        beforeRootRelativePath: 'Original Space',
        afterRootRelativePath: 'Legacy Rename',
      },
      fileRelativePaths: ['nodes/existing.md', 'nodes/created.md'],
      appendRelativePath: '.history/delta-log.jsonl',
    });

    write('nodes/existing.md', 'arbitrary legacy result');
    write('nodes/created.md', 'legacy-created file');
    appendFileSync(target('.history/delta-log.jsonl'), 'arbitrary delta\n');
    renameSync(spaceRoot(), spaceRoot('Legacy Rename'));

    recoverDiskTransactions(workspace);

    expect(existsSync(spaceRoot('Legacy Rename'))).toBe(false);
    expect(read('nodes/existing.md')).toEqual(before);
    expect(existsSync(target('nodes/created.md'))).toBe(false);
    expect(read('.history/delta-log.jsonl')).toEqual(deltaBefore);
  });

  it('aborts a blocked legacy title rename without touching the conflicting Space', () => {
    write('space.json', 'original');
    const conflictingRoot = spaceRoot('Conflicting Space');
    mkdirSync(conflictingRoot);
    write('space.json', 'conflict', conflictingRoot);
    const transaction = prepareDiskUndoJournal({
      workspacePath: workspace,
      transactionId: 'blocked-title-rename',
      directory: {
        kind: 'rename',
        beforeRootRelativePath: 'Original Space',
        afterRootRelativePath: 'Conflicting Space',
      },
      fileRelativePaths: ['space.json'],
    });

    abortPreparedDiskTransaction(transaction);

    expect(read('space.json').toString()).toBe('original');
    expect(read('space.json', conflictingRoot).toString()).toBe('conflict');
  });

  it('preserves opaque legacy after-state once its undo journal is committed', () => {
    write('space.json', 'before');
    const transaction = prepareDiskUndoJournal({
      workspacePath: workspace,
      transactionId: 'legacy-committed',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      fileRelativePaths: ['space.json'],
    });
    write('space.json', 'opaque after bytes');
    markPreparedDiskTransactionCommitted(transaction);

    recoverDiskTransactions(workspace);

    expect(read('space.json').toString()).toBe('opaque after bytes');
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('handles create and quarantine lifecycle recovery', () => {
    const createdRoot = 'Created Space';
    const create = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'create-space',
      directory: { kind: 'create', rootRelativePath: createdRoot },
      files: [
        {
          relativePath: 'space.json',
          before: null,
          after: Buffer.from('created record'),
        },
      ],
    });
    applyPreparedDiskTransaction(create);
    recoverDiskTransactions(workspace);
    expect(existsSync(spaceRoot(createdRoot))).toBe(false);

    const quarantine = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'delete-space',
      directory: { kind: 'quarantine', rootRelativePath: 'Original Space' },
    });
    applyPreparedDiskTransaction(quarantine);
    expect(existsSync(spaceRoot())).toBe(false);
    recoverDiskTransactions(workspace);
    expect(existsSync(spaceRoot())).toBe(true);

    const committedDelete = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'delete-space-committed',
      directory: { kind: 'quarantine', rootRelativePath: 'Original Space' },
    });
    applyPreparedDiskTransaction(committedDelete);
    markPreparedDiskTransactionCommitted(committedDelete);
    recoverDiskTransactions(workspace);
    expect(existsSync(spaceRoot())).toBe(false);
  });

  it('removes an opaque legacy-created root when preparation was not committed', () => {
    const transaction = prepareDiskUndoJournal({
      workspacePath: workspace,
      transactionId: 'opaque-create',
      directory: { kind: 'create', rootRelativePath: 'Opaque Created Space' },
    });
    const createdRoot = spaceRoot('Opaque Created Space');
    mkdirSync(path.join(createdRoot, 'arbitrary', 'nested'), {
      recursive: true,
    });
    writeFileSync(
      path.join(createdRoot, 'arbitrary', 'nested', 'file'),
      'legacy',
    );

    abortPreparedDiskTransaction(transaction);

    expect(existsSync(createdRoot)).toBe(false);
  });

  it('rejects traversal and a second outstanding transaction', () => {
    expect(() =>
      prepareDiskTransaction({
        workspacePath: workspace,
        directory: { kind: 'none', rootRelativePath: 'Original Space' },
        files: [
          { relativePath: '../outside', before: null, after: Buffer.from('x') },
        ],
      }),
    ).toThrow(TypeError);

    write('space.json', 'before');
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'first',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'space.json',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
      ],
    });
    expect(() =>
      prepareDiskTransaction({
        workspacePath: workspace,
        transactionId: 'second',
        directory: { kind: 'none', rootRelativePath: 'Original Space' },
      }),
    ).toThrow(/outstanding Disk transaction/);
    abortPreparedDiskTransaction(transaction);
  });

  it('requires a fully applied redo transaction before publishing COMMITTED', () => {
    write('space.json', 'before');
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'commit-order',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'space.json',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
      ],
    });
    expect(() => markPreparedDiskTransactionCommitted(transaction)).toThrow(
      /not complete/,
    );
    applyPreparedDiskTransaction(transaction);
    markPreparedDiskTransactionCommitted(transaction);
    finalizeCommittedDiskTransaction(transaction);
    expect(read('space.json').toString()).toBe('after');
  });

  it('blocks recovery on a corrupt manifest or marker binding', () => {
    write('space.json', 'before');
    const corruptManifest = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'corrupt-manifest',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'space.json',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
      ],
    });
    writeFileSync(
      path.join(corruptManifest.directoryPath, 'manifest.json'),
      '{',
    );
    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('space.json').toString()).toBe('before');
    rmSync(corruptManifest.directoryPath, { recursive: true });

    const corruptMarker = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'corrupt-marker',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'space.json',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
      ],
    });
    applyPreparedDiskTransaction(corruptMarker);
    markPreparedDiskTransactionCommitted(corruptMarker);
    writeFileSync(
      path.join(corruptMarker.directoryPath, 'COMMITTED'),
      JSON.stringify({
        version: 1,
        transactionId: 'corrupt-marker',
        manifestSha256: '0'.repeat(64),
      }),
    );

    expect(() => recoverDiskTransactions(workspace)).toThrow(
      DiskTransactionIntegrityError,
    );
    expect(read('space.json').toString()).toBe('after');
  });

  it('rejects unrelated missing-parent declarations on append entries', () => {
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'tampered-append-parent',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      append: appendDeclaration(
        '.history/delta-log.jsonl',
        Buffer.from('appended\n'),
      ),
    });
    const manifestPath = path.join(transaction.directoryPath, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      append: { missingParentsBefore: string[] };
    };
    manifest.append.missingParentsBefore = ['unrelated'];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => recoverDiskTransactions(workspace)).toThrow(
      /append has an unrelated missing parent/,
    );
    expect(existsSync(target('.history/delta-log.jsonl'))).toBe(false);
  });

  it('runs recovery before workspace migrations and World creation', () => {
    const canvas = {
      canvasId: 'canvas_recovery',
      title: 'Recovery',
      version: 0,
      state: { nodes: [], edges: [] },
      createdAt: 1,
      updatedAt: 1,
    };
    write('space.json', `${JSON.stringify(canvas)}\n`);
    write('nodes/note.md', 'before migration');
    const transaction = prepareDiskTransaction({
      workspacePath: workspace,
      transactionId: 'workspace-activation',
      directory: { kind: 'none', rootRelativePath: 'Original Space' },
      files: [
        {
          relativePath: 'nodes/note.md',
          before: Buffer.from('before migration'),
          after: Buffer.from('partial mutation'),
        },
      ],
    });
    applyPreparedDiskTransaction(transaction);

    prepareWorkspaceOnDisk(workspace);

    expect(read('nodes/note.md').toString()).toBe('before migration');
    expect(existsSync(path.join(workspace, '.world', 'space.json'))).toBe(true);
  });

  it('exposes Workspace-owned transaction and tombstone paths', () => {
    expect(workspaceHuabuDir(workspace)).toBe(path.join(workspace, '.huabu'));
    expect(workspaceTransactionsDir(workspace)).toBe(
      path.join(workspace, '.huabu', 'transactions'),
    );
    expect(workspaceTombstonesDir(workspace)).toBe(
      path.join(workspace, '.huabu', 'tombstones'),
    );
  });
});
