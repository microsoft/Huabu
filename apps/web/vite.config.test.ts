// @vitest-environment node

import { describe, expect, it } from 'vitest';

import viteConfig from './vite.config';

describe('Vite feature flags', () => {
  it('declares Vue esm-bundler defaults used by Milkdown', async () => {
    if (typeof viteConfig !== 'function') {
      throw new TypeError('Expected Vite config to be a function');
    }

    const config = await viteConfig({
      command: 'serve',
      mode: 'test',
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.define).toMatchObject({
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    });
  });
});
