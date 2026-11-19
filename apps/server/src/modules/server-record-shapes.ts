// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The shapes of the server records whose owners refuse a malformed value.
 *
 * Each owner reads its record through the schema here, and the Server and
 * `setup` check every legacy file the one-time import
 * (`storage/server-records.ts`) would take against the same schema, before
 * either opens the database ({@link checkPendingImport}). That check is what keeps an import
 * recoverable: on Disk a damaged file is repaired by editing the file, but
 * once a database holds the record, the file is never read again, so a
 * value the owner refuses would be stuck in the database.
 *
 * Records whose owners fall back to defaults on a malformed value (model
 * settings, change review, external-agent runtime) have no shape here: the
 * next save repairs them, on a database exactly as on Disk. The credential
 * envelope is checked by `security/secret-store.ts`, which holds the key.
 *
 * Kept above storage, which knows no owner's schema. The Vite dev server
 * cannot load it (`@huabu/shared` is TypeScript source), and needs no check:
 * it only reads the saved password, without opening the database.
 */

import { decodeAgentProfileRegistry } from '@agenetes/agent-profile';
import { z } from 'zod';

import { agentDefaultsSchema, agentletDeviceNameSchema } from '@huabu/shared';

import {
  readPendingImport,
  unimportableRecord,
} from './storage/server-records.js';

import type { ServerRecordName } from './storage/ports/server-records.js';
import type { PendingImportEntry } from './storage/server-records.js';

/** A credential version: absent means 0, and a reset increments it. */
export const credentialVersionSchema = z.number().int().nonnegative();

/** `device-owners`: `agentletId -> principalId`. */
export const deviceOwnersSchema = z.record(z.string(), z.string().min(1));

/** `agent-credential-versions`: `principalId -> version`. */
export const credentialVersionsSchema = z.record(
  z.string(),
  credentialVersionSchema,
);

/** `device-names`: `agentletId -> display name`. */
export const deviceNamesSchema = z.record(z.string(), agentletDeviceNameSchema);

/** Throws when `value` is not a record of `name` its owner can read. */
const REFUSED_SHAPES: Partial<
  Record<ServerRecordName, (value: unknown) => unknown>
> = {
  'agent-profiles': decodeAgentProfileRegistry,
  'user-agent-profiles': decodeAgentProfileRegistry,
  'agent-defaults': (value) => agentDefaultsSchema.parse(value),
  'device-names': (value) => deviceNamesSchema.parse(value),
  'device-owners': (value) => deviceOwnersSchema.parse(value),
  'agent-credential-versions': (value) => credentialVersionsSchema.parse(value),
};

/**
 * Why the owner of `name` would refuse `value`, or `null` when it reads it.
 * Records with no shape here are always readable.
 */
export function refusedServerRecordShape(
  name: ServerRecordName,
  value: unknown,
): string | null {
  const check = REFUSED_SHAPES[name];
  if (!check) return null;
  try {
    check(value);
    return null;
  } catch (error) {
    return error instanceof z.ZodError
      ? error.issues
          .map(
            (issue) =>
              `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
          )
          .join('; ')
      : // One line, for a startup error: some owners' messages embed
        // indented JSON.
        (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .trim();
  }
}

/**
 * The records opening `env`'s database would import (`readPendingImport`),
 * each checked as its owner reads it. Run before anything opens the
 * database: opening upgrades it and imports these, after which repairing a
 * file no longer reaches the database's copy.
 *
 * @throws ServerRecordError naming the first file an owner would refuse.
 */
export async function checkPendingImport(
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly PendingImportEntry[]> {
  const pending = await readPendingImport(env);
  for (const { key, value, file } of pending) {
    const refused = refusedServerRecordShape(key.name, value);
    if (refused !== null) throw unimportableRecord(file, refused);
  }
  return pending;
}
