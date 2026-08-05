/**
 * Failure rollback for the executor's synchronous Disk commit section.
 *
 * The executor still writes through the legacy synchronous CanvasStore, so a
 * commit is three filesystem mutations rather than one storage transaction:
 * affected markdown sidecars, `space.json`, then the append-only delta log.
 * Keep a narrowly-scoped before-image of exactly those bytes so a late failure
 * (especially an append failure) does not leave a version bump or sidecar
 * mutation behind.
 *
 * This helper is intentionally Disk-era glue. It disappears when the Canvas
 * write path moves behind a backend transaction/commit port.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { repairJsonLinesTail } from '../../utils/fs.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import {
  canvasJsonPath,
  deltaLogPath,
  nodesDir,
} from '../workspace/disk/paths.js';

interface FileSnapshot {
  path: string;
  bytes: Buffer | null;
}

interface DeltaLogSnapshot {
  path: string;
  existed: boolean;
  size: number;
  parentExisted: boolean;
}

interface NodeFilesSnapshot {
  directory: string;
  directoryExisted: boolean;
  sidecarNames: Set<string>;
  /** Raw before-images only for node ids this commit may mutate. */
  affectedFiles: Map<string, Buffer>;
  affectedNodeIds: ReadonlySet<string>;
  nodeIdForFilename: (filename: string) => string | null;
}

interface CanvasPersistenceSnapshot {
  record: FileSnapshot;
  deltaLog: DeltaLogSnapshot;
  /** Null for structural/order-only commits that cannot touch sidecars. */
  nodes: NodeFilesSnapshot | null;
}

function isSidecarFile(name: string): boolean {
  // Atomic sidecar writes own and clean their unique
  // `.<target>.tmp-<pid>-<uuid>` sibling on every failure path.
  return name.endsWith('.md');
}

function nodeIdFromSidecar(name: string, bytes: Buffer): string | null {
  try {
    const { meta } = parseFrontmatter(bytes.toString('utf8'));
    const rawId = meta['id'];
    if (typeof rawId === 'string' && rawId) return rawId;
  } catch {
    // A partial `.tmp` may not parse. New filenames are still detected by
    // comparing against `sidecarNames`; existing malformed files are left
    // untouched because the executor could not have selected them by id.
  }
  return name.endsWith('.md') ? name.slice(0, -3) : null;
}

function snapshotFile(filePath: string): FileSnapshot {
  return {
    path: filePath,
    bytes: existsSync(filePath) ? readFileSync(filePath) : null,
  };
}

function snapshotDeltaLog(filePath: string): DeltaLogSnapshot {
  const parentExisted = existsSync(path.dirname(filePath));
  if (!existsSync(filePath)) {
    return { path: filePath, existed: false, size: 0, parentExisted };
  }
  const before = statSync(filePath);
  if (!before.isFile()) {
    throw new Error(`Delta log path is not a file: ${filePath}`);
  }
  // Normalize a crash tail before the transaction boundary. Rollback can then
  // remain O(1): truncate to the recovered boundary without copying the
  // ever-growing log on every successful commit.
  repairJsonLinesTail(filePath);
  return {
    path: filePath,
    existed: true,
    size: statSync(filePath).size,
    parentExisted,
  };
}

function snapshotNodeFiles(
  canvasId: string,
  affectedNodeIds: ReadonlySet<string>,
  nodeIdForFilename: (filename: string) => string | null,
): NodeFilesSnapshot {
  const directory = nodesDir(canvasId);
  const directoryExisted = existsSync(directory);
  const sidecarNames = new Set<string>();
  const affectedFiles = new Map<string, Buffer>();

  if (directoryExisted) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isSidecarFile(entry.name)) continue;
      sidecarNames.add(entry.name);
      let nodeId = nodeIdForFilename(entry.name);
      let bytes: Buffer | null = null;
      if (!nodeId) {
        // A same-count external rename does not trip CanvasStore's cheap
        // staleness probe. Parse only this warm-index miss so an affected file
        // still has a before-image; coherent-index commits read no extra body.
        bytes = readFileSync(path.join(directory, entry.name));
        nodeId = nodeIdFromSidecar(entry.name, bytes);
      }
      if (nodeId && affectedNodeIds.has(nodeId)) {
        affectedFiles.set(
          entry.name,
          bytes ?? readFileSync(path.join(directory, entry.name)),
        );
      }
    }
  }

  return {
    directory,
    directoryExisted,
    sidecarNames,
    affectedFiles,
    affectedNodeIds,
    nodeIdForFilename,
  };
}

