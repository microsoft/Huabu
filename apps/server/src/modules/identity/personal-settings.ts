// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Whose settings a call reads and writes.
 *
 * The deployment's settings, model keys and connected credentials belong to
 * its administrators. In Bubble mode every member has their own instead: a
 * call made for a member, and everything it starts (an agent run included),
 * runs in that member's personal settings namespace, and the secret store and
 * settings files answer from it. Local mode, administrators and the machine
 * credential never open one, so they read the deployment's, exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { getDataDir } from '../../data-dir.js';

import type { ResolvedIdentity, ResourceAccess } from './service.js';

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
 * access, or an administrator's access over the deployment's settings.
 */
export function useCaller(identity: ResolvedIdentity): void {
  const slot = storage.getStore();
  if (!slot) throw new Error('No settings scope is open for this call');
  const personal = identity.member && !identity.owner;
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

/** A name safe for a directory, the same for the same principal. */
function personKey(principalId: string): string {
  return createHash('sha256').update(principalId).digest('hex').slice(0, 32);
}

/**
 * Where a settings file lives for this call: in the data directory for the
 * deployment, under `people/<key>/` for a member.
 */
export function settingsFilePath(fileName: string): string {
  const owner = personalSettingsOwner();
  return owner
    ? path.join(getDataDir(), 'people', personKey(owner), fileName)
    : path.join(getDataDir(), fileName);
}

/**
 * The secret id this call stores `id` under: itself for the deployment, and
 * namespaced for a member, so one person's keys are never another's.
 */
export function personalSecretId(id: string): string {
  const owner = personalSettingsOwner();
  return owner ? `person:${personKey(owner)}:${id}` : id;
}
