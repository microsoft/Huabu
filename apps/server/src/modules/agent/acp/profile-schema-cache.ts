/**
 * Per-profile ACP meta cache — `profileId → last-known
 * AcpSessionPersistedMeta`.
 *
 * ### Motivation
 *
 * The per-`(canvasId, threadId)` cache in `session-store` requires
 * spawning the agent at least once per thread before the toolbar
 * selectors (model / mode / config option) can populate. But for any
 * given profile (e.g. "Copilot @ ~/projects/foo"), the schema portion
 * of the meta — `availableModels`, `availableModes`, `configOptions`
 * shape — is **identical across every thread bound to that profile**.
 * Only the `current*` values are per-thread state.
 *
 * By caching the most recent push from any session of a profile, the
 * toolbar can render immediately on a brand-new thread **without
 * spawning** the agent. The user can browse model / mode options, see
 * the same defaults they used last time, and only when they actually
 * pick something different (or send a message) do we incur the
 * spawn cost.
 *
 * ### What gets cached
 *
 * The full {@link AcpSessionPersistedMeta} shape — schema (lists) AND
 * last-known state (`currentModelId`, `currentModeId`, per-option
 * `currentValue`). The state is treated as a "best-effort default"
 * for a new thread: if the agent disagrees on session/new it will
 * push corrections via SSE and overwrite. This matches the user
 * expectation of "use my usual settings" when starting a new chat.
 *
 * `availableCommands` is intentionally **excluded** — slash command
 * catalogues can vary per session (some agents expose
 * session-specific commands like `/load <previous-session-id>`).
 * Those still come from per-thread state only.
 *
 * ### Storage shape
 *
 *   data/acp-profile-schema-cache.json
 *     {
 *       "schemaVersion": 1,
 *       "profiles": {
 *         "<profileId>": { ...AcpSessionPersistedMeta (sans
 *                          availableCommands) }
 *       }
 *     }
 *
 * Lives next to `agent-profiles.json` because it's profile-scoped,
 * not canvas-scoped (so it can be reused across canvases).
 *
 * ### Concurrency / lifecycle
 *
 * In-memory `Map` is the source of truth at runtime; disk write is
 * debounced per profile (250 ms tail) to coalesce bursty updates
 * from `handleSessionMetaUpdate`. The map is lazy-loaded on first
 * access; corrupt / missing file ⇒ empty map (never throws).
 *
 * Cross-process concurrency is out of scope — Sediment is single
 * instance per workspace.
 */

import path from 'node:path';

import { getDataDir } from '../../../data-dir.js';
import { atomicWriteJson, readJson } from '../../storage/io.js';

import type {
  AcpCost,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
} from '@sediment/shared';

const CACHE_FILE = 'acp-profile-schema-cache.json';
const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 250;

/**
 * Subset of {@link AcpSessionPersistedMeta} suitable for per-profile
 * caching. `availableCommands` is excluded (per-session). Everything
 * else mirrors the on-the-wire snapshot shape — schema fields are
 * shared across all threads of the profile; `current*` fields are
 * stored as "last-known default" for a new thread.
 */
export interface AcpProfileSchemaCacheEntry {
  availableModes?: AcpSessionMode[];
  currentModeId?: string | null;
  availableModels?: AcpModelInfo[];
  currentModelId?: string | null;
  configOptions?: AcpSessionConfigOption[];
  /**
   * Epoch ms of the last write; mirrors {@link AcpSessionPersistedMeta.metaUpdatedAt}
   * so the cached-meta route can project this into the wire snapshot's
   * `updatedAt` field.
   */
  metaUpdatedAt?: number;
}

interface CacheFile {
  schemaVersion: number;
  profiles: Record<string, AcpProfileSchemaCacheEntry>;
}

function cachePath(): string {
  return path.join(getDataDir(), CACHE_FILE);
}

/** Lazy module-level state — loaded from disk on first access. */
let memoryCache: Map<string, AcpProfileSchemaCacheEntry> | null = null;
let loaded = false;
const pendingWriteTimers = new Map<string, NodeJS.Timeout>();

function ensureLoaded(): Map<string, AcpProfileSchemaCacheEntry> {
  if (loaded && memoryCache) return memoryCache;
  memoryCache = new Map();
  loaded = true;
  const raw = readJson<unknown>(cachePath());
  if (!raw || typeof raw !== 'object') return memoryCache;
  const file = raw as Record<string, unknown>;
  const profiles = file.profiles;
  if (!profiles || typeof profiles !== 'object') return memoryCache;
  for (const [profileId, value] of Object.entries(profiles)) {
    const entry = sanitizeEntry(value);
    if (entry) memoryCache.set(profileId, entry);
  }
  return memoryCache;
}

