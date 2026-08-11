// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restart-safe Disk transactions for one Workspace.
 *
 * A transaction publishes an immutable manifest before it changes live Space
 * bytes. Recovery rolls an uncommitted manifest back and rolls a committed
 * manifest forward. File replacement is atomic; append recovery also accepts
 * a strict prefix of the declared bytes. This protects against a process
 * crash. It deliberately does not claim power-loss durability (there is no
 * directory fsync) or multi-process serialization.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { renameOverWithRetrySync } from '../../../../utils/fs.js';
import { createKeyedMutex } from '../../../../utils/keyed-mutex.js';
import { normalizeForCompare } from '../../../workspace/disk/naming.js';
import {
  HUABU_WORKSPACE_METADATA_DIR_NAME,
  workspaceHuabuDir,
  workspaceTransactionsDir,
} from '../../../workspace/disk/paths.js';

export const DISK_TRANSACTION_MANIFEST_VERSION = 1 as const;

const MANIFEST_FILENAME = 'manifest.json';
const PAYLOADS_DIRECTORY = 'payloads';
const COMMITTED_FILENAME = 'COMMITTED';
const COMMITTED_TEMP_FILENAME = 'COMMITTED.tmp';
const QUARANTINE_DIRECTORY = 'quarantine';
const TRANSACTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

const withWorkspaceTransactionMutex = createKeyedMutex<string>();

/**
 * Serialize the complete prepare → decision → cleanup window for a Workspace.
 * The on-disk recovery format intentionally permits only one outstanding
 * journal, so per-Space writer locks alone are insufficient.
 */
export function withDiskTransactionWorkspaceLock<T>(
  workspacePath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const workspace = path.resolve(workspacePath);
  return withWorkspaceTransactionMutex(workspace, () => {
    // A durable commit decision may outlive best-effort journal cleanup (for
    // example, an antivirus process can transiently hold the renamed `.done`
    // directory on Windows). Reap that residue before admitting the next
    // writer so cleanup failure cannot turn a successful commit into a
    // Workspace-wide write outage.
    recoverDiskTransactions(workspace);
    return operation();
  });
}

export class DiskTransactionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiskTransactionIntegrityError';
  }
}

export type DiskTransactionDirectoryInput =
  | { readonly kind: 'none'; readonly rootRelativePath: string }
  | { readonly kind: 'create'; readonly rootRelativePath: string }
  | {
      readonly kind: 'rename';
      readonly beforeRootRelativePath: string;
      readonly afterRootRelativePath: string;
    }
  | { readonly kind: 'quarantine'; readonly rootRelativePath: string };

export interface DiskTransactionFileInput {
  /** Portable path relative to the Space root. */
  readonly relativePath: string;
  /** Exact bytes before the transaction; null means absent. */
  readonly before: Buffer | null;
  /** Exact bytes after the transaction; null means absent. */
  readonly after: Buffer | null;
}

export interface DiskTransactionAppendInput {
  /** Portable path relative to the Space root. */
  readonly relativePath: string;
  readonly existedBefore: boolean;
  readonly beforeLength: number;
  readonly beforePrefixSha256: string;
  /** Exact bytes appended by this transaction. */
  readonly bytes: Buffer;
}

export interface PrepareDiskTransactionInput {
  /** Resolved absolute Workspace path. */
  readonly workspacePath: string;
  readonly transactionId?: string;
  readonly directory: DiskTransactionDirectoryInput;
  /** Applied in order before the append and an optional directory rename. */
  readonly files?: readonly DiskTransactionFileInput[];
  readonly append?: DiskTransactionAppendInput;
}

/**
 * Compatibility journal for an opaque synchronous legacy writer. The caller
 * names the files/log it may touch; preparation captures their before-state.
 */
export interface PrepareDiskUndoJournalInput {
  readonly workspacePath: string;
  readonly transactionId?: string;
  readonly directory: DiskTransactionDirectoryInput;
  readonly fileRelativePaths?: readonly string[];
  readonly appendRelativePath?: string;
}

export interface PreparedDiskTransaction {
  readonly workspacePath: string;
  readonly transactionId: string;
  readonly directoryPath: string;
}

export interface CapturedAppendLogPrefix {
  readonly existedBefore: boolean;
  readonly beforeLength: number;
  readonly beforePrefixSha256: string;
}

interface PayloadReference {
  readonly relativePath: string;
  readonly length: number;
  readonly sha256: string;
}

interface ManifestFile {
  readonly relativePath: string;
  readonly before: PayloadReference | null;
  readonly after: PayloadReference | null;
  readonly missingParentsBefore: readonly string[];
}

interface ManifestAppend {
  readonly relativePath: string;
  readonly existedBefore: boolean;
  readonly beforeLength: number;
  readonly beforePrefixSha256: string;
  readonly bytes: PayloadReference;
  readonly missingParentsBefore: readonly string[];
}

interface DiskTransactionManifest {
  readonly version: typeof DISK_TRANSACTION_MANIFEST_VERSION;
  readonly transactionId: string;
  readonly createdAt: number;
  readonly recoveryMode: 'undo-redo' | 'undo-only';
  readonly directory: DiskTransactionDirectoryInput;
  readonly files: readonly ManifestFile[];
  readonly append: ManifestAppend | null;
}

interface LoadedFile extends ManifestFile {
  readonly beforeBytes: Buffer | null;
  readonly afterBytes: Buffer | null;
}

interface LoadedAppend extends ManifestAppend {
  readonly appendBytes: Buffer;
}

interface LoadedTransaction {
  readonly handle: PreparedDiskTransaction;
  readonly manifest: DiskTransactionManifest;
  readonly manifestSha256: string;
  readonly files: readonly LoadedFile[];
  readonly append: LoadedAppend | null;
  readonly committed: boolean;
}

type Direction = 'redo' | 'undo';

type DirectoryState =
  | { readonly kind: 'root'; readonly rootPath: string; readonly present: true }
  | {
      readonly kind: 'root';
      readonly rootPath: string;
      readonly present: false;
    }
  | {
      readonly kind: 'rename';
      readonly location: 'before' | 'after';
      readonly rootPath: string;
    }
  | {
      readonly kind: 'quarantine';
      readonly location: 'live' | 'quarantine' | 'missing';
      readonly rootPath: string | null;
    };

