import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ensureResourceLayout, resourceSubdirPath } from './resource-dir.js';

/** Current `ResourceReceipt` schema version. */
export const RECEIPT_SCHEMA_VERSION = 2 as const;

export type ResourceKind = 'skill' | 'tool' | 'connector';

const RESOURCE_KINDS: readonly ResourceKind[] = ['skill', 'tool', 'connector'];

/** Same identifier convention as the Agenetes resource catalogue: stable, kebab-case. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A machine-owned installation and validation record for one local resource
 * (Skill, CLI tool, or connector bundle) placed under `AGENT_RESOURCE_DIR`.
 *
 * This is Agentlet-local bookkeeping, distinct from and never synchronized
 * field-for-field with the Agenetes `AgentResource` catalogue record;
 * `catalogue.ts` projects the subset of these fields that are safe to
 * publish.
 */
export interface ResourceReceipt {
  schemaVersion: 2;
  /** Stable, globally unique, kebab-case identifier shared with the catalogue projection. */
  id: string;
  kind: ResourceKind;
  name: string;
  /** Stable authority ID: `huabu` or the exact Agentlet machine ID. */
  provider: string;
  /** Source-owned agent-readable text, normally the imported SKILL.md. */
  sourceContent: string;
  /** Path to the validated entrypoint, relative to the resource root. Must resolve inside the root. */
  entrypoint: string;
  /** Optional install provenance (URL, package spec, commit) recorded for audit; never a secret. */
  source?: string;
  /** Content revision computed by Agentlet from the imported source tree. */
  sourceRevision?: string;
  /** ISO-8601 timestamp of the installation or last validation. */
  installedAt: string;
}

export type ResourceReceiptInput = Omit<ResourceReceipt, 'schemaVersion'>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Assert that `candidatePath` resolves inside `root`, rejecting `..`
 * traversal and absolute paths that escape the resource root. Returns the
 * resolved absolute path on success.
 */
export function assertInsideResourceRoot(root: string, candidatePath: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(resolvedRoot, candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must stay within ${resolvedRoot} (got: ${candidatePath})`);
  }
  if (!existsSync(resolvedCandidate)) {
    throw new Error(`${label} does not exist`);
  }
  const realRoot = realpathSync(resolvedRoot);
  const realCandidate = realpathSync(resolvedCandidate);
  const realRelative = relative(realRoot, realCandidate);
  if (
    realRelative === '' ||
    realRelative.startsWith('..') ||
    isAbsolute(realRelative)
  ) {
    throw new Error(`${label} must not escape the resource root through a symbolic link`);
  }
  return resolvedCandidate;
}

function assertValidId(id: unknown): asserts id is string {
  if (!isNonEmptyString(id) || !KEBAB_CASE.test(id)) {
    throw new Error(`Resource receipt id must be a stable kebab-case identifier: ${JSON.stringify(id)}`);
  }
}

/**
 * Validate an untyped value as a versioned `ResourceReceipt` and confirm its
 * declared entrypoint resolves inside the given resource root.
 *
 * An unsupported or missing `schemaVersion` fails explicitly rather than
 * being coerced, matching the catalogue's versioning contract.
 */
export function parseReceipt(value: unknown, root: string): ResourceReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Resource receipt must be a JSON object');
  }
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== RECEIPT_SCHEMA_VERSION && record.schemaVersion !== 1) {
    throw new Error(`Unsupported resource receipt schemaVersion: ${JSON.stringify(record.schemaVersion)}`);
  }
  assertValidId(record.id);
  if (
    typeof record.kind !== 'string' ||
    !RESOURCE_KINDS.includes(record.kind as ResourceKind)
  ) {
    throw new Error(`Resource receipt kind must be one of ${RESOURCE_KINDS.join(', ')}: got ${JSON.stringify(record.kind)}`);
  }
  for (const field of ['name', 'provider', 'entrypoint', 'installedAt'] as const) {
    if (!isNonEmptyString(record[field])) {
      throw new Error(`Resource receipt field "${field}" must be a non-empty string`);
    }
  }
  if (record.source !== undefined && !isNonEmptyString(record.source)) {
    throw new Error('Resource receipt field "source" must be a non-empty string when present');
  }
  if (record.sourceRevision !== undefined && !isNonEmptyString(record.sourceRevision)) {
    throw new Error('Resource receipt field "sourceRevision" must be a non-empty string when present');
  }

  const sourceContent =
    record.schemaVersion === 1
      ? [record.description, record.instructions].filter(isNonEmptyString).join('\n\n')
      : record.sourceContent;
  if (!isNonEmptyString(sourceContent)) {
    throw new Error('Resource receipt field "sourceContent" must be a non-empty string');
  }

  // Reject a receipt that claims an entrypoint outside the resource root it is stored under.
  assertInsideResourceRoot(root, record.entrypoint as string, `Receipt "${record.id}" entrypoint`);

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    id: record.id,
    kind: record.kind as ResourceKind,
    name: record.name as string,
    provider: record.provider as string,
    sourceContent,
    entrypoint: record.entrypoint as string,
    source: record.source as string | undefined,
    sourceRevision: record.sourceRevision as string | undefined,
    installedAt: record.installedAt as string,
  };
}

function receiptFilePath(root: string, id: string): string {
  assertValidId(id);
  return join(resourceSubdirPath(root, 'receipts'), `${id}.json`);
}

/** Read and validate one persisted receipt by resource ID. Returns `undefined` if absent. */
export function readReceipt(root: string, id: string): ResourceReceipt | undefined {
  const path = receiptFilePath(root, id);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  return parseReceipt(JSON.parse(raw), root);
}

/**
 * Persist one validated receipt atomically: the bounded resource layout is
 * ensured, the payload is written to a temporary file in the same
 * directory, and then renamed over the final path so a concurrent reader
 * never observes a partially written file.
 */
export function writeReceipt(root: string, input: ResourceReceiptInput): ResourceReceipt {
  const receipt = parseReceipt({ ...input, schemaVersion: RECEIPT_SCHEMA_VERSION }, root);
  ensureResourceLayout(root);
  const finalPath = join(resourceSubdirPath(root, 'receipts'), `${receipt.id}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, finalPath);
  try {
    chmodSync(finalPath, 0o600);
  } catch {
    // POSIX permissions are best-effort on platforms that support them.
  }
  return receipt;
}

/** Remove a persisted receipt, if present. Idempotent. */
export function removeReceipt(root: string, id: string): void {
  const path = receiptFilePath(root, id);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
