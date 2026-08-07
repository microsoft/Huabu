/**
 * One-shot `agenetes-v1` to `agenetes-v2` thread-store migration.
 *
 * The v1 file kept driver fields at the workload top level and persisted a
 * common `{ sessionId?, metadata? }` state. V2 nests opaque driver specs,
 * records the selected driver's schema version, and stores driver-owned state
 * under `state.driverState`.
 */

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { acpSpecSchema } from '@agenetes/acp-driver';
import {
  FileThreadStore,
  THREAD_STORE_SCHEMA_VERSION,
} from '@agenetes/agenetes';
import { piSpecSchema } from '@agenetes/pi-driver';
import {
  agentMetadataSchema,
  workloadSpecSchema,
  type AgentMetadata,
  type WorkloadSpec,
} from '@agenetes/protocol';

import { atomicWriteJson } from '../../../utils/fs.js';

const LEGACY_SCHEMA_VERSION = 'agenetes-v1';
const BACKUP_SUFFIX = '.agenetes-v1.bak';

interface LegacyThreadStoreFile {
  readonly schemaVersion: typeof LEGACY_SCHEMA_VERSION;
  readonly records: Record<string, unknown>;
}

interface MigratedThreadRecord {
  readonly driverSchemaVersion: 1;
  readonly spec: WorkloadSpec;
  readonly state: {
    readonly driverState: unknown;
    readonly metadata?: AgentMetadata;
  };
}

function invalid(filePath: string, message: string): never {
  throw new Error(`Cannot migrate ${filePath}: ${message}`);
}

function readLegacyFile(filePath: string): LegacyThreadStoreFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return invalid(filePath, 'invalid JSON');
  }
  if (!raw || typeof raw !== 'object') {
    return invalid(filePath, 'expected an object');
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion === THREAD_STORE_SCHEMA_VERSION) return null;
  if (value.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    return invalid(
      filePath,
      `unsupported schema ${String(value.schemaVersion)}`,
    );
  }
  if (!value.records || typeof value.records !== 'object') {
    return invalid(filePath, 'missing records object');
  }
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    records: value.records as Record<string, unknown>,
  };
}

function parseLegacyState(
  filePath: string,
  threadId: string,
  raw: unknown,
): {
  sessionId?: string;
  initialPreambleDelivered?: boolean;
  metadata?: AgentMetadata;
} {
  if (!raw || typeof raw !== 'object') {
    return invalid(filePath, `thread '${threadId}' has invalid state`);
  }
  const value = raw as Record<string, unknown>;
  const state: {
    sessionId?: string;
    initialPreambleDelivered?: boolean;
    metadata?: AgentMetadata;
  } = {};
  if (value.sessionId !== undefined) {
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
      return invalid(filePath, `thread '${threadId}' has an invalid sessionId`);
    }
    state.sessionId = value.sessionId;
  }
  if (value.initialPreambleDelivered !== undefined) {
    if (typeof value.initialPreambleDelivered !== 'boolean') {
      return invalid(
        filePath,
        `thread '${threadId}' has invalid preamble delivery state`,
      );
    }
    state.initialPreambleDelivered = value.initialPreambleDelivered;
  }
  if (value.metadata !== undefined) {
    const parsed = agentMetadataSchema.safeParse(value.metadata);
    if (!parsed.success) {
      return invalid(filePath, `thread '${threadId}' has invalid metadata`);
    }
    state.metadata = parsed.data;
  }
  return state;
}

