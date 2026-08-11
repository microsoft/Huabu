// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Intent Recognition Service
 *
 * Receives an IntentContext and returns a ranked list of intent candidates
 * by calling the LLM to analyze the canvas state and recent user actions.
 */

import { llmComplete, llmStream } from './llm.js';
import { readCanvasMemory, readWorkspaceMemory } from './memory/index.js';
import { logIntentEpisode as storeEpisode } from './store/intent-store.js';
import { loadAgent } from '../../prompt/index.js';
import { getLogger } from '../../utils/logger.js';

import type { Context } from '@earendil-works/pi-ai';
import type {
  IntentCandidate,
  IntentContext,
  IntentEpisode,
  RecentAction,
} from '@huabu/shared';

const log = getLogger('intent');

// ---------------------------------------------------------------------------
// Context → natural-language serialization
// ---------------------------------------------------------------------------

function serializeContextLight(ctx: IntentContext): string {
  const lines: string[] = [];

  // Map for resolving `parentId` → parent label without making the
  // wire payload carry a pre-computed `parentFrame.label`.
  const nodeById = new Map(ctx.nodes.map((n) => [n.id, n] as const));

  if (ctx.nodes.length > 0) {
    const byType = new Map<string, typeof ctx.nodes>();
    for (const n of ctx.nodes) {
      const list = byType.get(n.type) ?? [];
      list.push(n);
      byType.set(n.type, list);
    }
    lines.push(
      `# Canvas: ${ctx.nodes.length} node(s), ${ctx.edges.length} edge(s)`,
    );
    for (const [type, nodes] of byType) {
      const labels = nodes
        .map((n) => {
          const parentLabel = n.parentId
            ? nodeById.get(n.parentId)?.label
            : undefined;
          const frame = parentLabel ? ` (in "${parentLabel}")` : '';
          return `[${n.id}] ${n.label ? `"${n.label}"` : '(untitled)'}${frame}`;
        })
        .join(', ');
      lines.push(`- ${type} (${nodes.length}): ${labels}`);
    }
  } else {
    lines.push('# Canvas is empty.');
  }

  if (ctx.edges.length > 0) {
    lines.push('');
    lines.push('# Connections:');
    for (const e of ctx.edges) {
      lines.push(`- [${e.source}] → [${e.target}]`);
    }
  }

  if (ctx.recentActions.length > 0) {
    lines.push('');
    lines.push('# Recent user actions (oldest → newest):');
    for (const a of ctx.recentActions) {
      lines.push(`- ${formatAction(a)}`);
    }
  }

  if (ctx.selectedNodes && ctx.selectedNodes.length > 0) {
    lines.push('');
    lines.push(`# Currently selected node(s) (${ctx.selectedNodes.length}):`);
    for (const s of ctx.selectedNodes) {
      const label = s.label ? ` "${s.label}"` : '';
      const src = s.src ? `\n    Source: ${s.src}` : '';
      lines.push(`- [${s.id}] ${s.type}${label}${src}`);
      if (s.children && s.children.length > 0) {
        for (const child of s.children) {
          const childLabel = child.label ? ` "${child.label}"` : '';
          lines.push(`  - [${child.id}] ${child.type}${childLabel}`);
        }
      }
    }
  }

  return lines.join('\n');
}