function integrity(message: string): never {
  throw new DiskTransactionIntegrityError(message);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertAbsoluteWorkspace(workspacePath: string): string {
  if (!path.isAbsolute(workspacePath)) {
    throw new TypeError('Disk transaction workspacePath must be absolute');
  }
  const resolved = path.resolve(workspacePath);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch (error) {
    if (isMissing(error)) {
      throw new TypeError(
        `Disk transaction Workspace does not exist: ${resolved}`,
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(
      `Disk transaction Workspace must be a real directory: ${resolved}`,
    );
  }
  return resolved;
}

function assertTransactionId(transactionId: string): string {
  if (!TRANSACTION_ID_RE.test(transactionId)) {
    throw new TypeError(`Invalid Disk transaction id: ${transactionId}`);
  }
  return transactionId;
}

function assertPortableRelativePath(
  relativePath: string,
  label: string,
): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.includes(':') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new TypeError(`Invalid ${label}: ${relativePath}`);
  }
  const segments = relativePath.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Invalid ${label}: ${relativePath}`);
  }
  return relativePath;
}

function assertRootName(root: string, label = 'Space root name'): string {
  assertPortableRelativePath(root, label);
  if (root.includes('/')) {
    throw new TypeError(`Invalid ${label}: ${root}`);
  }
  if (
    normalizeForCompare(root) ===
    normalizeForCompare(HUABU_WORKSPACE_METADATA_DIR_NAME)
  ) {
    throw new TypeError(`The ${label} cannot address ${root}`);
  }
  return root;
}

function assertDirectoryInput(
  directory: DiskTransactionDirectoryInput,
): DiskTransactionDirectoryInput {
  switch (directory.kind) {
    case 'none':
    case 'create':
    case 'quarantine':
      assertRootName(directory.rootRelativePath);
      return { ...directory };
    case 'rename': {
      const beforeRootRelativePath = assertRootName(
        directory.beforeRootRelativePath,
        'before Space root name',
      );
      const afterRootRelativePath = assertRootName(
        directory.afterRootRelativePath,
        'after Space root name',
      );
      if (beforeRootRelativePath === afterRootRelativePath) {
        throw new TypeError(
          'Disk transaction rename must change the root name',
        );
      }
      return { kind: 'rename', beforeRootRelativePath, afterRootRelativePath };
    }
    default:
      return integrity('Unknown Disk transaction directory operation');
  }
}

function lstatOrNull(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertRealDirectory(directoryPath: string, label: string): void {
  const stat = lstatOrNull(directoryPath);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    integrity(`${label} is not a real directory: ${directoryPath}`);
  }
}

function ensureMetadataDirectories(workspacePath: string): string {
  const huabu = workspaceHuabuDir(workspacePath);
  const transactions = workspaceTransactionsDir(workspacePath);
  for (const directory of [huabu, transactions]) {
    const stat = lstatOrNull(directory);
    if (!stat) {
      mkdirSync(directory);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      integrity(`Disk transaction metadata path is unsafe: ${directory}`);
    }
  }
  return transactions;
}

function existingMetadataDirectories(workspacePath: string): string | null {
  const huabu = workspaceHuabuDir(workspacePath);
  const transactions = workspaceTransactionsDir(workspacePath);
  const huabuStat = lstatOrNull(huabu);
  if (!huabuStat) return null;
  if (huabuStat.isSymbolicLink() || !huabuStat.isDirectory()) {
    integrity(`Disk transaction metadata path is unsafe: ${huabu}`);
  }
  const transactionStat = lstatOrNull(transactions);
  if (!transactionStat) return null;
  if (transactionStat.isSymbolicLink() || !transactionStat.isDirectory()) {
    integrity(`Disk transaction metadata path is unsafe: ${transactions}`);
  }
  return transactions;
}

function findRootEntry(workspacePath: string, expected: string): string | null {
  const comparison = normalizeForCompare(expected);
  const matches = readdirSync(workspacePath).filter(
    (entry) => normalizeForCompare(entry) === comparison,
  );
  if (matches.length > 1) {
    integrity(`Ambiguous Space root casing for ${expected}`);
  }
  const actual = matches[0];
  if (!actual) return null;
  const fullPath = path.join(workspacePath, actual);
  assertRealDirectory(fullPath, 'Space root');
  return actual;
}

function resolveExistingRoot(workspacePath: string, expected: string): string {
  const actual = findRootEntry(workspacePath, expected);
  if (!actual || actual !== expected) {
    integrity(`Expected exact Space root ${expected}`);
  }
  return path.join(workspacePath, actual);
}

function inspectDirectoryState(
  handle: PreparedDiskTransaction,
  directory: DiskTransactionDirectoryInput,
  allowMissingQuarantine = false,
): DirectoryState {
  switch (directory.kind) {
    case 'none': {
      return {
        kind: 'root',
        rootPath: resolveExistingRoot(
          handle.workspacePath,
          directory.rootRelativePath,
        ),
        present: true,
      };
    }
    case 'create': {
      const actual = findRootEntry(
        handle.workspacePath,
        directory.rootRelativePath,
      );
      if (actual && actual !== directory.rootRelativePath) {
        integrity(`Expected exact Space root ${directory.rootRelativePath}`);
      }
      return {
        kind: 'root',
        rootPath: path.join(handle.workspacePath, directory.rootRelativePath),
        present: actual !== null,
      };
    }
    case 'rename': {
      const beforeKey = normalizeForCompare(directory.beforeRootRelativePath);
      const afterKey = normalizeForCompare(directory.afterRootRelativePath);
      if (beforeKey === afterKey) {
        const actual = findRootEntry(
          handle.workspacePath,
          directory.beforeRootRelativePath,
        );
        if (!actual) integrity('Renamed Space root is missing');
        if (
          actual !== directory.beforeRootRelativePath &&
          actual !== directory.afterRootRelativePath
        ) {
          integrity(`Unexpected casing for renamed Space root: ${actual}`);
        }
        return {
          kind: 'rename',
          location:
            actual === directory.beforeRootRelativePath ? 'before' : 'after',
          rootPath: path.join(handle.workspacePath, actual),
        };
      }
      const before = findRootEntry(
        handle.workspacePath,
        directory.beforeRootRelativePath,
      );
      const after = findRootEntry(
        handle.workspacePath,
        directory.afterRootRelativePath,
      );
      if (before && before !== directory.beforeRootRelativePath) {
        integrity(
          `Expected exact Space root ${directory.beforeRootRelativePath}`,
        );
      }
      if (after && after !== directory.afterRootRelativePath) {
        integrity(
          `Expected exact Space root ${directory.afterRootRelativePath}`,
        );
      }
      if ((before === null) === (after === null)) {
        integrity('Rename transaction requires exactly one live Space root');
      }
      return before
        ? {
            kind: 'rename',
            location: 'before',
            rootPath: path.join(handle.workspacePath, before),
          }
        : {
            kind: 'rename',
            location: 'after',
            rootPath: path.join(handle.workspacePath, after as string),
          };
    }
    case 'quarantine': {
      const actual = findRootEntry(
        handle.workspacePath,
        directory.rootRelativePath,
      );
      if (actual && actual !== directory.rootRelativePath) {
        integrity(`Expected exact Space root ${directory.rootRelativePath}`);
      }
      const quarantine = path.join(handle.directoryPath, QUARANTINE_DIRECTORY);
      const quarantineStat = lstatOrNull(quarantine);
      if (
        quarantineStat &&
        (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory())
      ) {
        integrity(`Unsafe Disk transaction quarantine: ${quarantine}`);
      }
      if (actual && quarantineStat) {
        integrity('Quarantine transaction has both live and quarantined roots');
      }
      if (actual) {
        return {
          kind: 'quarantine',
          location: 'live',
          rootPath: path.join(handle.workspacePath, actual),
        };
      }
      if (quarantineStat) {
        return {
          kind: 'quarantine',
          location: 'quarantine',
          rootPath: quarantine,
        };
      }
      if (!allowMissingQuarantine) {
        integrity('Quarantine transaction root is missing from both locations');
      }
      return { kind: 'quarantine', location: 'missing', rootPath: null };
    }
  }
}

function assertPathComponentsSafe(
  rootPath: string,
  relativePath: string,
): void {
  let current = rootPath;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      integrity(`Disk transaction path crosses a symbolic link: ${current}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      integrity(`Disk transaction parent is not a directory: ${current}`);
    }
  }
}

function readTargetBytes(
  rootPath: string,
  relativePath: string,
): Buffer | null {
  assertPathComponentsSafe(rootPath, relativePath);
  const filePath = path.join(rootPath, ...relativePath.split('/'));
  const stat = lstatOrNull(filePath);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`Disk transaction target is not a regular file: ${filePath}`);
  }
  return readFileSync(filePath);
}

function missingParentPaths(rootPath: string, relativePath: string): string[] {
  const segments = relativePath.split('/').slice(0, -1);
  const missing: string[] = [];
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const relative = segments.slice(0, index + 1).join('/');
    const stat = lstatOrNull(current);
    if (!stat) {
      missing.push(relative);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      integrity(`Disk transaction parent is unsafe: ${current}`);
    }
  }
  return missing;
}