function parseLegacyEnvelope(
  filePath: string,
  threadId: string,
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return invalid(filePath, `thread '${threadId}' is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (!record.spec || typeof record.spec !== 'object') {
    return invalid(filePath, `thread '${threadId}' has no workload spec`);
  }
  const workload = record.spec as Record<string, unknown>;
  if (workload.threadId !== threadId) {
    return invalid(filePath, `thread '${threadId}' has a mismatched threadId`);
  }
  if (workload.kind !== 'internal' && workload.kind !== 'external') {
    return invalid(
      filePath,
      `thread '${threadId}' uses unknown kind '${String(workload.kind)}'`,
    );
  }
  return record;
}

function migrateInternalSpec(
  filePath: string,
  threadId: string,
  workload: Record<string, unknown>,
): WorkloadSpec {
  const nested =
    workload.spec && typeof workload.spec === 'object'
      ? (workload.spec as Record<string, unknown>)
      : undefined;
  if (!nested && workload.workloadType !== 'Job') {
    return invalid(filePath, `thread '${threadId}' has invalid pi spec`);
  }
  // Early v1 pi Jobs predate PiSpec and persisted their turn inputs directly
  // on the workload envelope. They are never authoritative Deployments.
  const driverSpec = nested
    ? {
        ...nested,
        ...(workload.initialPreamble !== undefined
          ? { initialPreamble: workload.initialPreamble }
          : {}),
      }
    : {
        ...(typeof workload.systemPrompt === 'string' &&
        workload.systemPrompt.length > 0
          ? { initialPreamble: [workload.systemPrompt] }
          : {}),
        recipe: {
          model: { type: 'host', id: 'active' },
          runtime: {
            ...(workload.maxIterations !== undefined
              ? { maxIterations: workload.maxIterations }
              : {}),
            toolExecution: 'parallel',
          },
        },
        initialMessages: workload.messages,
        hostContext: {
          ...(typeof workload.canvasId === 'string' &&
          workload.canvasId.length > 0
            ? { canvasId: workload.canvasId }
            : {}),
          ...(workload.origin &&
          typeof workload.origin === 'object' &&
          !Array.isArray(workload.origin)
            ? { origin: workload.origin }
            : {}),
          ...(typeof workload.scope === 'string'
            ? { legacyScope: workload.scope }
            : {}),
        },
      };
  const parsedDriverSpec = piSpecSchema.safeParse(driverSpec);
  if (!parsedDriverSpec.success) {
    return invalid(filePath, `thread '${threadId}' has invalid pi spec`);
  }
  const parsedWorkload = workloadSpecSchema.safeParse({
    kind: workload.kind,
    workloadType: workload.workloadType,
    namespace: workload.namespace,
    threadId: workload.threadId,
    spec: parsedDriverSpec.data,
  });
  if (!parsedWorkload.success) {
    return invalid(
      filePath,
      `thread '${threadId}' has invalid workload fields`,
    );
  }
  return parsedWorkload.data;
}

function migrateExternalSpec(
  filePath: string,
  threadId: string,
  workload: Record<string, unknown>,
): WorkloadSpec {
  const profile =
    workload.profile && typeof workload.profile === 'object'
      ? (workload.profile as Record<string, unknown>)
      : undefined;
  const launch =
    profile?.launch && typeof profile.launch === 'object'
      ? (profile.launch as Record<string, unknown>)
      : undefined;

  let driverFields: Record<string, unknown>;
  if (profile && launch?.kind === 'acp-command') {
    driverFields = {
      binding: workload.binding,
      agentletId: profile.agentletId,
      cwd: profile.workingDirPath,
      recipe: {
        command: launch.command,
        cwd: profile.workingDirPath,
        autoRestart: true,
        alias: (workload.binding as { alias?: unknown } | undefined)?.alias,
      },
      env: workload.env,
    };
  } else if (profile && launch?.kind === 'agent-team-manifest') {
    driverFields = {
      binding: workload.binding,
      agentletId: profile.agentletId,
      cwd: profile.workingDirPath,
      recipe: {
        autoRestart: true,
        alias: (workload.binding as { alias?: unknown } | undefined)?.alias,
        agentTeam: {
          manifestPath: launch.manifestPath,
          workingDirPath: profile.workingDirPath,
          harness: launch.harness,
        },
      },
      env: workload.env,
    };
  } else if (profile) {
    return invalid(filePath, `thread '${threadId}' has an invalid Profile`);
  } else {
    driverFields = {
      binding: workload.binding,
      agentletId: workload.agentletId,
      cwd: workload.cwd,
      recipe: workload.recipe,
      env: workload.env,
    };
  }

  const parsedDriverSpec = acpSpecSchema.safeParse({
    ...driverFields,
    ...(workload.initialPreamble !== undefined
      ? { initialPreamble: workload.initialPreamble }
      : {}),
  });
  if (!parsedDriverSpec.success) {
    return invalid(filePath, `thread '${threadId}' has invalid ACP spec`);
  }
  const parsedWorkload = workloadSpecSchema.safeParse({
    kind: workload.kind,
    workloadType: workload.workloadType,
    namespace: workload.namespace,
    threadId: workload.threadId,
    spec: parsedDriverSpec.data,
  });
  if (!parsedWorkload.success) {
    return invalid(
      filePath,
      `thread '${threadId}' has invalid workload fields`,
    );
  }
  return parsedWorkload.data;
}

function migrateRecord(
  filePath: string,
  threadId: string,
  raw: unknown,
): MigratedThreadRecord {
  const record = parseLegacyEnvelope(filePath, threadId, raw);
  const workload = record.spec as Record<string, unknown>;
  const legacyState = parseLegacyState(filePath, threadId, record.state);
  const spec =
    workload.kind === 'internal'
      ? migrateInternalSpec(filePath, threadId, workload)
      : migrateExternalSpec(filePath, threadId, workload);
  const driverState =
    workload.kind === 'internal'
      ? {}
      : {
          ...(legacyState.sessionId
            ? { sessionId: legacyState.sessionId }
            : {}),
          initialPreambleDelivered:
            legacyState.initialPreambleDelivered ?? false,
        };
  return {
    driverSchemaVersion: 1,
    spec,
    state: {
      driverState,
      ...(legacyState.metadata ? { metadata: legacyState.metadata } : {}),
    },
  };
}

/** Migrate one `threads.json`, returning the number of converted records. */
export function migrateAgenetesThreadFile(filePath: string): number {
  const legacy = readLegacyFile(filePath);
  if (!legacy) return 0;
  const records: Record<string, MigratedThreadRecord> = {};
  for (const [threadId, record] of Object.entries(legacy.records)) {
    records[threadId] = migrateRecord(filePath, threadId, record);
  }

  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (existsSync(backupPath)) {
    return invalid(filePath, `backup already exists at ${backupPath}`);
  }
  renameSync(filePath, backupPath);
  try {
    atomicWriteJson(filePath, {
      schemaVersion: THREAD_STORE_SCHEMA_VERSION,
      records,
    });
  } catch (error) {
    renameSync(backupPath, filePath);
    throw error;
  }
  return Object.keys(records).length;
}

/** Migrate every canvas-local Agenetes thread store in one workspace. */
export function migrateLegacyAgenetesThreads(workspace: string): number {
  if (!existsSync(workspace)) return 0;
  let migrated = 0;
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(
      workspace,
      entry.name,
      '.history',
      'threads.json',
    );
    if (!existsSync(filePath)) continue;
    migrated += migrateAgenetesThreadFile(filePath);
  }
  return migrated;
}

/**
 * Backfill external Deployment records created by control-plane routes that
 * persisted an empty preamble before the first chat turn.
 */
export function repairExternalAgentPreambles(
  workspace: string,
  initialPreamble: string,
): number {
  if (!existsSync(workspace)) return 0;
  const store = new FileThreadStore();
  let repaired = 0;
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const historyRoot = path.join(workspace, entry.name, '.history');
    const filePath = path.join(historyRoot, 'threads.json');
    if (!existsSync(filePath)) continue;
    const lookupNamespace = {
      name: entry.name,
      storage: { root: historyRoot },
    };
    for (const record of store.list(lookupNamespace)) {
      if (
        record.spec.kind !== 'external' ||
        record.spec.workloadType !== 'Deployment' ||
        !record.spec.spec ||
        typeof record.spec.spec !== 'object' ||
        Array.isArray(record.spec.spec) ||
        'initialPreamble' in record.spec.spec
      ) {
        continue;
      }
      const driverState = record.state.driverState;
      if (
        !driverState ||
        typeof driverState !== 'object' ||
        Array.isArray(driverState) ||
        (driverState as { initialPreambleDelivered?: unknown })
          .initialPreambleDelivered !== false
      ) {
        continue;
      }
      store.upsert(record.spec.namespace, record.spec.threadId, {
        ...record,
        spec: {
          ...record.spec,
          spec: {
            ...record.spec.spec,
            initialPreamble: [initialPreamble],
          },
        },
      });
      repaired += 1;
    }
  }
  return repaired;
}
