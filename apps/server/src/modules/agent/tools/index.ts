/**
 * Tool barrel + AgentTool factory.
 *
 * `definitions.ts` holds pure schema/description pairs (no canvasId, no
 * IO). This file binds those definitions to the request-scoped
 * `canvasId` / `origin` and the existing `executeTool` dispatcher,
 * producing the `AgentTool[]` that pi-agent-core's `Agent` consumes.
 *
 * Tool *selection* per agent is no longer hard-coded here — each
 * agent's `AGENT.md` declares its `tools:` list by name, and
 * {@link buildAgentToolsByNames} resolves names against `TOOL_REGISTRY`.
 */

import { TOOL_REGISTRY, type ToolDefinition } from './definitions.js';
import { executeTool } from './executor.js';
import { loadAgent, type AgentId } from '../../../prompt/index.js';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMode, NodeOrigin } from '@sediment/shared';

export { executeTool } from './executor.js';
export type { ToolDefinition } from './definitions.js';

/**
 * Surfaces the tool builder understands.
 *
 * Mirrors `AgentMode` plus `'sketch'` for the freehand-gesture
 * pipeline. Kept local rather than reusing `SkillScope` from the
 * skill loader because `'external'` agents bring their own tooling
 * and should never go through this builder.
 */
export type ToolScope = AgentMode | 'sketch';

/** Per-request context closed over by every tool's `execute`. */
export interface ToolBuildContext {
  /** Current canvas id; tools that omit it in args fall back to this value. */
  canvasId?: string;
  /**
   * `NodeOrigin` stamp injected onto every node created by the
   * `canvas_commands` tool. Defaults to `{ type: 'ai-operate' }`
   * inside the handler when unset; the sketch pipeline overrides
   * it to `{ type: 'sketch-recognized' }` so user-authored
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
 * Resolve a list of tool names against `TOOL_REGISTRY` and bind each
 * to the request context. Throws on unknown names so a typo in
 * `AGENT.md` fails loudly at startup rather than silently dropping a
 * tool.
 */
export function buildAgentToolsByNames(
  names: readonly string[],
  ctx: ToolBuildContext,
): AgentTool[] {
  return names.map((name) => {
    const def = TOOL_REGISTRY[name];
    if (!def) {
      throw new Error(
        `[tools] Unknown tool name "${name}" — not in TOOL_REGISTRY (definitions.ts)`,
      );
    }
    return toAgentTool(def, ctx);
  });
}

/**
 * Build the runnable tool set for an agent run.
 *
 * Resolves the agent's `tools:` list (declared in AGENT.md) via
 * {@link loadAgent} and binds each one to the request context. The
 * per-scope tool composition is owned by `prompt/agents/<id>/AGENT.md`.
 */
export function buildToolsForScope(
  scope: ToolScope,
  ctx: ToolBuildContext,
): AgentTool[] {
  // ToolScope ⊂ AgentId (intent has no tools and never reaches here),
  // so the cast is sound.
  const cfg = loadAgent(scope as AgentId);
  return buildAgentToolsByNames(cfg.toolNames, ctx);
}
