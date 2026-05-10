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
import {
  handleIngestContent,
  type IngestContentArgs,
} from './handlers/ingest-content.js';
import { handleWebSearch, type WebSearchArgs } from './handlers/web-search.js';

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
 * @param context Per-request context; today only `canvasId` (always
 *                injected into canvas-aware handlers).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: { canvasId?: string },
): Promise<string> {
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
      return handleRead(withCanvasId<ReadArgs>(args, 'read'));

    case 'canvas_commands':
      return handleCanvasCommands(
        withCanvasId<CanvasCommandsArgs>(args, 'canvas_commands'),
      );

    case 'ingest_content':
      return handleIngestContent(
        withCanvasId<IngestContentArgs>(args, 'ingest_content'),
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
