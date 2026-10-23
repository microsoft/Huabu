// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveServerDataDir } from '../src/bootstrap.js';

describe('server instance paths', () => {
  const root = resolve('/checkout/Huabu');

  it.each([undefined, ''])(
    'anchors the default data directory: %j',
    (value) => {
      expect(resolveServerDataDir(root, value)).toBe(
        resolve(root, 'apps/server/data'),
      );
    },
  );

  it.each(['./instance-data', '../instance-data', 'data with spaces '])(
    'anchors a relative override to the repository root: %j',
    (value) => {
      expect(resolveServerDataDir(root, value)).toBe(resolve(root, value));
    },
  );

  it('retains absolute deployment-owned paths', () => {
    const dataDir = resolve('/external/instance-data');
    expect(resolveServerDataDir(root, dataDir)).toBe(dataDir);
  });
});
