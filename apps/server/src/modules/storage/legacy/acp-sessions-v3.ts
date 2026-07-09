/**
 * FROZEN legacy schema — the pre-Agenetes ACP session store (v3).
 *
 * This module is a snapshot of the on-disk shape the ACP driver once
 * persisted to `<namespace.storage.root>/acp-sessions.json` (recovered
 * from `git show d84783a5~1:external/agenetes/packages/acp-driver/src/session-store.ts`,
 * the last commit before that store was removed). It exists ONLY so the
 * boot migrator can read the legacy `acp-sessions.json` and fold each
 * self-contained v3 record forward into a new Agenetes `threads.json`
 * `ThreadRecord`.
 *
 * ### Frozen, v3-only
 *
 * The migrator's only dependency on the past is this inert descriptor —
 * never any live driver code (which no longer writes this file). Per the
 * "只从最新升级" decision we migrate ONLY v3 records: a record is v3 when
 * it carries a `bindingRecipe` (the self-contained spawn snapshot). v2
 * records (recipe-absent) would require a profile lookup to reconstruct a
 * spec and are intentionally skipped — real workspaces contain zero of
 * them. v1 records never reach here.
 *
 * Only stable ACP SDK wire-types are referenced by `import type`; there
 * are no behavioural host imports and no file IO (the migrator owns the
 * path resolution and read).
 */

import type {
  Cost as AcpCost,
  ModelInfo as AcpModelInfo,
  SessionConfigOption as AcpSessionConfigOption,
  SessionMode as AcpSessionMode,
  AvailableCommand,
} from '@agentclientprotocol/sdk';

/** The `schemaVersion` value written by the last (v3) driver. */
export const ACP_SESSION_STORE_SCHEMA_VERSION = 3;

/**
 * Snapshot of the spawn recipe captured at thread-binding time. Its
 * presence is what makes a record "v3" (self-contained) and eligible for
 * migration.
 */
export interface AcpBindingRecipe {
  command?: string;
  cwd?: string;
  autoRestart: boolean;
  alias: string;
  agentTeam?: {
    agentDir: string;
    harness?: string;
  };
}

/** Snapshot of selector/usage state pushed by the agent. All optional. */
export interface AcpSessionPersistedMeta {
  availableCommands?: AvailableCommand[];
  commandsUpdatedAt?: number;
  availableModes?: AcpSessionMode[];
  currentModeId?: string | null;
  availableModels?: AcpModelInfo[];
  currentModelId?: string | null;
  configOptions?: AcpSessionConfigOption[];
  sessionInfo?: { title: string | null; updatedAt: string | null } | null;
  usage?: { used: number; size: number; cost: AcpCost | null } | null;
  metaUpdatedAt?: number;
}

/** One persisted session entry per Sediment thread on a canvas. */
export interface AcpSessionRecord {
  sessionId: string;
  profileId: string;
  cwd: string;
  updatedAt: number;
  bindingRecipe?: AcpBindingRecipe;
  meta?: AcpSessionPersistedMeta;
}

/** The on-disk `acp-sessions.json` file shape. */
export interface AcpSessionStoreFile {
  schemaVersion: number;
  records: Record<string, AcpSessionRecord>;
}

/** Tolerant guard for a persisted {@link AcpSessionRecord}. */
export function isAcpSessionRecord(value: unknown): value is AcpSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (
    !(
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      typeof r.profileId === 'string' &&
      typeof r.cwd === 'string' &&
      typeof r.updatedAt === 'number'
    )
  ) {
    return false;
  }
  if (r.meta !== undefined && (r.meta === null || typeof r.meta !== 'object')) {
    return false;
  }
  if (
    r.bindingRecipe !== undefined &&
    (r.bindingRecipe === null || typeof r.bindingRecipe !== 'object')
  ) {
    return false;
  }
  return true;
}

/**
 * Defensively shape-check a {@link AcpBindingRecipe}. Returns `undefined`
 * when the input is not a valid recipe (which, for the migrator, means the
 * record is not a migratable v3 record).
 */
