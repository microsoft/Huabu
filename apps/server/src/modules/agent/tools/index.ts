// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import {
  describeQualitiesForPrompt,
  describeSizesForPrompt,
  getImageCapabilities,
} from '@huabu/shared';

import { TOOL_REGISTRY, type ToolDefinition } from './definitions.js';
import { executeTool } from './executor.js';
import { loadAgent, type AgentId } from '../../../prompt/index.js';
import { getConfiguredImageModelFamily } from '../llm.js';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentMode, NodeOrigin } from '@huabu/shared';

export { executeTool } from './executor.js';
export type { ToolDefinition } from './definitions.js';

/**
 * Surfaces the tool builder understands.
 *
 * Mirrors `AgentMode` plus internal pipelines that also borrow the
 * canvas tool surface:
 *   - `'memory'` — background memory curator.
 *
 * Kept local rather than reusing `SkillScope` from the skill loader
 * because `'external'` agents bring their own tooling and should
 * never go through this builder.
 */
export type ToolScope = AgentMode | 'memory';

/** Per-request context closed over by every tool's `execute`. */
export interface ToolBuildContext {
  /** Current canvas id; tools that omit it in args fall back to this value. */
  canvasId?: string;
  /**
   * `NodeOrigin` stamp injected onto every node created by the
   * `canvas_commands` tool. Defaults to `{ type: 'ai-operate' }`
   * inside the handler when unset. Other tools ignore this field.
   */
  origin?: NodeOrigin;
  /** ACP conversation thread to attribute canvas changes to. */
  threadId?: string;
  /**
   * Run-scoped read-set: `nodeId → authored-content rev` the agent has
   * seen this run (seeded from the turn's node refs, updated by `read`).
   * `canvas_commands` auto-injects `expectRev` from it so content writes
   * carry the rev the agent last saw, and the executor's CAS can reject a
   * stale (or never-read) overwrite. Ephemeral — one Map per `runAgent`.
   */
  readSet?: Map<string, string>;
}

/**
 * Append a per-deployment "Active image deployment" section to
 * `generate_image`'s description so the agent sees the legal size /
 * quality values for the user's currently configured family
 * (`gpt-image-1` vs `gpt-image-2` vs `gpt-image-1-mini`). Resolved
 * at bind time rather than at module load so changing Settings
 * takes effect on the next chat turn.
 */
function patchGenerateImageDescription(def: ToolDefinition): ToolDefinition {
  if (def.name !== 'generate_image') return def;
  const family = getConfiguredImageModelFamily();
  const caps = getImageCapabilities(family);
  const block =
    `\n\n--- Active image deployment ---\n` +
    `Model family: ${caps.family}.\n` +
    `${describeSizesForPrompt(family)}\n` +
    `${describeQualitiesForPrompt(family)}`;
  return { ...def, description: `${def.description ?? ''}${block}` };
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
  const enriched = patchGenerateImageDescription(def);
  return {
    ...enriched,
    execute: async (_toolCallId, params) => {
      const out = await executeTool(
        def.name,
        params as Record<string, unknown>,
        {
          canvasId: ctx.canvasId,
          origin: ctx.origin,
          threadId: ctx.threadId,
          readSet: ctx.readSet,
        },
      );
      // Handlers may return either a plain string (the common text
      // envelope) or a pre-built `AgentToolResult` when they need to
      // emit non-text parts — e.g. `read` returning an image artifact
      // inline as vision content.
      if (typeof out === 'string') {
        return {
          content: [{ type: 'text', text: out }],
          details: undefined,
        };
      }
      return out;
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
  // Every ToolScope is also an AgentId, so the cast is sound.
  const cfg = loadAgent(scope as AgentId);
  return buildAgentToolsByNames(cfg.toolNames, ctx);
}
