// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { isPageUnloading } from './pageLifecycle';

describe('page lifecycle', () => {
  it('tracks page exit independently of React component cleanup', () => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(isPageUnloading()).toBe(true);

    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(isPageUnloading()).toBe(false);
  });
});
