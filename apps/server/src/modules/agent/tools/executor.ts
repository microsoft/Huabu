/**
 * Tool Executor — dispatcher only.
 *
 * Each tool's body lives in its own `handlers/<name>.ts` file. This
 * module's job is just:
 *  1. Resolve the implicit `canvasId` (request context fallback) for
 *     canvas-aware tools.
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
  handleInspectNodes,
  type GetCanvasOutlineArgs,
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
import { handleUseSkill } from './handlers/use-skill.js';
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
 * @param context Per-request context; today only `canvasId` (used as
 *                the implicit fallback when the LLM omits it).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: { canvasId?: string },
): Promise<string> {
  const resolveCanvasArgs = <T extends Record<string, unknown>>(
    value: T,
    toolName: string,
  ): T & { canvasId: string } => {
    const canvasId =
      typeof value.canvasId === 'string' && value.canvasId.trim().length > 0
        ? value.canvasId
        : context?.canvasId;
    if (!canvasId) {
      throw new Error(`canvasId is required for ${toolName}`);
    }
    return { ...value, canvasId };
  };

  switch (name) {
    case 'web_search':
      return handleWebSearch(args as WebSearchArgs);

    case 'get_canvas_outline':
      return handleGetCanvasOutline(
        resolveCanvasArgs(args, 'get_canvas_outline') as GetCanvasOutlineArgs,
      );

    case 'inspect_nodes':
      return handleInspectNodes(
        resolveCanvasArgs(args, 'inspect_nodes') as InspectNodesArgs,
      );

    case 'grep': {
      // grep/find/ls/read do *not* take canvasId from the schema.
      // They use the workspace as their cwd. grep/find/ls fall back
      // to the request-scoped canvas folder when `path` is omitted;
      // read requires an explicit `path`.
      return handleGrep({
        ...(args as Omit<GrepArgs, 'currentCanvasId'>),
        currentCanvasId: context?.canvasId,
      });
    }

    case 'find': {
      return handleFind({
        ...(args as Omit<FindArgs, 'currentCanvasId'>),
        currentCanvasId: context?.canvasId,
      });
    }

    case 'ls': {
      return handleLs({
        ...(args as Omit<LsArgs, 'currentCanvasId'>),
        currentCanvasId: context?.canvasId,
      });
    }

    case 'read':
      return handleRead(args as ReadArgs);

    case 'canvas_commands':
      return handleCanvasCommands(
        resolveCanvasArgs(args, 'canvas_commands') as CanvasCommandsArgs,
      );

    case 'ingest_content':
      return handleIngestContent(
        resolveCanvasArgs(args, 'ingest_content') as IngestContentArgs,
      );

    case 'use_skill':
      return handleUseSkill({
        skillId: typeof args.skillId === 'string' ? args.skillId : '',
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
