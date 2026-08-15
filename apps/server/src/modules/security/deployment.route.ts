// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  deploymentReadinessResponseSchema,
  type ApiResult,
  type DeploymentReadinessResponse,
} from '@huabu/shared';

import { resolveDeploymentConfig } from './deployment-config.js';
import { isOwnerRequest } from './owner.js';
import { isSecretStoreWritable } from '../../security/secret-store.js';

import type { FastifyPluginAsync } from 'fastify';

export function buildDeploymentReadiness(input: {
  allowedHostsConfigured: boolean;
  basicAuthConfigured: boolean;
  bindHost: string;
  bindScope: 'loopback' | 'network';
  ownerAllowed: boolean;
  credentialStoreWritable: boolean;
}): DeploymentReadinessResponse {
  const issues: DeploymentReadinessResponse['issues'] = [];
  if (!input.credentialStoreWritable) {
    issues.push({
      code: 'CREDENTIAL_STORE_READ_ONLY',
      severity: 'warning',
    });
  }
  if (input.bindScope === 'network') {
    issues.push({
      code: 'REMOTE_HTTP_UNVERIFIED',
      severity: 'warning',
    });
  }

  return deploymentReadinessResponseSchema.parse({
    bind: {
      host: input.bindHost,
      scope: input.bindScope,
    },
    access: {
      allowedHostsConfigured: input.allowedHostsConfigured,
      basicAuthConfigured: input.basicAuthConfigured,
    },
    owner: {
      policy: 'loopback-or-basic-auth',
      allowedForRequest: input.ownerAllowed,
    },
    credentials: {
      writable: input.credentialStoreWritable,
      reason: input.credentialStoreWritable
        ? 'available'
        : 'secret-key-required',
    },
    transport: {
      status: 'operator-unverified',
    },
    issues,
  });
}

const deploymentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<DeploymentReadinessResponse> }>(
    '/readiness',
    async (request) => {
      const config = resolveDeploymentConfig();
      const writable = isSecretStoreWritable();
      return buildDeploymentReadiness({
        ...config,
        ownerAllowed: isOwnerRequest(request),
        credentialStoreWritable: writable,
      });
    },
  );
};

export default deploymentRoutes;
