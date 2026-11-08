// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { collectMarkdownArtifactRefs, parseArtifactRef } from '@huabu/shared';

import {
  getRequestIdentity,
  recordRequestAuthorization,
} from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { AccessLevel } from '../identity/service.js';
import type { CanvasAccess } from '@huabu/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * What a route needs on the Space it names, when not the method's
     * default: `read` for a non-GET route that only reads it, `manage` for
     * renaming, deleting, or changing its parent.
     */
    spaceAccess?: 'read' | 'manage';
  }
}

type Fields = Record<string, unknown> | undefined;

/**
 * The one value a request gives for `field` across its route parameters,
 * query and body: `undefined` when absent, `null` when the sources disagree or
 * the value is not a single id, so a handler can never read a different
 * resource from the one authorized.
 */
function single(
  field: string,
  ...sources: Fields[]
): string | null | undefined {
  let found: string | undefined;
  for (const source of sources) {
    const value = source?.[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value || (found && found !== value))
      return null;
    found = value;
  }
  return found;
}

/**
 * Authorize every Space a request names before its route runs.
 *
 * The Space is the `canvasId` route parameter, query field or body field,
 * which must agree wherever more than one is given; a route that moves
 * content between Spaces also names the other one in its body. Conversations
 * use the caller's Space access; external agent adapters also check device ownership. The
 * identity provider decides each check, and each granted check is recorded so
 * a long-lived response is closed once it no longer holds. Unrestricted
 * callers, the local owner and the machine credential, skip the guard
 * entirely, so local mode is unchanged.
 */
export function registerSpaceAccess(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config?.identity === 'route-owned') return;
    const identity = getRequestIdentity(request);
    // Credential-free routes were already admitted or refused by identity.
    if (!identity || !isRestrictedRequest(request)) return;

    const params = request.params as Fields;
    const query = request.query as Fields;
    const body =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : undefined;
    const level =
      request.routeOptions.config?.spaceAccess ??
      (request.method === 'GET' || request.method === 'HEAD'
        ? 'read'
        : 'write');

    const canvasId = single('canvasId', params, query, body);
    const threadId = single('threadId', params, query, body);
    if (canvasId === null || threadId === null)
      return reply.code(400).send({
        message: 'A request may name only one Space and one conversation',
        code: 'SPACE_ACCESS_AMBIGUOUS',
      });
    const route = request.routeOptions.url ?? '';
    // A conversation lives in a Space, and is reached only through one the
    // caller may use.
    // Administrators included: their devices and agents are private too, and
    // a conversation named without its Space would skip the device check.
    if (
      !canvasId &&
      (threadId ||
        (!identity.owner &&
          (route === '/api/agent' || route.startsWith('/api/agent/')) &&
          route !== '/api/agent/defaults' &&
          route !== '/api/agent/defaults/'))
    )
      return reply.code(400).send({
        message: 'A conversation is addressed through its Space',
        code: 'SPACE_ACCESS_AMBIGUOUS',
      });

    const checks: Array<[AccessLevel, string]> = [];
    if (canvasId) checks.push([level, canvasId]);
    const destination = body?.destination as Fields;
    for (const [needed, value] of [
      ['write', body?.targetCanvasId],
      ['write', destination?.canvasId],
      ['write', body?.parentSpaceId],
      ['read', body?.srcCanvasId],
    ] as const) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !value)
        return reply.code(400).send({
          message: 'A request may name only one Space and one conversation',
          code: 'SPACE_ACCESS_AMBIGUOUS',
        });
      checks.push([needed, value]);
    }

    for (const [needed, spaceId] of checks) {
      const space = { type: 'space', id: spaceId } as const;
      if (await identity.access.can(needed, space)) {
        recordRequestAuthorization(request, needed, space);
        continue;
      }
      // Without read access the Space is indistinguishable from a missing one.
      if (needed !== 'read' && (await identity.access.can('read', space)))
        return reply.code(403).send({
          message: 'Space is read-only for this principal',
          code: 'SPACE_ACCESS_REQUIRED',
        });
      return reply.code(404).send({ message: 'Canvas not found' });
    }
  });
}

