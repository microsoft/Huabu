// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../host-port.js', () => ({
  getHostServerPort: () => 3001,
}));

import { buildReachbackEnv } from './reachback-env.js';

afterEach(() => {
  delete process.env.HUABU_PUBLIC_ORIGIN;
});

describe('buildReachbackEnv', () => {
  it('uses the configured canonical public origin', () => {
    process.env.HUABU_PUBLIC_ORIGIN = 'https://huabu.example.com:8443/';

    expect(buildReachbackEnv('thread-1', 'canvas-1')).toEqual({
      HUABU_RFS_URL: 'https://huabu.example.com:8443/api/rfs/canvas-1',
      HUABU_THREAD_ID: 'thread-1',
    });
  });

  it('keeps the loopback fallback for local development', () => {
    expect(buildReachbackEnv('thread-1', 'canvas-1')).toEqual({
      HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/canvas-1',
      HUABU_THREAD_ID: 'thread-1',
    });
  });

  it('encodes the canvas id as one path segment', () => {
    process.env.HUABU_PUBLIC_ORIGIN = 'https://192.0.2.10';

    expect(buildReachbackEnv('thread-1', 'canvas/with space')).toMatchObject({
      HUABU_RFS_URL: 'https://192.0.2.10/api/rfs/canvas%2Fwith%20space',
    });
  });
});