function captureSnapshot(
  canvasId: string,
  affectedNodeIds: ReadonlySet<string>,
  nodeIdForFilename: (filename: string) => string | null,
): CanvasPersistenceSnapshot {
  return {
    record: snapshotFile(canvasJsonPath(canvasId)),
    deltaLog: snapshotDeltaLog(deltaLogPath(canvasId)),
    nodes:
      affectedNodeIds.size === 0
        ? null
        : snapshotNodeFiles(canvasId, affectedNodeIds, nodeIdForFilename),
  };
}

function atomicRestore(filePath: string, bytes: Buffer): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.rollback-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    // The expected targets are files. Remove an unexpected directory rather
    // than letting a partially-restored commit masquerade as success.
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      rmSync(filePath, { recursive: true, force: true });
    }
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.bytes === null) {
    rmSync(snapshot.path, { recursive: true, force: true });
    return;
  }
  atomicRestore(snapshot.path, snapshot.bytes);
}

function restoreDeltaLog(snapshot: DeltaLogSnapshot): void {
  if (!snapshot.existed) {
    rmSync(snapshot.path, { recursive: true, force: true });
    const parent = path.dirname(snapshot.path);
    if (
      !snapshot.parentExisted &&
      existsSync(parent) &&
      readdirSync(parent).length === 0
    ) {
      rmSync(parent, { recursive: true });
    }
    return;
  }
  // Delta rows are append-only, so the before-image is just the byte offset.
  // This rolls back both a complete append-then-throw and a partial final row
  // without copying an ever-growing log on every successful commit.
  truncateSync(snapshot.path, snapshot.size);
}

function restoreNodeFiles(snapshot: NodeFilesSnapshot): void {
  const { directory } = snapshot;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isSidecarFile(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      let nodeId = snapshot.nodeIdForFilename(entry.name);
      // A file absent at preflight and not reflected in CanvasStore's index
      // may be a failed write side effect or an unrelated external edit. Read
      // only that new file and delete it only when its persisted id is ours.
      if (!nodeId && !snapshot.sidecarNames.has(entry.name)) {
        nodeId = nodeIdFromSidecar(entry.name, readFileSync(fullPath));
      }
      if (nodeId && snapshot.affectedNodeIds.has(nodeId)) {
        rmSync(fullPath, { force: true });
      }
    }
  }

  for (const [name, bytes] of snapshot.affectedFiles) {
    atomicRestore(path.join(directory, name), bytes);
  }

  if (!snapshot.directoryExisted && existsSync(directory)) {
    // Remove the transaction-created directory only when it is empty. An
    // unrelated external file that appeared concurrently must not be erased.
    if (readdirSync(directory).length === 0)
      rmSync(directory, { recursive: true });
  }
}

function restoreSnapshot(snapshot: CanvasPersistenceSnapshot): unknown[] {
  const errors: unknown[] = [];
  const attempt = (restore: () => void): void => {
    try {
      restore();
    } catch (error) {
      errors.push(error);
    }
  };

  // Each component gets an independent attempt: a blocked sidecar restore
  // must not strand an appended log row, and neither failure may prevent the
  // raw record before-image from being restored last.
  const nodes = snapshot.nodes;
  if (nodes) attempt(() => restoreNodeFiles(nodes));
  attempt(() => restoreDeltaLog(snapshot.deltaLog));
  attempt(() => restoreFile(snapshot.record));
  return errors;
}

/** Raised only when the original failure was compounded by rollback failure. */
export class CanvasPersistenceRollbackError extends Error {
  override name = 'CanvasPersistenceRollbackError';
  readonly originalError: unknown;
  readonly rollbackErrors: readonly unknown[];

  constructor(originalError: unknown, rollbackErrors: readonly unknown[]) {
    super(
      `Canvas persistence failed and rollback was incomplete (${rollbackErrors.length} rollback error${rollbackErrors.length === 1 ? '' : 's'})`,
    );
    this.originalError = originalError;
    this.rollbackErrors = rollbackErrors;
  }
}

/**
 * Run the executor's synchronous persistence section with failure rollback.
 *
 * `resetRecordState` writes the parsed prestate through CanvasStore before the
 * raw before-image is restored. Besides resetting topology, that clears any
 * in-memory node tombstones created by an attempted deletion. It must not
 * append logs or perform unrelated work.
 */
export function runCanvasPersistenceTransaction<T>(input: {
  canvasId: string;
  affectedNodeIds: ReadonlySet<string>;
  nodeIdForFilename: (filename: string) => string | null;
  resetRecordState: () => void;
  commit: () => T;
}): T {
  const snapshot = captureSnapshot(
    input.canvasId,
    input.affectedNodeIds,
    input.nodeIdForFilename,
  );
  try {
    return input.commit();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      input.resetRecordState();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    rollbackErrors.push(...restoreSnapshot(snapshot));
    if (rollbackErrors.length > 0) {
      throw new CanvasPersistenceRollbackError(error, rollbackErrors);
    }
    throw error;
  }
}
