// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Opening, creating and switching Workspaces where a Workspace is a row.
 *
 * On Disk the Server waits for a folder; here there is nothing to wait for, so
 * activation is the whole of "open a Workspace" — it creates the first one,
 * points the shared connection at it, mints its World, and records that it was
 * opened. Each of those is a step the process can only take once and can only
 * take correctly: a connection left on the previous Workspace answers
 * confidently with the wrong Spaces, and a second default Workspace on every
 * restart is a database that quietly grows an empty deployment per boot.
 *
 * Run against a schema with nothing in it, because "first start" is the case
 * that cannot be reproduced by a harness that has already created a Workspace.
 */

import { randomUUID } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import { openPostgresTestDatabase } from './backends/postgres/test-support.js';
import { PostgresWorkspaceRepository } from './backends/postgres/workspace-repository.js';
import { StorageProfileError } from './profile.js';
import {
  activateWorkspace,
  closeStorage,
  createNamedWorkspace,
  createSpace,
  getStorage,
  getWorkspaceRepository,
  getWorldCanvasId,
  initStorage,
} from './storage.js';
import { mountTestWorkspace } from './testing.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { StorageProfile } from './profile.js';

const POSTGRES: StorageProfile = {
  structured: { kind: 'postgres' },
  blobs: { kind: 'disk' },
};
const DISK: StorageProfile = {
  structured: { kind: 'disk' },
  blobs: { kind: 'disk' },
};

const releases: Array<() => Promise<void>> = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStorage();
  for (const release of releases.splice(0).reverse()) await release();
  for (const restore of restores.splice(0).reverse()) restore();
});

