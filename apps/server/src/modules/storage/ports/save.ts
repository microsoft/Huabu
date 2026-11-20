// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reliable save — what a Space keeps so a write can be retried safely.
 *
 * Two things ride along with the ordinary ordered write
 * ({@link SpaceHandle.write}):
 *
 * - a **result record** per (principal, request id): the response the caller
 *   was — or would have been — given. It is stored in the same commit as the
 *   state it describes, so a caller that lost the reply can ask again and be
 *   handed the same answer instead of applying the request twice;
 * - **version stamps** per node: the Space version at which each node was
 *   created and at which its membership (parent) last changed, and — when the
 *   write came from a browser page — which page made that change. They let a
 *   later write say "I read version N" and be checked against exactly the
 *   nodes it targets, without replaying history, and let a page's own
 *   earlier change not count as one it has not seen.
 *
 * Both are maintained inside every backend's write and are invisible to a
 * caller that never asks for them: a Space has no stamps until the first
 * {@link SpaceSave.stamps} call creates its baseline, and a write that carries
 * no result stores none.
 *
 * This file may not import a backend implementation.
 */

import { advanceNodeStamps } from '@huabu/shared/canvas-engine';

import { sanitizeId } from '../../../utils/fs.js';
import { stringifyJson } from '../../../utils/json.js';

import type { SpaceWriteInput, SpaceWriteReview } from './structured.js';
import type { NodeStamp, StampAuthor } from '@huabu/shared/canvas-engine';

export type { NodeStamp, StampAuthor };

/** Who asked, and the id they chose for the request. */
export interface SaveKey {
  readonly principalId: string;
  readonly operationId: string;
}

export interface SaveResult {
  readonly key: SaveKey;
  /** Hex SHA-256 of the request, so a reused id with another body is caught. */
  readonly digest: string;
  /** The response to hand back on a retry. Opaque JSON to storage. */
  readonly response: unknown;
}

export interface StoredSaveResult {
  readonly digest: string;
  readonly response: unknown;
  /** Space version the result was stored at. */
  readonly atVersion: number;
}

export interface SpaceStamps {
  /** UUID minted when the baseline is created. */
  readonly lineage: string;
  /** Head version when the baseline was created. */
  readonly floor: number;
  /** Current head version. */
  readonly version: number;
  /**
   * Sparse: an absent node means `{ created: floor, membership: floor }`.
   */
  readonly nodes: Readonly<Record<string, NodeStamp>>;
}

export type SaveRecordResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'result-exists';
      readonly stored: StoredSaveResult;
    }
  | {
      readonly ok: false;
      readonly reason: 'version-conflict';
      readonly actualVersion: number;
    };

export interface SpaceSave {
  /** The stored result for this key, or null. Never mutates the Space. */
  lookup(key: SaveKey): Promise<StoredSaveResult | null>;
  /**
   * The Space's current stamps.
   *
   * Idempotent; creates the baseline at the current head on first call.
   * `null` means the Space does not exist.
   */
  stamps(): Promise<SpaceStamps | null>;
  /**
   * Store a no-op / rejected outcome. The Space version does not move.
   *
   * Rejects with {@link SaveIdReusedError} when the key is already stored
   * with a different digest, and when the Space does not exist.
   */
  record(input: {
    readonly expectedVersion: number;
    readonly result: SaveResult;
  }): Promise<SaveRecordResult>;
}

/** The same key was already used for a request with a different digest. */
export class SaveIdReusedError extends Error {
  override name = 'SaveIdReusedError';
  readonly key: SaveKey;

  constructor(key: SaveKey) {
    super(
      `Request id ${JSON.stringify(key.operationId)} was already used for a different request`,
    );
    this.key = key;
  }
}

// ─── Rules shared by every backend ──────────────────────────────────────────

/** Largest serialized response a result record may hold. */
export const SAVE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** How long a result record is worth keeping for a retry. */
export const SAVE_RESULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Upper bound on result records removed by one opportunistic prune. */
export const SAVE_RESULT_PRUNE_LIMIT = 64;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINCIPAL_MAX_LENGTH = 256;

/** Reject a malformed key before it reaches a query or a filename. */
export function validateSaveKey(key: SaveKey): void {
  if (key === null || typeof key !== 'object') {
    throw new TypeError('Save key must be an object');
  }
  if (
    typeof key.principalId !== 'string' ||
    key.principalId.length === 0 ||
    key.principalId.length > PRINCIPAL_MAX_LENGTH
  ) {
    throw new TypeError('Save key principalId must be a non-empty string');
  }
  if (
    typeof key.operationId !== 'string' ||
    !UUID_PATTERN.test(key.operationId)
  ) {
    throw new TypeError('Save key operationId must be a UUID');
  }
}

/**
 * Validate one result record and return its serialized response.
 *
 * Returning the encoding keeps the size check and the stored bytes one value,
 * so a backend cannot store something other than what was measured.
 */