export function sanitizeBindingRecipe(
  raw: unknown,
): AcpBindingRecipe | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.alias !== 'string') return undefined;

  // Agent Team recipe — requires agentTeam.agentDir
  if (r.agentTeam && typeof r.agentTeam === 'object') {
    const at = r.agentTeam as Record<string, unknown>;
    if (typeof at.agentDir === 'string' && at.agentDir.length > 0) {
      return {
        autoRestart: r.autoRestart === true,
        alias: r.alias,
        agentTeam: {
          agentDir: at.agentDir,
          ...(typeof at.harness === 'string' && at.harness.length > 0
            ? { harness: at.harness }
            : {}),
        },
      };
    }
  }

  // Standard recipe — requires command + cwd
  if (typeof r.command !== 'string' || r.command.length === 0) return undefined;
  if (typeof r.cwd !== 'string') return undefined;
  return {
    command: r.command,
    cwd: r.cwd,
    autoRestart: r.autoRestart === true,
    alias: r.alias,
  };
}

/**
 * Defensively shape-check a {@link AcpSessionPersistedMeta} payload.
 * Returns a cleaned copy containing only fields that pass minimal type
 * validation, or `undefined` when no valid field is present.
 */
export function sanitizeMeta(
  raw: unknown,
): AcpSessionPersistedMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: AcpSessionPersistedMeta = {};
  let touched = false;
  if (Array.isArray(r.availableCommands)) {
    out.availableCommands = r.availableCommands as AvailableCommand[];
    touched = true;
  }
  if (typeof r.commandsUpdatedAt === 'number') {
    out.commandsUpdatedAt = r.commandsUpdatedAt;
    touched = true;
  }
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
  if (r.sessionInfo === null) {
    out.sessionInfo = null;
    touched = true;
  } else if (r.sessionInfo && typeof r.sessionInfo === 'object') {
    const si = r.sessionInfo as { title?: unknown; updatedAt?: unknown };
    out.sessionInfo = {
      title: typeof si.title === 'string' ? si.title : null,
      updatedAt: typeof si.updatedAt === 'string' ? si.updatedAt : null,
    };
    touched = true;
  }
  if (r.usage === null) {
    out.usage = null;
    touched = true;
  } else if (r.usage && typeof r.usage === 'object') {
    const u = r.usage as { used?: unknown; size?: unknown; cost?: unknown };
    if (typeof u.used === 'number' && typeof u.size === 'number') {
      let cost: AcpCost | null = null;
      if (u.cost && typeof u.cost === 'object') {
        const c = u.cost as { amount?: unknown; currency?: unknown };
        if (typeof c.amount === 'number' && typeof c.currency === 'string') {
          cost = { amount: c.amount, currency: c.currency };
        }
      }
      out.usage = { used: u.used, size: u.size, cost };
      touched = true;
    }
  }
  if (typeof r.metaUpdatedAt === 'number') {
    out.metaUpdatedAt = r.metaUpdatedAt;
    touched = true;
  }
  return touched ? out : undefined;
}

/**
 * A migratable v3 record: an {@link AcpSessionRecord} whose
 * `bindingRecipe` has been validated and narrowed to present.
 */
export interface MigratableV3Record extends AcpSessionRecord {
  bindingRecipe: AcpBindingRecipe;
}

/**
 * Parse a raw `acp-sessions.json` payload into the list of migratable v3
 * records (threadId + validated record). Tolerant: malformed files yield
 * an empty list; individual bad or v2 (recipe-absent) records are skipped.
 */
export function parseMigratableV3Records(
  raw: unknown,
): { threadId: string; record: MigratableV3Record }[] {
  if (!raw || typeof raw !== 'object') return [];
  const records = (raw as { records?: unknown }).records;
  if (!records || typeof records !== 'object') return [];
  const out: { threadId: string; record: MigratableV3Record }[] = [];
  for (const [threadId, value] of Object.entries(
    records as Record<string, unknown>,
  )) {
    if (!isAcpSessionRecord(value)) continue;
    const bindingRecipe = sanitizeBindingRecipe(value.bindingRecipe);
    if (!bindingRecipe) continue; // v2 (recipe-absent) → skip per v3-only rule
    const meta = sanitizeMeta(value.meta);
    out.push({
      threadId,
      record: {
        sessionId: value.sessionId,
        profileId: value.profileId,
        cwd: value.cwd,
        updatedAt: value.updatedAt,
        bindingRecipe,
        ...(meta !== undefined && { meta }),
      },
    });
  }
  return out;
}
