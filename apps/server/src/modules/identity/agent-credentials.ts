// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { getAgentletGateway } from '@agenetes/agentlet-host';
import { z } from 'zod';

import { personalSettingsOwner } from './personal-settings.js';
import { getConnectionToken } from '../../connection-token.js';
import { getServerRecords } from '../storage/index.js';

import type { IdentityService } from './service.js';
import type { FastifyInstance } from 'fastify';

/** The host-selected service, never inferred from a mutable process environment. */
let hostIdentity: IdentityService | undefined;

/**
 * Bind device admission to the same service as HTTP and bound revocation of
 * already connected devices. Ownership and reusable commands survive revocation.
 * Lookup failure or a lookup exceeding the revalidation interval disconnects
 * affected live devices. One stalled owner never blocks another owner's check.
 */
export function registerAgentIdentity(
  app: FastifyInstance,
  service: IdentityService,
  intervalMs: number,
): void {
  hostIdentity = service;
  app.addHook('onClose', async () => {
    if (hostIdentity === service) hostIdentity = undefined;
  });
  if (service.provider !== 'bubble') return;
  let closed = false;
  // Coalesce only this owner's pending lookup. Keep a timed-out lookup reserved
  // until it settles to avoid accumulating queries during a store outage;
  // any reconnection in the meantime is still refused by the sweep.
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; timedOut: boolean }
  >();
  const revalidate = async () => {
    if (closed) return;
    const gateway = getAgentletGateway();
    const connections = [
      ...(gateway?.getSessions(undefined, { status: 'connected' }) ?? []),
      ...(gateway?.getAgentlets({ status: 'connected' }) ?? []),
    ];
    try {
      const owners = new Set(
        connections.map((connection) => agentletOwner(connection.agentletId)),
      );
      await Promise.all(
        [...owners].map(async (owner) => {
          if (!owner) {
            for (const connection of connections)
              if (!agentletOwner(connection.agentletId))
                connection.disconnect('User device owner required');
            return;
          }
          const existing = pending.get(owner);
          if (existing) {
            if (existing.timedOut && !closed)
              disconnectAgentlets(owner, 'Device identity unavailable');
            return;
          }
          const check = {
            timedOut: false,
            timer: setTimeout(() => {
              check.timedOut = true;
              if (closed) return;
              try {
                disconnectAgentlets(owner, 'Device identity unavailable');
              } catch {
                // Ownership may have become unreadable while the lookup was
                // held. The captured connections must still fail closed.
                for (const connection of connections)
                  connection.disconnect('Device identity unavailable');
              }
            }, intervalMs),
          };
          check.timer.unref();
          pending.set(owner, check);
          try {
            const current = await service.resolvePrincipal?.(owner);
            if (!closed && !current?.member)
              disconnectAgentlets(owner, 'Device owner is not admitted');
          } catch {
            if (!closed)
              disconnectAgentlets(owner, 'Device identity unavailable');
          } finally {
            clearTimeout(check.timer);
            if (pending.get(owner) === check) pending.delete(owner);
          }
        }),
      );
    } catch {
      // An unreadable ownership map cannot make an existing device trusted.
      if (!closed)
        for (const connection of connections)
          connection.disconnect('Device identity unavailable');
    }
  };
  const timer = setInterval(() => {
    void revalidate().catch(() => {});
  }, intervalMs);
  timer.unref();
  app.addHook('preClose', async () => {
    closed = true;
    clearInterval(timer);
    for (const check of pending.values()) clearTimeout(check.timer);
    pending.clear();
  });
}

/**
 * Every credential names its owner's credential version: resetting it revokes
 * that person's device and reachback credentials, and nobody else's.
 */