/**
 * Defensively shape-check a cached entry loaded from disk. Drops any
 * field that fails minimal type validation; returns `undefined` when
 * NO field validates (caller treats as cache miss for that profile).
 */
function sanitizeEntry(raw: unknown): AcpProfileSchemaCacheEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: AcpProfileSchemaCacheEntry = {};
  let touched = false;
  if (Array.isArray(r.availableModes)) {
    out.availableModes = r.availableModes as AcpSessionMode[];
    touched = true;
  }
  if (r.currentModeId === null || typeof r.currentModeId === 'string') {
    out.currentModeId = r.currentModeId as string | null;
    touched = true;
  }
  if (Array.isArray(r.availableModels)) {
    out.availableModels = r.availableModels as AcpModelInfo[];
    touched = true;
  }
  if (r.currentModelId === null || typeof r.currentModelId === 'string') {
    out.currentModelId = r.currentModelId as string | null;
    touched = true;
  }
  if (Array.isArray(r.configOptions)) {
    out.configOptions = r.configOptions as AcpSessionConfigOption[];
    touched = true;
  }
  if (typeof r.metaUpdatedAt === 'number') {
    out.metaUpdatedAt = r.metaUpdatedAt;
    touched = true;
  }
  // Touch unused `AcpCost` import (it's transitively referenced by
  // configOptions / usage in the parent type but TS doesn't see it).
  void (null as unknown as AcpCost | null);
  return touched ? out : undefined;
}

/**
 * Read the cached schema entry for a profile. Returns `null` when
 * no session of this profile has ever pushed meta on this server.
 *
 * Never throws — a corrupt cache file just yields a miss.
 */
export function getProfileSchemaCache(
  profileId: string,
): AcpProfileSchemaCacheEntry | null {
  if (!profileId) return null;
  return ensureLoaded().get(profileId) ?? null;
}

/**
 * Merge a partial entry update into the cached profile schema and
 * schedule a debounced disk write. Used by the session-meta update
 * handlers to mirror schema/state pushes into the profile cache.
 *
 * Field-level merge: `undefined` fields preserve prior values;
 * explicit `null` (e.g. for `currentModelId` reset) overwrites.
 * Schema-list fields (`availableModes` / `availableModels` /
 * `configOptions`) replace wholesale when present, matching the
 * `apply*Update` semantics on the session entry.
 */
export function mergeProfileSchemaCache(
  profileId: string,
  patch: AcpProfileSchemaCacheEntry,
): void {
  if (!profileId) return;
  const cache = ensureLoaded();
  const prior = cache.get(profileId) ?? {};
  const next: AcpProfileSchemaCacheEntry = { ...prior };

  if (patch.availableModes !== undefined) {
    next.availableModes = patch.availableModes;
  }
  if ('currentModeId' in patch) {
    next.currentModeId = patch.currentModeId ?? null;
  }
  if (patch.availableModels !== undefined) {
    next.availableModels = patch.availableModels;
  }
  if ('currentModelId' in patch) {
    next.currentModelId = patch.currentModelId ?? null;
  }
  if (patch.configOptions !== undefined) {
    next.configOptions = patch.configOptions;
  }
  next.metaUpdatedAt = patch.metaUpdatedAt ?? Date.now();

  cache.set(profileId, next);
  scheduleWrite();
}

/**
 * Debounced single-flight write of the WHOLE cache file. Coalesces
 * bursts (e.g. config_option_update + current_mode_update arriving
 * within milliseconds of each other on session warm-up).
 */
function scheduleWrite(): void {
  const prior = pendingWriteTimers.get('global');
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingWriteTimers.delete('global');
    try {
      const file: CacheFile = {
        schemaVersion: SCHEMA_VERSION,
        profiles: Object.fromEntries(ensureLoaded()),
      };
      atomicWriteJson(cachePath(), file);
    } catch {
      // Best-effort. A failed write is recovered on the next update.
    }
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingWriteTimers.set('global', timer);
}

/**
 * Test helper: wipe in-memory state so the next `ensureLoaded` re-reads
 * from disk. Intended for unit tests; production code never calls this.
 */
export function __resetProfileSchemaCacheForTests(): void {
  memoryCache = null;
  loaded = false;
  for (const t of pendingWriteTimers.values()) clearTimeout(t);
  pendingWriteTimers.clear();
}
