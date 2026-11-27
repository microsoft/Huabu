// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Whose settings a call reads and writes.
 *
 * In Bubble mode every admitted user, including administrators, has their own
 * settings, model keys and connected credentials: a
 * call made for a member, and everything it starts (an agent run included),
 * runs in that member's personal settings namespace, and the secret store and
 * settings records answer from it. Local mode and the machine
 * credential never open one, so they read the deployment's, exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import type { ResolvedIdentity, ResourceAccess } from './service.js';
import type { ServerRecordKey, ServerRecordName } from '../storage/index.js';

interface Slot {
  /** Whose personal settings this call uses; `null` for the deployment's. */
  principalId: string | null;
  /**
   * What the caller may reach, for work that outlives the request and no
   * longer has it (an agent run's tools). `null` for an unrestricted caller.
   */
  access: ResourceAccess | null;
}

const storage = new AsyncLocalStorage<Slot>();

/** Run `fn` with an empty slot that {@link usePersonalSettings} may fill. */
export function openPersonalSettings<T>(fn: () => T): T {
  return storage.run({ principalId: null, access: null }, fn);
}

/**
 * Record who the call this runs inside is for: a member's own settings and
 * access, including administrators.
 */
export function useCaller(identity: ResolvedIdentity): void {
  const slot = storage.getStore();
  if (!slot) throw new Error('No settings scope is open for this call');
  const personal = identity.member;
  const principalId = personal ? identity.principal.principalId : null;
  if (slot.principalId && slot.principalId !== principalId)
    throw new Error('This call already runs as another person');
  slot.principalId = principalId;
  slot.access = identity.access;
}

/**
 * The access of the caller this call runs for, or `null` when it is
 * unrestricted (local mode, the machine credential, startup work).
 */
export function callerAccess(): ResourceAccess | null {
  return storage.getStore()?.access ?? null;
}

/** The member whose settings this call uses, or `null` for the deployment's. */
export function personalSettingsOwner(): string | null {
  return storage.getStore()?.principalId ?? null;
}

/**
 * A person's opaque key: the same for the same principal, safe as a path
 * segment or column value, and revealing nothing about the account.
 */
function personKey(principalId: string): string {
  return createHash('sha256').update(principalId).digest('hex').slice(0, 32);
}

/**
 * Which server record holds this call's copy of `name`: the deployment's,
 * or the member's own in their personal settings namespace.
 */
export function settingsRecordKey(name: ServerRecordName): ServerRecordKey {
  return { owner: personalOwnerKey(), name };
}

/**
 * The opaque key of the member this call is for, or `null` when it reads the
 * deployment's own copy. For state kept per person outside server records.
 */
export function personalOwnerKey(): string | null {
  const owner = personalSettingsOwner();
  return owner ? personKey(owner) : null;
}

/**
 * The secret id this call stores `id` under: itself for the deployment, and
 * namespaced for a member, so one person's keys are never another's.
 */
export function personalSecretId(id: string): string {
  const owner = personalSettingsOwner();
  return owner ? `person:${personKey(owner)}:${id}` : id;
}
