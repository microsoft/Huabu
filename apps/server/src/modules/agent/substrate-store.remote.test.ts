// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The agent's substrate helpers against a real Postgres substrate.
 *
 * The helpers are one owner's storage code over the extension port, so their
 * proof lives beside them rather than inside `storage/`: a lazy first write
 * races table creation across independent pools, and the append-only log has
 * to survive concurrent appends from two of them.
 */

import { afterEach, expect, it } from 'vitest';

import {
  appendSubstrateLog,
  readSubstrateDocument,
  writeSubstrateDocument,
} from './substrate-store.js';
import { PostgresStoreContext } from '../storage/backends/postgres/database.js';
import { PostgresStructuredStore } from '../storage/backends/postgres/structured-store.js';
import { openPostgresTestStore } from '../storage/backends/postgres/test-support.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('persists extension documents and concurrent log appends across independent pools', async () => {
  const h = await openPostgresTestStore();
  cleanup.push(h.cleanup);
  await h.store.spaces().create({ canvasId: 'space', title: 'Test' });
  const peer = new PostgresStoreContext(h.config);
  cleanup.push(() => peer.close());
  await peer.init();
  peer.useWorkspace(h.workspaceId);
  const a = await h.store.space('space').extension('agent.documents');
  const b = await new PostgresStructuredStore(peer)
    .space('space')
    .extension('agent.documents');
  const other = await h.store.space('space').extension('agent.other');
  if (!a || !b || !other) throw new Error('Expected substrates');
  // Simultaneous first use also races lazy table creation across independent pools.
  await Promise.all([
    writeSubstrateDocument(a, 'state', { count: 1 }),
    writeSubstrateDocument(b, 'second', { count: 2 }),
  ]);
  expect(await readSubstrateDocument(b, 'state')).toEqual({ count: 1 });
  expect(await readSubstrateDocument(other, 'state')).toBeNull();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      appendSubstrateLog(i % 2 ? a : b, 'debug', '.log', `${i},`),
    ),
  );
  const body = (
    await h.context
      .connection()
      .query(
        'SELECT body FROM extension_documents WHERE extension_id = $1 AND name = $2',
        [a.kind === 'postgres' ? a.extensionId : -1, 'debug.log'],
      )
  ).rows[0].body as string;
  expect(body.split(',').filter(Boolean).sort()).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i)).sort(),
  );
});