function formatAction(a: RecentAction): string {
  switch (a.action) {
    case 'node_created': {
      const labels = a.nodes
        .map((n) => `${n.type} "${n.label ?? n.id}"`)
        .join(', ');
      return `Created ${a.nodes.length} node(s): ${labels}`;
    }
    case 'nodes_deleted': {
      const labels = a.nodes
        .map((n) => `${n.type} "${n.label ?? n.id}"`)
        .join(', ');
      return `Deleted ${a.nodes.length} node(s): ${labels}`;
    }
    case 'node_edited': {
      const target = `${a.node.type} "${a.node.label ?? a.node.id}"`;
      if (!a.edit) return `Edited ${target}`;
      const { op, beforeLen, afterLen, charsAdded, charsRemoved } = a.edit;
      const delta =
        charsAdded && charsRemoved
          ? `+${charsAdded}/-${charsRemoved}`
          : charsAdded
            ? `+${charsAdded}`
            : `-${charsRemoved}`;
      return `Edited ${target} [${op} ${delta} chars, ${beforeLen}→${afterLen}]`;
    }
    case 'node_selected':
      return `Selected ${a.node.type} "${a.node.label ?? a.node.id}"`;
    case 'nodes_selected': {
      const labels = a.nodes.map((n) => `"${n.label ?? n.id}"`).join(', ');
      return `Selected ${a.nodes.length} nodes: ${labels}`;
    }
    case 'node_expanded':
      return `Expanded ${a.node.type} "${a.node.label ?? a.node.id}"`;
    case 'node_connected':
      return `Connected "${a.source.label ?? a.source.id}" → "${
        a.target.label ?? a.target.id
      }"`;
    case 'edges_disconnected': {
      const pairs = a.edges
        .map(
          (e) =>
            `"${e.source.label ?? e.source.id}" → "${
              e.target.label ?? e.target.id
            }"`,
        )
        .join(', ');
      return `Disconnected ${a.edges.length} edge(s): ${pairs}`;
    }
    case 'node_framed':
      return `Moved "${a.node.label ?? a.node.id}" into frame "${
        a.frame.label ?? a.frame.id
      }"`;
    case 'node_unframed':
      return `Removed "${a.node.label ?? a.node.id}" from frame "${
        a.frame.label ?? a.frame.id
      }"`;
    case 'frame_unframed':
      return `Dissolved frame "${a.frame.label ?? a.frame.id}", released ${
        a.nodes.length
      } node(s)`;
    case 'node_resized':
      return `Resized "${a.node.label ?? a.node.id}" to ${a.width}×${a.height}`;
    case 'nodes_reordered':
      return `Reordered ${a.nodes.length} node(s)`;
    case 'nodes_moved': {
      const labels = a.nodes.map((n) => `"${n.label ?? n.id}"`).join(', ');
      return `Moved ${a.nodes.length} node(s): ${labels}`;
    }
    case 'canvas_undone':
      return 'Undid the last canvas action';
    case 'canvas_redone':
      return 'Redid the previously undone canvas action';
    default: {
      const _exhaustive: never = a;
      return `Unknown action: ${(_exhaustive as RecentAction).action}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function appendScreenshot(
  parts: ContentPart[],
  screenshot: string | undefined,
  caption?: string,
): void {
  if (!screenshot) return;
  const base64 = screenshot.startsWith('data:')
    ? screenshot.replace(/^data:[^;]+;base64,/, '')
    : screenshot;
  parts.push({ type: 'image', data: base64, mimeType: 'image/png' });
  if (caption) {
    parts.push({ type: 'text', text: caption });
  }
}

// Hard cap + dedupe for model output.

/** Maximum candidates the recogniser will surface to the popover. */
export const MAX_INTENT_CANDIDATES = 5;

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '').toLowerCase();
}

/** Drop duplicate labels (first one wins). */
function dedupeCandidates(candidates: IntentCandidate[]): IntentCandidate[] {
  const seen = new Set<string>();
  const out: IntentCandidate[] = [];
  for (const c of candidates) {
    const key = normalizeLabel(c.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Memory preamble for one-shot intent recognition.

const MAX_WORKSPACE_MEMORY_CHARS = 2000;
const MAX_CANVAS_MEMORY_CHARS = 1500;

function buildMemoryPreamble(canvasId: string | undefined): string | null {
  const sections: string[] = [];

  const workspace = readWorkspaceMemory();
  if (workspace) {
    sections.push(
      `## Workspace memory (cross-canvas user preferences)\n${clamp(
        workspace.trim(),
        MAX_WORKSPACE_MEMORY_CHARS,
      )}`,
    );
  }

  if (canvasId) {
    const canvas = readCanvasMemory(canvasId);
    if (canvas) {
      sections.push(
        `## Canvas memory (this canvas's current goal / decisions)\n${clamp(
          canvas.trim(),
          MAX_CANVAS_MEMORY_CHARS,
        )}`,
      );
    }
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated]`;
}

function prependMemoryPart(
  parts: ContentPart[],
  canvasId: string | undefined,
): void {
  const preamble = buildMemoryPreamble(canvasId);
  if (!preamble) return;
  // Put memory first and explicitly mark it as non-copyable context.
  parts.unshift({
    type: 'text',
    text:
      '[SYSTEM Memory — background context only. ' +
      'Use as a soft bias when ranking candidates. ' +
      'NEVER copy any line from this block into your output, ' +
      'and NEVER treat it as a list of suggested intents.]\n' +
      preamble,
  });
}

