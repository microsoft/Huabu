import { randomBytes } from 'node:crypto';

import { RESOURCE_GRANT_ENV } from '@huabu/shared';

import { HostedCapabilityError } from './errors.js';

const GRANT_TTL_MS = 24 * 60 * 60 * 1_000;
const POLICY_VERSION = 1;

export interface ResourceGrant {
  agentletId: string;
  profileId: string;
  canvasId: string;
  threadId: string;
  allowedResourceIds: ReadonlySet<string>;
  expiresAt: number;
  policyVersion: number;
}

const grants = new Map<string, ResourceGrant>();
const tokensByScope = new Map<string, string>();
const activeInvocations = new Map<string, number>();

export interface IssueResourceGrantInput {
  agentletId: string;
  profileId: string;
  canvasId: string;
  threadId: string;
  allowedResourceIds: readonly string[];
}

function grantScopeKey(
  grant: Pick<
    ResourceGrant,
    'agentletId' | 'profileId' | 'canvasId' | 'threadId'
  >,
): string {
  return [
    grant.agentletId,
    grant.profileId,
    grant.canvasId,
    grant.threadId,
  ].join('\u0000');
}

function deleteGrant(token: string, grant: ResourceGrant): void {
  grants.delete(token);
  const scopeKey = grantScopeKey(grant);
  if (tokensByScope.get(scopeKey) === token) {
    tokensByScope.delete(scopeKey);
  }
}

function pruneExpiredGrants(now = Date.now()): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) {
      deleteGrant(token, grant);
    }
  }
}

export function issueResourceGrant(
  input: IssueResourceGrantInput,
): Record<typeof RESOURCE_GRANT_ENV, string> {
  pruneExpiredGrants();
  const token = randomBytes(32).toString('base64url');
  const grant: ResourceGrant = {
    ...input,
    allowedResourceIds: new Set(input.allowedResourceIds),
    expiresAt: Date.now() + GRANT_TTL_MS,
    policyVersion: POLICY_VERSION,
  };
  const scopeKey = grantScopeKey(grant);
  const previousToken = tokensByScope.get(scopeKey);
  if (previousToken) {
    const previousGrant = grants.get(previousToken);
    if (previousGrant) deleteGrant(previousToken, previousGrant);
  }
  grants.set(token, grant);
  tokensByScope.set(scopeKey, token);
  return { [RESOURCE_GRANT_ENV]: token };
}

export function authorizeResourceGrant(
  token: string | undefined,
  canvasId: string,
  resourceId: string,
): ResourceGrant {
  pruneExpiredGrants();
  if (!token) {
    throw new HostedCapabilityError(
      'forbidden',
      'A session resource grant is required.',
    );
  }
  const grant = grants.get(token);
  if (!grant) {
    throw new HostedCapabilityError(
      'forbidden',
      'The session resource grant is invalid or expired.',
    );
  }
  if (
    grant.canvasId !== canvasId ||
    !grant.allowedResourceIds.has(resourceId)
  ) {
    throw new HostedCapabilityError(
      'forbidden',
      'The session resource grant does not allow this invocation.',
    );
  }
  return grant;
}

export function acquireInvocation(
  token: string,
  resourceId: string,
): () => void {
  const grant = grants.get(token);
  if (
    !grant ||
    grant.expiresAt <= Date.now() ||
    !grant.allowedResourceIds.has(resourceId)
  ) {
    if (grant?.expiresAt && grant.expiresAt <= Date.now()) {
      deleteGrant(token, grant);
    }
    throw new HostedCapabilityError(
      'forbidden',
      'The session resource grant is invalid or expired.',
    );
  }
  const key = `${grantScopeKey(grant)}\u0000${resourceId}`;
  const active = activeInvocations.get(key) ?? 0;
  const limit = resourceId === 'generate-image' ? 1 : 4;
  if (active >= limit) {
    throw new HostedCapabilityError(
      'quota_exceeded',
      'The hosted capability concurrency limit has been reached.',
    );
  }
  activeInvocations.set(key, active + 1);
  return () => {
    const remaining = (activeInvocations.get(key) ?? 1) - 1;
    if (remaining <= 0) activeInvocations.delete(key);
    else activeInvocations.set(key, remaining);
  };
}

export function resetResourceGrantsForTests(): void {
  grants.clear();
  tokensByScope.clear();
  activeInvocations.clear();
}
