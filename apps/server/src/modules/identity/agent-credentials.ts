// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { personalSettingsOwner } from './personal-settings.js';
import { getConnectionToken } from '../../connection-token.js';
import { getDataDir } from '../../data-dir.js';
import { atomicWriteJson, readJsonStrict } from '../../utils/fs.js';

import type { IdentityService } from './service.js';

const claimsSchema = z.discriminatedUnion('aud', [
  z
    .object({ aud: z.literal('device'), principalId: z.string().min(1) })
    .strict(),
  z
    .object({
      aud: z.literal('rfs'),
      principalId: z.string().min(1),
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

function ownersPath(): string {
  return join(getDataDir(), 'agentlet-owners.json');
}

/** Device ownership is durable and never changes on reconnect or role changes. */
export function agentletOwner(agentletId: string): string | null {
  const owners = ownersSchema.parse(readJsonStrict(ownersPath()) ?? {});
  return Object.hasOwn(owners, agentletId) ? owners[agentletId] : null;
}

function sign(claims: Claims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message = PREFIX + payload;
  const signature = createHmac('sha256', getConnectionToken())
    .update(message)
    .digest('base64url');
  return `${message}.${signature}`;
}

/** Purpose-separated credentials never expose the host's machine credential. */
export function readAgentCredential(token: string): Claims | null {
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
    const parsed = claimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString()),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  if (!owner && process.env.HUABU_IDENTITY_PROVIDER === 'bubble') {
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
    const claims = readAgentCredential(token);
    if (claims?.aud !== 'device')
      throw new Error('User device credential required');
    const identity = await service.resolvePrincipal?.(claims.principalId);
    if (!identity?.member) throw new Error('Device owner is not admitted');
    const owners = ownersSchema.parse(readJsonStrict(ownersPath()) ?? {});
    if (
      Object.hasOwn(owners, agentletId) &&
      owners[agentletId] !== claims.principalId
    )
      throw new Error('Device belongs to another user');
    if (!Object.hasOwn(owners, agentletId))
      atomicWriteJson(ownersPath(), {
        ...owners,
        [agentletId]: claims.principalId,
      });
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
  if (!principalId) {
    requireOwnAgentlet(spec.agentletId);
    return { HUABU_RFS_TOKEN: getConnectionToken() };
  }
  requireOwnAgentlet(spec.agentletId);
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
