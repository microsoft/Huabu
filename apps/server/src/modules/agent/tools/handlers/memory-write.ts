/**
 * Memory tool handlers — thin bridges from pi-agent-core tool calls
 * into the memory writers.
 *
 * Each handler:
 *   1. Receives the validated tool args (pi-ai already passed the
 *      TypeBox schema check before dispatch).
 *   2. Calls the matching writer in `modules/agent/memory/writers.ts`.
 *   3. Serialises the {@link WriteResult} as a JSON string for the
 *      tool result content block.
 *
 * Handlers never throw past the writer boundary — writers return
 * structured failure, and the sub-agent sees it as a successful tool
 * call with `ok:false`. This avoids the `isError:true` path (which is
 * for true exceptions like a thrown sandbox escape) and keeps the
 * agent's flow under its own control.
 */

import {
  writeLongTerm,
  writeSkill,
  writeWorkingMemory,
} from '../../memory/writers.js';

import type {
  memoryLongtermWriteParamsSchema,
  memoryShorttermWriteParamsSchema,
  memorySkillWriteParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────

export type MemoryLongtermWriteArgs = Static<
  typeof memoryLongtermWriteParamsSchema
>;

export type MemoryShorttermWriteArgs = Static<
  typeof memoryShorttermWriteParamsSchema
> & {
  /**
   * Injected by the executor from the request-scoped canvas id —
   * working memory is per-canvas, so a tool call that arrives
   * without a canvas in scope is rejected upstream.
   */
  canvasId: string;
};

export type MemorySkillWriteArgs = Static<typeof memorySkillWriteParamsSchema>;

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function handleMemoryLongtermWrite(
  args: MemoryLongtermWriteArgs,
): Promise<string> {
  const result = writeLongTerm({
    mode: args.mode,
    diff: args.diff,
  });
  return JSON.stringify(result);
}

export async function handleMemoryShorttermWrite(
  args: MemoryShorttermWriteArgs,
): Promise<string> {
  const result = writeWorkingMemory({
    canvasId: args.canvasId,
    body: args.body,
  });
  return JSON.stringify(result);
}

export async function handleMemorySkillWrite(
  args: MemorySkillWriteArgs,
): Promise<string> {
  const result = writeSkill({
    op: args.op,
    id: args.id,
    title: args.title,
    description: args.description,
    appliesTo: args.appliesTo,
    body: args.body,
    rationale: args.rationale,
  });
  return JSON.stringify(result);
}
