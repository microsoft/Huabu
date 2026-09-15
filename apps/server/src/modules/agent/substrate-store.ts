// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Two shapes an extension namespace can be stored in, on either substrate.
 *
 * The storage port hands a namespace a *place* and nothing else — a directory
 * on Disk, a connection plus a parent row on SQLite (proposal §6.4.4). That is
 * deliberate: a key/value member on the port would have fixed one access shape
 * for every owner forever. What the port's own commentary anticipates instead
 * is a helper *over* the substrate, written by owners who happen to want the
 * same shape. This is that helper, for the two shapes the agent module needs:
 *
 *   - a whole JSON document, rewritten each time (memory bookkeeping);
 *   - an append-only text log per key (the debug prompt dump).
 *
 * Nothing here is a port. It is one owner's storage code, kept in one file
 * because two owners wanted the same thing rather than because storage said
 * they should.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, readJson, sanitizeId } from '../../utils/fs.js';

import type { SpaceSubstrate } from '../storage/index.js';
import type { DatabaseSync } from 'node:sqlite';

/** Tables created on demand, once per connection. */
const prepared = new WeakSet<DatabaseSync>();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS extension_documents (
    extension_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (extension_id, name),
    FOREIGN KEY (extension_id) REFERENCES space_extensions(extension_id)
      ON DELETE CASCADE
  ) STRICT;
`;

function ensureTables(database: DatabaseSync): void {
  if (prepared.has(database)) return;
  database.exec(SCHEMA);
  prepared.add(database);
}

/**
 * Read one JSON document from a namespace, or `null` when it is not there.
 *
 * Absence and damage are the same answer on purpose: both callers treat a
 * missing document as "start from nothing", and a bookkeeping file a user can
 * corrupt by hand must not be able to fail a request.
 */
export function readSubstrateDocument<T>(
  substrate: SpaceSubstrate,
  name: string,
): T | null {
  const safe = sanitizeId(name, 'document name');
  if (substrate.kind === 'disk') {
    return readJson<T>(path.join(substrate.directory, `${safe}.json`));
  }
  ensureTables(substrate.database);
  const row = substrate.database
    .prepare(
      `SELECT body FROM extension_documents
       WHERE extension_id = ? AND name = ?`,
    )
    .get(substrate.extensionId, safe);
  if (row === undefined || typeof row['body'] !== 'string') return null;
  try {
    return JSON.parse(row['body']) as T;
  } catch {
    return null;
  }
}

/** Replace one JSON document in a namespace. */
export function writeSubstrateDocument(
  substrate: SpaceSubstrate,
  name: string,
  value: unknown,
): void {
  const safe = sanitizeId(name, 'document name');
  if (substrate.kind === 'disk') {
    atomicWriteJson(path.join(substrate.directory, `${safe}.json`), value);
    return;
  }
  ensureTables(substrate.database);
  const body = JSON.stringify(value);
  if (body === undefined) {
    throw new TypeError(`Document ${safe} is not representable as JSON`);
  }
  substrate.database
    .prepare(
      `INSERT INTO extension_documents (extension_id, name, body)
       VALUES (?, ?, ?)
       ON CONFLICT(extension_id, name) DO UPDATE SET body = excluded.body`,
    )
    .run(substrate.extensionId, safe, body);
}

/**
 * Append to one text log in a namespace.
 *
 * On Disk this is a real file, which is the point of the debug log: a
 * developer tails it. Elsewhere it is a row that grows, which keeps the same
 * feature working without pretending there is a file to tail.
 */
export function appendSubstrateLog(
  substrate: SpaceSubstrate,
  name: string,
  suffix: string,
  block: string,
): void {
  const safe = sanitizeId(name, 'log name');
  if (substrate.kind === 'disk') {
    mkdirSync(substrate.directory, { recursive: true });
    appendFileSync(
      path.join(substrate.directory, `${safe}${suffix}`),
      block,
      'utf8',
    );
    return;
  }
  ensureTables(substrate.database);
  substrate.database
    .prepare(
      `INSERT INTO extension_documents (extension_id, name, body)
       VALUES (?, ?, ?)
       ON CONFLICT(extension_id, name) DO UPDATE SET
         body = extension_documents.body || excluded.body`,
    )
    .run(substrate.extensionId, `${safe}${suffix}`, block);
}
