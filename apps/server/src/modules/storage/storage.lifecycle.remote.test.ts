// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the composition root promises when opening storage goes wrong.
 *
 * `initStorage` opens two independent backends. Either can fail — a database
 * that is down at boot, a container the account cannot see — and the half that
 * succeeded is then live, connected, and unreachable: a failed start hands the
 * caller an error and drops the holder, so nothing outside this module is left
 * holding the open one. That is the leak these cases exist to catch, and it is
 * a leak per restart rather than a crash, which is why nothing louder
 * announces it.
 *
 * The failures are injected by configuration, not by substitution: an
 * unreachable Postgres and a container that does not exist are what a bad
 * deployment actually looks like. The one exception is a `close()` that
 * rejects, which no real adapter does today — it is stubbed at the port,
 * because composition's `finally` only runs when something refuses.
 */

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { Pool } from 'pg';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';

import { AzureBlobStore } from './backends/azure/blob-store.js';
import { prepareAzureTestEnvironment } from './backends/azure/test-support.js';
import { openPostgresTestDatabase } from './backends/postgres/test-support.js';
import { StorageProfileError } from './profile.js';
import {
  closeStorage,
  createNamedWorkspace,
  createSpace,
  getBlobStore,
  getStorage,
  initStorage,
  materializesWorkspaces,
  space,
  storageServes,
} from './storage.js';
import { forEachProductProfile, mountTestWorkspace } from './testing.js';

import type { StorageProfile } from './profile.js';

const POSTGRES_AZURE: StorageProfile = {
  structured: { kind: 'postgres' },
  blobs: { kind: 'azure' },
};

/** A Postgres nobody is listening on — "the database is down at boot". */
const UNREACHABLE_POSTGRES = 'postgresql://huabu:huabu@127.0.0.1:1/huabu_test';

const releases: Array<() => Promise<void>> = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  // Before the close below, so a stubbed `close()` cannot strand the cleanup.
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

/** Point the Azure profile at a container, existing or not. */
function azureEnvironment(container: string): void {
  setEnv(
    'HUABU_AZURE_STORAGE_CONNECTION_STRING',
    inject('azureConnectionString'),
  );
  setEnv('HUABU_AZURE_BLOB_CONTAINER', container);
  setEnv('HUABU_AZURE_BLOB_PREFIX', 'lifecycle');
}

interface TestPostgres {
  /** Connection string for `HUABU_POSTGRES_URL`, in a schema nobody shares. */
  readonly url: string;
  /**
   * Server-side backends this composition still holds.
   *
   * The only honest answer to "was the pool drained": a pool that was ended
   * leaves no session behind, and one that leaked keeps an idle one for the
   * process's lifetime. Read from the database rather than from the adapter,
   * so a store that merely *says* it closed does not pass.
   */
  backends(): Promise<number>;
  /** Tables the migration created, so "init ran to completion" is checkable. */
  tables(): Promise<number>;
}

async function emptyPostgres(): Promise<TestPostgres> {
  const database = await openPostgresTestDatabase();
  releases.push(database.cleanup);
  const schema = database.config.options.replace('-c search_path=', '');
  const applicationName = `huabu-lifecycle-${randomUUID()}`;
  const url = new URL(database.config.connectionString);
  url.searchParams.set('options', database.config.options);
  url.searchParams.set('application_name', applicationName);
  const admin = new Pool({
    connectionString: database.config.connectionString,
    max: 1,
  });
  releases.push(() => admin.end());
  const count = async (sql: string, parameter: string): Promise<number> =>
    Number((await admin.query(sql, [parameter])).rows[0].n);
  return {
    url: url.toString(),
    backends: () =>
      count(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
        applicationName,
      ),
    tables: () =>
      count(
        'SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1',
        schema,
      ),
  };
}

/**
 * The same Postgres, reached over a link that takes `delayMs` to establish.
 *
 * A real connection to the real database; only the handshake is slow. It
 * exists to make one ordering certain rather than likely: that the blob
 * failure arrives while the structured init is still in flight, which is the
 * only arrangement in which waiting for both and giving up on the first are
 * distinguishable.
 */
async function slowLink(
  connectionString: string,
  delayMs: number,
): Promise<string> {
  const upstream = new URL(connectionString);
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    const timer = setTimeout(() => {
      const server = net.connect(
        Number(upstream.port || 5432),
        upstream.hostname,
      );
      sockets.add(server);
      server.on('error', () => client.destroy());
      server.on('close', () => sockets.delete(server));
      client.pipe(server);
      server.pipe(client);
    }, delayMs);
    client.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });
  releases.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
    });
  });
  const { port } = proxy.address() as net.AddressInfo;
  const slowed = new URL(connectionString);
  slowed.hostname = '127.0.0.1';
  slowed.port = String(port);
  return slowed.toString();
}

