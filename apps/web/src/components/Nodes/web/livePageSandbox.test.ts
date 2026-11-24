// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { livePageSandboxFor } from './livePageSandbox';

const APP = 'http://127.0.0.1:3001';
const page = (overrides: Partial<Parameters<typeof livePageSandboxFor>[0]>) =>
  livePageSandboxFor({
    interactiveView: false,
    kind: 'url',
    snapshot: false,
    src: 'https://example.com/',
    appOrigin: APP,
    ...overrides,
  });

describe('livePageSandboxFor', () => {
  it('lets a remote site keep its own origin', () => {
    expect(page({})).toContain('allow-same-origin');
    expect(page({ src: 'http://127.0.0.1:9999/' })).toContain(
      'allow-same-origin',
    );
  });

  it('never gives a document on the application origin that origin', () => {
    for (const src of [
      `${APP}/api/canvas/one/artifact/page.html`,
      `${APP.toUpperCase()}/api/canvas/one/artifact/page.html`,
      '/api/canvas/one/artifact/page.html',
      `${APP}/`,
    ]) {
      const flags = page({ src });
      expect(flags).not.toContain('allow-same-origin');
      expect(flags).toContain('allow-scripts');
    }
    expect(
      page({ kind: 'html', src: '/api/canvas/one/artifact/page.html' }),
    ).not.toContain('allow-same-origin');
    expect(
      page({ kind: 'html', src: 'data:text/html,<p>x</p>' }),
    ).not.toContain('allow-same-origin');
  });

  it('keeps scripts off for a snapshot and the narrow set for an Interactive View', () => {
    expect(page({ kind: 'html', snapshot: true, src: '/a.mhtml' })).toBe(
      'allow-popups',
    );
    expect(page({ interactiveView: true, kind: 'html', src: '/r' })).toBe(
      'allow-scripts allow-forms',
    );
  });
});
