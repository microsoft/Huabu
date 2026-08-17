// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory analyzer — assemble context, call the LLM sub-agent, dispatch
 * writes via the memory tool.
 *
 * The worker calls {@link runAnalysisPass}. We:
 *
 *   1. Build the system prompt from `prompt/agents/memory/AGENT.md`.
 *   2. Assemble a compact context bundle from backend-owned Space records
 *      and logs, plus the memory surfaces.
 *   3. Run the sub-agent against that context. The agent's only way
 *      to affect the world is via the `fs_write` tool, whose handler
 *      routes by virtual path into the writers in `./writers.ts`.
 *   4. Aggregate the tool results into a single summary the worker
 *      can log.
 *
 * Cost / token notes:
 *   - The bundle is intentionally lean: node bodies / tool result
 *     bodies are excluded.
 *   - The sub-agent is capped at `maxIterations=5` via AGENT.md.
 *   - `fs_write` is marked `executionMode: 'sequential'` so batched
 *     mutations on the same disk targets apply in declared order.
 */

import { existsSync, readFileSync } from 'node:fs';

import { loadAgent, listSkills } from '../../../prompt/index.js';
import {
  getStructuredStore,
  type CanvasEvent,
  type CanvasFile,
  type SpaceHandle,
} from '../../storage/index.js';
import {
  canvasMemoryPath,
  workspaceMemoryPath,
} from '../../workspace/paths.js';
import { runAgent } from '../agent.service.js';

import type { MemoryLogger } from './index.js';
import type { WriteResult } from './writers.js';
import type { Context, Message } from '@earendil-works/pi-ai';

/**
 * Soft caps applied while assembling the context bundle. The
 * sub-agent only needs a *flavour* of recent activity, not the full
 * history — these caps keep the prompt under ~8 KB even on busy
 * canvases.
 */
const MAX_NODES_IN_SNAPSHOT = 60;
const MAX_EVENTS_IN_DIGEST = 100;

/**
 * Run one memory analysis pass.
 *
 * Errors propagate up to the worker, which logs them as warnings and
 * does NOT call `markAnalyzed` (so the next trigger retries). Writer
 * rejections are *not* errors — they come back as `ok:false` tool
 * results which we surface in the returned summary.
 */
export type AnalysisPassResult =
  | {
      status: 'completed';
      results: WriteResult[];
    }
  | { status: 'skipped'; reason: 'space-not-found' };

export async function runAnalysisPass(
  canvasId: string,
  logger?: MemoryLogger,
): Promise<AnalysisPassResult> {
  const handle = getStructuredStore().space(canvasId);
  const record = await handle.read();
  if (!record) return { status: 'skipped', reason: 'space-not-found' };

  const bundle = await assembleContext(canvasId, handle, record);
  const agent = loadAgent('memory');
  const context: Context = {
    systemPrompt: agent.systemPrompt,
    messages: bundle.messages,
    tools: [],
  };

  logger?.info(
    `[memory] analysing canvas ${canvasId} (bundle: ${bundle.summary})`,
  );

  const writeResults: WriteResult[] = [];

  // runAgent yields SSE-shaped events. After the PR-ACP refactor the
  // pi-agent-core stream emits a `tool_call` (with `internalToolName`)
  // when each tool starts and a `tool_call_update` (with `rawOutput`)
  // when it settles — there's no longer a dedicated `tool_result`
  // frame. We keep a small map of toolCallId -> tool name so we only
  // parse the updates that belong to our writer (`fs_write`).
  const stream = runAgent({
    scope: 'memory',
    modelRole: 'memory',
    canvasId,
    context,
    logger: { info: (m) => logger?.info(m) },
    maxIterations: agent.runtime.maxIterations ?? 5,
  });
  const writeCalls = new Map<string, string>();
  for await (const event of stream) {
    if (event.type === 'tool_call') {
      const { toolCallId, internalToolName } = event.data;
      if (internalToolName === 'fs_write') {
        writeCalls.set(toolCallId, internalToolName);
      }
      continue;
    }
    if (event.type !== 'tool_call_update') continue;
    const { toolCallId, rawOutput } = event.data;
    if (!writeCalls.has(toolCallId)) continue;
    if (typeof rawOutput !== 'string' || rawOutput.length === 0) continue;
    const parsed = parseWriteResult(rawOutput);
    if (parsed) writeResults.push(parsed);
  }

  return {
    status: 'completed',
    results: writeResults,
  };
}

