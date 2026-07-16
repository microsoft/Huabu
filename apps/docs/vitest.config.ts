// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default defineConfig(async (environment) => {
  const resolved =
    typeof viteConfig === 'function'
      ? await viteConfig(environment)
      : viteConfig;

  return mergeConfig(resolved, {
    test: {
      environment: 'happy-dom',
    },
  });
});
