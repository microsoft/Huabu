/**
 * @file intent.service.ts
 *
 * Intent recognition service.
 * Receives an AgentBaseContext and returns a ranked list of intent candidates
 * by calling the LLM to analyze the canvas state and recent user actions.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getIntentDb } from './intent.db.js';
import { ACTION_RESOLVE_SYSTEM_PROMPT } from '../../prompt/action-resolve.js';
import { INTENT_SYSTEM_PROMPT } from '../../prompt/intent.js';
import { getLLM } from '../agent/llm.js';

import type {
  AgentBaseContext,
  IntentAction,
  IntentCandidate,
  IntentEpisode,
  RecentAction,
} from '@sediment/shared';

// ---------------------------------------------------------------------------
// Context → natural-language serialization
// ---------------------------------------------------------------------------

/**
 * Lightweight context for Step 1 (intent recognition).
 *
 * Information hierarchy:
 *   1. Node schema only — type + label, NO snippets/content (the screenshot
 *      already shows spatial layout; text is noise at this stage).
 *   2. Selected nodes — full content (strongest intent signal).
 *   3. Last 10 recent actions (already capped by frontend ring buffer).
 *   4. Screenshot carries visual annotations for the latest action
 *      (handled on the frontend side).
 */
function serializeContextLight(ctx: AgentBaseContext): string {
  const lines: string[] = [];

  // Node schema — type + label only, grouped by type for scannability
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
          const frame = n.frameLabel ? ` (in "${n.frameLabel}")` : '';
          return `[${n.id}] ${n.label ? `"${n.label}"` : '(untitled)'}${frame}`;
        })
        .join(', ');
      lines.push(`- ${type} (${nodes.length}): ${labels}`);
    }
  } else {
    lines.push('# Canvas is empty.');
  }

  // Edges — compact adjacency list
  if (ctx.edges.length > 0) {
    lines.push('');
    lines.push('# Connections:');
    for (const e of ctx.edges) {
      lines.push(`- [${e.source.id}] → [${e.target.id}]`);
    }
  }

  // Recent actions (last 10, maintained by frontend)
  if (ctx.recentActions.length > 0) {
    lines.push('');
    lines.push('# Recent user actions (oldest → newest):');
    for (const a of ctx.recentActions) {
      lines.push(`- ${formatAction(a)}`);
    }
  }

  // Selected nodes — full content (primary intent signal)
  if (ctx.selectedNodes && ctx.selectedNodes.length > 0) {
    lines.push('');
    lines.push(`# Currently selected node(s) (${ctx.selectedNodes.length}):`);
    for (const s of ctx.selectedNodes) {
      const label = s.label ? ` "${s.label}"` : '';
      const content = s.content ? `\n    Content: ${s.content}` : '';
      const src = s.src ? `\n    Source: ${s.src}` : '';
      lines.push(`- [${s.id}] ${s.type}${label}${content}${src}`);
      if (s.children && s.children.length > 0) {
        for (const child of s.children) {
          const childLabel = child.label ? ` "${child.label}"` : '';
          const childContent = child.content
            ? `\n      Content: ${child.content}`
            : '';
          lines.push(
            `  - [${child.id}] ${child.type}${childLabel}${childContent}`,
          );
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Full context for Step 2 (action resolution).
 * Includes node snippets so the LLM can generate concrete content in actions.
 */
function serializeContext(ctx: AgentBaseContext): string {
  const lines: string[] = [];

  // Nodes
  if (ctx.nodes.length > 0) {
    lines.push(`# Canvas has ${ctx.nodes.length} node(s):`);
    for (const n of ctx.nodes) {
      const frame = n.frameLabel ? ` (in frame "${n.frameLabel}")` : '';
      const snippet = n.snippet ? `: ${n.snippet}` : '';
      const label = n.label ? ` "${n.label}"` : '';
      lines.push(`- [${n.id}] ${n.type}${label}${frame}${snippet}`);
    }
  } else {
    lines.push('# Canvas is empty.');
  }

  // Edges
  if (ctx.edges.length > 0) {
    lines.push('');
    lines.push('# Connections:');
    for (const e of ctx.edges) {
      const srcLabel = e.source.label ? ` "${e.source.label}"` : '';
      const tgtLabel = e.target.label ? ` "${e.target.label}"` : '';
      lines.push(`- [${e.source.id}]${srcLabel} → [${e.target.id}]${tgtLabel}`);
    }
  }

  // Recent actions
  if (ctx.recentActions.length > 0) {
    lines.push('');
    lines.push('# Recent user actions (oldest → newest):');
    for (const a of ctx.recentActions) {
      lines.push(`- ${formatAction(a)}`);
    }
  }

  // Selected nodes (strong intent signal — full content included)
  if (ctx.selectedNodes && ctx.selectedNodes.length > 0) {
    lines.push('');
    lines.push(`# Currently selected node(s) (${ctx.selectedNodes.length}):`);
    for (const s of ctx.selectedNodes) {
      const label = s.label ? ` "${s.label}"` : '';
      const content = s.content ? `\n    Content: ${s.content}` : '';
      const src = s.src ? `\n    Source: ${s.src}` : '';
      lines.push(`- [${s.id}] ${s.type}${label}${content}${src}`);
      if (s.children && s.children.length > 0) {
        for (const child of s.children) {
          const childLabel = child.label ? ` "${child.label}"` : '';
          const childContent = child.content
            ? `\n      Content: ${child.content}`
            : '';
          lines.push(
            `  - [${child.id}] ${child.type}${childLabel}${childContent}`,
          );
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
        .map((n) => `${n.nodeType} "${n.label ?? n.id}"`)
        .join(', ');
      return `Created ${a.nodes.length} node(s): ${labels}`;
    }
    case 'nodes_deleted': {
      const labels = a.nodes
        .map((n) => `${n.nodeType} "${n.label ?? n.id}"`)
        .join(', ');
      return `Deleted ${a.nodes.length} node(s): ${labels}`;
    }
    case 'node_edited':
      return `Edited ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_selected':
      return `Selected ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'nodes_selected': {
      const labels = a.nodes.map((n) => `"${n.label ?? n.id}"`).join(', ');
      return `Selected ${a.nodes.length} nodes: ${labels}`;
    }
    case 'node_expanded':
      return `Expanded ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
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
      // Exhaustiveness guard — if this line produces a TS error, a new
      // RecentAction variant has been added and this function needs a new case.
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
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

/**
 * Append a canvas screenshot as a multimodal image_url part.
 * Handles both raw base64 payloads and existing data-URLs.
 */
function appendScreenshot(
  parts: ContentPart[],
  screenshot: string | undefined,
  caption?: string,
): void {
  if (!screenshot) return;
  const url = screenshot.startsWith('data:')
    ? screenshot
    : `data:image/png;base64,${screenshot}`;
  parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
  if (caption) {
    parts.push({ type: 'text', text: caption });
  }
}

// ---------------------------------------------------------------------------
// LLM-based intent recognition
// ---------------------------------------------------------------------------

/**
 * Call the LLM to analyse the canvas context and return intent candidates.
 * When a screenshot is available, sends it as a multimodal image for visual reasoning.
 */
async function llmIntentRecognition(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  const llm = getLLM();
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(
    userContentParts,
    ctx.screenshot,
    'Above is a screenshot of the current canvas viewport. Nodes are labeled with their IDs. The last user action is annotated in red: a banner at the top-left reads "Last step: ...", affected nodes have red borders, and arrows show directional relationships (connect, frame). Use these visual signals to infer intent.',
  );

  const response = await llm.invoke([
    new SystemMessage(INTENT_SYSTEM_PROMPT),
    new HumanMessage({ content: userContentParts }),
  ]);

  const raw =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

  try {
    // Strip markdown fences if the model wraps them
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return (parsed as IntentCandidate[]).map((item) => ({
      label: String(item.label ?? ''),
      description: item.description ? String(item.description) : undefined,
    }));
  } catch {
    console.error('[intent] Failed to parse LLM response:', raw);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM-based action resolution (step 2)
// ---------------------------------------------------------------------------

/**
 * Given a canvas context and a user-selected intent string, call the LLM to
 * produce a concrete action plan.
 */
async function llmResolveActions(
  ctx: AgentBaseContext,
  chosenIntent: string,
): Promise<IntentAction[]> {
  const llm = getLLM();
  const contextText = serializeContext(ctx);

  const userContentParts: ContentPart[] = [
    {
      type: 'text',
      text: `Current canvas state:\n\n${contextText}\n\nUser-chosen intent: "${chosenIntent}"`,
    },
  ];

  appendScreenshot(userContentParts, ctx.screenshot);

  const response = await llm.invoke([
    new SystemMessage(ACTION_RESOLVE_SYSTEM_PROMPT),
    new HumanMessage({ content: userContentParts }),
  ]);

  const raw =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];
    return parsed as IntentAction[];
  } catch {
    console.error('[intent] Failed to parse action-resolve LLM response:', raw);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform intent recognition by calling the LLM with the canvas context.
 */
export async function recognizeIntent(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  try {
    return await llmIntentRecognition(ctx);
  } catch (err) {
    console.error('[intent] LLM intent recognition failed:', err);
    return [];
  }
}

/**
 * Stream intent recognition — yields individual IntentCandidate objects
 * as they are incrementally parsed from the LLM token stream.
 */
export async function* recognizeIntentStream(
  ctx: AgentBaseContext,
): AsyncGenerator<IntentCandidate> {
  const llm = getLLM();
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(
    userContentParts,
    ctx.screenshot,
    'Above is a screenshot of the current canvas viewport. Nodes are labeled with their IDs. The last user action is annotated in red: a banner at the top-left reads "Last step: ...", affected nodes have red borders, and arrows show directional relationships (connect, frame). Use these visual signals to infer intent.',
  );

  let accumulated = '';
  let yieldedCount = 0;

  const stream = await llm.stream([
    new SystemMessage(INTENT_SYSTEM_PROMPT),
    new HumanMessage({ content: userContentParts }),
  ]);

  for await (const chunk of stream) {
    const token =
      typeof chunk.content === 'string'
        ? chunk.content
        : Array.isArray(chunk.content)
          ? chunk.content
              .filter(
                (p): p is { type: 'text'; text: string } => p.type === 'text',
              )
              .map((p) => p.text)
              .join('')
          : '';
    accumulated += token;

    // Try to parse complete candidate objects from the accumulated JSON array
    const candidates = tryParsePartialCandidates(accumulated);
    while (yieldedCount < candidates.length) {
      yield candidates[yieldedCount];
      yieldedCount++;
    }
  }

  // Final parse attempt on the complete response
  const finalCandidates = tryParsePartialCandidates(accumulated);
  while (yieldedCount < finalCandidates.length) {
    yield finalCandidates[yieldedCount];
    yieldedCount++;
  }
}

/**
 * Extract fully-closed JSON objects from an accumulating JSON array string.
 * Uses brace-depth tracking to only yield objects whose closing `}` has
 * been received — never yields partially-streamed objects.
 */
function tryParsePartialCandidates(raw: string): IntentCandidate[] {
  // Strip markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  // Find the opening bracket of the array
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
        // We have a complete top-level object
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

/**
 * Resolve a chosen intent into a concrete action plan via the LLM.
 */
export async function resolveActions(
  ctx: AgentBaseContext,
  chosenIntent: string,
): Promise<IntentAction[]> {
  try {
    return await llmResolveActions(ctx, chosenIntent);
  } catch (err) {
    console.error('[intent] LLM action resolution failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Episode logging — stores intent interaction history for preference learning
// ---------------------------------------------------------------------------

/**
 * Persist an intent episode to the database.
 */
export function logIntentEpisode(episode: IntentEpisode): void {
  const db = getIntentDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO intent_episodes
      (id, timestamp, contextSummary, candidates, outcomeType, chosenIndex, chosenLabel)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    episode.id,
    episode.timestamp,
    episode.contextSummary,
    JSON.stringify(episode.candidates),
    episode.outcome.type,
    episode.outcome.type === 'selected' ? episode.outcome.chosenIndex : null,
    episode.outcome.type === 'selected' ? episode.outcome.chosenLabel : null,
  );
}
