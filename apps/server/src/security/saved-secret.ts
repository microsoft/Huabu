// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The master-key prerequisite, and a saved credential read without opening
 * the database.
 *
 * Kept apart from `secret-store.ts` so the Vite dev server, which only needs
 * the saved remote-login password, loads this and the record composition
 * root and nothing else: the secret store loads the owners' record schemas,
 * which import `@huabu/shared` as TypeScript source.
 */

import {
  CREDENTIALS_RECORD,
  openCredentialEnvelope,
  parseServerMasterKey,
} from './encrypted-secret-store.js';
import { resolveStandaloneMasterKey } from './private-config.js';
import { parseStorageProfile } from '../modules/storage/profile.js';
import { peekServerRecord } from '../modules/storage/server-records.js';

/**
 * The master key `env` supplies, or `null` when the instance generates its
 * own. Reads only `env`, so it is checked before anything reaches a
 * database: PostgreSQL without a supplied key fails here at once, rather
 * than after waiting on a connection.
 */
export function masterKeyPrerequisite(env: NodeJS.ProcessEnv): Buffer | null {
  const encodedKey = env.HUABU_SECRET_KEY?.trim();
  if (!encodedKey && parseStorageProfile(env).structured.kind === 'postgres') {
    // A generated key is a file in the private configuration directory. With
    // the ciphertext in PostgreSQL that file would be the one thing a
    // replaced container loses, leaving every credential unreadable.
    throw new Error(
      'PostgreSQL credential storage requires HUABU_SECRET_KEY. Set it to a ' +
        'Base64 32-byte key from your secret manager; an instance that ' +
        "already has a generated key keeps it in HUABU_CONFIG_DIR's master-key file.",
    );
  }
  return encodedKey ? parseServerMasterKey(encodedKey) : null;
}

/**
 * The saved credential `id` (its stored id), or `null`, read without
 * changing storage: nothing is created for a new instance, and a database
 * an earlier version left is neither upgraded nor imported into, so `setup`
 * can ask before the operator confirms anything. Only the credential record
 * is read, the database's row or the file the import would take it from;
 * no other record's damage affects the lookup.
 *
 * @throws when the key cannot open the saved credentials.
 */
export async function readSavedSecret(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const key = masterKeyPrerequisite(env);
  const envelope = await peekServerRecord(CREDENTIALS_RECORD, env);
  if (envelope === null) return null;
  return (
    openCredentialEnvelope(
      envelope,
      key ?? resolveStandaloneMasterKey(true, env),
    ).get(id) ?? null
  );
}
