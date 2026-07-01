/**
 * Canvas write tool handler — `canvas_commands`.
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
 * `ToolResponse<'canvas_commands', ...>` envelope. Errors throw —
 * pi-agent-core catches and surfaces them as `isError: true`.
 */

import { createId } from '@sediment/shared';

import { getLogger } from '../../../../utils/logger.js';
import {
  CanvasNotFoundError,
  executeOnServer,
} from '../../../canvas/canvas-executor.js';

import type { CanvasCommand, NodeOrigin } from '@sediment/shared';

const log = getLogger('tool.canvas-commands');

/**
 * Args type for `handleCanvasCommands`. Intentionally kept loose
 * (`commands: Array<Record<string, unknown>>`) instead of being derived
 * from `canvasCommandsParamsSchema` because the body walks each command
 * with runtime `cmd.type === '...'` narrowing and augments shapes the
 * schema does not describe (injected `origin`, `labelSource`). The
 * schema still validates LLM input upstream via `validateToolCall` —
 * the looseness here is only on the executor side.
 */
export type CanvasCommandsArgs = {
  canvasId: string;
  commands: Array<Record<string, unknown>>;
};

/** Default origin assigned to every node created by the operate agent. */
const DEFAULT_ORIGIN: NodeOrigin = { type: 'ai-operate' };

/**
 * Execute a batch of canvas commands and return the SSE-bound payload.
 *
 * `origin` controls the `NodeOrigin` stamp injected onto every CREATE /
 * MERGE / CREATE_QUESTION command. Defaults to `{ type: 'ai-operate' }`
 * for the chat/operate agent; the sketch pipeline overrides this to
 * `{ type: 'sketch-recognized' }` so user-authored gestures are not
 * mis-tagged as AI-initiated. Provenance (`author: 'ai'`) and
 * `labelSource: 'agent'` are still injected regardless of `origin` —
 * they describe who *wrote* the content, which is the LLM in both cases.
 */
export async function handleCanvasCommands(
  args: CanvasCommandsArgs,
  origin: NodeOrigin = DEFAULT_ORIGIN,
  opts?: { broadcast?: boolean; threadId?: string },
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

  const annotated = args.commands.map((cmd) => {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = cmd.nodes as Array<Record<string, unknown>>;
      return {
        ...cmd,
        nodes: nodes.map((node) => {
          const data = (node.data as Record<string, unknown> | undefined) ?? {};
          const hasLabel = typeof data.label === 'string';
          return {
            ...node,
            data: {
              ...data,
              origin,
              ...(hasLabel ? { labelSource: 'agent' as const } : {}),
            },
          };
        }),
      };
    }
    if (cmd.type === 'MERGE_NODE_DATA') {
      const patches = cmd.patches as Array<Record<string, unknown>>;
      return {
        ...cmd,
        patches: patches.map((entry) => {
          const patch =
            (entry.patch as Record<string, unknown> | undefined) ?? {};
          const hasLabel = typeof patch.label === 'string';
          if (hasLabel) {
            return {
              ...entry,
              patch: { ...patch, labelSource: 'agent' as const },
            };
          }
          return entry;
        }),
      };
    }
    if (cmd.type === 'CONNECT_NODES' || cmd.type === 'SET_EDGE_STYLE') {
      // Edges expose a `label` field (same provenance model as the
      // node-level `label`). When the LLM provides a non-empty label
      // without an explicit `labelSource`, stamp `'agent'` so the UI
      // can distinguish AI-authored labels from user-authored ones.
      // An explicit empty string clears the label — we leave it alone
      // so the user-side merger can drop the field correctly.
      const stampStyle = (
        style: Record<string, unknown> | undefined,
      ): Record<string, unknown> | undefined => {
        if (!style || typeof style !== 'object') return style;
        const hasLabelKey = Object.prototype.hasOwnProperty.call(
          style,
          'label',
        );
        if (!hasLabelKey) return style;
        if (typeof style.label !== 'string' || style.label.length === 0) {
          return style;
        }
        if (
          'labelSource' in style &&
          typeof style.labelSource === 'string' &&
          style.labelSource.length > 0
        ) {
          return style;
        }
        return { ...style, labelSource: 'agent' as const };
      };

      if (cmd.type === 'CONNECT_NODES') {
        const edges = cmd.edges as Array<Record<string, unknown>>;
        return {
          ...cmd,
          edges: edges.map((edge) => {
            const stamped = stampStyle(
              edge.style as Record<string, unknown> | undefined,
            );
            return stamped === edge.style ? edge : { ...edge, style: stamped };
          }),
        };
      }
      // SET_EDGE_STYLE: each entry is `{ edge, style }`.
      const patches = cmd.edges as Array<Record<string, unknown>>;
      return {
        ...cmd,
        edges: patches.map((entry) => {
          const stamped = stampStyle(
            entry.style as Record<string, unknown> | undefined,
          );
          return stamped === entry.style ? entry : { ...entry, style: stamped };
        }),
      };
    }
    if (cmd.type === 'CREATE_QUESTION') {
      const raw = cmd as Record<string, unknown>;
      return {
        ...raw,
        origin,
      };
    }
    return cmd;
  });

  const runId = createId('run');

  // M2 sketch carve-out: the sketch pipeline still applies commands
  // client-side via `useCanvasStore.executeCommands('agent')` after
  // receiving the SketchCommandResponse. Running the executor here
  // would double-apply and immediately desync local `version`. The
  // chat agent path (default origin `ai-operate`) is the one that
  // benefits from server-side execution today; sketch joins in M3
  // when broadcast lands.
  if (origin.type === 'sketch-recognized') {
    return JSON.stringify({
      source: 'agent',
      canvasId: args.canvasId,
      commands: annotated,
    });
  }

  try {
    const result = await executeOnServer({
      canvasId: args.canvasId,
      commands: annotated as unknown as CanvasCommand[],
      originator: {
        source: 'agent',
        ...(opts?.threadId ? { threadId: opts.threadId } : {}),
      },
      runId,
      // Out-of-band writers (ask-agent) broadcast + persist the change
      // card; the built-in chat agent leaves these off (its tab applies
      // the deltas from the tool result).
      ...(opts?.broadcast ? { broadcast: true } : {}),
      ...(opts?.threadId ? { computeChanges: true } : {}),
    });

    return JSON.stringify({
      source: 'agent',
      canvasId: args.canvasId,
      runId,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      // Signals the web that this batch was broadcast: the initiating
      // tab must NOT apply these deltas from the tool result — the canvas
      // sync stream delivers them instead. Revert is owned by the
      // broadcast-fed change card.
      ...(opts?.broadcast ? { broadcast: true } : {}),
      // Carry the executor's annotated commands (ids assigned) so the
      // web can render the per-message command list.
      commands: result.commands,
      deltas: result.deltas,
      results: result.results,
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