function setEnv(key: string, value: string | undefined): void {
  const previous = process.env[key];
  restores.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * A schema with no tables in it, wired through `HUABU_POSTGRES_URL`.
 *
 * Deliberately not the shared harness: that one registers a Workspace of its
 * own, and a database that already has one cannot answer what a first start
 * does.
 */
async function emptyDatabase(): Promise<void> {
  const database = await openPostgresTestDatabase();
  releases.push(database.cleanup);
  const url = new URL(database.config.connectionString);
  url.searchParams.set('options', database.config.options);
  url.searchParams.set('application_name', `huabu-workspaces-${randomUUID()}`);
  setEnv('HUABU_POSTGRES_URL', url.toString());
}

it('starts a first Workspace on an empty database and reopens that same one', async () => {
  await emptyDatabase();

  await initStorage(POSTGRES);
  const first = getWorkspaceHandle();
  const world = getWorldCanvasId();
  expect(first?.name).toBe('Workspace');
  expect(world).not.toBeNull();
  expect(await getWorkspaceRepository().list()).toHaveLength(1);
  expect((await createSpace('space-first-start', 'First')).ok).toBe(true);

  await closeStorage();
  await initStorage(POSTGRES);

  // The restart reopens the Workspace that is there rather than starting
  // another: `ensureDefault` is idempotent while a registered Workspace
  // remains, and it is asked on every boot. One extra empty Workspace per
  // restart is the failure this forecloses, and nothing would report it.
  expect(getWorkspaceHandle()?.workspaceId).toBe(first?.workspaceId);
  expect(await getWorkspaceRepository().list()).toHaveLength(1);
  // The World is minted once per Workspace and never changes, so reopening
  // the same Workspace must not mint a second one.
  expect(getWorldCanvasId()).toBe(world);
  expect(
    (await getStorage().structured.spaces().list()).map(
      (entry) => entry.canvasId,
    ),
  ).toEqual(['space-first-start']);
});

it('creates a Workspace by name here, and says why it cannot on Disk', async () => {
  await emptyDatabase();
  await initStorage(POSTGRES);

  const created = await createNamedWorkspace('Second');
  expect(created.name).toBe('Second');
  expect(
    (await getWorkspaceRepository().list()).map((entry) => entry.name).sort(),
  ).toEqual(['Second', 'Workspace']);

  await closeStorage();
  const mounted = await mountTestWorkspace(DISK, 'huabu-named-workspace-');
  releases.push(mounted.close);
  // A sentence rather than a stack trace, and it names what to do instead.
  // The refusal is synchronous although the operation is asynchronous, which
  // is the shape a caller has to be able to rely on either way.
  expect(() => createNamedWorkspace('Refused')).toThrow(StorageProfileError);
  expect(() => createNamedWorkspace('Refused')).toThrow(
    /"disk" structured backend keeps Workspaces as directories.*adopting a folder/s,
  );
});

it('re-points the connection and the World when the active Workspace changes', async () => {
  await emptyDatabase();
  await initStorage(POSTGRES);
  const first = getWorkspaceHandle();
  const firstWorld = getWorldCanvasId();
  if (!first) throw new Error('Expected a Workspace to have been activated');
  expect((await createSpace('space-in-first', 'In first')).ok).toBe(true);

  const second = await createNamedWorkspace('Second');
  await activateWorkspace(second);

  // One connection, two namespaces. A context still pointed at the previous
  // Workspace would answer this with the other Workspace's Spaces, and every
  // answer after it would be wrong in the same confident way.
  expect(getWorkspaceHandle()?.workspaceId).toBe(second.workspaceId);
  expect(await getStorage().structured.spaces().list()).toEqual([]);
  // A Workspace's World is its own, so the cached id cannot survive the
  // switch — a Portal aimed at the previous one would cross the boundary.
  const secondWorld = getWorldCanvasId();
  expect(secondWorld).not.toBeNull();
  expect(secondWorld).not.toBe(firstWorld);
  // Activation also records that this Workspace was opened, which is the
  // recency a Workspace picker orders by.
  expect((await getWorkspaceRepository().list())[0].workspaceId).toBe(
    second.workspaceId,
  );
  expect((await createSpace('space-in-second', 'In second')).ok).toBe(true);

  await activateWorkspace(first);
  expect(getWorldCanvasId()).toBe(firstWorld);
  expect(
    (await getStorage().structured.spaces().list()).map(
      (entry) => entry.canvasId,
    ),
  ).toEqual(['space-in-first']);
});

it('reports a failed open-record instead of losing it behind activation', async () => {
  await emptyDatabase();
  await initStorage(POSTGRES);
  const second = await createNamedWorkspace('Second');

  // Recording that a Workspace was opened is a *write* on this backend, where
  // on SQLite it was a synchronous call that could only throw. Nothing real
  // makes it fail, so the failure is injected — what is being asserted is that
  // activation waits for it at all. Left unawaited, the rejection escapes the
  // caller entirely and surfaces later as an unhandled one, with the
  // Workspace already switched.
  vi.spyOn(
    PostgresWorkspaceRepository.prototype,
    'markOpened',
  ).mockRejectedValue(new Error('open record refused'));

  await expect(activateWorkspace(second)).rejects.toThrow(
    'open record refused',
  );
});

it('serves the Workspace repository and the Spaces from one connection', async () => {
  await emptyDatabase();
  await initStorage(POSTGRES);
  const repository = getWorkspaceRepository();
  const structured = getStorage().structured;

  await closeStorage();

  // Closing the process's one context closes both, because there is only one:
  // a repository with a context of its own would still be answering here.
  // That is the arrangement the deletion fence depends on — two contexts on
  // one database would let one of them delete what the other just
  // acknowledged.
  await expect(repository.list()).rejects.toThrow(/Postgres store is closed/);
  expect(() => structured.spaces()).toThrow(/Postgres store is closed/);
});

it('refuses a Postgres profile with no connection string, in one sentence', async () => {
  setEnv('HUABU_POSTGRES_URL', undefined);

  await expect(initStorage(POSTGRES)).rejects.toThrow(StorageProfileError);
  await expect(initStorage(POSTGRES)).rejects.toThrow(
    /Postgres requires HUABU_POSTGRES_URL/,
  );
});
