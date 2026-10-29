// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { collectMarkdownArtifactRefs, parseArtifactRef } from '@huabu/shared';

import {
  getRequestIdentity,
  recordRequestAuthorization,
} from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** A non-GET route that only reads the Space it names. */
    spaceAccess?: 'read';
    /** Starts or steers an agent outside the agent route prefixes. */
    invokesAgent?: true;
  }
}

type Fields = Record<string, unknown> | undefined;

/**
 * Agents act through the shared machine credential, which reaches every
 * Space, so a member may not run or steer one until credentials carry the
 * caller's own authority. RFS is that credential's own surface: it launches
 * agents and Task Runs and leases shared service credentials, and the web
 * app never calls it. Matched by route pattern, not URL spelling.
 */
const AGENT_ROUTES = [
  '/api/agent',
  '/api/acp',
  '/api/agent-change-review',
  '/api/rfs',
];

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
 * and agents are an owner's alone, as {@link AGENT_ROUTES} explains. The
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
    if (
      !identity.owner &&
      (threadId ||
        request.routeOptions.config?.invokesAgent ||
        AGENT_ROUTES.some(
          (prefix) => route === prefix || route.startsWith(`${prefix}/`),
        ))
    ) {
      return reply.code(403).send({
        message: 'Agents and conversations require an owner',
        code: 'AGENT_ACCESS_REQUIRED',
      });
    }

    const checks: Array<['read' | 'write', string]> = [];
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
      if (needed === 'write' && (await identity.access.can('read', space)))
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
  const readable = await Promise.all(
    spaces.map((space) =>
      access.can('read', { type: 'space', id: space.canvasId }),
    ),
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
