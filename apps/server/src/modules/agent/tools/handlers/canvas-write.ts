/**
 * Canvas write tool handler — `canvas_commands`.
 *
 * Translates the LLM's command batch into the SSE-bound payload the
 * frontend executes. The handler does not touch the filesystem itself;
 * it only annotates each command with `origin` / `labelSource` so
 * downstream apply logic knows the change came from the agent. The
 * actual canvas mutation happens client-side via the existing
 * canvas-command pipeline once the SSE event lands.
 *
 * Phase 4 (Milkdown migration): block-level `provenance` is now stamped
 * client-side by `NotePreview` (it owns the markdown→PM parser needed
 * for fingerprinting). The server therefore no longer injects any
 * `provenance` field. Range-precise provenance generation is tracked
 * separately in Phase 4.5 — see `docs/milkdown-migration-plan.md` §4.
 *
 * Returns the inner payload (`{ source, canvasId, commands }`) on
 * success; the SSE bridge / web client wraps it into the standard
 * `ToolResponse<'canvas_commands', ...>` envelope. Errors throw —
 * pi-agent-core catches and surfaces them as `isError: true`.
 */

import type { NodeOrigin } from '@sediment/shared';

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
): Promise<string> {
  console.log(
    `[canvas_commands] handler invoked: canvasId=${args.canvasId ?? '(none)'}, origin=${origin.type}, commandCount=${args.commands?.length ?? 0}, types=[${(args.commands ?? []).map((c) => c.type).join(', ')}]`,
  );

  const commands = args.commands.map((cmd) => {
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
      return cmd;
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

  return JSON.stringify({
    source: 'agent',
    canvasId: args.canvasId,
    commands,
  });
}
