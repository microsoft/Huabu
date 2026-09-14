// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, vi } from 'vitest';

import { PgExecutor, PostgresStoreContext } from './database.js';

/** Fake only the SQL boundary; keep adapter validation and workspace guards real. */
export function unitContext(now = () => 1) {
  const context = new PostgresStoreContext({}, now);
  vi.spyOn(context, 'assertOpen').mockImplementation(() => {});
  context.useWorkspace('workspace');
  const database = new PgExecutor(context.connection());
  const get = vi.spyOn(database, 'get').mockResolvedValue(undefined);
  const all = vi.spyOn(database, 'all').mockResolvedValue([]);
  const execute = vi.spyOn(database, 'run').mockResolvedValue({ changes: 1 });
  vi.spyOn(context, 'database').mockReturnValue(database);
  const transaction = vi
    .spyOn(context, 'transaction')
    .mockImplementation((operation) => operation(database));
  return { context, database, get, all, execute, transaction };
}
afterEach(() => vi.restoreAllMocks());
