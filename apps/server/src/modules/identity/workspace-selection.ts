// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { WorkspacePreferences } from './preferences.js';
import type { ResolvedIdentity, ResourceDirectory } from './service.js';
import type { WorkspaceScope } from '../workspace/context.js';

/**
 * One personal-Workspace creation per principal, however many first requests
 * race. Keyed by directory too, so separate hosts never share a creation.
 */
const provisioning = new WeakMap<
  ResourceDirectory,
  Map<string, Promise<WorkspaceScope>>
>();

/**
 * The Workspace a Bubble request runs in: its caller's current one, while they
 * may still enter it. Otherwise the first Workspace they may enter, which
 * becomes current. A member who may enter none gets a personal Workspace that
 * they own. `null` for a caller with no Workspace at all, such as an
 * administrator before any exists.
 */
export async function selectRequestWorkspace(
  identity: ResolvedIdentity,
  preferences: WorkspacePreferences,
  resources: ResourceDirectory,
): Promise<WorkspaceScope | null> {
  const { principalId } = identity.principal;
  const allowed = await identity.access.workspaces();
  const may = (workspaceId: string) =>
    allowed === 'all' || allowed.includes(workspaceId);

  const preferred = await preferences.current(principalId);
  if (preferred && may(preferred)) {
    const scope = await resources.openWorkspace(preferred);
    if (scope) return scope;
  }

  const chosen = await firstEnterable(allowed, resources);
  if (chosen) {
    await preferences.select(principalId, chosen.handle.workspaceId);
    return chosen;
  }
  if (allowed === 'all') return null;
  return provisionPersonalWorkspace(identity, preferences, resources);
}

/**
 * Make one Workspace its caller's current one. Refused, with nothing changed,
 * for a Workspace the caller may not enter or that does not exist.
 */
export async function chooseRequestWorkspace(
  identity: ResolvedIdentity,
  preferences: WorkspacePreferences,
  resources: ResourceDirectory,
  workspaceId: string,
): Promise<WorkspaceScope | null> {
  const allowed = await identity.access.workspaces();
  if (allowed !== 'all' && !allowed.includes(workspaceId)) return null;
  const scope = await resources.openWorkspace(workspaceId);
  if (scope)
    await preferences.select(identity.principal.principalId, workspaceId);
  return scope;
}

async function firstEnterable(
  allowed: readonly string[] | 'all',
  resources: ResourceDirectory,
): Promise<WorkspaceScope | null> {
  // An administrator lands where the Server already is, as before.
  if (allowed === 'all') return resources.defaultWorkspace();
  for (const workspaceId of allowed) {
    const scope = await resources.openWorkspace(workspaceId);
    if (scope) return scope;
  }
  return null;
}

function provisionPersonalWorkspace(
  identity: ResolvedIdentity,
  preferences: WorkspacePreferences,
  resources: ResourceDirectory,
): Promise<WorkspaceScope> {
  const { principalId, displayName } = identity.principal;
  let pending = provisioning.get(resources);
  if (!pending) provisioning.set(resources, (pending = new Map()));
  const running = pending.get(principalId);
  if (running) return running;
  const creating = (async () => {
    // Recheck grants: the preference can be stale after revocation, or a
    // racing first request may just have claimed its personal Workspace.
    const already = await preferences.current(principalId);
    const allowed = await identity.access.workspaces();
    const existing =
      already && (allowed === 'all' || allowed.includes(already))
        ? await resources.openWorkspace(already)
        : null;
    if (existing) return existing;
    const scope = await resources.createWorkspace(
      `${displayName?.trim() || principalId}'s Workspace`,
    );
    await identity.access.claim({
      type: 'workspace',
      id: scope.handle.workspaceId,
    });
    await preferences.select(principalId, scope.handle.workspaceId);
    return scope;
  })().finally(() => pending.delete(principalId));
  pending.set(principalId, creating);
  return creating;
}
