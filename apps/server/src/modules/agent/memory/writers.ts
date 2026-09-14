// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory writers — minimal disk primitives.
 *
 * Two operations, one shape:
 *
 *   - {@link overwriteMemoryFile}        — write the supplied body verbatim,
 *                                          creating the file if needed.
 *   - {@link replaceStringInMemoryFile}  — substitute a single
 *                                          unique substring (Claude
 *                                          Code style edit).
 *
 * Both take a {@link MemoryDocument} — where the bytes live, resolved by the
 * caller (currently `tools/handlers/fs-write.ts`), which owns the tier
 * mapping. The indirection exists because the tiers no longer share a
 * substrate: the Workspace-scoped ones are files, while a Space's memory body
 * is a blob under its own scope (proposal §6.4.3, disposition D). Everything
 * below is rules about the *content*, so none of it should know which.
 *
 * The `tier` knob is purely for behaviour that varies by destination:
 *
 *   - cap enforcement (workspace + canvas only — skill bodies are
 *     allowed to grow larger)
 *   - post-write cache invalidation (user skill loader caches
 *     SKILL.md by id and needs to drop the entry after a write)
 *
 * Write serialisation is deliberately *not* one of them. Every writer below
 * is a read-modify-write whose halves are both awaited, so what has to be
 * serialised is one document against itself — see {@link MemoryDocument.key}.
 *
 * Failures never throw past this boundary — each writer returns a
 * structured {@link WriteResult} so the sub-agent (and the worker's
 * summary log) can reason about partial success.
 */

import { existsSync, readFileSync } from 'node:fs';

import { MemorySandboxError } from './sandbox.js';
import { invalidateUserSkill } from '../../../prompt/index.js';
import { atomicWriteText, mkdirp } from '../../../utils/fs.js';
import { createKeyedMutex } from '../../../utils/keyed-mutex.js';

import type { MemoryLogger } from './index.js';
import type { BlobScope } from '../../storage/index.js';

// ─── Where a document lives ────────────────────────────────────────────────

/**
 * One memory document, addressed however its tier stores it.
 *
 * `target` is what a {@link WriteResult} names, so it is the caller's own
 * vocabulary rather than a physical location — an agent that reads
 * `memory/space.md` should see that spelling back, not wherever the bytes
 * happen to sit.
 */
export interface MemoryDocument {
  readonly target: string;
  /**
   * Stable identity of the bytes, for write serialisation.
   *
   * Deliberately not `target`: that is the caller's vocabulary, and every
   * Space calls its body `memory/space.md`. Serialising on it would make
   * unrelated Spaces wait on each other and still not tell two of them apart.
   */
  readonly key: string;
  read(): Promise<string | null>;
  write(body: string): Promise<void>;
}

/** A document that is a real file — the Workspace-scoped tiers. */
export function fileDocument(
  absPath: string,
  parentDir: string,
): MemoryDocument {
  return {
    target: absPath,
    key: absPath,
    async read(): Promise<string | null> {
      return existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
    },
    async write(body: string): Promise<void> {
      mkdirp(parentDir);
      atomicWriteText(absPath, body);
    },
  };
}

/** A document that is a blob — a Space's memory body. */
export function blobDocument(
  scope: BlobScope,
  name: string,
  target: string,
  /** The Space that owns `scope`; its identity, not its display name. */
  canvasId: string,
): MemoryDocument {
  return {
    target,
    key: `space:${canvasId}/${name}`,
    async read(): Promise<string | null> {
      const bytes = await scope.read(name);
      return bytes === null ? null : bytes.toString('utf8');
    },
    async write(body: string): Promise<void> {
      await scope.put(name, Buffer.from(body, 'utf8'));
    },
  };
}

// ─── Concurrency guards ────────────────────────────────────────────────────
//
// Both writers read a document, compute a new body, and write it back, and
// every step is awaited. Two concurrent edits therefore interleave: each
// reads the same body, and the later write silently discards the earlier
// one while both report success. The workspace body is shared by curators
// from every Space and by the ask / operate chat agents; a Space's body is
// reachable by two of its own agent turns at once. Neither is a tier
// property, so the lock is keyed by the document rather than the tier —
// unrelated documents never wait on each other.
const memoryDocumentLock = createKeyedMutex();

export interface WriteResult {
  ok: boolean;
  /** Absolute path the writer targeted (resolved through the sandbox). */
  target: string;
  /** Short, agent-readable reason — populated on both success and reject. */
  reason: string;
}

/**
 * Memory destination. Drives cap enforcement, locking, and post-write
 * cache invalidation — paths themselves are resolved by the caller.
 */
export type MemoryTier = 'workspace' | 'canvas' | 'skill';

/** Body cap for `'workspace'` + `'canvas'` tiers; skills are uncapped. */
export const MEMORY_BYTE_CAP = 4 * 1024;
export const MEMORY_LINE_CAP = 80;

/** Minimum rationale length when creating a new user skill. */
export const SKILL_CREATE_RATIONALE_MIN = 20;