/** Whether the caller's access is decided per Workspace and Space. */
export function isRestrictedRequest(request: FastifyRequest): boolean {
  const access = getRequestIdentity(request)?.access;
  return access !== undefined && access !== UNRESTRICTED_ACCESS;
}

/** The current Workspace, as a resource, if the caller may write it. */
async function writableWorkspace(request: FastifyRequest) {
  const workspaceId = getWorkspaceHandle()?.workspaceId;
  if (!workspaceId) return null;
  const resource = { type: 'workspace', id: workspaceId } as const;
  return (await getRequestIdentity(request)?.access.can('write', resource))
    ? resource
    : null;
}

/** Whether the caller may create root Spaces in their current Workspace. */
export async function canWriteWorkspace(
  request: FastifyRequest,
): Promise<boolean> {
  return (
    !isRestrictedRequest(request) || (await writableWorkspace(request)) !== null
  );
}

/** Root creation has no existing Space to authorize; it writes the Workspace. */
export async function requireWorkspaceWrite(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isRestrictedRequest(request)) return;
  const resource = await writableWorkspace(request);
  if (resource) {
    recordRequestAuthorization(request, 'write', resource);
    return;
  }
  reply.code(403).send({
    message: 'Workspace write access required',
    code: 'SPACE_ACCESS_REQUIRED',
  });
}

/** Conditional manage checks for mutations carried by otherwise writable routes. */
export async function canManageSpace(
  request: FastifyRequest,
  canvasId: string,
): Promise<boolean> {
  return (
    !isRestrictedRequest(request) ||
    (await getRequestIdentity(request)?.access.can('manage', {
      type: 'space',
      id: canvasId,
    })) === true
  );
}

/** Project the existing authorization owner for UI affordances, never as a mutation grant. */
export async function getSpaceAccess(
  request: FastifyRequest,
  canvasId: string,
): Promise<CanvasAccess> {
  const [write, manage] = await Promise.all([
    !isRestrictedRequest(request)
      ? true
      : getRequestIdentity(request)?.access.can('write', {
          type: 'space',
          id: canvasId,
        }),
    canManageSpace(request, canvasId),
  ]);
  return { write: write === true, manage };
}

/** Record the caller as owner of the Space it has just created. */
export async function claimSpace(
  request: FastifyRequest,
  canvasId: string,
): Promise<void> {
  await getRequestIdentity(request)?.access.claim({
    type: 'space',
    id: canvasId,
  });
}

/** Whether the caller may read the Space. */
export async function canReadSpace(
  request: FastifyRequest,
  canvasId: string,
): Promise<boolean> {
  return (
    (await getRequestIdentity(request)?.access.can('read', {
      type: 'space',
      id: canvasId,
    })) ?? false
  );
}

/** Keep only the Spaces the caller may read, in their original order. */
export async function readableSpaces<T extends { canvasId: string }>(
  request: FastifyRequest,
  spaces: readonly T[],
): Promise<T[]> {
  const access = getRequestIdentity(request)?.access;
  if (!access) return [];
  const resources = spaces.map((space) => ({
    type: 'space' as const,
    id: space.canvasId,
  }));
  const readable = access.canMany
    ? await access.canMany('read', resources)
    : await Promise.all(
        resources.map((resource) => access.can('read', resource)),
      );
  return spaces.filter((_, index) => readable[index]);
}

/**
 * Whether the caller may read every other Space whose artifact `value` cites,
 * as a whole artifact URL or a Markdown image, at any depth. A route that
 * reads bytes a client-supplied snapshot points at must not reach further
 * than the Space it was authorized for.
 */
export async function canReadCitedSpaces(
  request: FastifyRequest,
  canvasId: string,
  value: unknown,
): Promise<boolean> {
  const cited = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const raw of [node, ...collectMarkdownArtifactRefs(node)]) {
        const owner = parseArtifactRef(raw)?.canvasId;
        if (owner && owner !== canvasId) cited.add(owner);
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  for (const owner of cited)
    if (!(await canReadSpace(request, owner))) return false;
  return true;
}