export function validateSaveResult(result: SaveResult): string {
  if (result === null || typeof result !== 'object') {
    throw new TypeError('Save result must be an object');
  }
  validateSaveKey(result.key);
  if (
    typeof result.digest !== 'string' ||
    !DIGEST_PATTERN.test(result.digest)
  ) {
    throw new TypeError('Save result digest must be a lowercase SHA-256 hex');
  }
  if (result.response === undefined) {
    throw new TypeError('Save result response must be a JSON value');
  }
  const responseJson = stringifyJson(result.response, 'Save result response');
  if (Buffer.byteLength(responseJson, 'utf8') > SAVE_RESPONSE_MAX_BYTES) {
    throw new TypeError(
      `Save result response exceeds ${SAVE_RESPONSE_MAX_BYTES} bytes`,
    );
  }
  return responseJson;
}

/**
 * Validate the result carried by a write, if any.
 *
 * @returns the serialized response, or null when the write carries no result.
 */
export function validateWriteSaveResult(input: SpaceWriteInput): string | null {
  if (input.result === undefined) return null;
  if (input.allowCreate === true) {
    throw new Error('A result record cannot accompany an implicit create');
  }
  return validateSaveResult(input.result);
}

/**
 * Validate the Review records carried by a write, if any.
 *
 * Shared so every backend refuses the same input before it touches anything:
 * a thread id that could not name a list, or records that are not plain JSON.
 *
 * @returns the entries to store; empty when the write carries none.
 */
export function validateWriteReviews(
  input: SpaceWriteInput,
): readonly SpaceWriteReview[] {
  if (input.reviews === undefined || input.reviews.length === 0) return [];
  if (input.allowCreate === true) {
    throw new Error('Review records cannot accompany an implicit create');
  }
  for (const review of input.reviews) {
    sanitizeId(review.threadId, 'threadId');
    if (!Array.isArray(review.records)) {
      throw new TypeError('Review records must be an array');
    }
    stringifyJson(
      review.records,
      `Changes for thread ${JSON.stringify(review.threadId)}`,
    );
  }
  return input.reviews;
}

const AUTHOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate the author carried by a write, if any.
 *
 * The key is stored in every stamp the write advances, so it is kept short
 * and free of anything that would need escaping.
 */
export function validateWriteAuthor(
  input: SpaceWriteInput,
): StampAuthor | undefined {
  const { author } = input;
  if (author === undefined) return undefined;
  if (
    author === null ||
    typeof author !== 'object' ||
    typeof author.by !== 'string' ||
    !AUTHOR_PATTERN.test(author.by)
  ) {
    throw new TypeError(
      'Write author must be 1-64 characters of [A-Za-z0-9_-]',
    );
  }
  return author;
}

/** Request ids compare case-insensitively, the way UUIDs do. */
export function normalizeSaveKey(key: SaveKey): SaveKey {
  validateSaveKey(key);
  return {
    principalId: key.principalId,
    operationId: key.operationId.toLowerCase(),
  };
}

/**
 * What a write or `record` must answer when its key is already stored.
 *
 * The same digest is the retry this whole mechanism exists for; a different
 * one is a caller reusing an id for another request, which must never be
 * answered with someone else's response.
 */
export function storedResultOutcome(
  stored: StoredSaveResult,
  result: SaveResult,
): { ok: false; reason: 'result-exists'; stored: StoredSaveResult } {
  if (stored.digest !== result.digest) throw new SaveIdReusedError(result.key);
  return { ok: false, reason: 'result-exists', stored };
}

// ─── Stamps ─────────────────────────────────────────────────────────────────

/**
 * Advance stamps across one committed write.
 *
 * Pure. A new id is stamped `{ to, to }`; an id whose `parentId` changed gets
 * `membership = to`; a removed id is dropped, so recreating it later stamps it
 * as new. A stamp set here names `author` as who made the change, or nobody
 * when the write has none. When nothing about node existence or membership
 * changed, the returned `nodes` is the very object passed in — a backend uses
 * that identity to skip persisting an unchanged map.
 */
export function advanceStamps(
  prev: SpaceStamps,
  prevNodes: readonly unknown[],
  nextNodes: readonly unknown[],
  toVersion: number,
  author?: StampAuthor,
): SpaceStamps {
  return {
    lineage: prev.lineage,
    floor: prev.floor,
    version: toVersion,
    nodes: advanceNodeStamps(prev, prevNodes, nextNodes, toVersion, author),
  };
}

/** Decode a persisted stamp map, refusing anything that is not one. */
export function parseNodeStamps(
  value: unknown,
  context: string,
): Record<string, NodeStamp> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is not a stamp map`);
  }
  const nodes: Record<string, NodeStamp> = {};
  for (const [id, stamp] of Object.entries(value)) {
    const { created, membership, createdBy, membershipBy } = (stamp ?? {}) as {
      created?: unknown;
      membership?: unknown;
      createdBy?: unknown;
      membershipBy?: unknown;
    };
    if (
      typeof created !== 'number' ||
      typeof membership !== 'number' ||
      !Number.isSafeInteger(created) ||
      !Number.isSafeInteger(membership) ||
      (createdBy !== undefined && typeof createdBy !== 'string') ||
      (membershipBy !== undefined && typeof membershipBy !== 'string')
    ) {
      throw new Error(
        `${context} holds an invalid stamp for ${JSON.stringify(id)}`,
      );
    }
    nodes[id] = {
      created,
      membership,
      ...(createdBy ? { createdBy } : {}),
      ...(membershipBy ? { membershipBy } : {}),
    };
  }
  return nodes;
}
