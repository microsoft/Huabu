// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  AccessLevel,
  HuabuResource,
  ResolvedIdentity,
} from './service.js';
import type { FastifyRequest } from 'fastify';

const identities = new WeakMap<FastifyRequest, ResolvedIdentity>();
const authorizations = new WeakMap<
  FastifyRequest,
  Array<{ level: AccessLevel; resource: HuabuResource }>
>();

export function setRequestIdentity(
  request: FastifyRequest,
  identity: ResolvedIdentity,
): void {
  identities.set(request, identity);
}

/** Transport-resolved identity, never a caller-supplied principal header/body. */
export function getRequestIdentity(
  request: FastifyRequest,
): ResolvedIdentity | undefined {
  return identities.get(request);
}

/** Record a resource access the request was granted, to recheck while it lasts. */
export function recordRequestAuthorization(
  request: FastifyRequest,
  level: AccessLevel,
  resource: HuabuResource,
): void {
  const granted = authorizations.get(request) ?? [];
  granted.push({ level, resource });
  authorizations.set(request, granted);
}

export function getRequestAuthorizations(
  request: FastifyRequest,
): ReadonlyArray<{ level: AccessLevel; resource: HuabuResource }> {
  return authorizations.get(request) ?? [];
}

const workspaceChoosers = new WeakMap<
  FastifyRequest,
  (workspaceId: string) => Promise<boolean>
>();

/** How this request's caller changes their own current Workspace. */
export function setRequestWorkspaceChooser(
  request: FastifyRequest,
  choose: (workspaceId: string) => Promise<boolean>,
): void {
  workspaceChoosers.set(request, choose);
}

/**
 * Present when the caller has a current Workspace of their own (Bubble mode);
 * absent when switching moves the process-active Workspace (local mode).
 */
export function getRequestWorkspaceChooser(
  request: FastifyRequest,
): ((workspaceId: string) => Promise<boolean>) | undefined {
  return workspaceChoosers.get(request);
}
