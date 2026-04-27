/**
 * Intent Recognition Service
 *
 * Receives an AgentBaseContext and returns a ranked list of intent candidates
 * by calling the LLM to analyze the canvas state and recent user actions.
 */

import { llmComplete, llmStream } from './llm.js';
import { logIntentEpisode as storeEpisode } from './store/intent-store.js';
import {
  INTENT_SYSTEM_PROMPT,
  ANNOTATION_INTENT_SYSTEM_PROMPT,
} from '../../prompt/intent.js';

import type { Context } from '@mariozechner/pi-ai';
import type {
  AgentBaseContext,
  AnnotationClusterContext,
  IntentCandidate,
  IntentEpisode,
  RecentAction,
} from '@sediment/shared';

// ---------------------------------------------------------------------------
// Context → natural-language serialization
// ---------------------------------------------------------------------------

function serializeContextLight(ctx: AgentBaseContext): string {
  const lines: string[] = [];

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

  if (ctx.edges.length > 0) {
    lines.push('');
    lines.push('# Connections:');
    for (const e of ctx.edges) {
      lines.push(`- [${e.source.id}] → [${e.target.id}]`);
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

// ---------------------------------------------------------------------------
// LLM-based intent recognition
// ---------------------------------------------------------------------------

const SCREENSHOT_CAPTION =
  'Above is a screenshot of the current canvas viewport. Nodes are labeled with their IDs. The last user action is annotated in red: a banner at the top-left reads "Last step: ...", affected nodes have red borders, and arrows show directional relationships (connect, frame). Use these visual signals to infer intent.';

async function llmIntentRecognition(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(userContentParts, ctx.screenshot, SCREENSHOT_CAPTION);

  const piContext: Context = {
    systemPrompt: INTENT_SYSTEM_PROMPT,
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
// Public API
// ---------------------------------------------------------------------------

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

export async function* recognizeIntentStream(
  ctx: AgentBaseContext,
): AsyncGenerator<IntentCandidate> {
  const contextText = serializeContextLight(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(userContentParts, ctx.screenshot, SCREENSHOT_CAPTION);

  const piContext: Context = {
    systemPrompt: INTENT_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userContentParts, timestamp: Date.now() },
    ],
  };

  let accumulated = '';
  let yieldedCount = 0;

  const s = await llmStream(piContext);

  for await (const event of s) {
    if (event.type === 'text_delta') {
      accumulated += event.delta;

      const candidates = tryParsePartialCandidates(accumulated);
      while (yieldedCount < candidates.length) {
        yield candidates[yieldedCount];
        yieldedCount++;
      }
    }
  }

  const finalCandidates = tryParsePartialCandidates(accumulated);
  while (yieldedCount < finalCandidates.length) {
    yield finalCandidates[yieldedCount];
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
// Annotation intent recognition
// ---------------------------------------------------------------------------

/**
 * Serialize an AnnotationClusterContext into a human-readable text block
 * so the LLM has structured context alongside the screenshot.
 */
function serializeClusterContext(ctx: AnnotationClusterContext): string {
  const lines: string[] = [];

  lines.push(
    `Shape: ${ctx.shapeType} (confidence: ${(ctx.shapeConfidence * 100).toFixed(0)}%)`,
  );
  lines.push(`Annotation center: (${ctx.position.x}, ${ctx.position.y})`);

  if (ctx.startNode) {
    const sn = ctx.startNode;
    lines.push(
      `Start-point nearest node: [${sn.id}] ${sn.type}${sn.label ? ` "${sn.label}"` : ''} at (${sn.position.x}, ${sn.position.y}), distance=${sn.distance}px, ${sn.direction}`,
    );
  }
  if (ctx.endNode) {
    const en = ctx.endNode;
    lines.push(
      `End-point nearest node: [${en.id}] ${en.type}${en.label ? ` "${en.label}"` : ''} at (${en.position.x}, ${en.position.y}), distance=${en.distance}px, ${en.direction}`,
    );
  }

  if (ctx.enclosedNodes.length > 0) {
    lines.push(`Enclosed/overlapping nodes (${ctx.enclosedNodes.length}):`);
    for (const n of ctx.enclosedNodes) {
      lines.push(
        `  - [${n.id}] ${n.type}${n.label ? ` "${n.label}"` : ''} at (${n.position.x}, ${n.position.y})`,
      );
    }
  }

  if (ctx.nearbyNodes.length > 0) {
    lines.push(`Nearby nodes (${ctx.nearbyNodes.length}):`);
    for (const n of ctx.nearbyNodes) {
      lines.push(
        `  - [${n.id}] ${n.type}${n.label ? ` "${n.label}"` : ''}, dist=${n.distance}px ${n.direction}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Recognize annotation intent from a canvas screenshot + structured context.
 * This is the LLM fallback path — only called when the client-side rule engine
 * could not confidently resolve the intent.
 */
export async function* recognizeAnnotationIntentStream(
  screenshot: string,
  clusterContext: AnnotationClusterContext,
): AsyncGenerator<IntentCandidate> {
  const base64 = screenshot.startsWith('data:')
    ? screenshot.replace(/^data:[^;]+;base64,/, '')
    : screenshot;

  const contextText = serializeClusterContext(clusterContext);

  const userContentParts: ContentPart[] = [
    { type: 'image', data: base64, mimeType: 'image/png' },
    {
      type: 'text',
      text: `Annotation analysis from client-side pipeline:\n\n${contextText}\n\nThe rule engine could not confidently classify this annotation. Please analyze the screenshot and the structured context above to determine the user's intent. Return exactly ONE intent as a JSON array with a single object.`,
    },
  ];

  const piContext: Context = {
    systemPrompt: ANNOTATION_INTENT_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userContentParts, timestamp: Date.now() },
    ],
  };

  let accumulated = '';
  let yieldedCount = 0;

  const s = await llmStream(piContext);

  for await (const event of s) {
    if (event.type === 'text_delta') {
      accumulated += event.delta;

      const candidates = tryParsePartialCandidates(accumulated);
      while (yieldedCount < candidates.length) {
        yield candidates[yieldedCount];
        yieldedCount++;
      }
    }
  }

  const finalCandidates = tryParsePartialCandidates(accumulated);
  while (yieldedCount < finalCandidates.length) {
    yield finalCandidates[yieldedCount];
    yieldedCount++;
  }
}

// ---------------------------------------------------------------------------
// Episode logging
// ---------------------------------------------------------------------------

export function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): void {
  storeEpisode(episode, canvasId);
}
