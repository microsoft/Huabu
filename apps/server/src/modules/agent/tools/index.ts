/**
 * Tool barrel + AgentTool factory.
 *
 * `definitions.ts` holds pure schema/description pairs (no canvasId, no
 * IO). This file binds those definitions to the request-scoped
 * `canvasId` and the existing `executeTool` dispatcher, producing the
 * `AgentTool[]` that pi-agent-core's `Agent` consumes.
 */

import { chatTools, operateTools, type ToolDefinition } from './definitions.js';
import { executeTool } from './executor.js';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMode } from '@sediment/shared';

export { executeTool } from './executor.js';
export type { ToolDefinition } from './definitions.js';

/** Per-request context closed over by every tool's `execute`. */
export interface ToolBuildContext {
  /** Current canvas id; tools that omit it in args fall back to this value. */
  canvasId?: string;
}

/**
 * Wrap a `ToolDefinition` into a runnable `AgentTool` by attaching an
 * `execute` closure that delegates to the existing `executeTool`
 * dispatcher. Errors are thrown so pi-agent-core marks the resulting
 * toolResult as `isError: true` (its standard convention).
 */
function toAgentTool(def: ToolDefinition, ctx: ToolBuildContext): AgentTool {
  return {
    ...def,
    execute: async (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<undefined>> => {
      const text = await executeTool(
        def.name,
        params as Record<string, unknown>,
        { canvasId: ctx.canvasId },
      );
      return {
        content: [{ type: 'text', text }],
        details: undefined,
      };
    },
  };
}

/**
 * Build the runnable tool set for an agent run.
 *
 * The returned array shape mirrors `definitions.ts`'s `chatTools` /
 * `operateTools`, just with `execute` bound to the request context.
 */
export function buildToolsForMode(
  mode: AgentMode,
  ctx: ToolBuildContext,
): AgentTool[] {
  const defs = mode === 'operate' ? operateTools : chatTools;
  return defs.map((def) => toAgentTool(def, ctx));
}
