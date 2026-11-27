// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What each person has seen of the changes Agents made in a Space.
 *
 * Kept with the Space, in its own extension namespace, as one small document
 * per person: the deployment's in local mode, where every device is the same
 * person's, and each member's own in Bubble mode. It is not a server record —
 * those belong to no Workspace, and this is about one Space's nodes and goes
 * when the Space does.
 *
 * The document maps conversation → node → the state of that node's review
 * record the person saw. Writes set single cells and are merged, so two
 * devices marking different nodes do not undo each other. Cells are never
 * removed by a write: a read drops the ones whose record is gone.
 *
 * Merging is serialized in this process. Two server processes writing the
 * same person's document for the same Space at once could lose a cell; a
 * deployment that runs several needs this in the database instead.
 */

import { createKeyedMutex } from '../../utils/keyed-mutex.js';
import {
  readSubstrateDocument,
  writeSubstrateDocument,
} from '../agent/substrate-store.js';
import { personalOwnerKey } from '../identity/personal-settings.js';
import { space } from '../storage/index.js';

import type { SeenChange, SeenChanges } from '@huabu/shared';

const EXTENSION = 'huabu.seenchanges';
/** The document of the deployment itself: everyone, in local mode. */
const DEPLOYMENT = 'deployment';

interface SeenDocument {
  version: 1;
  /** Room is left beside this for other things a person has seen. */
  changes: SeenChanges;
}

const serialize = createKeyedMutex();

/** The document this call reads and writes: the caller's own. */
function documentName(): string {
  return personalOwnerKey() ?? DEPLOYMENT;
}

/** The caller's document of a Space, or `null` when the Space is gone. */
async function load(
  canvasId: string,
  name: string,
): Promise<{
  changes: SeenChanges;
  save: (changes: SeenChanges) => Promise<void>;
} | null> {
  // No substrate is handed out for a Space that does not exist, so nothing
  // written here can bring a deleted Space back.
  const substrate = await space(canvasId).extension(EXTENSION);
  if (!substrate) return null;
  const stored = await readSubstrateDocument<Partial<SeenDocument>>(
    substrate,
    name,
  );
  return {
    changes:
      stored?.version === 1 &&
      stored.changes &&
      typeof stored.changes === 'object'
        ? stored.changes
        : {},
    save: (changes) =>
      writeSubstrateDocument(substrate, name, {
        version: 1,
        changes,
      } satisfies SeenDocument),
  };
}

/** What the caller has seen of the Space's changes. */
export async function readSeenChanges(canvasId: string): Promise<SeenChanges> {
  return (await load(canvasId, documentName()))?.changes ?? {};
}

/** Record cells as seen by the caller, and return everything they have seen. */
export function markSeenChanges(
  canvasId: string,
  seen: readonly SeenChange[],
): Promise<SeenChanges> {
  const name = documentName();
  return serialize(`${canvasId}/${name}`, async () => {
    const document = await load(canvasId, name);
    if (!document) return {};
    const { changes, save } = document;
    const next: SeenChanges = { ...changes };
    let changed = false;
    for (const { threadId, nodeId, key } of seen) {
      if (next[threadId]?.[nodeId] === key) continue;
      next[threadId] = { ...next[threadId], [nodeId]: key };
      changed = true;
    }
    if (changed) await save(next);
    return next;
  });
}

/**
 * Drop, from the caller's record, the cells of the given conversations whose
 * node no longer has a review record there, and return what is left of those
 * conversations. Called with the records a read just fetched, so the record
 * cleans itself as it is read and no write has to announce a removal.
 *
 * @param live For each conversation read, the ids of the nodes that have a
 *   review record in it.
 */
export function pruneSeenChanges(
  canvasId: string,
  live: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SeenChanges> {
  const name = documentName();
  return serialize(`${canvasId}/${name}`, async () => {
    const document = await load(canvasId, name);
    if (!document) return {};
    const { changes, save } = document;
    const next: SeenChanges = { ...changes };
    const kept: SeenChanges = {};
    let changed = false;
    for (const [threadId, nodes] of live) {
      const cells = changes[threadId];
      if (!cells) continue;
      const remaining = Object.fromEntries(
        Object.entries(cells).filter(([nodeId]) => nodes.has(nodeId)),
      );
      if (Object.keys(remaining).length === Object.keys(cells).length) {
        kept[threadId] = cells;
        continue;
      }
      changed = true;
      if (Object.keys(remaining).length > 0) {
        next[threadId] = remaining;
        kept[threadId] = remaining;
      } else delete next[threadId];
    }
    if (changed) await save(next);
    return kept;
  });
}
