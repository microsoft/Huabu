// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { IdentityPrincipal, IdentityResponse } from '@huabu/shared';

/** Supplied by a trusted transport, never copied from a request body. */
export interface IdentityCredentials {
  authorization?: string;
  loopback: boolean;
}

export interface ResolvedIdentity {
  principal: IdentityPrincipal;
  /** Huabu's existing single-owner policy, not a general permission model. */
  owner: boolean;
}

/** Resolve afresh for each request so revocation is not hidden by a host cache. */
export interface IdentityService {
  readonly provider: IdentityResponse['provider'];
  readonly challenge: string;
  authenticate(
    credentials: IdentityCredentials,
  ): Promise<ResolvedIdentity | null>;
}

export class IdentityError extends Error {
  constructor(
    readonly statusCode: 403 | 503,
    readonly code: 'IDENTITY_FORBIDDEN' | 'IDENTITY_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
