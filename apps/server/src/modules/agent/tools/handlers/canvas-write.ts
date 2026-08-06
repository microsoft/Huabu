// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas write tool handler — `space_commands`.
 *
 * As of M2 (headless executor) this handler runs the batch
 * **server-side** through {@link executeOnServer} and returns the
 * structural deltas + per-command outcomes the web client should
 * apply locally. The handler still owns the origin / labelSource
 * annotation step — `executeOnServer` is intentionally agnostic to
 * who the agent is.
 *
 * Phase 4 (Milkdown migration): block-level `provenance` is now stamped
 * client-side by `NotePreview` (it owns the markdown→PM parser needed
 * for fingerprinting). The server therefore no longer injects any
 * `provenance` field. Range-precise provenance generation is tracked
 * separately in Phase 4.5 — see `docs/milkdown-migration-plan.md` §4.
 *
 * Returns the envelope `{ source, canvasId, commands, fromVersion,
 * toVersion, deltas, results, pendingEffects, runId }` on success;
 * the SSE bridge / web client wraps it into the standard
 * `ToolResponse<'space_commands', ...>` envelope. Errors throw —
 * pi-agent-core catches and surfaces them as `isError: true`.
 */

import { createId } from '@huabu/shared';

import { getLogger } from '../../../../utils/logger.js';
import { prepareAgentCanvasCommands } from '../../../canvas/agent-command-preparation.js';
import { executeCanvasCommandsOnHost } from '../../../canvas/canvas-command-router.js';
import { CanvasNotFoundError } from '../../../canvas/canvas-executor.js';

import type {
  BuiltInAgentOperationCommand,
  ExecuteConflict,
  NodeOrigin,
} from '@huabu/shared';

const log = getLogger('tool.canvas-commands');

/**
 * Build a concise, model-facing instruction for a rejected content write.
 * The model cannot hand-carry `expectRev` (it is injected only from the
 * run's read-set, populated by `read`), so a `not-read` conflict is only
 * cleared by actually reading the node — NOT by retrying the same command.
 * Spelling that out here stops the blind identical-retry loop.
 */
function buildConflictHint(conflicts: readonly ExecuteConflict[]): string {
  const parts: string[] = [];
  if (conflicts.some((c) => c.reason === 'not-read')) {
    parts.push(
      'Read before write: `read` the conflicted node(s) first, then re-issue. Retrying as-is fails again.',
    );
  }
  if (conflicts.some((c) => c.reason === 'stale')) {
    parts.push(
      'Node(s) changed since your last read — re-`read`, then re-issue.',
    );
  }
  return parts.join(' ');
}

/**
 * Args type for `handleCanvasCommands`, derived from the canonical shared
 * agent operation contract validated by pi-ai before dispatch.
 */
export type CanvasCommandsArgs = {
  canvasId: string;
  commands: BuiltInAgentOperationCommand[];
};

/** Default origin assigned to every node created by the operate agent. */
const DEFAULT_ORIGIN: NodeOrigin = { type: 'ai-operate' };

/**
 * Execute a batch of canvas commands and return the SSE-bound payload.
 *
 * `origin` controls the `NodeOrigin` stamp injected onto every CREATE /
 * MERGE command. Defaults to `{ type: 'ai-operate' }`.
 * Provenance (`author: 'ai'`) and `labelSource: 'agent'` are still
 * injected regardless of `origin` — they describe who *wrote* the
 * content, which is the LLM in every case.
 */
export async function handleCanvasCommands(
  args: CanvasCommandsArgs,
  origin: NodeOrigin = DEFAULT_ORIGIN,
  opts?: { threadId?: string; readSet?: Map<string, string> },
): Promise<string> {
  log.info(
    {
      canvasId: args.canvasId ?? null,
      origin: origin.type,
      commandCount: args.commands?.length ?? 0,
      types: (args.commands ?? []).map((c) => c.type),
    },
    'canvas_commands handler invoked',
  );

  const annotated = prepareAgentCanvasCommands(args.commands, {
    origin,
    readSet: opts?.readSet,
  });

  const runId = createId('run');

  try {
    const result = await executeCanvasCommandsOnHost({
      canvasId: args.canvasId,
      commands: annotated,
      originator: {
        source: 'agent',
        ...(opts?.threadId ? { threadId: opts.threadId } : {}),
      },
      runId,
      ...(opts?.threadId ? { computeChanges: true } : {}),
    });

    return JSON.stringify({
      source: 'agent',
      canvasId: result.canvasId,
      runId,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      // Carry the executor's annotated commands (ids assigned) so the
      // web can render the per-message command list.
      commands: result.commands,
      deltas: result.deltas,
      results: result.results,
      ...(result.conflicts && result.conflicts.length > 0
        ? {
            conflicts: result.conflicts,
            conflictHint: buildConflictHint(result.conflicts),
          }
        : {}),
      pendingEffects: {
        mutatedNodes: result.pendingEffects.mutatedNodes,
        deletedNodeIds: result.pendingEffects.deletedNodeIds,
        contentEditedNodeIds: result.pendingEffects.contentEditedNodeIds,
        deferredFitFrameIds: result.pendingEffects.deferredFitFrameIds,
      },
    });
  } catch (err) {
    if (err instanceof CanvasNotFoundError) {
      throw new Error(`Canvas not found: ${args.canvasId}`);
    }
    throw err;
  }
}
