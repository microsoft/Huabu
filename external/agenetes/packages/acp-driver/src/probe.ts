/**
 * Ephemeral capability discovery, independent of durable workloads.
 */

import { randomUUID } from 'node:crypto';

import { acpSessionRegistry } from './session-registry.js';
import { ensureAcpSession } from './session.js';
import { releaseThread } from './spawn-orchestrator.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { EnsureAcpSessionOptions } from './session.js';

type CapabilityObservation = Pick<
  AcpSessionEntry,
  | 'availableModes'
  | 'currentModeId'
  | 'availableModels'
  | 'currentModelId'
  | 'configOptions'
  | 'availableCommands'
  | 'commandsUpdatedAt'
  | 'metaUpdatedAt'
>;

export async function awaitSchemaQuiescence(
  entry: Pick<
    AcpSessionEntry,
    'availableModes' | 'availableModels' | 'configOptions' | 'metaUpdatedAt'
  > &
    Partial<Pick<AcpSessionEntry, 'availableCommands' | 'commandsUpdatedAt'>>,
  options: {
    pollIntervalMs?: number;
    quietWindowMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const quietWindowMs = options.quietWindowMs ?? 300;
  const maxWaitMs = options.maxWaitMs ?? 2000;
  const fingerprint = () =>
    JSON.stringify([
      entry.availableModes,
      entry.availableModels,
      entry.configOptions,
      entry.metaUpdatedAt,
      entry.availableCommands,
      entry.commandsUpdatedAt,
    ]);
  const start = Date.now();
  let last = fingerprint();
  let lastChangeAt = start;
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const next = fingerprint();
    if (next !== last) {
      last = next;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietWindowMs) {
      return;
    }
  }
}

export async function probeAcpCapabilities(
  options: Pick<
    EnsureAcpSessionOptions,
    'agentletId' | 'binding' | 'profileExecutionRevision' | 'recipe' | 'logger'
  >,
) {
  const threadId = `capability-probe-${randomUUID()}`;
  const namespace = Object.freeze({ name: 'capability-probe' });
  let result:
    | { ok: true; observation: CapabilityObservation }
    | { ok: false; error: unknown };
  try {
    const entry = await ensureAcpSession({
      ...options,
      recipe: options.recipe
        ? { ...options.recipe, autoRestart: false }
        : options.recipe,
      threadId,
      namespace,
      workloadType: 'Job',
      idleTimeoutSecs: 60,
    });
    await awaitSchemaQuiescence(entry);
    if (entry.client.isClosed) {
      throw new Error('Agent disconnected during capability discovery');
    }
    const observation = structuredClone({
      availableModes: entry.availableModes,
      currentModeId: entry.currentModeId,
      availableModels: entry.availableModels,
      currentModelId: entry.currentModelId,
      configOptions: entry.configOptions,
      availableCommands: entry.availableCommands,
      commandsUpdatedAt: entry.commandsUpdatedAt,
      metaUpdatedAt: Date.now(),
    });
    result = { ok: true, observation };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    acpSessionRegistry.remove(options.agentletId, threadId, namespace);
    await releaseThread(options.agentletId, threadId, namespace);
  } catch (error) {
    if (!result.ok) {
      throw new AggregateError(
        [result.error, error],
        `Capability discovery failed and its process could not be reclaimed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
  if (!result.ok) throw result.error;
  return result.observation;
}
