/**
 * Memory analyzer — assemble context, call the LLM sub-agent, dispatch
 * writes via the memory tool.
 *
 * The worker calls {@link runAnalysisPass}. We:
 *
 *   1. Build the system prompt from `prompt/agents/memory/AGENT.md`.
 *   2. Assemble a compact context bundle from disk: canvas snapshot,
 *      chat-thread digest, recent ops, current contents of every
 *      memory surface (workspace, canvas, user-skill catalogue).
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { runAgent } from '../agent.service.js';
import { readMemoryState } from './trigger.js';
import { loadAgent, listSkills } from '../../../prompt/index.js';
import {
  canvasJsonPath,
  chatDir,
  eventsPath,
  workspaceMemoryPath,
  canvasMemoryPath,
} from '../../storage/paths.js';

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
const MAX_CHAT_TURNS_IN_DIGEST = 12;
const MAX_THREAD_SCAN = 6;

/**
 * Run one memory analysis pass.
 *
 * Errors propagate up to the worker, which logs them as warnings and
 * does NOT call `markAnalyzed` (so the next trigger retries). Writer
 * rejections are *not* errors — they come back as `ok:false` tool
 * results which we surface in the returned summary.
 *
 * The returned `latestChatTs` is the maximum message timestamp the
 * pass scanned (independent of which were summarised into the
 * prompt). The worker persists it as `lastSeenThreadCursor` via
 * {@link markAnalyzed} so subsequent passes only look at strictly
 * newer turns — without it the chat digest would re-include the
 * same messages every threshold crossing.
 */
export async function runAnalysisPass(
  canvasId: string,
  logger?: MemoryLogger,
): Promise<{ results: WriteResult[]; latestChatTs: number | null }> {
  const agent = loadAgent('memory');
  const bundle = assembleContext(canvasId);
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

  return { results: writeResults, latestChatTs: bundle.latestChatTs };
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
  /**
   * Max message timestamp scanned by the chat digest, or `null` when
   * no new turns were seen. Carries to the worker so it can persist
   * `lastSeenThreadCursor` and the next pass only looks at strictly
   * newer turns.
   */
  latestChatTs: number | null;
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
function assembleContext(canvasId: string): ContextBundle {
  const messages: Message[] = [];
  const parts: string[] = [];

  const snapshot = readCanvasSnapshot(canvasId);
  if (snapshot) {
    messages.push({
      role: 'user',
      content: `[SYSTEM Canvas snapshot]\n${snapshot.text}`,
      timestamp: Date.now(),
    });
    parts.push(`${snapshot.nodeCount} nodes`);
  }

  const state = readMemoryState(canvasId);
  const chat = readChatDigest(canvasId, state.lastSeenThreadCursor);
  if (chat) {
    messages.push({
      role: 'user',
      content: `[SYSTEM Chat digest since ${
        state.lastSeenThreadCursor ?? 'start'
      }]\n${chat.text}`,
      timestamp: Date.now(),
    });
    parts.push(`${chat.turns} chat turns`);
  }
  const events = readEventsDigest(canvasId);
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
    latestChatTs: chat?.latestTs ?? null,
  };
}

// ─── Source readers ────────────────────────────────────────────────────────

function readCanvasSnapshot(
  canvasId: string,
): { text: string; nodeCount: number } | null {
  const file = canvasJsonPath(canvasId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      title?: string | null;
      state?: { nodes?: unknown[]; edges?: unknown[] };
    };
    const nodes = Array.isArray(raw.state?.nodes) ? raw.state!.nodes : [];
    const edges = Array.isArray(raw.state?.edges) ? raw.state!.edges : [];
    const summarisedNodes = nodes
      .slice(0, MAX_NODES_IN_SNAPSHOT)
      .map((n) => summariseNode(n));
    const truncated = nodes.length > MAX_NODES_IN_SNAPSHOT;
    const lines = [
      `title: ${raw.title ?? '(untitled)'}`,
      `nodes: ${nodes.length}${truncated ? ` (showing first ${MAX_NODES_IN_SNAPSHOT})` : ''}`,
      `edges: ${edges.length}`,
      '',
      ...summarisedNodes,
    ];
    return { text: lines.join('\n'), nodeCount: nodes.length };
  } catch {
    return null;
  }
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

