// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { serviceLeaseSchema } from '@huabu/shared/service-package';

import type {
  ServiceConfigurationField,
  ServiceLease,
} from '@huabu/shared/service-package';
export type {
  ServiceConfigurationField,
  ServiceManifest,
  ServiceLease,
} from '@huabu/shared/service-package';
export type ServiceFieldOption = NonNullable<
  ServiceConfigurationField['options']
>[number];

function requiredEnvironment(name: 'HUABU_RFS_URL' | 'AGENTLET_TOKEN'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Service SDK requires ${name}`);
  return value;
}

async function serviceFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const baseUrl = requiredEnvironment('HUABU_RFS_URL').replace(/\/+$/, '');
  const token =
    process.env.HUABU_RFS_TOKEN?.trim() ||
    requiredEnvironment('AGENTLET_TOKEN');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Service request failed (${response.status})`);
  }
  return response;
}

export async function leaseService(serviceId: string): Promise<ServiceLease> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(serviceId)) {
    throw new Error('Invalid Service id');
  }
  const response = await serviceFetch(
    `/services/${encodeURIComponent(serviceId)}/lease`,
    { method: 'POST' },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid Service lease');
    throw error;
  }
  const lease = serviceLeaseSchema.safeParse(body);
  if (!lease.success || lease.data.id !== serviceId) {
    throw new Error('Invalid Service lease');
  }
  return lease.data;
}

export async function withServiceContext<T>(
  serviceId: string,
  run: (service: ServiceLease) => Promise<T> | T,
): Promise<T> {
  return run(await leaseService(serviceId));
}
