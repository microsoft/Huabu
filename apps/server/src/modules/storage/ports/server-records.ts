// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Server records port — state the Server keeps about itself and the people
 * using it, owned by no Workspace.
 *
 * Saved credentials, model and agent settings, Agent Profiles, device
 * ownership, and device credential versions belong to the deployment or to
 * one person, never to a Workspace, so neither the structured store (bound to
 * the active Workspace) nor the blob store (bytes) answers for them. They are
 * served by the configured *structured* backend all the same: on a database
 * profile they are rows beside the Workspace records, so a deployment whose
 * records and bytes are remote keeps nothing durable on the Server's disk
 * (docs/proposals/server-records.md).
 *
 * A record is one JSON document. Owners replace it whole and never delete it,
 * so "absent" always means "never written".
 *
 * This file may not import a backend implementation.
 */

import type { StructuredBackendKind } from './structured.js';

/**
 * Every record a Server keeps, and whether a member may hold a personal
 * copy. Closed on purpose: the Disk adapter maps each name to its historical
 * file, and an unknown name is a programming error rather than a new file.
 */
export const SERVER_RECORDS = {
  /** The encrypted credential envelope (`security/encrypted-secret-store.ts`). Personal credentials are entries inside it. */
  credentials: { personal: false },
  /** Model provider, image, and utility settings (`agent/llm.ts`). */
  'model-settings': { personal: true },
  /** The Utility Agent selection (`agent/agent-defaults.ts`). */
  'agent-defaults': { personal: true },
  /** Conversation change-review settings (`agent/change-review-config.ts`). */
  'change-review': { personal: true },
  /** External-agent idle timeout and process limit (`agent/acp/runtime-config.ts`). */
  'external-agent-runtime': { personal: true },
  /** Display names a person gave their devices (`agent/acp/device-names.ts`). */
  'device-names': { personal: true },
  /** `agentletId -> principalId`; a device's owner never changes (`identity/agent-credentials.ts`). */
  'device-owners': { personal: false },
  /** `principalId -> version`; a reset increments it and revokes older device credentials. */
  'agent-credential-versions': { personal: false },
  /** The local-mode Agent Profile registry. */
  'agent-profiles': { personal: false },
  /** The Bubble-mode Agent Profile registry; every member's Profiles, filtered by owner on read. */
  'user-agent-profiles': { personal: false },
} as const satisfies Record<string, { readonly personal: boolean }>;

export type ServerRecordName = keyof typeof SERVER_RECORDS;

export const SERVER_RECORD_NAMES = Object.freeze(
  Object.keys(SERVER_RECORDS) as ServerRecordName[],
);

/**
 * A person's record owner: the opaque 32-hex key `identity/personal-settings.ts`
 * derives from a principal id. Never the principal id itself, so no account
 * identifier becomes a path segment or a stored column value.
 */
const OWNER_KEY_PATTERN = /^[0-9a-f]{32}$/;

/** Whether `value` has the shape of a person's record owner key. */
export function isServerRecordOwner(value: string): boolean {
  return OWNER_KEY_PATTERN.test(value);
}

/** Which record: the deployment's (`owner: null`) or one person's. */
export interface ServerRecordKey {
  /** A person's opaque owner key, or `null` for the deployment's own record. */
  readonly owner: string | null;
  readonly name: ServerRecordName;
}

export class ServerRecordError extends Error {
  override name = 'ServerRecordError';
}

/** Reject a key no adapter may store, before any adapter sees it. */
export function assertServerRecordKey(key: ServerRecordKey): ServerRecordKey {
  if (!Object.hasOwn(SERVER_RECORDS, key.name))
    throw new ServerRecordError(`Unknown server record: ${String(key.name)}`);
  if (key.owner === null) return key;
  if (!isServerRecordOwner(key.owner))
    throw new ServerRecordError('Invalid server record owner');
  if (!SERVER_RECORDS[key.name].personal)
    throw new ServerRecordError(
      `Server record ${key.name} belongs to the deployment, not a person`,
    );
  return key;
}

/** A stable string for one key, for maps and mutexes. */
export function serverRecordId(key: ServerRecordKey): string {
  return `${key.owner ?? ''}/${key.name}`;
}

/**
 * Serialize a value the way every adapter stores it. `null` is reserved for
 * "never written", so a record cannot hold it, nor anything that serializes
 * to it, such as `NaN` or an object whose `toJSON()` returns `null`.
 */
export function encodeServerRecord(
  key: ServerRecordKey,
  value: unknown,
): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined || text === 'null')
    throw new ServerRecordError(
      `Server record ${key.name} must be a JSON value other than null`,
    );
  return text;
}

/**
 * Parse stored text, naming the record when it is damaged. Stored `null`
 * is damage too: no adapter writes it, and reading it back as "never
 * written" would let the next write silently replace whatever was lost.
 */
export function decodeServerRecord(
  key: ServerRecordKey,
  text: string,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ServerRecordError(`Server record ${key.name} is not valid JSON`, {
      cause: error,
    });
  }
  if (value === null)
    throw new ServerRecordError(`Server record ${key.name} holds null`);
  return value;
}

export interface ServerRecordStore {
  readonly kind: StructuredBackendKind;
  /**
   * Prepare the adapter on its already opened connection. Connections are
   * the composition root's; an adapter borrows one and never closes it.
   */
  init(): Promise<void>;
  /**
   * The latest acknowledged value, read from storage on every call and
   * freshly parsed so the caller may mutate it, or `null` when the record
   * was never written. Adapters keep no copy between calls: a value another
   * process committed is visible to the next read, as it was when every
   * record was a file read on each use.
   *
   * @throws ServerRecordError when stored bytes are not valid JSON.
   */
  get(key: ServerRecordKey): Promise<unknown>;
  /**
   * Replace the record. Resolves once the value is durable and `get` returns
   * it. Concurrent `put`s to one key are not ordered here; the composition
   * root's `update` serializes read-modify-write.
   */
  put(key: ServerRecordKey, value: unknown): Promise<void>;
  /** Every stored record's key, in no particular order. */
  keys(): Promise<readonly ServerRecordKey[]>;
}
