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
      const owners = new Set(connections.map(connectedAgentletOwner));
      await Promise.all(
        [...owners].map(async (owner) => {
          if (!owner) {
            for (const connection of connections)
              if (!connectedAgentletOwner(connection))
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

/**
 * Which devices one operation may use, decided against one view of device
 * ownership. Local mode retains its single-owner devices; Bubble users have
 * private ones.
 */
export interface DeviceAccess {
  /** The device's durable owner, or `null` for an unowned device. */
  owner(agentletId: string): string | null;
  /**
   * Whether the caller may use `agentletId`, and, when the caller asked for
   * `requestedId` and was placed on `agentletId`, whether both belong to the
   * same owner.
   */
  canUse(agentletId: string, requestedId?: string): boolean;
  /** @throws a 403 error when {@link canUse} refuses `agentletId`. */
  require(agentletId: string): void;
}

function deviceAccess(
  owner: (agentletId: string) => string | null,
): DeviceAccess {
  const canUse = (agentletId: string, requestedId?: string) => {
    const person = personalSettingsOwner();
    // Background recovery has no HTTP caller, but Bubble still requires a
    // durable owner. An old unowned workload must never receive the signing key.
    if (!person && hostIdentity?.provider === 'bubble') {
      const expected = owner(requestedId ?? agentletId);
      return expected !== null && owner(agentletId) === expected;
    }
    const expected = requestedId ? owner(requestedId) : null;
    if (!person && !expected) return true;
    const actual = owner(agentletId);
    return (!person || actual === person) && (!expected || actual === expected);
  };
  return {
    owner,
    canUse,
    require(agentletId) {
      if (canUse(agentletId)) return;
      const error = new Error('Device is unavailable to this user');
      Object.assign(error, { statusCode: 403, code: 'DEVICE_ACCESS_REQUIRED' });
      throw error;
    },
  };
}

/**
 * Device access as recorded in storage, read once. Use it for devices that
 * may not be connected, and keep the result for the rest of one operation
 * rather than reading again per device.
 */
export async function readDeviceAccess(): Promise<DeviceAccess> {
  const owners = ownersSchema.parse(
    (await getServerRecords().get(OWNERS)) ?? {},
  );
  return deviceAccess((agentletId) =>
    Object.hasOwn(owners, agentletId) ? owners[agentletId] : null,
  );
}

/**
 * The owner a connection was admitted for. A handshake records the device's
 * owner, or refuses a credential that does not match it, before admitting
 * the connection, and ownership never changes, so this is the recorded owner
 * without reading it. `null` for a device that needs no owner, as in local
 * mode.
 */
export function connectedAgentletOwner(connection: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): string | null {
  const principalId = connection.metadata['principalId'];
  return typeof principalId === 'string' ? principalId : null;
}

/**
 * Device access decided from the Gateway's live connections, without reading
 * storage. Only connected devices have an owner here, so use it only where
 * the devices in question are connected ones, such as placing work on a
 * connected device.
 */
export function connectedDeviceAccess(): DeviceAccess {
  const gateway = getAgentletGateway();
  return deviceAccess((agentletId) => {
    const connection = gateway?.getAgentlet(agentletId);
    return connection ? connectedAgentletOwner(connection) : null;
  });
}

/** Device ownership is durable and never changes on reconnect or role changes. */
export async function agentletOwner(
  agentletId: string,
): Promise<string | null> {
  return (await readDeviceAccess()).owner(agentletId);
}

/** {@link DeviceAccess.require} for one device, reading ownership once. */
export async function requireOwnAgentlet(agentletId: string): Promise<void> {
  (await readDeviceAccess()).require(agentletId);
}

async function credentialVersion(principalId: string): Promise<number> {
  const versions = versionsSchema.parse(
    (await getServerRecords().get(VERSIONS)) ?? {},
  );
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
      if (connectedAgentletOwner(connection) === principalId)
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

async function sign(claims: Unsigned): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      v: await credentialVersion(claims.principalId),
    }),
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

/**
 * Whether `token` is a credential this Server signed, revoked or not. It
 * reads nothing; only {@link readAgentCredential} decides whether to honor it.
 */
export function isAgentCredential(token: string): boolean {
  return signedClaims(token) !== null;
}

/**
 * Purpose-separated credentials never expose the host's machine credential.
 * Reads the owner's current credential version on every call, so a reset
 * made by any process revokes the credential at its next use.
 */
export async function readAgentCredential(
  token: string,
): Promise<Claims | null> {
  const claims = signedClaims(token);
  return claims && claims.v === (await credentialVersion(claims.principalId))
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

export async function ownDeviceCredential(): Promise<string> {
  const principalId = personalSettingsOwner();
  return principalId
    ? sign({ aud: 'device', principalId })
    : getConnectionToken();
}

/** Called by the Gateway's existing host-owned authentication port. */
export function authenticateUserAgentlet(service: IdentityService) {
  return async (agentletId: string, token: string) => {
    const admitted = await readAgentCredential(token);
    if (admitted?.aud !== 'device') throw refusedDeviceCredential(token);
    const identity = await service.resolvePrincipal?.(admitted.principalId);
    if (!identity?.member) throw new Error('Device owner is not admitted');
    // The credential may have been reset during the lookup, after its
    // devices were disconnected; this one is not connected yet.
    const claims = await readAgentCredential(token);
    if (claims?.aud !== 'device') throw refusedDeviceCredential(token);
    // An admission mutation may have completed while a handshake's initial
    // lookup was pending; reusable credentials alone do not admit its owner.
    if (!(await service.resolvePrincipal?.(claims.principalId))?.member)
      throw new Error('Device owner is not admitted');
    if (!(await readAgentCredential(token)))
      throw refusedDeviceCredential(token);
    const owner = await agentletOwner(agentletId);
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
      if (!(await readAgentCredential(token)))
        throw refusedDeviceCredential(token);
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
  const access = await readDeviceAccess();
  const principalId = access.owner(spec.agentletId);
  access.require(spec.agentletId);
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
    HUABU_RFS_TOKEN: await sign({
      aud: 'rfs',
      principalId,
      workspaceId: path[4],
      canvasId: path[5],
      threadId,
    }),
  };
}
