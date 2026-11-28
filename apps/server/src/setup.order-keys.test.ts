// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import {
  SPACE_ORDER_KEYS_REWRITE,
  spaceStateRewrite,
} from './modules/storage/ports/space-state-rewrites.js';

it('the standalone setup can upgrade a database that holds Spaces', async () => {
  // Setup opens the database's server records, which upgrades the database,
  // without composing storage. The version-5 data step needs its rule then:
  // without it the upgrade of a database with Spaces fails.
  expect(() => spaceStateRewrite(SPACE_ORDER_KEYS_REWRITE)).toThrow();
  await import('./setup.js');
  expect(spaceStateRewrite(SPACE_ORDER_KEYS_REWRITE)).toBeTypeOf('function');
});
