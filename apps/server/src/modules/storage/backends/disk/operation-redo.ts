// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { resolveDirectChildPath, safeJoin } from '../../../../utils/fs.js';
import { SpaceOperationError } from '../../ports/operations.js';

const projectionSchema = z
  .object({
    path: z.string().min(1),
    before: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    after: z.string().nullable(),
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal(1),
    projections: z.array(projectionSchema).min(1),
  })
  .strict();
export type DiskOperationProjection = z.infer<typeof projectionSchema>;

export function diskBytesDigest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Reject symlinks and non-file targets rather than adopting external edits during recovery. */
export function readOperationFile(
  root: string,
  relative: string,
): string | null {
  const target = checkedPath(root, relative);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Operation target is not a regular file');
    return readFileSync(target, 'utf8');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function checkedPath(root: string, relative: string): string {
  if (
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid operation projection path');
  const target = safeJoin(root, relative);
  let parent = path.dirname(target);
  while (parent !== path.resolve(root)) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Operation parent is not a physical directory');
    } catch (error) {
      if (!missing(error)) throw error;
    }

    parent = path.dirname(parent);
  }
  return target;
}
function flushDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(directory: string): void {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Operation directory is not physical');
  } catch (error) {
    if (!missing(error)) throw error;
    ensureDirectory(path.dirname(directory));
    mkdirSync(directory);
    flushDirectory(path.dirname(directory));
  }
}

function install(root: string, relative: string, bytes: string | null): void {
  const target = checkedPath(root, relative);
  ensureDirectory(path.dirname(target));
  if (bytes === null) {
    try {
      unlinkSync(target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    flushDirectory(path.dirname(target));
    return;
  }
  const temp = resolveDirectChildPath(
    path.dirname(target),
    `.${path.basename(target)}.redo-${randomUUID()}`,
  );
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    flushDirectory(path.dirname(target));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (!missing(cleanupError))
        throw new AggregateError(
          [error, cleanupError],
          'Redo install and cleanup failed',
        );
    }
    throw error;
  }
}

/** One synchronous decision/install boundary; callers may expose no reads until recover returns. */
export class DiskOperationRedo {
  constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly onStage: (stage: string) => void = () => {},
  ) {
    checkedPath(root, directory);
  }

  private name(name: string): string {
    return path.relative(
      this.root,
      resolveDirectChildPath(safeJoin(this.root, this.directory), name),
    );
  }

  recover(): void {
    const planBytes = readOperationFile(this.root, this.name('pending.json'));
    const decision = readOperationFile(this.root, this.name('decision'));
    if (decision === null) {
      if (planBytes !== null)
        install(this.root, this.name('pending.json'), null);
      return;
    }
    if (planBytes === null || diskBytesDigest(planBytes) !== decision)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Disk commit decision has no intact redo plan',
      );
    const parsed = planSchema.safeParse(JSON.parse(planBytes));
    if (!parsed.success)
      throw new SpaceOperationError('replay-corrupt', 'Invalid Disk redo plan');
    const paths = new Set<string>();
    for (const projection of parsed.data.projections) {
      const target = checkedPath(this.root, projection.path);
      if (
        target === safeJoin(this.root, this.directory) ||
        target === safeJoin(this.root, this.name('pending.json')) ||
        target === safeJoin(this.root, this.name('decision')) ||
        paths.has(target)
      )
        throw new SpaceOperationError(
          'replay-corrupt',
          'Invalid or duplicate Disk projection target',
        );
      paths.add(target);
      const current = readOperationFile(this.root, projection.path);
      if (current !== projection.after) {
        if (
          (current === null ? null : diskBytesDigest(current)) !==
          projection.before
        )
          throw new SpaceOperationError(
            'replay-corrupt',
            'Managed file changed outside the committed Disk operation',
          );
      }
      install(this.root, projection.path, projection.after);
      this.onStage(`installed:${projection.path}`);
    }
    // Every projection and directory entry is flushed before forgetting the decision.
    install(this.root, this.name('decision'), null);
    install(this.root, this.name('pending.json'), null);
    this.onStage('complete');
  }

  commit(projections: readonly DiskOperationProjection[]): void {
    this.recover();
    const plan = planSchema.parse({ version: 1, projections });
    const targets = new Set<string>();
    for (const projection of plan.projections) {
      const target = checkedPath(this.root, projection.path);
      if (
        targets.has(target) ||
        target === safeJoin(this.root, this.name('pending.json')) ||
        target === safeJoin(this.root, this.name('decision'))
      )
        throw new SpaceOperationError(
          'invalid-commit',
          'Invalid Disk projection target',
        );
      targets.add(target);
      const current = readOperationFile(this.root, projection.path);
      if (
        (current === null ? null : diskBytesDigest(current)) !==
        projection.before
      )
        throw new SpaceOperationError(
          'head-conflict',
          'Disk projection changed before commit',
        );
    }
    const bytes = JSON.stringify(plan);
    install(this.root, this.name('pending.json'), bytes);
    this.onStage('prepared');
    install(this.root, this.name('decision'), diskBytesDigest(bytes));
    this.onStage('decided');
    this.recover();
  }
}