function hashFilePrefix(filePath: string, length: number): string {
  const descriptor = openSync(filePath, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < length) {
      integrity(`Append-log prefix is unavailable: ${filePath}`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(length, 1)));
    let position = 0;
    while (position < length) {
      const requested = Math.min(buffer.length, length - position);
      const count = readSync(descriptor, buffer, 0, requested, position);
      if (count === 0) integrity(`Short append-log prefix read: ${filePath}`);
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

/** Capture the exact prefix identity required by an append transaction. */
export function captureAppendLogPrefix(
  workspacePath: string,
  rootRelativePath: string,
  relativePath: string,
): CapturedAppendLogPrefix {
  const workspace = assertAbsoluteWorkspace(workspacePath);
  const root = resolveExistingRoot(workspace, assertRootName(rootRelativePath));
  const relative = assertPortableRelativePath(relativePath, 'append-log path');
  assertPathComponentsSafe(root, relative);
  const filePath = path.join(root, ...relative.split('/'));
  const stat = lstatOrNull(filePath);
  if (!stat) {
    return {
      existedBefore: false,
      beforeLength: 0,
      beforePrefixSha256: EMPTY_SHA256,
    };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`Append-log target is not a regular file: ${filePath}`);
  }
  return {
    existedBefore: true,
    beforeLength: stat.size,
    beforePrefixSha256: hashFilePrefix(filePath, stat.size),
  };
}

function assertBytesState(
  actual: Buffer | null,
  before: Buffer | null,
  after: Buffer | null,
  relativePath: string,
): void {
  const matchesBefore =
    actual === null ? before === null : before?.equals(actual) === true;
  const matchesAfter =
    actual === null ? after === null : after?.equals(actual) === true;
  if (!matchesBefore && !matchesAfter) {
    integrity(`Unexpected live bytes at ${relativePath}`);
  }
}

function assertInitialAppendState(
  rootPath: string,
  append: DiskTransactionAppendInput,
): void {
  const relative = append.relativePath;
  assertPathComponentsSafe(rootPath, relative);
  const filePath = path.join(rootPath, ...relative.split('/'));
  const stat = lstatOrNull(filePath);
  if (!append.existedBefore) {
    if (stat) integrity(`Expected absent append log: ${relative}`);
    if (
      append.beforeLength !== 0 ||
      append.beforePrefixSha256 !== EMPTY_SHA256
    ) {
      throw new TypeError('Absent append log must declare the empty prefix');
    }
    return;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`Expected existing append log: ${relative}`);
  }
  if (stat.size !== append.beforeLength) {
    integrity(`Append-log length changed before prepare: ${relative}`);
  }
  if (
    hashFilePrefix(filePath, append.beforeLength) !== append.beforePrefixSha256
  ) {
    integrity(`Append-log prefix changed before prepare: ${relative}`);
  }
}

function payloadReference(
  relativePath: string,
  bytes: Buffer,
): PayloadReference {
  return { relativePath, length: bytes.length, sha256: sha256(bytes) };
}

function writePayload(
  buildingPath: string,
  relativePath: string,
  bytes: Buffer,
): PayloadReference {
  const reference = payloadReference(relativePath, bytes);
  writeFileSync(path.join(buildingPath, ...relativePath.split('/')), bytes, {
    flag: 'wx',
  });
  return reference;
}

function preparedHandle(
  workspacePath: string,
  transactionId: string,
): PreparedDiskTransaction {
  return {
    workspacePath,
    transactionId,
    directoryPath: path.join(
      workspaceTransactionsDir(workspacePath),
      transactionId,
    ),
  };
}

/**
 * Publish an immutable prepared manifest. No live target is changed here.
 * A Workspace permits one outstanding transaction; callers serialize at the
 * application layer and recovery clears crash residue during activation.
 */