// ---------------------------------------------------------------------------
// LLM-based intent recognition
// ---------------------------------------------------------------------------

const SCREENSHOT_CAPTION =
  'Above is a screenshot of the current canvas viewport. Nodes are labeled with their IDs. The last user action is annotated in red: a banner at the top-left reads "Last step: ...", affected nodes have red borders, and arrows show directional relationships (connect, frame). Use these visual signals to infer intent.';

async function llmIntentRecognition(
  ctx: IntentContext,
  canvasId: string | undefined,
): Promise<IntentCandidate[]> {
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(userContentParts, ctx.screenshot, SCREENSHOT_CAPTION);
  prependMemoryPart(userContentParts, canvasId);

  const piContext: Context = {
    systemPrompt: loadAgent('intent').systemPrompt,
    messages: [
      { role: 'user', content: userContentParts, timestamp: Date.now() },
    ],
  };

  const response = await llmComplete(piContext);

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    const mapped = (parsed as IntentCandidate[]).map((item) => ({
      label: String(item.label ?? ''),
      description: item.description ? String(item.description) : undefined,
    }));
    return dedupeCandidates(mapped).slice(0, MAX_INTENT_CANDIDATES);
  } catch {
    log.error({ raw }, 'Failed to parse LLM response');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function recognizeIntent(
  ctx: IntentContext,
  canvasId?: string,
): Promise<IntentCandidate[]> {
  try {
    return await llmIntentRecognition(ctx, canvasId);
  } catch (err) {
    log.error({ err }, 'LLM intent recognition failed');
    return [];
  }
}

export async function* recognizeIntentStream(
  ctx: IntentContext,
  canvasId?: string,
): AsyncGenerator<IntentCandidate> {
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(userContentParts, ctx.screenshot, SCREENSHOT_CAPTION);
  prependMemoryPart(userContentParts, canvasId);

  const piContext: Context = {
    systemPrompt: loadAgent('intent').systemPrompt,
    messages: [
      { role: 'user', content: userContentParts, timestamp: Date.now() },
    ],
  };

  let accumulated = '';
  // Stream-time dedupe + hard cap.
  const seenKeys = new Set<string>();
  let yieldedCount = 0;

  const s = await llmStream(piContext);

  for await (const event of s) {
    if (event.type === 'text_delta') {
      accumulated += event.delta;

      const candidates = tryParsePartialCandidates(accumulated);
      for (let i = yieldedCount; i < candidates.length; i++) {
        if (yieldedCount >= MAX_INTENT_CANDIDATES) break;
        const c = candidates[i];
        const key = normalizeLabel(c.label);
        if (!key || seenKeys.has(key)) {
          yieldedCount++;
          continue;
        }
        seenKeys.add(key);
        yield c;
        yieldedCount++;
      }
      if (yieldedCount >= MAX_INTENT_CANDIDATES) break;
    }
  }

  if (yieldedCount >= MAX_INTENT_CANDIDATES) return;
  const finalCandidates = tryParsePartialCandidates(accumulated);
  for (let i = yieldedCount; i < finalCandidates.length; i++) {
    if (yieldedCount >= MAX_INTENT_CANDIDATES) break;
    const c = finalCandidates[i];
    const key = normalizeLabel(c.label);
    if (!key || seenKeys.has(key)) {
      yieldedCount++;
      continue;
    }
    seenKeys.add(key);
    yield c;
    yieldedCount++;
  }
}

function tryParsePartialCandidates(raw: string): IntentCandidate[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  const arrStart = cleaned.indexOf('[');
  if (arrStart < 0) return [];
  const inner = cleaned.slice(arrStart + 1);

  const results: IntentCandidate[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objText = inner.slice(objStart, i + 1);
        try {
          const obj = JSON.parse(objText) as Record<string, unknown>;
          if (obj && typeof obj.label === 'string' && obj.label.length > 0) {
            results.push({
              label: obj.label,
              description: obj.description
                ? String(obj.description)
                : undefined,
            });
          }
        } catch {
          // skip malformed
        }
        objStart = -1;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Episode logging
// ---------------------------------------------------------------------------

export async function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): Promise<void> {
  await storeEpisode(episode, canvasId);
}
