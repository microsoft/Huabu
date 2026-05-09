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
  ): (T & { canvasId: string }) | null => {
    const canvasId =
      typeof value.canvasId === 'string' && value.canvasId.trim().length > 0
        ? value.canvasId
        : context?.canvasId;
    if (!canvasId) return null;
    return { ...value, canvasId };
  };

  switch (name) {
    case 'web_search':
      return handleWebSearch(args as WebSearchArgs);

    case 'get_canvas_outline': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for get_canvas_outline',
        });
      }
      return handleGetCanvasOutline(resolvedArgs as GetCanvasOutlineArgs);
    }

    case 'inspect_nodes': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for inspect_nodes',
        });
      }
      return handleInspectNodes(resolvedArgs as InspectNodesArgs);
    }

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

    case 'read': {
      return handleRead(args as ReadArgs);
    }

    case 'canvas_commands': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          tool: 'canvas_commands',
          status: 'error',
          error: 'canvasId is required for canvas_commands',
        });
      }
      return handleCanvasCommands(resolvedArgs as CanvasCommandsArgs);
    }

    case 'ingest_content': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for ingest_content',
        });
      }
      return handleIngestContent(resolvedArgs as IngestContentArgs);
    }

    case 'use_skill':
      return handleUseSkill({
        skillId: typeof args.skillId === 'string' ? args.skillId : '',
      });

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
