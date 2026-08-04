/**
 * File-backed CRUD store for user-configured external agent profiles.
 *
 * Profiles are long-lived spawn recipes (cli + cwd + flags) persisted
 * to `data/agent-profiles.json`. Each one names a way to launch one
 * external agent process on demand via the embedded daemon (see
 * `@agenetes/agentlet-host`).
 *
 * Why a tiny dedicated file instead of the existing `external-agents.
 * json`: the legacy file stored alias-only canvas bindings (see
 * `modules/agent/external-agents-store.ts`); profiles carry richer
 * spawn-time configuration the user edits in Settings. Mixing the two
 * shapes inside a single file would force a schema migration every
 * time either side changed. Keep them separate.
 *
 * Concurrency model: this module is loaded once per server process
 * and writes through `atomicWriteJson`, so two routes inside the same
 * server cannot race. Multiple servers writing to the same workspace
 * is intentionally out of scope — Sediment is single-instance per
 * workspace.
 */

import { chmodSync } from 'node:fs';
import path from 'node:path';

import { acpAgentProfileSchema } from '@sediment/shared';

import { getDataDir } from '../../../data-dir.js';
import { atomicWriteJson, readJson } from '../../../utils/fs.js';

import type { AcpAgentProfile } from '@sediment/shared';

/** Persistence file name under `data/`. */
const PROFILES_FILE = 'agent-profiles.json';

/** Current on-disk schema version. Bump on incompatible changes. */
const SCHEMA_VERSION = 1;

interface ProfileStoreFile {
  schemaVersion: number;
  profiles: AcpAgentProfile[];
}

function profilesPath(): string {
  return path.join(getDataDir(), PROFILES_FILE);
}

/**
 * Best-effort tighten the file mode to user-only after write. We
 * write through `atomicWriteJson` (renames a `.tmp` over the target)
 * so the chmod has to be reapplied after every save; failures are
 * non-fatal (Windows ignores chmod, posix may already be 0600 by
 * inheritance — neither is worth aborting over).
 */
function lockdownFile(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort. Some platforms (Windows) don't honour POSIX modes.
  }
}

function loadAll(): AcpAgentProfile[] {
  const file = readJson<ProfileStoreFile>(profilesPath());
  if (!file || !Array.isArray(file.profiles)) return [];

  // Validate each record through the shared zod schema so the wire
  // contract and the on-disk contract can't drift. Malformed entries
  // are dropped rather than throwing — a single hand-edited record
  // shouldn't bring down the whole store.
  const out: AcpAgentProfile[] = [];
  for (const raw of file.profiles) {
    const parsed = acpAgentProfileSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function saveAll(profiles: AcpAgentProfile[]): void {
  const file: ProfileStoreFile = {
    schemaVersion: SCHEMA_VERSION,
    profiles,
  };
  const target = profilesPath();
  atomicWriteJson(target, file);
  lockdownFile(target);
}

/** Return every profile, ordered by `createdAt` ascending (stable). */
export function listProfiles(): AcpAgentProfile[] {
  return [...loadAll()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Lookup by id; returns `null` when not found. */
export function getProfile(id: string): AcpAgentProfile | null {
  return loadAll().find((p) => p.id === id) ?? null;
}

/**
 * Insert a new profile. The caller supplies every field including
 * `id` and timestamps — id allocation and timestamp generation are
 * the route's responsibility so a `create` retry can be idempotent
 * by passing the previous id.
 */
export function insertProfile(profile: AcpAgentProfile): void {
  const all = loadAll();
  if (all.some((p) => p.id === profile.id)) {
    throw new Error(`Profile with id ${profile.id} already exists`);
  }
  all.push(profile);
  saveAll(all);
}

/**
 * Patch an existing profile. Mutates the record in place; throws
 * when no profile matches `id`. The route bumps `updatedAt` before
 * calling this; we never touch timestamps here.
 */
export function updateProfile(
  id: string,
  patch: Partial<Omit<AcpAgentProfile, 'id' | 'createdAt'>>,
): AcpAgentProfile {
  const all = loadAll();
  const idx = all.findIndex((p) => p.id === id);
  const current = all[idx];
  if (!current) throw new Error(`Profile with id ${id} not found`);
  const next: AcpAgentProfile = { ...current, ...patch, id: current.id };
  all[idx] = next;
  saveAll(all);
  return next;
}

/** Remove a profile by id. Returns `true` when something was removed. */
export function deleteProfile(id: string): boolean {
  const all = loadAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  saveAll(next);
  return true;
}

/** Remove migrated records while retaining legacy Agent Team profiles. */
export function removeProfiles(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const migrated = new Set(ids);
  saveAll(loadAll().filter((profile) => !migrated.has(profile.id)));
}

/** Test-only: wipe the on-disk store. */
export function _wipeProfilesForTests(): void {
  saveAll([]);
}
