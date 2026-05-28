/**
 * Memory analyzer — assemble context, call the LLM sub-agent, dispatch
 * writes via the memory tools.
 *
 * The worker calls {@link runAnalysisPass}. We:
 *
 *   1. Build the system prompt from `prompt/agents/memory/AGENT.md`.
 *   2. Assemble a compact context bundle from disk: canvas snapshot,
 *      chat-thread digest, recent ops, current contents of every
 *      memory surface (long-term, working, user-skill catalogue).
 *   3. Run the sub-agent against that context. The agent's only way
 *      to affect the world is via the three `memory_*_write` tools,
 *      whose handlers wrap the writers in `./writers.ts`.
 *   4. Aggregate the tool results into a single summary the worker
 *      can log.
 *
 * Cost / token notes:
 *   - The bundle is intentionally lean: node bodies / tool result
 *     bodies are excluded.
 *   - The sub-agent is capped at `maxIterations=5` via AGENT.md.
 *   - All three writers run sequentially (`executionMode: 'sequential'`)
 *     because batched mutations on the same disk targets are easier
 *     to reason about when ordered.
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
  longTermMemoryPath,
  workingMemoryPath,
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
 */
export async function runAnalysisPass(
  canvasId: string,
  logger?: MemoryLogger,
): Promise<WriteResult[]> {
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

  // runAgent yields SSE-shaped events; we discard everything except
  // tool_result, where we pluck the JSON-encoded WriteResult that
  // each memory writer handler returns. The chat / operate routes
  // also forward `text_delta` etc. to the client; here we don't have
  // a client — the side effects on disk are the only output.
  const stream = runAgent({
    scope: 'memory',
    canvasId,
    context,
    logger: { info: (m) => logger?.info(m) },
    maxIterations: agent.runtime.maxIterations ?? 5,
  });
  for await (const event of stream) {
    if (event.type !== 'tool_result') continue;
    const { toolName, toolResult } = event.data;
    if (!toolName.startsWith('memory_')) continue;
    const parsed = parseWriteResult(toolResult);
    if (parsed) writeResults.push(parsed);
  }

  return writeResults;
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
      'Analyse the observations above. Update long-term, working, or skill memory only if there is high-confidence value in doing so. Output nothing in free-form text — use tool calls.',
    timestamp: Date.now(),
  });

  return {
    messages,
    summary: parts.join(', ') || '(empty)',
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
}

/**
 * Pull a digest of recent chat turns from `<canvas>/.history/chat/`.
 *
 * Strategy:
 *   - List every thread file, sorted by `mtime` descending.
 *   - Walk up to {@link MAX_THREAD_SCAN} threads, gathering messages
 *     until we have {@link MAX_CHAT_TURNS_IN_DIGEST} non-system
 *     turns.
 *   - For each turn, emit the role + the first ~200 chars of the
 *     content (or a `[tool: name]` marker for assistant turns that
 *     only carry tool calls).
 *   - Drop turns older than `since` (the bookkeeping's
 *     `lastSeenThreadCursor`).
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
  outer: for (const thread of threads) {
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
      if (since !== null && typeof msg.timestamp === 'number') {
        if (msg.timestamp <= since) continue;
      }
      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = digestMessageContent(msg.content);
      if (text.startsWith('[SYSTEM')) continue;
      lines.push(`${role}: ${text}`);
      turns++;
      if (turns >= MAX_CHAT_TURNS_IN_DIGEST) break outer;
    }
  }
  if (turns === 0) return null;
  return { text: lines.join('\n'), turns };
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

  const longTerm = readFileSafe(longTermMemoryPath());
  parts.push('## Long-term memory');
  parts.push(longTerm.trim().length > 0 ? longTerm.trim() : '(empty)');

  const working = readFileSafe(workingMemoryPath(canvasId));
  parts.push('');
  parts.push('## Working memory');
  parts.push(working.trim().length > 0 ? working.trim() : '(empty)');

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