interface CommonArgs {
  tier: MemoryTier;
  /** Where the bytes live, already sandbox-validated by the caller. */
  document: MemoryDocument;
  /**
   * Required when `tier === 'skill'` — used to invalidate the user
   * skill loader cache after a successful write. Ignored otherwise.
   */
  skillId?: string;
  logger?: MemoryLogger;
}

// ─── overwrite ─────────────────────────────────────────────────────────────

export interface OverwriteArgs extends CommonArgs {
  /** Wholesale file contents. A trailing newline is added if absent. */
  body: string;
}

/**
 * Write `body` to `absPath`, creating the file (and `parentDir`) if
 * needed. Cap-enforced for workspace + canvas; skill writes are
 * uncapped. Serialised against concurrent writes to the same document.
 */
export async function overwriteMemoryFile(
  args: OverwriteArgs,
): Promise<WriteResult> {
  return runForDocument(args.document, () => doOverwrite(args));
}

async function doOverwrite(args: OverwriteArgs): Promise<WriteResult> {
  const { target } = args.document;
  try {
    const body = ensureTrailingNewline(args.body);
    if (args.tier !== 'skill') {
      const capCheck = checkCap(body);
      if (!capCheck.ok) return reject(target, capCheck.reason);
    }
    await args.document.write(body);
    if (args.tier === 'skill' && args.skillId) {
      invalidateUserSkill(args.skillId);
    }
    args.logger?.info(
      `[memory] ${args.tier} overwritten at ${target} (${body.length} bytes)`,
    );
    return { ok: true, target, reason: 'overwritten' };
  } catch (err) {
    return rejectFromError(err, target);
  }
}

// ─── replace_string ────────────────────────────────────────────────────────

export interface ReplaceStringArgs extends CommonArgs {
  /** Substring to find; must appear in the file exactly once. */
  oldString: string;
  /** Replacement substring. */
  newString: string;
}

/**
 * Replace exactly one occurrence of `oldString` with `newString` in
 * the file at `absPath`. Rejects on missing file, zero or multiple
 * matches, or post-edit cap overflow (for workspace + canvas).
 *
 * The "exactly once" rule is the safety contract: ambiguity is the
 * agent's problem to disambiguate by adding more context, not the
 * writer's to guess.
 */
export async function replaceStringInMemoryFile(
  args: ReplaceStringArgs,
): Promise<WriteResult> {
  return runForDocument(args.document, () => doReplaceString(args));
}

async function doReplaceString(args: ReplaceStringArgs): Promise<WriteResult> {
  const { target } = args.document;
  try {
    if (typeof args.oldString !== 'string' || args.oldString.length === 0) {
      return reject(target, 'oldString is required and non-empty');
    }
    if (typeof args.newString !== 'string') {
      return reject(target, 'newString is required (use "" to delete)');
    }
    if (args.oldString === args.newString) {
      return reject(target, 'oldString and newString are identical');
    }
    const before = await args.document.read();
    if (before === null) {
      return reject(
        target,
        `file does not exist — use mode="overwrite" to create it`,
      );
    }
    const idx = before.indexOf(args.oldString);
    if (idx === -1) {
      return reject(target, 'oldString not found in file — no edit applied');
    }
    if (before.indexOf(args.oldString, idx + 1) !== -1) {
      return reject(
        target,
        'oldString matches multiple times — add more surrounding context to make it unique',
      );
    }
    const after = ensureTrailingNewline(
      before.slice(0, idx) +
        args.newString +
        before.slice(idx + args.oldString.length),
    );
    if (args.tier !== 'skill') {
      const capCheck = checkCap(after);
      if (!capCheck.ok) return reject(target, capCheck.reason);
    }
    await args.document.write(after);
    if (args.tier === 'skill' && args.skillId) {
      invalidateUserSkill(args.skillId);
    }
    args.logger?.info(
      `[memory] ${args.tier} edited at ${target} (${after.length} bytes)`,
    );
    return { ok: true, target, reason: 'edited' };
  } catch (err) {
    return rejectFromError(err, target);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Serialise a write against other writes to the same document. Returns a
 * Promise either way so callers can `await` uniformly.
 */
function runForDocument<T>(
  document: MemoryDocument,
  fn: () => T | Promise<T>,
): Promise<T> {
  return memoryDocumentLock(document.key, fn);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

function checkCap(s: string): { ok: true } | { ok: false; reason: string } {
  if (Buffer.byteLength(s, 'utf8') > MEMORY_BYTE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${MEMORY_BYTE_CAP} bytes; distil and retry`,
    };
  }
  const lines = s.split('\n').length;
  if (lines > MEMORY_LINE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${MEMORY_LINE_CAP} lines; distil and retry`,
    };
  }
  return { ok: true };
}

function reject(target: string, reason: string): WriteResult {
  return { ok: false, target, reason };
}

function rejectFromError(err: unknown, target: string): WriteResult {
  if (err instanceof MemorySandboxError) {
    return reject(target, err.message);
  }
  return reject(target, (err as Error).message);
}
