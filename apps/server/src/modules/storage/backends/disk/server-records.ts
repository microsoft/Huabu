// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the server-record port: one JSON file per record,
 * at the path `data-dir.ts` assigns it.
 *
 * Reads go to the file every time, which also keeps a record correct when
 * the data directory changes underneath (tests point `HUABU_DATA_DIR` at a
 * new directory per case). Writes replace the file atomically, flush it
 * before publishing, and leave it readable by the owner alone, because the
 * credential envelope is one of these files.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { diskPeopleDir, diskServerRecordPath } from './data-dir.js';
import { getDataDir } from '../../../../data-dir.js';
import { atomicWriteText } from '../../../../utils/fs.js';
import {
  SERVER_RECORD_NAMES,
  SERVER_RECORDS,
  decodeServerRecord,
  encodeServerRecord,
  isServerRecordOwner,
} from '../../ports/server-records.js';

import type {
  ServerRecordKey,
  ServerRecordStore,
} from '../../ports/server-records.js';

export class DiskServerRecordStore implements ServerRecordStore {
  readonly kind = 'disk' as const;

  /**
   * @param dataDir Resolved on every call, so the store follows the data
   *   directory in force rather than the one it was built in.
   */
  constructor(private readonly dataDir: () => string = () => getDataDir()) {}

  async init(): Promise<void> {
    // Files need no preparation; a record's directory is made on first write.
  }

  async get(key: ServerRecordKey): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(diskServerRecordPath(key, this.dataDir()), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return decodeServerRecord(key, text);
  }

  async put(key: ServerRecordKey, value: unknown): Promise<void> {
    // Validate exactly as the SQL adapters do; the file itself stays
    // indented, as these files always were, for an operator reading them.
    encodeServerRecord(key, value);
    atomicWriteText(
      diskServerRecordPath(key, this.dataDir()),
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600, durable: true },
    );
  }

  async keys(): Promise<readonly ServerRecordKey[]> {
    const dataDir = this.dataDir();
    const keys: ServerRecordKey[] = [];
    const collect = (owner: string | null) => {
      for (const name of SERVER_RECORD_NAMES) {
        if (owner !== null && !SERVER_RECORDS[name].personal) continue;
        const key = { owner, name };
        if (existsSync(diskServerRecordPath(key, dataDir))) keys.push(key);
      }
    };
    collect(null);
    let people: string[];
    try {
      people = readdirSync(diskPeopleDir(dataDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return keys;
      throw error;
    }
    // Anything else under `people/` is not a person's directory this
    // Server wrote, so it is not a record to report.
    for (const owner of people.filter(isServerRecordOwner)) collect(owner);
    return keys;
  }
}
