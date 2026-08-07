/**
 * Legacy ACP-session migration (M6.9 row 1) — the removed
 * `acp-sessions.json` store → the Agenetes `threads.json` `ThreadStore`.
 *
 * The ACP driver used to persist `(threadId → sessionId)` recovery records
 * in `<canvasDir>/.history/acp-sessions.json` (schemaVersion 3). That store
 * is gone; its role — letting a cold thread resume its external agent
 * session via `session/load` — now lives on `ThreadRecord.state.sessionId`
 * behind the {@link FileThreadStore} (`<canvasDir>/.history/threads.json`).
 * This one-shot boot migrator folds each self-contained v3 record forward
 * into a reconstructed `ThreadRecord`, then renames the source to `.bak`.
 *
 * ### v3-only, self-contained
 *
 * Only records carrying a `bindingRecipe` (v3) are migrated: they are
 * self-contained, so a valid {@link AcpWorkloadSpec} can be rebuilt with no
 * profile lookup. v2 records (recipe-absent) are skipped by
 * {@link parseMigratableV3Records} — real workspaces contain none. The v3
 * `meta` snapshot maps 1:1 onto {@link AgentMetadata} (identical field set),
 * so it rides straight into `state.metadata` after a schema safe-parse.
 *
 * The reconstructed spec omits `env`: the reachback env is host-port
 * dependent and rebuilt live per turn (`buildReachbackEnv`), never a durable
 * spec field. It is enough that the record survives `isPersistableSpec`
 * (threadId / kind / workloadType / namespace) and carries binding + recipe
 * + cwd so the first cold resume can spawn; the live path re-bakes a fresh
 * spec on the next turn.
 *
 * ### Idempotent, launch-only
 *
 * Skips any thread already present in `threads.json` (never clobbering a
 * live-updated record) and renames the source `acp-sessions.json` to `.bak`
 * on completion, so a re-run is a no-op. One bad canvas never aborts the
 * batch.
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { FileThreadStore } from '@agenetes/agenetes';
import { agentMetadataSchema } from '@agenetes/protocol';

import { parseMigratableV3Records } from './legacy/acp-sessions-v3.js';
import { readJson } from '../../../utils/fs.js';
import { SPACE_JSON_FILENAME } from '../disk/paths.js';

import type { AcpWorkloadSpec } from '../../agent/agenetes/drivers.js';
import type { AgentStateSnapshot, Namespace } from '@agenetes/protocol';

/**
 * The dispatch `kind` the ACP driver is registered under (mirrors
 * `EXTERNAL_DRIVER_KIND` in agent/agenetes/drivers.ts). Inlined so this
 * boot migrator need not pull the whole agent stack at import time.
 */
const EXTERNAL_DRIVER_KIND = 'external';
/** An ACP session is a long-lived, stateful connection — always a Deployment. */
const ACP_WORKLOAD_TYPE = 'Deployment';

/**
 * Migrate one canvas's `acp-sessions.json` into its `threads.json`. Returns
 * the number of records migrated. Renames the source to `.bak` when done.
 */
export function migrateAcpSessionsFile(
  threadStore: FileThreadStore,
  namespace: Namespace,
  sessionsPath: string,
): number {
  const raw = readJson<unknown>(sessionsPath);
  const migratable = parseMigratableV3Records(raw);

  let migrated = 0;
  for (const { threadId, record } of migratable) {
    // Never clobber a record that already exists (e.g. one refreshed by a
    // live turn after a prior migration run).
    if (threadStore.get(namespace, threadId) !== undefined) continue;

    const spec: AcpWorkloadSpec = {
      threadId,
      kind: EXTERNAL_DRIVER_KIND,
      workloadType: ACP_WORKLOAD_TYPE,
      namespace,
      spec: {
        binding: {
          alias: record.bindingRecipe.alias,
          profileId: record.profileId,
        },
        ...(record.cwd ? { cwd: record.cwd } : {}),
        recipe: record.bindingRecipe,
      },
    };

    const state: AgentStateSnapshot = {
      driverState: {
        sessionId: record.sessionId,
        initialPreambleDelivered: false,
      },
    };
    if (record.meta !== undefined) {
      const parsed = agentMetadataSchema.safeParse(record.meta);
      if (parsed.success) state.metadata = parsed.data;
    }

    threadStore.upsert(namespace, threadId, {
      driverSchemaVersion: 1,
      spec,
      state,
    });
    migrated += 1;
  }

  renameSync(sessionsPath, `${sessionsPath}.bak`);
  return migrated;
}

/**
 * Walk every canvas's `.history/acp-sessions.json` and migrate its v3
 * records into `threads.json`. The per-canvas namespace uses the on-disk
 * `<canvasDir>/.history` as `storage.root` (so the migrated `threads.json`
 * lands where the live reader looks) and the canonical `canvasId` as `name`,
 * so the persisted `spec.namespace` matches the
 * live `canvasAcpNamespace(canvasId)`.
 */
export function migrateLegacyAcpSessions(workspace: string): void {
  let canvasDirs: string[];
  try {
    canvasDirs = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  const threadStore = new FileThreadStore();

  for (const dirName of canvasDirs) {
    const canvasDir = path.join(workspace, dirName);
    const historyRoot = path.join(canvasDir, '.history');
    const sessionsPath = path.join(historyRoot, 'acp-sessions.json');
    if (!existsSync(sessionsPath)) continue;

    const canvasId =
      readJson<{ canvasId?: string }>(path.join(canvasDir, SPACE_JSON_FILENAME))
        ?.canvasId ?? dirName;
    const namespace: Namespace = {
      name: canvasId,
      storage: { root: historyRoot },
    };

    try {
      migrateAcpSessionsFile(threadStore, namespace, sessionsPath);
    } catch {
      // tolerant: one bad canvas never aborts the batch
    }
  }
}
