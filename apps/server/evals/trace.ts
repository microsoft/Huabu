// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Trace recorder.
 *
 * Wraps `runAgent` and folds its `AsyncGenerator<StreamEvent>` output
 * into a single structured `Trace` document. The document is the
 * canonical artifact every downstream stage (assertions, differ,
 * report) consumes, and it is the only thing we persist to disk.
 *
 * Trace shape is intentionally flat / JSON-friendly — no class
 * instances, no Date objects — so it diff-friendly via standard
 * tooling and stable across schema versions.
 */

import { runAgent } from '../src/modules/agent/agent.service.js';
import { loadAgent } from '../src/prompt/index.js';

import type { Context } from '@earendil-works/pi-ai';
import type { AgentMode } from '@huabu/shared';

/** Bumped whenever the on-disk trace shape changes. */
export const TRACE_SCHEMA_VERSION = 1;

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  /** Wall-clock duration between `tool_start` and `tool_result` (ms). */
  ms: number;
  /**
   * `true` if pi-agent-core treated the result as success; `false`
   * when the SSE bridge wrapped it in `{ status: 'error', ... }`.
   */
  ok: boolean;
  /** First ~500 chars of the tool result text — handy for spot checks. */
  resultPreview: string;
}

export interface Trace {
  schemaVersion: number;
  caseId: string;
  seed: number;
  /** ISO 8601 timestamp at run start. */
  startedAt: string;
  /** Total wall-clock from generator start to last yield (ms). */
  elapsedMs: number;
  /** Number of agent turns completed (counted via `done.meta.iterations`). */
  turns: number;
  toolCalls: ToolCallRecord[];
  /** Final assistant text. Empty string if the agent errored before replying. */
  finalText: string;
  /** Optional error message; non-null implies the run did not produce a `done` event. */
  error: string | null;
  /** Stop reason from the agent loop (`'stop'` / `'aborted'` / `'error'`). */
  stopReason: string | null;
  /** Token usage from pi-ai's last assistant message, if reported. */
  usage: { input?: number; output?: number; total?: number } | null;
}

interface RecordOptions {
  caseId: string;
  seed: number;
  mode: AgentMode;
  canvasId: string;
  prompt: string;
  maxIterations: number;
}

/**
 * Drive `runAgent` end-to-end and emit a single `Trace`.
 *
 * The runner is responsible for activating the workspace beforehand
 * (so `runAgent`'s tool handlers resolve files relative to it).
 */
export async function recordTrace(opts: RecordOptions): Promise<Trace> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const context: Context = {
    systemPrompt: loadAgent(opts.mode).systemPrompt,
    messages: [
      {
        role: 'user',
        content: opts.prompt,
        timestamp: startedAtMs,
      },
    ],
    tools: [],
  };

  const toolCalls: ToolCallRecord[] = [];
  // Tool start metadata keyed by the stable per-call id, so a
  // `tool_call` pairs exactly with its `tool_call_update` even when
  // tools execute in parallel and complete out of declaration order.
  const pending = new Map<string, { index: number; startedMs: number }>();

  let finalText = '';
  let error: string | null = null;
  let stopReason: string | null = null;
  let turns = 0;
  let usage: Trace['usage'] = null;

  const stream = runAgent({
    scope: opts.mode,
    canvasId: opts.canvasId,
    context,
    maxIterations: opts.maxIterations,
  });

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'tool_call': {
          // Internal-agent turns carry the machine tool name on
          // `internalToolName`; fall back to the display title.
          const name = event.data.internalToolName ?? event.data.title;
          const index =
            toolCalls.push({
              name,
              args: (event.data.rawInput as Record<string, unknown>) ?? {},
              ms: 0,
              ok: true,
              resultPreview: '',
            }) - 1;
          pending.set(event.data.toolCallId, {
            index,
            startedMs: Date.now(),
          });
          break;
        }
        case 'tool_call_update': {
          const entry = pending.get(event.data.toolCallId);
          if (!entry) break;
          // Only finalize on a terminal status or once a result
          // payload arrives — external agents may stream interim
          // `in_progress` updates we should not treat as completion.
          const status = event.data.status;
          const isTerminal = status === 'completed' || status === 'failed';
          if (!isTerminal && event.data.rawOutput === undefined) break;
          pending.delete(event.data.toolCallId);
          const elapsedMs = Math.max(0, Date.now() - entry.startedMs);

          // The internal bridge wraps thrown handler errors as
          // `{ status: 'error', ... }` JSON envelopes on `rawOutput`
          // (see agent.service.ts) and sets ACP status `failed`.
          const text =
            typeof event.data.rawOutput === 'string'
              ? event.data.rawOutput
              : event.data.rawOutput !== undefined
                ? JSON.stringify(event.data.rawOutput)
                : '';
          let ok = status !== 'failed';
          if (ok && text.startsWith('{')) {
            try {
              const parsed = JSON.parse(text) as { status?: string };
              if (parsed.status === 'error') ok = false;
            } catch {
              // not JSON; treat as success
            }
          }

          const record = toolCalls[entry.index];
          record.ms = elapsedMs;
          record.ok = ok;
          record.resultPreview = text.slice(0, 500);
          break;
        }
        case 'done': {
          finalText = event.data.message;
          stopReason = event.data.meta?.stopReason ?? null;
          turns = event.data.meta?.iterations ?? turns;
          // pi-ai's `Usage` shape is `{ input, output, totalTokens, ... }`
          // but the shared event type widens it to `unknown` — narrow
          // just enough to read the three fields we surface.
          const u = event.data.meta?.usage as
            | { input?: number; output?: number; totalTokens?: number }
            | undefined;
          if (u) {
            usage = {
              input: u.input,
              output: u.output,
              total: u.totalTokens,
            };
          }
          break;
        }
        case 'error': {
          error = event.data.error;
          break;
        }
        // text_delta / thinking_delta are streaming UX only — we
        // already capture the full text via `done.message`.
        default:
          break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const elapsedMs = Date.now() - startedAtMs;

  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    caseId: opts.caseId,
    seed: opts.seed,
    startedAt,
    elapsedMs,
    turns,
    toolCalls,
    finalText,
    error,
    stopReason,
    usage,
  };
}
