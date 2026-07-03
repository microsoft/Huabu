/**
 * Tool Executor — dispatcher only.
 *
 * Each tool's body lives in its own `handlers/<name>.ts` file. This
 * module's job is just:
 *  1. Inject the request-scoped `canvasId` so every canvas-aware
 *     tool runs against the active canvas. The LLM never sees a
 *     `canvasId` argument — cross-canvas access is not exposed.
 *  2. Dispatch the call to the matching handler.
 *  3. Return a string result that pi-agent-core wraps into a
 *     `toolResult` content block.
 *
 * Failures throw — pi-agent-core's `executePreparedToolCall` catches
 * them and emits a tool result with `isError: true`, with the thrown
 * `Error.message` as the text content. Handlers MUST NOT encode
 * errors inside the JSON payload.
 *
 * Adding a new tool is a four-step change:
 *  - schema in `./schemas/`
 *  - definition + `*ParamsSchema` in `./definitions.ts`
 *  - body in `./handlers/<name>.ts`
 *  - dispatcher case below
 */

import {
  handleGetCanvasOutline,
  handleInspectEdges,
  handleInspectNodes,
  type GetCanvasOutlineArgs,
  type InspectEdgesArgs,
  type InspectNodesArgs,
} from './handlers/canvas-query.js';
import {
  handleCanvasCommands,
  type CanvasCommandsArgs,
} from './handlers/canvas-write.js';
import { handleRead, type ReadArgs } from './handlers/fs-read.js';
import {
  handleFind,
  handleGrep,
  handleLs,
  type FindArgs,
  type GrepArgs,
  type LsArgs,
} from './handlers/fs-search.js';
import { handleFsWrite, type FsWriteArgs } from './handlers/fs-write.js';
import {
  handleGenerateImage,
  type GenerateImageArgs,
} from './handlers/image-generation.js';
import {
  handleSnapshotNodes,
  type SnapshotNodesArgs,
} from './handlers/snapshot-node.js';
import { handleWebSearch, type WebSearchArgs } from './handlers/web-search.js';

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { NodeOrigin } from '@sediment/shared';

/**
 * Per-request context every handler call receives.
 *
 * - `canvasId` is injected into every canvas-aware handler. The LLM
 *   never sees a `canvasId` argument — cross-canvas access is not
 *   exposed.
 * - `origin` is forwarded to `canvas_commands` only; other handlers
 *   ignore it. It controls the `NodeOrigin` stamp on AI-generated
 *   nodes (defaults to `'ai-operate'` when unset; the sketch
 *   pipeline overrides it to `'sketch-recognized'`).
 */
export interface ExecuteContext {
  canvasId?: string;
  origin?: NodeOrigin;
  /** ACP conversation thread to attribute canvas changes to (change card). */
  threadId?: string;
  /**
   * Run-scoped `nodeId → rev` read-set. `read` records the rev of each
   * node it reads; `canvas_commands` reads it to auto-inject `expectRev`
   * on content writes. One Map per `runAgent`; never persisted.
   */
  readSet?: Map<string, string>;
}

/**
 * Execute a tool call and return the result as a string.
 *
 * Per the pi-agent-core `AgentTool.execute` contract, failures throw
 * — the agent loop catches the throw and emits a tool result with
 * `isError: true` (see node_modules/.../pi-agent-core/dist/agent-loop.js
 * `executePreparedToolCall`). Successful calls return a JSON string.
 *
 * @param name    Tool name (matches `ToolDefinition.name`).
 * @param args    Validated tool arguments — already passed pi-ai's
 *                schema check by the time this runs.
 * @param context Per-request context (see `ExecuteContext`).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: ExecuteContext,
): Promise<string | AgentToolResult<unknown>> {
  const requireCanvasId = (toolName: string): string => {
    const canvasId = context?.canvasId;
    if (!canvasId) {
      throw new Error(`canvasId is required for ${toolName}`);
    }
    return canvasId;
  };
  const withCanvasId = <T>(value: Record<string, unknown>, toolName: string) =>
    ({ ...value, canvasId: requireCanvasId(toolName) }) as unknown as T;

  switch (name) {
    case 'web_search':
      return handleWebSearch(args as WebSearchArgs);

    case 'get_canvas_outline':
      return handleGetCanvasOutline(
        withCanvasId<GetCanvasOutlineArgs>(args, 'get_canvas_outline'),
      );

    case 'inspect_nodes':
      return handleInspectNodes(
        withCanvasId<InspectNodesArgs>(args, 'inspect_nodes'),
      );

    case 'inspect_edges':
      return handleInspectEdges(
        withCanvasId<InspectEdgesArgs>(args, 'inspect_edges'),
      );

    case 'grep':
      return handleGrep(withCanvasId<GrepArgs>(args, 'grep'));

    case 'find':
      return handleFind(withCanvasId<FindArgs>(args, 'find'));

    case 'ls':
      return handleLs(withCanvasId<LsArgs>(args, 'ls'));

    case 'read':
      return handleRead(withCanvasId<ReadArgs>(args, 'read'), context?.readSet);

    case 'canvas_commands':
      return handleCanvasCommands(
        withCanvasId<CanvasCommandsArgs>(args, 'canvas_commands'),
        context?.origin,
        { threadId: context?.threadId, readSet: context?.readSet },
      );

    case 'fs_write':
      // canvasId is conditionally needed (only for memory/canvas.md);
      // the handler enforces that. Pass it through when present so the
      // handler can resolve canvas-scoped paths, but do not require it
      // here — workspace and skill writes have no canvas binding.
      return handleFsWrite({
        ...args,
        canvasId: context?.canvasId,
      } as FsWriteArgs);

    case 'snapshot_nodes':
      return handleSnapshotNodes(
        withCanvasId<SnapshotNodesArgs>(args, 'snapshot_nodes'),
      );

    case 'generate_image':
      return handleGenerateImage(
        withCanvasId<GenerateImageArgs>(args, 'generate_image'),
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