/**
 * Every Azure store composition builds, without replacing any of them.
 *
 * A store the composition root opens is never handed out when the open fails,
 * so there is no other way to ask it whether it was closed. The spy calls
 * straight through: what is observed is the real store, opened against the
 * real container.
 */
function captureAzureStores(): AzureBlobStore[] {
  const built: AzureBlobStore[] = [];
  const create = AzureBlobStore.fromEnvironment.bind(AzureBlobStore);
  vi.spyOn(AzureBlobStore, 'fromEnvironment').mockImplementation(() => {
    const store = create();
    built.push(store);
    return store;
  });
  return built;
}

describe('opening storage', () => {
  it('refuses the synchronous on-demand path when the bytes are remote', async () => {
    releases.push(await prepareAzureTestEnvironment());
    setEnv('HUABU_BLOB_BACKEND', 'azure');

    // What a caller that skipped startup actually sees: a sentence naming the
    // whole profile, at the accessor — not an Azure error on the first upload,
    // from a store that was handed out before its container was validated.
    expect(() => getStorage()).toThrow(StorageProfileError);
    expect(() => getStorage()).toThrow(
      /"disk" \/ "azure" profile has connections to open/,
    );
    expect(() => getBlobStore()).toThrow(/Call initStorage\(\)/);

    // One environment variable apart, in the same process: local bytes have
    // nothing to await, so the on-demand path stays legal for them. The blob
    // axis is what closed it, not the structured one.
    setEnv('HUABU_BLOB_BACKEND', undefined);
    expect(() => getStorage()).not.toThrow();
  });

  it('closes the blob store a failed structured init leaves open', async () => {
    releases.push(await prepareAzureTestEnvironment());
    setEnv('HUABU_POSTGRES_URL', UNREACHABLE_POSTGRES);
    const built = captureAzureStores();

    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow(/ECONNREFUSED/);

    expect(built).toHaveLength(1);
    // "closed", not "not initialized": the store was opened and then closed.
    // A blob store left open is a handle nothing else in the process can
    // reach, because composition cleared the only reference to it.
    expect(() => built[0].assertOpen()).toThrow(/Azure blob store is closed/);
    // And it stays closed. This is what awaiting both settlements buys: an
    // init still in flight when composition gave up would resolve afterwards
    // and mark the closed store open again, since `init()` checks for closure
    // before its await rather than after it.
    await sleep(750);
    expect(() => built[0].assertOpen()).toThrow(/Azure blob store is closed/);
  });

  it('leaves no session behind when a blob failure outruns the structured init', async () => {
    const postgres = await emptyPostgres();
    setEnv('HUABU_POSTGRES_URL', await slowLink(postgres.url, 1_000));
    azureEnvironment(`huabu-absent-${randomUUID()}`);

    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow(
      /specified container does not exist/,
    );

    // The blob axis answers in a fraction of the time this link takes to come
    // up, so the failure is certain to be reported while a connection is still
    // being established and a migration is still to run on it. By the time the
    // caller is told, that work has finished and its session is gone:
    // composition closes the shared connection itself, in a `finally`, rather
    // than leaving a half-opened pool to whichever half of the init lost.
    expect(await postgres.tables()).toBeGreaterThan(0);
    expect(await postgres.backends()).toBe(0);
    // Nothing reconnects behind composition's back afterwards.
    await sleep(1_500);
    expect(await postgres.backends()).toBe(0);
  });

  it('leaves nothing configured behind, and opens cleanly on the next attempt', async () => {
    const postgres = await emptyPostgres();
    releases.push(await prepareAzureTestEnvironment());
    setEnv('HUABU_STRUCTURED_BACKEND', 'postgres');
    setEnv('HUABU_BLOB_BACKEND', 'azure');
    setEnv('HUABU_POSTGRES_URL', UNREACHABLE_POSTGRES);

    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow(/ECONNREFUSED/);

    // Not half-open: the accessor answers exactly as it does in a process that
    // never called `initStorage` at all, rather than handing out the storage
    // whose init rejected.
    expect(() => getStorage()).toThrow(StorageProfileError);
    expect(() => getStorage()).toThrow(/before initStorage/);
    // Idempotent after a failure, which is what a shutdown handler registered
    // at boot depends on. It is also what releases the connection the refused
    // on-demand build above memoized from the environment.
    await expect(closeStorage()).resolves.toBeUndefined();
    await expect(closeStorage()).resolves.toBeUndefined();

    setEnv('HUABU_POSTGRES_URL', postgres.url);
    const storage = await initStorage(POSTGRES_AZURE);
    expect(await storage.structured.spaces().list()).toEqual([]);
    expect((await createSpace('space-after-failure', 'Recovered')).ok).toBe(
      true,
    );
    await space('space-after-failure').artifacts.put(
      'art.bin',
      Buffer.from('bytes'),
    );
    expect(
      await space('space-after-failure').artifacts.read('art.bin'),
    ).toEqual(Buffer.from('bytes'));
  });

  it('refuses Azure blobs the environment does not describe, opening nothing', async () => {
    const postgres = await emptyPostgres();
    setEnv('HUABU_POSTGRES_URL', postgres.url);
    setEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', undefined);
    setEnv('HUABU_AZURE_BLOB_CONTAINER', undefined);

    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow(
      /HUABU_AZURE_STORAGE_CONNECTION_STRING and HUABU_AZURE_BLOB_CONTAINER/,
    );
    // The structured store is built first, so this is the case where the
    // second half of the composition throws while the first is already
    // constructed. Nothing reached the database and nothing was left holding
    // it.
    expect(await postgres.backends()).toBe(0);

    setEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', 'not-a-connection-string');
    setEnv('HUABU_AZURE_BLOB_CONTAINER', 'huabu');
    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow();
    expect(await postgres.backends()).toBe(0);

    // A prefix that is not a single segment would file a Space's bytes
    // somewhere other than the area an operator granted. The adapter refuses
    // it in its constructor; what matters here is that the refusal reaches
    // startup instead of being softened into the default prefix.
    azureEnvironment('huabu');
    setEnv('HUABU_AZURE_BLOB_PREFIX', 'huabu/prod');
    await expect(initStorage(POSTGRES_AZURE)).rejects.toThrow(
      /prefix must be a non-empty single segment/,
    );
    expect(await postgres.backends()).toBe(0);
  });
});