function parseWriteResult(raw: string): WriteResult | null {
  try {
    const obj = JSON.parse(raw) as Partial<WriteResult> & {
      tool?: string;
      status?: string;
    };
    // The agent service wraps errors into `{ tool, status:'error', error }`
    // envelopes; surface those as rejection too.
    if (obj.status === 'error') {
      return {
        ok: false,
        target: '<unknown>',
        reason: String((obj as { error?: string }).error ?? 'error'),
      };
    }
    if (typeof obj.ok === 'boolean' && typeof obj.target === 'string') {
      return {
        ok: obj.ok,
        target: obj.target,
        reason: String(obj.reason ?? ''),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Context assembly ──────────────────────────────────────────────────────

interface ContextBundle {
  messages: Message[];
  summary: string;
}

/**
 * Build the per-canvas context bundle.
 *
 * Each piece is a separate `user`-role message tagged with a
 * `[SYSTEM …]` header so the sub-agent can refer back to them. The
 * final message asks for the analysis itself. Empty / missing
 * sources are omitted so the prompt never carries stub "(none)"
 * lines that would waste tokens.
 */
async function assembleContext(
  canvasId: string,
  handle: SpaceHandle,
  record: CanvasFile,
): Promise<ContextBundle> {
  const messages: Message[] = [];
  const parts: string[] = [];

  const snapshot = readCanvasSnapshot(record);
  messages.push({
    role: 'user',
    content: `[SYSTEM Canvas snapshot]\n${snapshot.text}`,
    timestamp: Date.now(),
  });
  parts.push(`${snapshot.nodeCount} nodes`);

  const eventRows = await handle.events.read(MAX_EVENTS_IN_DIGEST);
  const events = readEventsDigest(eventRows);
  if (events) {
    messages.push({
      role: 'user',
      content: `[SYSTEM Recent ops]\n${events.text}`,
      timestamp: Date.now(),
    });
    parts.push(`${events.count} ops`);
  }

  const memorySnapshot = readMemorySnapshot(canvasId);
  messages.push({
    role: 'user',
    content: `[SYSTEM Current memory]\n${memorySnapshot}`,
    timestamp: Date.now(),
  });

  messages.push({
    role: 'user',
    content:
      'Analyse the observations above. Update workspace, canvas, or skill memory only if there is high-confidence value in doing so. Output nothing in free-form text — use tool calls.',
    timestamp: Date.now(),
  });

  return {
    messages,
    summary: parts.join(', ') || '(empty)',
  };
}

// ─── Source readers ────────────────────────────────────────────────────────

function readCanvasSnapshot(record: CanvasFile): {
  text: string;
  nodeCount: number;
} {
  const nodes = Array.isArray(record.state?.nodes) ? record.state.nodes : [];
  const edges = Array.isArray(record.state?.edges) ? record.state.edges : [];
  const summarisedNodes = nodes
    .slice(0, MAX_NODES_IN_SNAPSHOT)
    .map((node) => summariseNode(node));
  const truncated = nodes.length > MAX_NODES_IN_SNAPSHOT;
  const lines = [
    `title: ${record.title ?? '(untitled)'}`,
    `nodes: ${nodes.length}${truncated ? ` (showing first ${MAX_NODES_IN_SNAPSHOT})` : ''}`,
    `edges: ${edges.length}`,
    '',
    ...summarisedNodes,
  ];
  return { text: lines.join('\n'), nodeCount: nodes.length };
}

function summariseNode(node: unknown): string {
  if (!node || typeof node !== 'object') return '- (malformed node)';
  const n = node as {
    id?: string;
    type?: string;
    data?: { label?: string };
    position?: { x?: number; y?: number };
  };
  const id = n.id ?? '(no id)';
  const type = n.type ?? '(no type)';
  const label = n.data?.label?.toString() ?? '';
  const x = n.position?.x;
  const y = n.position?.y;
  const pos =
    typeof x === 'number' && typeof y === 'number'
      ? ` @ (${Math.round(x)},${Math.round(y)})`
      : '';
  return `- [${type}] ${id} "${label.slice(0, 60)}"${pos}`;
}

interface EventsDigest {
  text: string;
  count: number;
}

function readEventsDigest(events: readonly CanvasEvent[]): EventsDigest | null {
  if (events.length === 0) return null;
  const summaries = events.map((event) => {
    // Preserve the existing output until the dedicated formatter issue is
    // addressed. Canonical RecentAction payloads use `action`, so they still
    // render as the historical "event" fallback in this storage-only slice.
    const payload = event.payload as unknown as {
      kind?: unknown;
      description?: unknown;
    };
    return `- ${payload.kind ?? 'event'}: ${String(payload.description ?? '').slice(0, 120)}`;
  });
  return { text: summaries.join('\n'), count: events.length };
}

function readMemorySnapshot(canvasId: string): string {
  const parts: string[] = [];

  const longTerm = readFileSafe(workspaceMemoryPath());
  parts.push('## Long-term memory');
  parts.push(longTerm.trim().length > 0 ? longTerm.trim() : '(empty)');

  const canvas = readFileSafe(canvasMemoryPath(canvasId));
  parts.push('');
  parts.push('## Canvas memory');
  parts.push(canvas.trim().length > 0 ? canvas.trim() : '(empty)');

  parts.push('');
  parts.push('## User-skill catalogue');
  // Listing only user / merged skills here keeps the prompt focussed
  // on what the curator can actually *write to*. System-only skills
  // are read-only from the memory agent's perspective.
  const skills = listSkills().filter(
    (s) => s.source === 'user' || s.source === 'merged',
  );
  if (skills.length === 0) {
    parts.push('(no user skills yet)');
  } else {
    for (const s of skills) {
      parts.push(`- ${s.id} (${s.source}): ${s.description}`);
    }
  }

  return parts.join('\n');
}

function readFileSafe(file: string): string {
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