function prepareTransaction(
  input: PrepareDiskTransactionInput,
  recoveryMode: DiskTransactionManifest['recoveryMode'],
): PreparedDiskTransaction {
  const workspacePath = assertAbsoluteWorkspace(input.workspacePath);
  const transactionId = assertTransactionId(
    input.transactionId ?? randomUUID(),
  );
  const directory = assertDirectoryInput(input.directory);
  const transactionsPath = ensureMetadataDirectories(workspacePath);
  const existingEntries = readdirSync(transactionsPath);
  if (existingEntries.length > 0) {
    integrity('Workspace already has an outstanding Disk transaction');
  }

  const handle = preparedHandle(workspacePath, transactionId);
  const provisionalHandle: PreparedDiskTransaction = {
    ...handle,
    directoryPath: path.join(transactionsPath, `.building-${transactionId}`),
  };
  const initialDirectory = inspectDirectoryState(provisionalHandle, directory);
  if (
    directory.kind === 'create' &&
    (initialDirectory.kind !== 'root' || initialDirectory.present)
  ) {
    integrity(
      `Create transaction Space root already exists: ${directory.rootRelativePath}`,
    );
  }
  if (
    directory.kind === 'rename' &&
    (initialDirectory.kind !== 'rename' ||
      initialDirectory.location !== 'before')
  ) {
    integrity('Rename transaction is already in its after state');
  }
  if (
    directory.kind === 'quarantine' &&
    (initialDirectory.kind !== 'quarantine' ||
      initialDirectory.location !== 'live')
  ) {
    integrity('Quarantine transaction requires a live Space root');
  }

  const rootPath = initialDirectory.rootPath;
  const files = input.files ?? [];
  const seen = new Set<string>();
  const validatedFiles = files.map((file) => {
    const relativePath = assertPortableRelativePath(
      file.relativePath,
      'file path',
    );
    const comparisonPath = normalizeForCompare(relativePath);
    if (seen.has(comparisonPath)) {
      throw new TypeError(`Duplicate Disk transaction file: ${relativePath}`);
    }
    seen.add(comparisonPath);
    if (!Buffer.isBuffer(file.before) && file.before !== null) {
      throw new TypeError(`Invalid before bytes for ${relativePath}`);
    }
    if (!Buffer.isBuffer(file.after) && file.after !== null) {
      throw new TypeError(`Invalid after bytes for ${relativePath}`);
    }
    if (
      recoveryMode === 'undo-redo' &&
      file.before === null &&
      file.after === null
    ) {
      throw new TypeError(
        `Disk transaction file has no state: ${relativePath}`,
      );
    }
    if (directory.kind === 'create' && file.before !== null) {
      throw new TypeError(
        `Create transaction cannot have before bytes: ${relativePath}`,
      );
    }
    const before = file.before === null ? null : Buffer.from(file.before);
    const after = file.after === null ? null : Buffer.from(file.after);
    if (directory.kind !== 'create') {
      const actual = readTargetBytes(rootPath as string, relativePath);
      const matches =
        actual === null ? before === null : before?.equals(actual);
      if (!matches)
        integrity(`Live bytes changed before prepare: ${relativePath}`);
    }
    return {
      relativePath,
      before,
      after,
      missingParentsBefore:
        directory.kind === 'create'
          ? relativePath
              .split('/')
              .slice(0, -1)
              .map((_, index, segments) =>
                segments.slice(0, index + 1).join('/'),
              )
          : missingParentPaths(rootPath as string, relativePath),
    };
  });

  let validatedAppend: DiskTransactionAppendInput | null = null;
  let appendMissingParents: string[] = [];
  if (input.append) {
    const relativePath = assertPortableRelativePath(
      input.append.relativePath,
      'append-log path',
    );
    if (seen.has(normalizeForCompare(relativePath))) {
      throw new TypeError(
        `Append log collides with a file target: ${relativePath}`,
      );
    }
    if (
      !Number.isSafeInteger(input.append.beforeLength) ||
      input.append.beforeLength < 0 ||
      !SHA256_RE.test(input.append.beforePrefixSha256) ||
      !Buffer.isBuffer(input.append.bytes)
    ) {
      throw new TypeError(`Invalid append-log declaration: ${relativePath}`);
    }
    if (directory.kind === 'create' && input.append.existedBefore) {
      throw new TypeError('Create transaction append log cannot exist before');
    }
    validatedAppend = {
      ...input.append,
      relativePath,
      bytes: Buffer.from(input.append.bytes),
    };
    if (directory.kind !== 'create') {
      assertInitialAppendState(rootPath as string, validatedAppend);
      appendMissingParents = missingParentPaths(
        rootPath as string,
        relativePath,
      );
    } else {
      if (
        validatedAppend.beforeLength !== 0 ||
        validatedAppend.beforePrefixSha256 !== EMPTY_SHA256
      ) {
        throw new TypeError('Create transaction append log must start empty');
      }
      appendMissingParents = relativePath
        .split('/')
        .slice(0, -1)
        .map((_, index, segments) => segments.slice(0, index + 1).join('/'));
    }
  }
  if (
    directory.kind === 'quarantine' &&
    (validatedFiles.length || validatedAppend)
  ) {
    throw new TypeError('Quarantine transactions cannot also change files');
  }

  const buildingPath = provisionalHandle.directoryPath;
  try {
    mkdirSync(buildingPath);
    mkdirSync(path.join(buildingPath, PAYLOADS_DIRECTORY));
    const manifestFiles: ManifestFile[] = validatedFiles.map((file, index) => {
      const prefix = `payloads/${index.toString().padStart(4, '0')}`;
      return {
        relativePath: file.relativePath,
        before:
          file.before === null
            ? null
            : writePayload(buildingPath, `${prefix}-before.bin`, file.before),
        after:
          file.after === null
            ? null
            : writePayload(buildingPath, `${prefix}-after.bin`, file.after),
        missingParentsBefore: file.missingParentsBefore,
      };
    });
    const manifestAppend = validatedAppend
      ? {
          relativePath: validatedAppend.relativePath,
          existedBefore: validatedAppend.existedBefore,
          beforeLength: validatedAppend.beforeLength,
          beforePrefixSha256: validatedAppend.beforePrefixSha256,
          bytes: writePayload(
            buildingPath,
            'payloads/append.bin',
            validatedAppend.bytes,
          ),
          missingParentsBefore: appendMissingParents,
        }
      : null;
    const manifest: DiskTransactionManifest = {
      version: DISK_TRANSACTION_MANIFEST_VERSION,
      transactionId,
      createdAt: Date.now(),
      recoveryMode,
      directory,
      files: manifestFiles,
      append: manifestAppend,
    };
    writeFileSync(
      path.join(buildingPath, MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    renameSync(buildingPath, handle.directoryPath);
    return handle;
  } catch (error) {
    rmSync(buildingPath, { recursive: true, force: true });
    throw error;
  }
}

/** Publish a journal whose committed state can be deterministically redone. */
export function prepareDiskTransaction(
  input: PrepareDiskTransactionInput,
): PreparedDiskTransaction {
  return prepareTransaction(input, 'undo-redo');
}

/**
 * Capture an undo journal before calling an opaque legacy writer.
 *
 * The writer may produce arbitrary after-bytes at the declared targets. Call
 * {@link markPreparedDiskTransactionCommitted} only after it returns
 * successfully. Committed recovery then only finalizes the journal; a crash
 * before that marker restores these captured bytes exactly.
 */
export function prepareDiskUndoJournal(
  input: PrepareDiskUndoJournalInput,
): PreparedDiskTransaction {
  const workspacePath = assertAbsoluteWorkspace(input.workspacePath);
  const requestedDirectory = assertDirectoryInput(input.directory);
  // A legacy strict rename reports a business conflict when its destination
  // already belongs to another Space. In that known-before state no rename
  // can occur, so journal the live root as `none`; abort must restore target
  // files without mistaking the unrelated destination for partial progress.
  const directory: DiskTransactionDirectoryInput =
    requestedDirectory.kind === 'rename' &&
    normalizeForCompare(requestedDirectory.beforeRootRelativePath) !==
      normalizeForCompare(requestedDirectory.afterRootRelativePath) &&
    findRootEntry(workspacePath, requestedDirectory.afterRootRelativePath) !==
      null
      ? {
          kind: 'none',
          rootRelativePath: requestedDirectory.beforeRootRelativePath,
        }
      : requestedDirectory;
  if (
    directory.kind === 'quarantine' &&
    ((input.fileRelativePaths?.length ?? 0) > 0 || input.appendRelativePath)
  ) {
    throw new TypeError('Quarantine undo journals cannot declare file writes');
  }
  let rootPath: string;
  let rootName: string;
  switch (directory.kind) {
    case 'none':
      rootName = directory.rootRelativePath;
      rootPath = resolveExistingRoot(workspacePath, rootName);
      break;
    case 'rename':
      rootName = directory.beforeRootRelativePath;
      rootPath = resolveExistingRoot(workspacePath, rootName);
      break;
    case 'create':
      rootName = directory.rootRelativePath;
      rootPath = path.join(workspacePath, rootName);
      break;
    case 'quarantine':
      rootName = directory.rootRelativePath;
      rootPath = resolveExistingRoot(workspacePath, rootName);
      break;
  }
  const files = (input.fileRelativePaths ?? []).map((candidate) => {
    const relativePath = assertPortableRelativePath(candidate, 'file path');
    const before =
      directory.kind === 'create'
        ? null
        : readTargetBytes(rootPath, relativePath);
    return { relativePath, before, after: before };
  });
  let append: DiskTransactionAppendInput | undefined;
  if (input.appendRelativePath) {
    const relativePath = assertPortableRelativePath(
      input.appendRelativePath,
      'append-log path',
    );
    const captured =
      directory.kind === 'create'
        ? {
            existedBefore: false,
            beforeLength: 0,
            beforePrefixSha256: EMPTY_SHA256,
          }
        : captureAppendLogPrefix(workspacePath, rootName, relativePath);
    append = { relativePath, ...captured, bytes: Buffer.alloc(0) };
  }
  return prepareTransaction(
    {
      workspacePath,
      transactionId: input.transactionId,
      directory,
      files,
      append,
    },
    'undo-only',
  );
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return integrity(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    integrity(`${label} has unexpected fields`);
  }
}

function parsePayloadReference(
  value: unknown,
  label: string,
): PayloadReference {
  const record = asRecord(value, label);
  assertExactKeys(record, ['relativePath', 'length', 'sha256'], label);
  if (
    typeof record.relativePath !== 'string' ||
    typeof record.length !== 'number' ||
    !Number.isSafeInteger(record.length) ||
    record.length < 0 ||
    typeof record.sha256 !== 'string' ||
    !SHA256_RE.test(record.sha256)
  ) {
    integrity(`${label} is malformed`);
  }
  const relativePath = assertPortableRelativePath(
    record.relativePath,
    `${label} path`,
  );
  if (!relativePath.startsWith(`${PAYLOADS_DIRECTORY}/`)) {
    integrity(`${label} is outside the payload directory`);
  }
  return {
    relativePath,
    length: record.length,
    sha256: record.sha256,
  };
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) integrity(`${label} must be an array`);
  const out = value.map((item) => {
    if (typeof item !== 'string') integrity(`${label} must contain paths`);
    return assertPortableRelativePath(item, label);
  });
  if (new Set(out).size !== out.length)
    integrity(`${label} contains duplicates`);
  return out;
}

function parseDirectory(value: unknown): DiskTransactionDirectoryInput {
  const record = asRecord(value, 'manifest directory');
  if (record.kind === 'rename') {
    assertExactKeys(
      record,
      ['kind', 'beforeRootRelativePath', 'afterRootRelativePath'],
      'manifest directory',
    );
    if (
      typeof record.beforeRootRelativePath !== 'string' ||
      typeof record.afterRootRelativePath !== 'string'
    ) {
      integrity('Manifest rename roots are malformed');
    }
    return assertDirectoryInput({
      kind: 'rename',
      beforeRootRelativePath: record.beforeRootRelativePath,
      afterRootRelativePath: record.afterRootRelativePath,
    });
  }
  if (
    record.kind === 'none' ||
    record.kind === 'create' ||
    record.kind === 'quarantine'
  ) {
    assertExactKeys(record, ['kind', 'rootRelativePath'], 'manifest directory');
    if (typeof record.rootRelativePath !== 'string') {
      integrity('Manifest root is malformed');
    }
    return assertDirectoryInput({
      kind: record.kind,
      rootRelativePath: record.rootRelativePath,
    });
  }
  return integrity('Unknown manifest directory operation');
}

function parseManifest(
  bytes: Buffer,
  expectedId: string,
): DiskTransactionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return integrity('Disk transaction manifest is not valid JSON');
  }
  const record = asRecord(parsed, 'Disk transaction manifest');
  assertExactKeys(
    record,
    [
      'version',
      'transactionId',
      'createdAt',
      'recoveryMode',
      'directory',
      'files',
      'append',
    ],
    'Disk transaction manifest',
  );
  if (
    record.version !== DISK_TRANSACTION_MANIFEST_VERSION ||
    record.transactionId !== expectedId ||
    typeof record.createdAt !== 'number' ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.recoveryMode !== 'undo-redo' &&
      record.recoveryMode !== 'undo-only') ||
    !Array.isArray(record.files)
  ) {
    integrity('Disk transaction manifest header is malformed');
  }
  const recoveryMode = record.recoveryMode;
  const directory = parseDirectory(record.directory);
  const files = record.files.map((value, index): ManifestFile => {
    const file = asRecord(value, `manifest file ${index}`);
    assertExactKeys(
      file,
      ['relativePath', 'before', 'after', 'missingParentsBefore'],
      `manifest file ${index}`,
    );
    if (typeof file.relativePath !== 'string') {
      integrity(`Manifest file ${index} path is malformed`);
    }
    const relativePath = assertPortableRelativePath(
      file.relativePath,
      `manifest file ${index} path`,
    );
    const before =
      file.before === null
        ? null
        : parsePayloadReference(file.before, `manifest file ${index} before`);
    const after =
      file.after === null
        ? null
        : parsePayloadReference(file.after, `manifest file ${index} after`);
    if (!before && !after && recoveryMode === 'undo-redo') {
      integrity(`Manifest file ${index} has no state`);
    }
    const missingParentsBefore = parseStringArray(
      file.missingParentsBefore,
      `manifest file ${index} missing parents`,
    );
    const validParents = new Set(
      relativePath
        .split('/')
        .slice(0, -1)
        .map((_, parentIndex, segments) =>
          segments.slice(0, parentIndex + 1).join('/'),
        ),
    );
    if (missingParentsBefore.some((parent) => !validParents.has(parent))) {
      integrity(`Manifest file ${index} has an unrelated missing parent`);
    }
    return { relativePath, before, after, missingParentsBefore };
  });
  if (
    new Set(files.map((file) => normalizeForCompare(file.relativePath)))
      .size !== files.length
  ) {
    integrity('Disk transaction manifest has duplicate file targets');
  }

  let append: ManifestAppend | null = null;
  if (record.append !== null) {
    const value = asRecord(record.append, 'manifest append');
    assertExactKeys(
      value,
      [
        'relativePath',
        'existedBefore',
        'beforeLength',
        'beforePrefixSha256',
        'bytes',
        'missingParentsBefore',
      ],
      'manifest append',
    );
    if (
      typeof value.relativePath !== 'string' ||
      typeof value.existedBefore !== 'boolean' ||
      typeof value.beforeLength !== 'number' ||
      !Number.isSafeInteger(value.beforeLength) ||
      value.beforeLength < 0 ||
      typeof value.beforePrefixSha256 !== 'string' ||
      !SHA256_RE.test(value.beforePrefixSha256)
    ) {
      integrity('Manifest append is malformed');
    }
    const relativePath = assertPortableRelativePath(
      value.relativePath,
      'manifest append path',
    );
    if (
      files.some(
        (file) =>
          normalizeForCompare(file.relativePath) ===
          normalizeForCompare(relativePath),
      )
    ) {
      integrity('Manifest append collides with a file target');
    }
    const missingParentsBefore = parseStringArray(
      value.missingParentsBefore,
      'manifest append missing parents',
    );
    const validParents = new Set(
      relativePath
        .split('/')
        .slice(0, -1)
        .map((_, parentIndex, segments) =>
          segments.slice(0, parentIndex + 1).join('/'),
        ),
    );
    if (missingParentsBefore.some((parent) => !validParents.has(parent))) {
      integrity('Manifest append has an unrelated missing parent');
    }
    append = {
      relativePath,
      existedBefore: value.existedBefore,
      beforeLength: value.beforeLength,
      beforePrefixSha256: value.beforePrefixSha256,
      bytes: parsePayloadReference(value.bytes, 'manifest append bytes'),
      missingParentsBefore,
    };
  }
  if (directory.kind === 'quarantine' && (files.length || append)) {
    integrity('Quarantine manifest also changes files');
  }
  if (directory.kind === 'create') {
    if (files.some((file) => file.before !== null) || append?.existedBefore) {
      integrity('Create manifest declares pre-existing bytes');
    }
  }
  return {
    version: DISK_TRANSACTION_MANIFEST_VERSION,
    transactionId: expectedId,
    createdAt: record.createdAt,
    recoveryMode,
    directory,
    files,
    append,
  };
}