describe('closing storage', () => {
  it('drains the shared connections even when a store refuses to close', async () => {
    const postgres = await emptyPostgres();
    releases.push(await prepareAzureTestEnvironment());
    setEnv('HUABU_POSTGRES_URL', postgres.url);
    await initStorage(POSTGRES_AZURE);
    expect((await createSpace('space-close-order', 'Closing')).ok).toBe(true);
    expect(await postgres.backends()).toBeGreaterThan(0);

    vi.spyOn(AzureBlobStore.prototype, 'close').mockRejectedValue(
      new Error('container handle stuck'),
    );

    // The refusal is reported rather than swallowed...
    await expect(closeStorage()).rejects.toThrow('container handle stuck');
    // ...and the pool is still gone, because it was never the failing store's
    // to hold: composition owns the shared connection and closes it in a
    // `finally`. A restart loop is where this would otherwise show up, one
    // leaked pool at a time.
    expect(await postgres.backends()).toBe(0);

    vi.restoreAllMocks();
    const reopened = await initStorage(POSTGRES_AZURE);
    expect(
      (await reopened.structured.spaces().list()).map((s) => s.canvasId),
    ).toEqual(['space-close-order']);
  });

  it('is safe before anything is open, and again after it is closed', async () => {
    await expect(closeStorage()).resolves.toBeUndefined();

    const postgres = await emptyPostgres();
    releases.push(await prepareAzureTestEnvironment());
    setEnv('HUABU_POSTGRES_URL', postgres.url);
    await initStorage(POSTGRES_AZURE);
    expect(await postgres.backends()).toBeGreaterThan(0);

    await expect(closeStorage()).resolves.toBeUndefined();
    expect(await postgres.backends()).toBe(0);
    await expect(closeStorage()).resolves.toBeUndefined();
    expect(await postgres.backends()).toBe(0);
  });
});

/**
 * The declaration an operator reads, checked against the deployment it names.
 *
 * `capabilities.ts` is a promise made before anything opens. Four pairings
 * became selectable at once, so the promise is now made about deployments
 * whose behaviour nothing had yet compared it to — and a matrix that disagrees
 * with the running profile is worse than none, because it is believed.
 */
describe('a mounted profile does what it declared', () => {
  forEachProductProfile((profile, label) => {
    it(`matches its capability declaration (${label})`, async () => {
      const mounted = await mountTestWorkspace(profile, 'huabu-declared-');
      releases.push(mounted.close);
      expect((await createSpace('space-declared', 'Declared')).ok).toBe(true);

      // Every Disk-only row keys on the Space being a real directory, which
      // is the one fact `diskTree` carries.
      expect(space('space-declared').diskTree !== null).toBe(
        storageServes('reveal-space-folder'),
      );
      expect(materializesWorkspaces()).toBe(
        storageServes('workspace-directory'),
      );

      // ...and the refusal at the call site agrees with the row: a Workspace
      // is created by name exactly where it is not a folder to adopt.
      if (storageServes('workspace-directory')) {
        expect(() => createNamedWorkspace('Refused')).toThrow(
          StorageProfileError,
        );
      } else {
        await expect(createNamedWorkspace('Second')).resolves.toMatchObject({
          name: 'Second',
        });
      }
    });
  });
});
