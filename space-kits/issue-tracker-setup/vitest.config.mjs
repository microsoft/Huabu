// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('../../apps/server/', import.meta.url)),
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      '../../space-kits/issue-tracker-setup/tests/*.integration.test.mjs',
    ],
    testTimeout: 30_000,
  },
};
