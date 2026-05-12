/**
 * Tool barrel + AgentTool factory.
 *
 * `definitions.ts` holds pure schema/description pairs (no canvasId, no
 * IO). This file binds those definitions to the request-scoped
 * `canvasId` and the existing `executeTool` dispatcher, producing the
 * `AgentTool[]` that pi-agent-core's `Agent` consumes.
 */

import {
  annotationTools,
  askTools,
  operateTools,
  type ToolDefinition,
} from './definitions.js';
import { executeTool } from './executor.js';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMode, NodeOrigin } from '@sediment/shared';

export { executeTool } from './executor.js';
export type { ToolDefinition } from './definitions.js';

/**
 * Surfaces the tool builder understands.
 *
 * Mirrors `AgentMode` plus `'annotation'` for the freehand-gesture
 * pipeline. Kept local rather than reusing `SkillScope` from the
 * skill loader because `'external'` agents bring their own tooling
 * and should never go through this builder.
 */
export type ToolScope = AgentMode | 'annotation';

/** Per-request context closed over by every tool's `execute`. */
export interface ToolBuildContext {
  /** Current canvas id; tools that omit it in args fall back to this value. */
  canvasId?: string;
  /**
   * `NodeOrigin` stamp injected onto every node created by the
   * `canvas_commands` tool. Defaults to `{ type: 'ai-operate' }`
   * inside the handler when unset; the annotation pipeline overrides
   * it to `{ type: 'annotation-recognized' }` so user-authored
   * gestures are not mis-tagged as AI-initiated. Other tools ignore
   * this field.
   */
  origin?: NodeOrigin;
}

/**
 * Wrap a `ToolDefinition` into a runnable `AgentTool` by attaching an
 * `execute` closure that delegates to the existing `executeTool`
 * dispatcher.
 *
 * Per the pi-agent-core `AgentTool.execute` contract, failures throw.
 * We deliberately do NOT wrap `executeTool` in a try/catch here:
 * pi-agent-core's `executePreparedToolCall` catches the throw, builds
 * an error tool result via `createErrorToolResult`, and sets
 * `isError: true` on the resulting toolResult message and
 * `tool_execution_end` event. The web SSE bridge in
 * `agent.service.ts` lifts that flag into a
 * `ToolResponse<status: 'error'>` envelope.
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
        {
          canvasId: ctx.canvasId,
          origin: ctx.origin,
        },
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
 * The returned array shape mirrors `definitions.ts`'s `askTools` /
 * `operateTools` / `annotationTools`, just with `execute` bound to
 * the request context.
 */
export function buildToolsForScope(
  scope: ToolScope,
  ctx: ToolBuildContext,
): AgentTool[] {
  const defs =
    scope === 'operate'
      ? operateTools
      : scope === 'annotation'
        ? annotationTools
        : askTools;
  return defs.map((def) => toAgentTool(def, ctx));
}
