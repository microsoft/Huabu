// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildDeploymentReadiness } from './deployment.route.js';

describe('deployment readiness', () => {
  it('reports the local writable default without warnings', () => {
    expect(
      buildDeploymentReadiness({
        allowedHostsConfigured: false,
        basicAuthConfigured: false,
        bindHost: '127.0.0.1',
        bindScope: 'loopback',
        ownerAllowed: true,
        credentialStoreWritable: true,
      }),
    ).toMatchObject({
      owner: { allowedForRequest: true },
      credentials: { writable: true, reason: 'available' },
      issues: [],
    });
  });

  it('reports only redacted remote and credential capabilities', () => {
    const result = buildDeploymentReadiness({
      allowedHostsConfigured: true,
      basicAuthConfigured: true,
      bindHost: '0.0.0.0',
      bindScope: 'network',
      ownerAllowed: true,
      credentialStoreWritable: false,
    });

    expect(result.issues.map((issue) => issue.code)).toEqual([
      'CREDENTIAL_STORE_READ_ONLY',
      'REMOTE_HTTP_UNVERIFIED',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /password|token|secretKey|allowedHosts":\[/i,
    );
  });

  it('reports the Bubble owner policy without disclosing its endpoint', () => {
    const result = buildDeploymentReadiness({
      allowedHostsConfigured: true,
      basicAuthConfigured: false,
      bindHost: '0.0.0.0',
      bindScope: 'network',
      ownerAllowed: true,
      credentialStoreWritable: true,
      ownerPolicy: 'bubble-system-owner',
    });
    expect(result.owner).toEqual({
      policy: 'bubble-system-owner',
      allowedForRequest: true,
    });
  });
});