function readRegularFile(filePath: string, label: string): Buffer {
  const stat = lstatOrNull(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`${label} is missing or unsafe: ${filePath}`);
  }
  return readFileSync(filePath);
}

function loadPayload(
  directoryPath: string,
  reference: PayloadReference,
): Buffer {
  const bytes = readRegularFile(
    path.join(directoryPath, ...reference.relativePath.split('/')),
    'Disk transaction payload',
  );
  if (bytes.length !== reference.length || sha256(bytes) !== reference.sha256) {
    integrity(
      `Disk transaction payload failed verification: ${reference.relativePath}`,
    );
  }
  return bytes;
}

function parseCommittedMarker(bytes: Buffer, loaded: LoadedTransaction): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return integrity('Disk transaction COMMITTED marker is not valid JSON');
  }
  const marker = asRecord(parsed, 'Disk transaction COMMITTED marker');
  assertExactKeys(
    marker,
    ['version', 'transactionId', 'manifestSha256'],
    'Disk transaction COMMITTED marker',
  );
  if (
    marker.version !== DISK_TRANSACTION_MANIFEST_VERSION ||
    marker.transactionId !== loaded.handle.transactionId ||
    marker.manifestSha256 !== loaded.manifestSha256
  ) {
    integrity('Disk transaction COMMITTED marker does not bind the manifest');
  }
}