interface ChatDigest {
  text: string;
  turns: number;
  /**
   * Max `timestamp` seen across every message that passed the `since`
   * filter, regardless of whether it landed in the digest body. The
   * worker persists this as the next pass's `lastSeenThreadCursor`
   * so the chat digest monotonically advances.
   */
  latestTs: number | null;
}

/**
 * Pull a digest of recent chat turns from `<canvas>/.history/chat/`.
 *
 * Strategy:
 *   - List every thread file, sorted by `mtime` descending.
 *   - Walk up to {@link MAX_THREAD_SCAN} threads, scanning each
 *     message in turn. For each message:
 *       - drop turns older than `since` (the bookkeeping's
 *         `lastSeenThreadCursor`);
 *       - track `latestTs` = max(`timestamp`) of every survivor,
 *         so the caller can advance the cursor even when the
 *         digest body itself was capped;
 *       - skip system / non-user / non-assistant rows;
 *       - emit up to {@link MAX_CHAT_TURNS_IN_DIGEST} into the body.
 *   - For each emitted turn, render the role + the first ~200 chars
 *     of the content (or `[tool: name]` for assistant turns that
 *     only carried tool calls).
 */
function readChatDigest(
  canvasId: string,
  since: number | null,
): ChatDigest | null {
  const dir = chatDir(canvasId);
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const threads = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .map((p) => ({ path: p, mtime: safeMtime(p) }))
    .filter((t) => t.mtime !== null)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, MAX_THREAD_SCAN);

  const lines: string[] = [];
  let turns = 0;
  let latestTs: number | null = null;
  for (const thread of threads) {
    let ctx: { messages?: unknown[] } | null;
    try {
      ctx = JSON.parse(readFileSync(thread.path, 'utf8')) as {
        messages?: unknown[];
      };
    } catch {
      continue;
    }
    if (!ctx?.messages || !Array.isArray(ctx.messages)) continue;
    for (const m of ctx.messages) {
      if (!m || typeof m !== 'object') continue;
      const msg = m as {
        role?: string;
        content?: unknown;
        timestamp?: number;
      };
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : null;
      if (since !== null && ts !== null && ts <= since) continue;

      // Advance latestTs for every message that survived the `since`
      // filter — not just the ones we end up emitting. That way the
      // cursor still advances when MAX_CHAT_TURNS_IN_DIGEST has been
      // reached, and we don't re-scan the same prefix next pass.
      if (ts !== null && (latestTs === null || ts > latestTs)) {
        latestTs = ts;
      }

      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (turns >= MAX_CHAT_TURNS_IN_DIGEST) continue;
      const text = digestMessageContent(msg.content);
      if (text.startsWith('[SYSTEM')) continue;
      lines.push(`${role}: ${text}`);
      turns++;
    }
  }
  if (turns === 0 && latestTs === null) return null;
  return { text: lines.join('\n'), turns, latestTs };
}

function digestMessageContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 200);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      parts.push(`[tool: ${b.name}]`);
    }
  }
  return parts.join(' ').slice(0, 200);
}

interface EventsDigest {
  text: string;
  count: number;
}

function readEventsDigest(canvasId: string): EventsDigest | null {
  const file = eventsPath(canvasId);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-MAX_EVENTS_IN_DIGEST);
  if (tail.length === 0) return null;
  const summaries: string[] = [];
  for (const line of tail) {
    try {
      const evt = JSON.parse(line) as {
        ts?: number;
        payload?: { kind?: string; description?: string };
      };
      const kind = evt.payload?.kind ?? 'event';
      const desc = evt.payload?.description ?? '';
      summaries.push(`- ${kind}: ${String(desc).slice(0, 120)}`);
    } catch {
      // malformed line — skip
    }
  }
  return { text: summaries.join('\n'), count: tail.length };
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

function safeMtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
