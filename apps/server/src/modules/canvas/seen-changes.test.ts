// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  markSeenChanges,
  pruneSeenChanges,
  readSeenChanges,
} from './seen-changes.js';
import {
  openPersonalSettings,
  useCaller,
} from '../identity/personal-settings.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { createCanvas, deleteCanvas } from '../storage/compatibility/canvas.js';
import { resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-seen-changes-'));
  setWorkspacePath(tmp);
  resetStorageCache();
  await createCanvas('c1', 'Space');
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** Run `fn` as a member of a Bubble deployment. */
const as = <T>(principalId: string, fn: () => Promise<T>): Promise<T> =>
  openPersonalSettings(() => {
    useCaller({
      principal: { principalId, kind: 'user' },
      member: true,
      owner: false,
      access: UNRESTRICTED_ACCESS,
    });
    return fn();
  });

const cell = (threadId: string, nodeId: string, key: string) => ({
  threadId,
  nodeId,
  key,
});

describe('seen changes', () => {
  it('sets cells and merges writes that arrive together', async () => {
    expect(await readSeenChanges('c1')).toEqual({});
    await Promise.all([
      markSeenChanges('c1', [cell('t1', 'n1', 'a@1')]),
      markSeenChanges('c1', [cell('t1', 'n2', 'b@1')]),
      markSeenChanges('c1', [cell('t2', 'n1', 'c@1')]),
    ]);
    expect(await readSeenChanges('c1')).toEqual({
      t1: { n1: 'a@1', n2: 'b@1' },
      t2: { n1: 'c@1' },
    });
    // Seeing a node again replaces its cell; it does not add one.
    expect(await markSeenChanges('c1', [cell('t1', 'n1', 'a@2')])).toEqual({
      t1: { n1: 'a@2', n2: 'b@1' },
      t2: { n1: 'c@1' },
    });
  });

  it('drops, on a read, the cells whose record is gone', async () => {
    await markSeenChanges('c1', [
      cell('t1', 'n1', 'a@1'),
      cell('t1', 'n2', 'b@1'),
      cell('t2', 'n1', 'c@1'),
      cell('t3', 'n9', 'd@1'),
    ]);
    // t1 still has a record for n1 only; t2 has none; t3 was not read.
    const kept = await pruneSeenChanges(
      'c1',
      new Map([
        ['t1', new Set(['n1'])],
        ['t2', new Set<string>()],
      ]),
    );
    expect(kept).toEqual({ t1: { n1: 'a@1' } });
    expect(await readSeenChanges('c1')).toEqual({
      t1: { n1: 'a@1' },
      t3: { n9: 'd@1' },
    });
  });

  it('keeps each member’s record apart, and the deployment’s apart from both', async () => {
    await markSeenChanges('c1', [cell('t1', 'n1', 'everyone')]);
    await as('ana', () => markSeenChanges('c1', [cell('t1', 'n1', 'ana')]));
    expect(await as('ana', () => readSeenChanges('c1'))).toEqual({
      t1: { n1: 'ana' },
    });
    expect(await as('ben', () => readSeenChanges('c1'))).toEqual({});
    expect(await readSeenChanges('c1')).toEqual({ t1: { n1: 'everyone' } });
  });

  it('goes with its Space', async () => {
    await markSeenChanges('c1', [cell('t1', 'n1', 'a@1')]);
    await deleteCanvas('c1');
    // Nothing to read, and a write must not bring the Space back.
    expect(await readSeenChanges('c1')).toEqual({});
    expect(await markSeenChanges('c1', [cell('t1', 'n1', 'a@1')])).toEqual({});
    await createCanvas('c1', 'Space');
    expect(await readSeenChanges('c1')).toEqual({});
  });
});