const version = z.number().int().nonnegative();
const claimsSchema = z.discriminatedUnion('aud', [
  z
    .object({
      aud: z.literal('device'),
      principalId: z.string().min(1),
      v: version,
    })
    .strict(),
  z
    .object({
      aud: z.literal('rfs'),
      principalId: z.string().min(1),
      v: version,
      workspaceId: z.string().min(1),
      canvasId: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
]);
type Claims = z.infer<typeof claimsSchema>;
export type AgentReachback = Extract<Claims, { aud: 'rfs' }>;
const PREFIX = 'huabu-agent.v1.';
const ownersSchema = z.record(z.string(), z.string().min(1));
const versionsSchema = z.record(z.string(), version);

/** `agentletId -> principalId` for every device that ever connected as a user's. */
const OWNERS = { owner: null, name: 'device-owners' } as const;
/** `principalId -> version`; absent means version 0. */
const VERSIONS = { owner: null, name: 'agent-credential-versions' } as const;

function readOwners(): z.infer<typeof ownersSchema> {
  return ownersSchema.parse(getServerRecords().get(OWNERS) ?? {});
}

function readVersions(): z.infer<typeof versionsSchema> {
  return versionsSchema.parse(getServerRecords().get(VERSIONS) ?? {});
}

/** Device ownership is durable and never changes on reconnect or role changes. */
export function agentletOwner(agentletId: string): string | null {
  const owners = readOwners();
  return Object.hasOwn(owners, agentletId) ? owners[agentletId] : null;
}

function credentialVersion(principalId: string): number {
  const versions = readVersions();
  return Object.hasOwn(versions, principalId) ? versions[principalId] : 0;
}

/**
 * Revoke every device and reachback credential `principalId` holds, and
 * disconnect their devices and running agents. They reconnect with a new
 * connection command; nobody else's devices are affected.
 *
 * Their devices stay theirs: a device's Profiles and conversations are
 * authorized through its owner, so handing the device on would hand them on.
 */
export async function resetAgentCredentials(
  principalId: string,
): Promise<void> {
  await getServerRecords().update(VERSIONS, (current) => {
    const versions = versionsSchema.parse(current ?? {});
    const previous = Object.hasOwn(versions, principalId)
      ? versions[principalId]
      : 0;
    return { ...versions, [principalId]: previous + 1 };
  });
  disconnectAgentlets(principalId, 'Device credentials were reset');
}

/** Disconnect this owner's current and just-admitted connections without rotating credentials. */
export function disconnectAgentlets(principalId: string, reason: string): void {
  const disconnect = () => {
    const gateway = getAgentletGateway();
    for (const connection of [
      ...(gateway?.getSessions() ?? []),
      ...(gateway?.getAgentlets() ?? []),
    ])
      if (agentletOwner(connection.agentletId) === principalId)
        connection.disconnect(reason);
  };
  disconnect();
  // A handshake admitted just before disconnection registers its connection
  // once its authentication resolves, without another macrotask between
  // them; it is not in the Gateway yet, so sweep again once it is.
  setImmediate(disconnect);
}

type Unsigned = {
  [A in Claims['aud']]: Omit<Extract<Claims, { aud: A }>, 'v'>;
}[Claims['aud']];

function sign(claims: Unsigned): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, v: credentialVersion(claims.principalId) }),
  ).toString('base64url');
  const message = PREFIX + payload;
  const signature = createHmac('sha256', getConnectionToken())
    .update(message)
    .digest('base64url');
  return `${message}.${signature}`;
}

/**
 * The claims of a credential this Server signed, whatever version it carries.
 * Only {@link readAgentCredential} decides whether it is still honored.
 */
function signedClaims(token: string): Claims | null {
  if (!token.startsWith(PREFIX) || token.length > 8192) return null;
  const parts = token.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = createHmac('sha256', getConnectionToken())
    .update(PREFIX + payload)
    .digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const claims = claimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString()),
    );
    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
}

/** Purpose-separated credentials never expose the host's machine credential. */
export function readAgentCredential(token: string): Claims | null {
  const claims = signedClaims(token);
  return claims && claims.v === credentialVersion(claims.principalId)
    ? claims
    : null;
}

/** Why a device's credential is refused, in words its owner can act on. */
function refusedDeviceCredential(token: string): Error {
  return new Error(
    signedClaims(token)?.aud === 'device'
      ? 'Device credentials were reset; copy a new connection command from Devices and Agents'
      : 'User device credential required',
  );
}

export function ownDeviceCredential(): string {
  const principalId = personalSettingsOwner();
  return principalId
    ? sign({ aud: 'device', principalId })
    : getConnectionToken();
}

