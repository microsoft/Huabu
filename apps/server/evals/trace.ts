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
import { buildAgentPrompt } from '../src/prompt/agent.js';

import type { Context } from '@earendil-works/pi-ai';
import type { AgentMode } from '@sediment/shared';

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
    systemPrompt: buildAgentPrompt(opts.mode),
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
  // Tool start times keyed by tool name. pi-agent-core does not expose
  // a tool-call id in our SSE bridge, so we pair the most recent
  // `tool_start` for a given name with the next `tool_result` of the
  // same name. Within a single batch, calls of the same name are
  // executed in order, so this matches pi-agent-core's emission order.
  const pending = new Map<string, number[]>();

  let finalText = '';
  let error: string | null = null;
  let stopReason: string | null = null;
  let turns = 0;
  let usage: Trace['usage'] = null;

  const stream = runAgent({
    mode: opts.mode,
    canvasId: opts.canvasId,
    context,
    maxIterations: opts.maxIterations,
  });

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'tool_start': {
          const list = pending.get(event.data.toolName) ?? [];
          list.push(Date.now());
          pending.set(event.data.toolName, list);
          // Push a placeholder so the order in `toolCalls` matches
          // `tool_start` order. We patch `ms` / `ok` / preview when
          // the matching `tool_result` arrives.
          toolCalls.push({
            name: event.data.toolName,
            args: event.data.toolArgs ?? {},
            ms: 0,
            ok: true,
            resultPreview: '',
          });
          break;
        }
        case 'tool_result': {
          const list = pending.get(event.data.toolName);
          const startedMs = list?.shift() ?? Date.now();
          const elapsedMs = Math.max(0, Date.now() - startedMs);

          // pi-agent-core wraps thrown handler errors as
          // `{ status: 'error', ... }` JSON envelopes (see
          // agent.service.ts). Anything else is treated as success.
          let ok = true;
          const text = event.data.toolResult ?? '';
          if (text.startsWith('{')) {
            try {
              const parsed = JSON.parse(text) as { status?: string };
              if (parsed.status === 'error') ok = false;
            } catch {
              // not JSON; treat as success
            }
          }

          // Patch the most recent placeholder for this tool name in
          // reverse order — guarantees FIFO pairing without an
          // O(n) scan from the front for typical (small) traces.
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            const entry = toolCalls[i];
            if (entry.name === event.data.toolName && entry.ms === 0) {
              entry.ms = elapsedMs;
              entry.ok = ok;
              entry.resultPreview = text.slice(0, 500);
              break;
            }
          }
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