function loadTransaction(handle: PreparedDiskTransaction): LoadedTransaction {
  const workspacePath = assertAbsoluteWorkspace(handle.workspacePath);
  const transactionId = assertTransactionId(handle.transactionId);
  const expected = preparedHandle(workspacePath, transactionId);
  if (path.resolve(handle.directoryPath) !== expected.directoryPath) {
    throw new TypeError('Prepared Disk transaction handle has an invalid path');
  }
  assertRealDirectory(expected.directoryPath, 'Disk transaction directory');
  const manifestBytes = readRegularFile(
    path.join(expected.directoryPath, MANIFEST_FILENAME),
    'Disk transaction manifest',
  );
  const manifest = parseManifest(manifestBytes, transactionId);
  const payloadPaths = new Set<string>();
  const files = manifest.files.map((file): LoadedFile => {
    if (file.before) payloadPaths.add(file.before.relativePath);
    if (file.after) payloadPaths.add(file.after.relativePath);
    return {
      ...file,
      beforeBytes: file.before
        ? loadPayload(expected.directoryPath, file.before)
        : null,
      afterBytes: file.after
        ? loadPayload(expected.directoryPath, file.after)
        : null,
    };
  });
  const append = manifest.append
    ? {
        ...manifest.append,
        appendBytes: loadPayload(expected.directoryPath, manifest.append.bytes),
      }
    : null;
  if (manifest.append) payloadPaths.add(manifest.append.bytes.relativePath);

  const payloadDirectory = path.join(
    expected.directoryPath,
    PAYLOADS_DIRECTORY,
  );
  assertRealDirectory(payloadDirectory, 'Disk transaction payload directory');
  const actualPayloads = readdirSync(payloadDirectory).map(
    (name) => `${PAYLOADS_DIRECTORY}/${name}`,
  );
  if (
    actualPayloads.length !== payloadPaths.size ||
    actualPayloads.some((name) => !payloadPaths.has(name))
  ) {
    integrity('Disk transaction payload directory has unexpected entries');
  }

  const rootEntries = readdirSync(expected.directoryPath);
  const allowedRootEntries = new Set([
    MANIFEST_FILENAME,
    PAYLOADS_DIRECTORY,
    COMMITTED_FILENAME,
    COMMITTED_TEMP_FILENAME,
    ...(manifest.directory.kind === 'quarantine' ? [QUARANTINE_DIRECTORY] : []),
  ]);
  if (rootEntries.some((entry) => !allowedRootEntries.has(entry))) {
    integrity('Disk transaction directory has unexpected entries');
  }
  const markerPath = path.join(expected.directoryPath, COMMITTED_FILENAME);
  const committed = existsSync(markerPath);
  const loaded: LoadedTransaction = {
    handle: expected,
    manifest,
    manifestSha256: sha256(manifestBytes),
    files,
    append,
    committed,
  };
  if (committed) {
    parseCommittedMarker(
      readRegularFile(markerPath, 'Disk transaction COMMITTED marker'),
      loaded,
    );
  }
  return loaded;
}

function transactionTempRelativePath(
  transactionId: string,
  relativePath: string,
): string {
  const digest = sha256(Buffer.from(relativePath)).slice(0, 16);
  const parent = path.posix.dirname(relativePath);
  const filename = `.huabu-tx-${transactionId}-${digest}.tmp`;
  return parent === '.' ? filename : `${parent}/${filename}`;
}

function assertTempSafe(
  rootPath: string,
  transactionId: string,
  relativePath: string,
): void {
  const tempRelative = transactionTempRelativePath(transactionId, relativePath);
  assertPathComponentsSafe(rootPath, tempRelative);
  const tempPath = path.join(rootPath, ...tempRelative.split('/'));
  const stat = lstatOrNull(tempPath);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    integrity(`Unsafe Disk transaction temporary file: ${tempPath}`);
  }
}

function readAppendTail(
  rootPath: string,
  append: LoadedAppend,
  allowUnknownTail = false,
): { readonly exists: boolean; readonly tailLength: number } {
  assertPathComponentsSafe(rootPath, append.relativePath);
  const filePath = path.join(rootPath, ...append.relativePath.split('/'));
  const stat = lstatOrNull(filePath);
  if (!stat) {
    if (append.existedBefore) {
      integrity(`Pre-existing append log disappeared: ${append.relativePath}`);
    }
    return { exists: false, tailLength: 0 };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`Append-log target is unsafe: ${append.relativePath}`);
  }
  if (stat.size < append.beforeLength) {
    integrity(`Append-log prefix was truncated: ${append.relativePath}`);
  }
  if (
    hashFilePrefix(filePath, append.beforeLength) !== append.beforePrefixSha256
  ) {
    integrity(`Append-log prefix changed: ${append.relativePath}`);
  }
  const tailLength = stat.size - append.beforeLength;
  if (allowUnknownTail) return { exists: true, tailLength };
  if (tailLength > append.appendBytes.length) {
    integrity(
      `Append log has bytes beyond the transaction: ${append.relativePath}`,
    );
  }
  if (tailLength > 0) {
    const descriptor = openSync(filePath, 'r');
    try {
      const tail = Buffer.allocUnsafe(tailLength);
      let read = 0;
      while (read < tailLength) {
        const count = readSync(
          descriptor,
          tail,
          read,
          tailLength - read,
          append.beforeLength + read,
        );
        if (count === 0)
          integrity(`Short append-log tail read: ${append.relativePath}`);
        read += count;
      }
      if (!append.appendBytes.subarray(0, tailLength).equals(tail)) {
        integrity(
          `Append-log tail is not the declared prefix: ${append.relativePath}`,
        );
      }
    } finally {
      closeSync(descriptor);
    }
  }
  return { exists: true, tailLength };
}

function allowedCreateEntries(transaction: LoadedTransaction): Set<string> {
  const allowed = new Set<string>();
  const addPath = (relativePath: string) => {
    const segments = relativePath.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      allowed.add(segments.slice(0, index + 1).join('/'));
    }
  };
  for (const file of transaction.files) {
    addPath(file.relativePath);
    addPath(
      transactionTempRelativePath(
        transaction.handle.transactionId,
        file.relativePath,
      ),
    );
  }
  if (transaction.append) addPath(transaction.append.relativePath);
  return allowed;
}