/** Local mode retains its single-owner devices; Bubble users have private ones. */
export function canUseAgentlet(
  agentletId: string,
  requestedId?: string,
): boolean {
  const owner = personalSettingsOwner();
  // Background recovery has no HTTP caller, but Bubble still requires a
  // durable owner. An old unowned workload must never receive the signing key.
  if (!owner && hostIdentity?.provider === 'bubble') {
    const expected = agentletOwner(requestedId ?? agentletId);
    return expected !== null && agentletOwner(agentletId) === expected;
  }
  const expected = requestedId ? agentletOwner(requestedId) : null;
  if (!owner && !expected) return true;
  const actual = agentletOwner(agentletId);
  return (!owner || actual === owner) && (!expected || actual === expected);
}

export function requireOwnAgentlet(agentletId: string): void {
  if (!canUseAgentlet(agentletId)) {
    const error = new Error('Device is unavailable to this user');
    Object.assign(error, { statusCode: 403, code: 'DEVICE_ACCESS_REQUIRED' });
    throw error;
  }
}

/** Called by the Gateway's existing host-owned authentication port. */
export function authenticateUserAgentlet(service: IdentityService) {
  return async (agentletId: string, token: string) => {
    const admitted = readAgentCredential(token);
    if (admitted?.aud !== 'device') throw refusedDeviceCredential(token);
    const identity = await service.resolvePrincipal?.(admitted.principalId);
    if (!identity?.member) throw new Error('Device owner is not admitted');
    // The credential may have been reset during the lookup, after its
    // devices were disconnected; this one is not connected yet.
    const claims = readAgentCredential(token);
    if (claims?.aud !== 'device') throw refusedDeviceCredential(token);
    // An admission mutation may have completed while a handshake's initial
    // lookup was pending; reusable credentials alone do not admit its owner.
    if (!(await service.resolvePrincipal?.(claims.principalId))?.member)
      throw new Error('Device owner is not admitted');
    if (!readAgentCredential(token)) throw refusedDeviceCredential(token);
    const owner = agentletOwner(agentletId);
    if (owner !== null && owner !== claims.principalId)
      throw new Error('Device belongs to another user');
    if (owner === null) {
      // Claims are serialized, so of two people racing for a new device the
      // second sees the first's claim here and is refused.
      await getServerRecords().update(OWNERS, (current) => {
        const owners = ownersSchema.parse(current ?? {});
        if (
          Object.hasOwn(owners, agentletId) &&
          owners[agentletId] !== claims.principalId
        )
          throw new Error('Device belongs to another user');
        return { ...owners, [agentletId]: claims.principalId };
      });
      // A reset that completed while the claim was being written has already
      // swept connected devices; this one is not connected yet.
      if (!readAgentCredential(token)) throw refusedDeviceCredential(token);
    }
    return { metadata: { principalId: claims.principalId } };
  };
}

/** Resolved at spawn time; credentials never enter a persisted workload spec. */
export async function agentReachbackEnvironment(spec: {
  agentletId?: string;
  env?: Record<string, string>;
}): Promise<Record<string, string> | undefined> {
  if (!spec.agentletId) return undefined;
  const principalId = agentletOwner(spec.agentletId);
  requireOwnAgentlet(spec.agentletId);
  if (
    hostIdentity?.provider === 'bubble' &&
    (!principalId ||
      !(await hostIdentity.resolvePrincipal?.(principalId))?.member)
  ) {
    const error = new Error('Device owner is not admitted');
    Object.assign(error, { statusCode: 403, code: 'DEVICE_ACCESS_REQUIRED' });
    throw error;
  }
  if (!principalId) {
    return { HUABU_RFS_TOKEN: getConnectionToken() };
  }
  const url = spec.env?.HUABU_RFS_URL;
  const threadId = spec.env?.HUABU_THREAD_ID;
  const path = url
    ? new URL(url).pathname.split('/').map(decodeURIComponent)
    : [];
  if (
    path.length !== 6 ||
    path[1] !== 'api' ||
    path[2] !== 'rfs' ||
    path[3] !== 'w' ||
    !threadId
  )
    throw new Error(
      'A personal agent must have a Workspace, Space and conversation',
    );
  return {
    HUABU_RFS_TOKEN: sign({
      aud: 'rfs',
      principalId,
      workspaceId: path[4],
      canvasId: path[5],
      threadId,
    }),
  };
}
