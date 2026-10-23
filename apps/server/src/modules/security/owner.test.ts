// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOwnerRequest, markBasicAuthenticated } from './owner.js';

import type { FastifyRequest } from 'fastify';

function request(remoteAddress: string): FastifyRequest {
  return { socket: { remoteAddress } } as FastifyRequest;
}

describe('owner request authorization', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows loopback without authentication', () => {
    expect(isOwnerRequest(request('127.0.0.1'))).toBe(true);
  });

  it('rejects an unauthenticated remote request', () => {
    expect(isOwnerRequest(request('192.0.2.10'))).toBe(false);
  });

  it('allows a remote request after Basic Auth succeeds', () => {
    const remote = request('192.0.2.10');
    markBasicAuthenticated(remote);
    expect(isOwnerRequest(remote)).toBe(true);
  });

  it('grants remote owner access only when login is explicitly disabled', () => {
    vi.stubEnv('HUABU_AUTH_MODE', 'none');
    vi.stubEnv('HUABU_BASIC_AUTH_USER', undefined);
    vi.stubEnv('HUABU_BASIC_AUTH_PASS', undefined);
    expect(isOwnerRequest(request('192.0.2.10'))).toBe(true);
  });
});