function assertCreateRootHasOnlyDeclaredEntries(
  transaction: LoadedTransaction,
  rootPath: string,
): void {
  const allowed = allowedCreateEntries(transaction);
  const visit = (directoryPath: string, prefix: string): void => {
    for (const name of readdirSync(directoryPath)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!allowed.has(relative)) {
        integrity(`Create transaction found an unexpected entry: ${relative}`);
      }
      const fullPath = path.join(directoryPath, name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        integrity(`Create transaction found a symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) visit(fullPath, relative);
      else if (!stat.isFile())
        integrity(`Create transaction found a special file: ${relative}`);
    }
  };
  visit(rootPath, '');
}

function preflight(
  transaction: LoadedTransaction,
  allowMissingQuarantine = false,
): DirectoryState {
  const directoryState = inspectDirectoryState(
    transaction.handle,
    transaction.manifest.directory,
    allowMissingQuarantine,
  );
  if (directoryState.kind === 'quarantine') return directoryState;
  if (directoryState.kind === 'root' && !directoryState.present) {
    if (transaction.manifest.directory.kind !== 'create') {
      integrity('Disk transaction Space root is missing');
    }
    return directoryState;
  }
  const rootPath = directoryState.rootPath;
  if (
    transaction.manifest.directory.kind === 'create' &&
    transaction.manifest.recoveryMode === 'undo-redo'
  ) {
    assertCreateRootHasOnlyDeclaredEntries(transaction, rootPath);
  }
  for (const file of transaction.files) {
    const actual = readTargetBytes(rootPath, file.relativePath);
    if (transaction.manifest.recoveryMode === 'undo-redo') {
      assertBytesState(
        actual,
        file.beforeBytes,
        file.afterBytes,
        file.relativePath,
      );
    }
    assertTempSafe(
      rootPath,
      transaction.handle.transactionId,
      file.relativePath,
    );
  }
  if (transaction.append) {
    readAppendTail(
      rootPath,
      transaction.append,
      transaction.manifest.recoveryMode === 'undo-only',
    );
  }
  return directoryState;
}

function ensureSafeParents(rootPath: string, relativePath: string): void {
  const segments = relativePath.split('/').slice(0, -1);
  let current = rootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) mkdirSync(current);
    else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      integrity(`Disk transaction parent is unsafe: ${current}`);
    }
  }
}

function removeIfPresent(filePath: string): void {
  const stat = lstatOrNull(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    integrity(`Disk transaction cannot remove unsafe target: ${filePath}`);
  }
  unlinkSync(filePath);
}

function installTargetBytes(
  transactionId: string,
  rootPath: string,
  relativePath: string,
  bytes: Buffer | null,
): void {
  ensureSafeParents(rootPath, relativePath);
  const targetPath = path.join(rootPath, ...relativePath.split('/'));
  const tempRelative = transactionTempRelativePath(transactionId, relativePath);
  const tempPath = path.join(rootPath, ...tempRelative.split('/'));
  removeIfPresent(tempPath);
  if (bytes === null) {
    removeIfPresent(targetPath);
    return;
  }
  const actual = readTargetBytes(rootPath, relativePath);
  if (actual?.equals(bytes)) return;
  writeFileSync(tempPath, bytes, { flag: 'wx' });
  renameOverWithRetrySync(tempPath, targetPath);
}

function transitionAppend(
  rootPath: string,
  append: LoadedAppend,
  direction: Direction,
  allowUnknownTail = false,
): void {
  const filePath = path.join(rootPath, ...append.relativePath.split('/'));
  const current = readAppendTail(rootPath, append, allowUnknownTail);
  if (direction === 'undo') {
    if (!current.exists) return;
    const descriptor = openSync(filePath, 'r+');
    try {
      ftruncateSync(descriptor, append.beforeLength);
    } finally {
      closeSync(descriptor);
    }
    if (!append.existedBefore) unlinkSync(filePath);
    return;
  }
  if (current.exists && current.tailLength === append.appendBytes.length) {
    return;
  }
  ensureSafeParents(rootPath, append.relativePath);
  if (current.exists) {
    const descriptor = openSync(filePath, 'r+');
    try {
      ftruncateSync(descriptor, append.beforeLength);
    } finally {
      closeSync(descriptor);
    }
  }
  appendFileSync(filePath, append.appendBytes);
}

function removeMissingParents(
  rootPath: string,
  transaction: LoadedTransaction,
): void {
  const parents = new Set<string>();
  for (const file of transaction.files) {
    for (const parent of file.missingParentsBefore) parents.add(parent);
  }
  if (transaction.append) {
    for (const parent of transaction.append.missingParentsBefore) {
      parents.add(parent);
    }
  }
  const deepestFirst = [...parents].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  );
  for (const relative of deepestFirst) {
    const directoryPath = path.join(rootPath, ...relative.split('/'));
    const stat = lstatOrNull(directoryPath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      integrity(`Cannot clean unsafe transaction parent: ${directoryPath}`);
    }
    if (readdirSync(directoryPath).length === 0) {
      rmSync(directoryPath, { recursive: true, force: false });
    }
  }
}

function renameRoot(workspacePath: string, from: string, to: string): void {
  renameSync(path.join(workspacePath, from), path.join(workspacePath, to));
}

function transition(
  transaction: LoadedTransaction,
  direction: Direction,
  allowMissingQuarantine = false,
): void {
  let state = preflight(transaction, allowMissingQuarantine);
  const directory = transaction.manifest.directory;
  if (directory.kind === 'quarantine') {
    if (state.kind !== 'quarantine') integrity('Invalid quarantine state');
    if (state.location === 'missing') return;
    if (direction === 'redo' && state.location === 'live') {
      renameSync(
        state.rootPath as string,
        path.join(transaction.handle.directoryPath, QUARANTINE_DIRECTORY),
      );
    } else if (direction === 'undo' && state.location === 'quarantine') {
      renameSync(
        state.rootPath as string,
        path.join(transaction.handle.workspacePath, directory.rootRelativePath),
      );
    }
    return;
  }

  if (
    direction === 'undo' &&
    directory.kind === 'create' &&
    transaction.manifest.recoveryMode === 'undo-only'
  ) {
    if (state.kind === 'root' && state.present) {
      rmSync(state.rootPath, { recursive: true, force: false });
    }
    return;
  }

  if (directory.kind === 'create' && state.kind === 'root' && !state.present) {
    if (direction === 'undo') return;
    mkdirSync(state.rootPath);
    state = { ...state, present: true };
  }
  if (state.kind === 'root' && !state.present) {
    integrity('Disk transaction Space root is missing');
  }
  if (state.kind === 'quarantine') {
    integrity('Unexpected quarantine state for a file transaction');
  }

  if (
    direction === 'undo' &&
    directory.kind === 'rename' &&
    state.kind === 'rename' &&
    state.location === 'after'
  ) {
    renameRoot(
      transaction.handle.workspacePath,
      directory.afterRootRelativePath,
      directory.beforeRootRelativePath,
    );
    state = {
      kind: 'rename',
      location: 'before',
      rootPath: path.join(
        transaction.handle.workspacePath,
        directory.beforeRootRelativePath,
      ),
    };
  }
  const rootPath = state.rootPath;
  for (const file of transaction.files) {
    installTargetBytes(
      transaction.handle.transactionId,
      rootPath,
      file.relativePath,
      direction === 'redo' ? file.afterBytes : file.beforeBytes,
    );
  }
  if (transaction.append) {
    transitionAppend(
      rootPath,
      transaction.append,
      direction,
      transaction.manifest.recoveryMode === 'undo-only',
    );
  }
  if (direction === 'undo') removeMissingParents(rootPath, transaction);

  if (
    direction === 'redo' &&
    directory.kind === 'rename' &&
    state.kind === 'rename' &&
    state.location === 'before'
  ) {
    renameRoot(
      transaction.handle.workspacePath,
      directory.beforeRootRelativePath,
      directory.afterRootRelativePath,
    );
  }
  if (direction === 'undo' && directory.kind === 'create') {
    const stat = lstatOrNull(rootPath);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        integrity(`Created Space root became unsafe: ${rootPath}`);
      }
      if (readdirSync(rootPath).length !== 0) {
        integrity(
          `Created Space root contains unexpected entries: ${rootPath}`,
        );
      }
      rmSync(rootPath, { recursive: true, force: false });
    }
  }
}

/** Idempotently install the after-state of a prepared transaction. */
export function applyPreparedDiskTransaction(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (transaction.manifest.recoveryMode === 'undo-only') {
    throw new TypeError(
      'An undo-only Disk journal cannot apply an after-state',
    );
  }
  transition(transaction, 'redo');
}

function verifyDirectionState(
  transaction: LoadedTransaction,
  direction: Direction,
): void {
  const state = preflight(transaction);
  const directory = transaction.manifest.directory;
  if (directory.kind === 'quarantine') {
    if (
      state.kind !== 'quarantine' ||
      state.location !== (direction === 'redo' ? 'quarantine' : 'live')
    ) {
      integrity('Quarantine transaction is not in the requested state');
    }
    return;
  }
  if (directory.kind === 'create') {
    if (state.kind !== 'root' || state.present !== (direction === 'redo')) {
      integrity('Create transaction is not in the requested state');
    }
    if (direction === 'undo') return;
  }
  if (directory.kind === 'rename') {
    if (
      state.kind !== 'rename' ||
      state.location !== (direction === 'redo' ? 'after' : 'before')
    ) {
      integrity('Rename transaction is not in the requested state');
    }
  }
  if (state.kind === 'root' && !state.present) {
    integrity('Disk transaction Space root is missing');
  }
  if (state.kind === 'quarantine') {
    integrity('Unexpected quarantine state for a file transaction');
  }
  const rootPath = state.rootPath;
  for (const file of transaction.files) {
    const actual = readTargetBytes(rootPath, file.relativePath);
    const expected = direction === 'redo' ? file.afterBytes : file.beforeBytes;
    const matches =
      actual === null ? expected === null : expected?.equals(actual);
    if (!matches)
      integrity(
        `Disk transaction target is not complete: ${file.relativePath}`,
      );
  }
  if (transaction.append) {
    const current = readAppendTail(rootPath, transaction.append);
    if (direction === 'redo') {
      if (
        !current.exists ||
        current.tailLength !== transaction.append.appendBytes.length
      ) {
        integrity('Disk transaction append is not complete');
      }
    } else if (
      current.tailLength !== 0 ||
      current.exists !== transaction.append.existedBefore
    ) {
      integrity('Disk transaction append was not rolled back');
    }
  }
}

/**
 * Prove that an uncommitted deterministic journal has not changed any live
 * target yet. Callers can use this immediately before their first mutation;
 * unlike rollback, validation never installs or removes live bytes.
 */
export function validatePreparedDiskTransactionUnapplied(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (transaction.committed) {
    integrity('Cannot validate a committed Disk transaction as unapplied');
  }
  if (transaction.manifest.recoveryMode !== 'undo-redo') {
    throw new TypeError(
      'An undo-only Disk journal has no deterministic unapplied state',
    );
  }
  verifyDirectionState(transaction, 'undo');
}

function writeCommittedMarker(transaction: LoadedTransaction): void {
  const markerPath = path.join(
    transaction.handle.directoryPath,
    COMMITTED_FILENAME,
  );
  const tempPath = path.join(
    transaction.handle.directoryPath,
    COMMITTED_TEMP_FILENAME,
  );
  removeIfPresent(tempPath);
  const marker = {
    version: DISK_TRANSACTION_MANIFEST_VERSION,
    transactionId: transaction.handle.transactionId,
    manifestSha256: transaction.manifestSha256,
  };
  writeFileSync(tempPath, `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  renameSync(tempPath, markerPath);
}

/** Publish the commit decision after the complete after-state is observable. */
export function markPreparedDiskTransactionCommitted(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (transaction.committed) return;
  if (transaction.manifest.recoveryMode === 'undo-redo') {
    verifyDirectionState(transaction, 'redo');
  } else {
    // Bytes are intentionally opaque, but the declared root, paths, and
    // append-only prefix still have to be structurally safe before commit.
    preflight(transaction);
  }
  writeCommittedMarker(transaction);
}

/** Resolve an injected/ambiguous marker error against the durable decision. */
export function isPreparedDiskTransactionCommitted(
  handle: PreparedDiskTransaction,
): boolean {
  return loadTransaction(handle).committed;
}

function cleanJournalDirectory(
  handle: PreparedDiskTransaction,
  prefix: '.done-' | '.aborted-',
): void {
  const destination = path.join(
    workspaceTransactionsDir(handle.workspacePath),
    `${prefix}${handle.transactionId}`,
  );
  renameSync(handle.directoryPath, destination);
  rmSync(destination, { recursive: true, force: false });
}

/** Undo an uncommitted transaction and remove its journal. */
export function abortPreparedDiskTransaction(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (transaction.committed) {
    integrity('Cannot abort a committed Disk transaction');
  }
  transition(transaction, 'undo');
  verifyDirectionState(transaction, 'undo');
  cleanJournalDirectory(transaction.handle, '.aborted-');
}

/**
 * Remove an uncommitted journal after the caller has proved that no declared
 * target was mutated. Unlike {@link abortPreparedDiskTransaction}, this does
 * not replay the captured before-state: that distinction prevents a
 * just-arrived external file from being mistaken for transaction output and
 * deleted while cancelling a stale filename plan.
 */
export function discardUnappliedDiskTransaction(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (transaction.committed) {
    integrity('Cannot discard a committed Disk transaction');
  }
  cleanJournalDirectory(transaction.handle, '.aborted-');
}

/** Verify and remove a committed transaction (and a quarantined Space). */
export function finalizeCommittedDiskTransaction(
  handle: PreparedDiskTransaction,
): void {
  const transaction = loadTransaction(handle);
  if (!transaction.committed) {
    integrity('Cannot finalize an uncommitted Disk transaction');
  }
  if (transaction.manifest.recoveryMode === 'undo-redo') {
    verifyDirectionState(transaction, 'redo');
  }
  cleanJournalDirectory(transaction.handle, '.done-');
}

/**
 * Finalize a durable commit decision without changing its business outcome.
 *
 * Once `COMMITTED` exists, rollback is no longer legal. Cleanup is therefore
 * maintenance: try the caller's finalizer first, then the normal recovery
 * path while the Workspace transaction gate is still held. Persistent
 * cleanup errors are retried when the next writer enters that gate and must
 * not make the already-committed operation report failure.
 */
export function finalizeCommittedDiskTransactionBestEffort(
  handle: PreparedDiskTransaction,
  finalize: (
    handle: PreparedDiskTransaction,
  ) => void = finalizeCommittedDiskTransaction,
): void {
  try {
    finalize(handle);
    return;
  } catch {
    // Fall through to the idempotent recovery path. It also handles a
    // finalizer that renamed the journal to `.done-*` before failing removal.
  }
  try {
    recoverDiskTransactions(handle.workspacePath);
  } catch {
    // The next Workspace-gated writer retries recovery. The durable commit is
    // still the authoritative outcome, so cleanup cannot be surfaced as an
    // operation failure here.
  }
}

interface RecoveryEntry {
  readonly name: string;
  readonly kind: 'active' | 'building' | 'done' | 'aborted';
  readonly transactionId: string;
}

function parseRecoveryEntry(name: string): RecoveryEntry {
  for (const [prefix, kind] of [
    ['.building-', 'building'],
    ['.done-', 'done'],
    ['.aborted-', 'aborted'],
  ] as const) {
    if (name.startsWith(prefix)) {
      return {
        name,
        kind,
        transactionId: assertTransactionId(name.slice(prefix.length)),
      };
    }
  }
  return { name, kind: 'active', transactionId: assertTransactionId(name) };
}

/**
 * Recover every journal before migrations or any storage adapter opens the
 * Workspace. Unexpected metadata or live bytes block activation.
 */
export function recoverDiskTransactions(workspacePath: string): void {
  const workspace = assertAbsoluteWorkspace(workspacePath);
  const transactionsPath = existingMetadataDirectories(workspace);
  if (!transactionsPath) return;
  const entries = readdirSync(transactionsPath).map(parseRecoveryEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.transactionId)) {
      integrity(
        `Conflicting Disk transaction journal entries: ${entry.transactionId}`,
      );
    }
    ids.add(entry.transactionId);
    assertRealDirectory(
      path.join(transactionsPath, entry.name),
      'Disk transaction journal entry',
    );
  }
  for (const entry of entries
    .filter((candidate) => candidate.kind !== 'active')
    .sort((left, right) => left.name.localeCompare(right.name))) {
    rmSync(path.join(transactionsPath, entry.name), {
      recursive: true,
      force: false,
    });
  }
  const active = entries
    .filter((candidate) => candidate.kind === 'active')
    .sort((left, right) => left.name.localeCompare(right.name));
  if (active.length > 1) {
    integrity('Workspace has multiple outstanding Disk transactions');
  }
  for (const entry of active) {
    const transaction = loadTransaction(
      preparedHandle(workspace, entry.transactionId),
    );
    if (transaction.committed) {
      if (transaction.manifest.recoveryMode === 'undo-redo') {
        transition(transaction, 'redo', true);
        if (transaction.manifest.directory.kind !== 'quarantine') {
          verifyDirectionState(transaction, 'redo');
        }
      }
      cleanJournalDirectory(transaction.handle, '.done-');
    } else {
      transition(transaction, 'undo');
      verifyDirectionState(transaction, 'undo');
      cleanJournalDirectory(transaction.handle, '.aborted-');
    }
  }
}
