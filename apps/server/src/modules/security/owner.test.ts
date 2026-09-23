// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isOwnerRequest } from './owner.js';
import { setRequestIdentity } from '../identity/request.js';

import type { FastifyRequest } from 'fastify';

function request(remoteAddress: string): FastifyRequest {
  return { socket: { remoteAddress } } as FastifyRequest;
}

describe('owner request authorization', () => {
  it('does not infer owner authority from loopback without resolved identity', () => {
    expect(isOwnerRequest(request('127.0.0.1'))).toBe(false);
  });

  it('rejects an unauthenticated remote request', () => {
    expect(isOwnerRequest(request('192.0.2.10'))).toBe(false);
  });

  it('allows a resolved owner regardless of transport', () => {
    const remote = request('192.0.2.10');
    setRequestIdentity(remote, {
      principal: { principalId: 'owner', kind: 'user' },
      owner: true,
    });
    expect(isOwnerRequest(remote)).toBe(true);
  });

  it('does not elevate a resolved non-owner on loopback', () => {
    const local = request('127.0.0.1');
    setRequestIdentity(local, {
      principal: { principalId: 'agent', kind: 'bot' },
      owner: false,
    });
    expect(isOwnerRequest(local)).toBe(false);
  });
});
