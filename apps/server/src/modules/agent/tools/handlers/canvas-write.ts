/**
 * Canvas write tool handler — `canvas_commands`.
 *
 * Translates the LLM's command batch into the SSE-bound payload the
 * frontend executes. The handler does not touch the filesystem itself;
 * it only annotates each command with `origin` / `provenance` /
 * `labelSource` so downstream apply logic knows the change came from
 * the agent. The actual canvas mutation happens client-side via the
 * existing canvas-command pipeline once the SSE event lands.
 *
 * Returns the inner payload (`{ source, canvasId, commands }`) on
 * success; the SSE bridge / web client wraps it into the standard
 * `ToolResponse<'canvas_commands', ...>` envelope. Errors throw —
 * pi-agent-core catches and surfaces them as `isError: true`.
 */

import { getCanvasStore } from '../../../storage/index.js';

import type { BlockProvenanceMap, NodeOrigin } from '@sediment/shared';

/**
 * Args type for `handleCanvasCommands`. Intentionally kept loose
 * (`commands: Array<Record<string, unknown>>`) instead of being derived
 * from `canvasCommandsParamsSchema` because the body walks each command
 * with runtime `cmd.type === '...'` narrowing and augments shapes the
 * schema does not describe (injected `origin`, `provenance`,
 * `labelSource`). The schema still validates LLM input upstream via
 * `validateToolCall` — the looseness here is only on the executor side.
 */
export type CanvasCommandsArgs = {
  canvasId: string;
  commands: Array<Record<string, unknown>>;
};

/** Default origin assigned to every node created by the operate agent. */
const DEFAULT_ORIGIN: NodeOrigin = { type: 'ai-operate' };

/** Build an `__all__` sentinel provenance map for AI-generated content. */
function buildAIProvenance(): BlockProvenanceMap {
  return {
    __all__: {
      author: 'ai',
      createdAt: new Date().toISOString(),
    },
  };
}

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

  // Read canvas state once so we can resolve node types for provenance injection.
  const canvas = getCanvasStore(args.canvasId).read();
  const nodeTypeMap = new Map<string, string>();
  if (canvas) {
    for (const n of (canvas.state.nodes ?? []) as Array<
      Record<string, unknown>
    >) {
      const data = (n.data as Record<string, unknown> | undefined) ?? {};
      const nodeType = (n.nodeType ?? n.type ?? data.type) as
        | string
        | undefined;
      if (typeof n.id === 'string' && typeof nodeType === 'string') {
        nodeTypeMap.set(n.id, nodeType);
      }
    }
  }

  const commands = args.commands.map((cmd) => {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = cmd.nodes as Array<Record<string, unknown>>;
      return {
        ...cmd,
        nodes: nodes.map((node) => {
          const data = (node.data as Record<string, unknown> | undefined) ?? {};
          const isNote = node.nodeType === 'note';
          const hasContent =
            isNote &&
            typeof data.content === 'string' &&
            data.content.length > 0;
          const hasLabel = typeof data.label === 'string';
          return {
            ...node,
            data: {
              ...data,
              origin,
              ...(hasContent ? { provenance: buildAIProvenance() } : {}),
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
          const nodeId = entry.nodeId as string | undefined;
          const isNote = nodeId ? nodeTypeMap.get(nodeId) === 'note' : false;
          const hasContent =
            isNote &&
            typeof patch.content === 'string' &&
            patch.content.length > 0;
          const hasLabel = typeof patch.label === 'string';
          const extra: Record<string, unknown> = {};
          if (hasContent) extra.provenance = buildAIProvenance();
          if (hasLabel) extra.labelSource = 'agent';
          if (Object.keys(extra).length > 0) {
            return {
              ...entry,
              patch: { ...patch, ...extra },
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
