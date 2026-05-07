/**
 * Intent Recognition Service
 *
 * Receives an AgentBaseContext and returns a ranked list of intent candidates
 * by calling the LLM to analyze the canvas state and recent user actions.
 */

import { validateToolCall } from '@mariozechner/pi-ai';

import { llmComplete, llmStream } from './llm.js';
import { logIntentEpisode as storeEpisode } from './store/intent-store.js';
import { getNodeDetailTool } from './tools/definitions.js';
import { executeTool } from './tools/executor.js';
import {
  INTENT_SYSTEM_PROMPT,
  ANNOTATION_INTENT_SYSTEM_PROMPT,
} from '../../prompt/intent.js';

import type { AssistantMessage, Context, ToolCall } from '@mariozechner/pi-ai';
import type {
  AgentBaseContext,
  AnnotationClusterContext,
  CanvasCommand,
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
//
// The client sends a screenshot plus a minimal context payload (cluster
// bbox + ID lists for nearby/enclosed nodes and nearby edges). The LLM is
// driven through a small tool-calling loop with a single tool exposed:
// `get_node_detail`, which it can call iteratively to fetch any node's
// content before producing the final JSON command batch.
// ---------------------------------------------------------------------------

/**
 * Render the minimal cluster payload as a short text block. We deliberately
 * include nothing beyond IDs — the LLM is expected to use the screenshot
 * for visual reasoning and `get_node_detail` for content lookups.
 */
function serializeClusterContext(ctx: AnnotationClusterContext): string {
  const lines: string[] = [];
  lines.push(
    `Annotation bbox: (${ctx.bbox.x}, ${ctx.bbox.y}) ${ctx.bbox.width}x${ctx.bbox.height}px`,
  );
  lines.push(`Stroke count: ${ctx.strokeCount}`);

  if (ctx.enclosedNodeIds.length > 0) {
    lines.push(
      `Enclosed node IDs (${ctx.enclosedNodeIds.length}): ${ctx.enclosedNodeIds.join(', ')}`,
    );
  } else {
    lines.push('Enclosed node IDs: (none)');
  }

  if (ctx.nearbyNodeIds.length > 0) {
    lines.push(
      `Nearby node IDs (${ctx.nearbyNodeIds.length}, by proximity): ${ctx.nearbyNodeIds.join(', ')}`,
    );
  } else {
    lines.push('Nearby node IDs: (none)');
  }

  if (ctx.nearbyEdgeIds.length > 0) {
    lines.push(
      `Nearby edge IDs (${ctx.nearbyEdgeIds.length}): ${ctx.nearbyEdgeIds.join(', ')}`,
    );
  } else {
    lines.push('Nearby edge IDs: (none)');
  }

  return lines.join('\n');
}

export interface AnnotationCommandResult {
  /** One-sentence reason describing what the user meant. */
  reasoning: string;
  /** Atomic batch of canvas commands to execute. */
  commands: CanvasCommand[];
}

/** Strip markdown fences and any leading/trailing prose around a JSON object. */
function extractJsonObject(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/, '')
    .replace(/\s*```[\s\S]*$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
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
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Maximum tool-calling iterations for a single annotation request. */
const ANNOTATION_MAX_ITERATIONS = 6;

/**
 * Drive the LLM through a tool-calling loop limited to `get_node_detail`,
 * then parse the final assistant text as `{ reasoning, commands }`.
 */
async function runAnnotationAgent(
  piContext: Context,
  canvasId?: string,
): Promise<string> {
  const tools = [getNodeDetailTool];
  piContext.tools = tools;

  let iteration = 0;
  while (iteration < ANNOTATION_MAX_ITERATIONS) {
    iteration++;

    const s = await llmStream(piContext);

    // Drain the stream so the result is finalized.
    for await (const _event of s) {
      // We don't need to surface deltas to the client — the route returns
      // the final command batch as a single JSON response.
    }

    let result: AssistantMessage;
    try {
      result = await s.result();
    } catch (err) {
      console.error('[annotation-intent] LLM stream failed:', err);
      return '';
    }

    piContext.messages.push(result);

    if (result.stopReason !== 'toolUse') {
      return result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');
    }

    const toolCalls = result.content.filter(
      (b): b is ToolCall => b.type === 'toolCall',
    );

    for (const call of toolCalls) {
      let toolResultText: string;
      let isError = false;
      try {
        const validatedArgs = validateToolCall(tools, call);
        toolResultText = await executeTool(
          call.name,
          validatedArgs as Record<string, unknown>,
          { mode: 'ask', canvasId },
        );
      } catch (err) {
        isError = true;
        toolResultText = JSON.stringify({
          error: err instanceof Error ? err.message : 'Tool execution failed',
        });
      }

      piContext.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: toolResultText }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  console.warn(
    '[annotation-intent] max tool iterations reached without a final answer',
  );
  return '';
}

/**
 * Recognize annotation intent and return executable canvas commands.
 *
 * The LLM may issue several `get_node_detail` tool calls before producing
 * the final JSON answer; we parse that JSON for the client to execute.
 */
export async function recognizeAnnotationCommands(
  screenshot: string,
  clusterContext: AnnotationClusterContext,
  canvasId?: string,
): Promise<AnnotationCommandResult> {
  const base64 = screenshot.startsWith('data:')
    ? screenshot.replace(/^data:[^;]+;base64,/, '')
    : screenshot;

  const contextText = serializeClusterContext(clusterContext);

  const userContentParts: ContentPart[] = [
    { type: 'image', data: base64, mimeType: 'image/png' },
    {
      type: 'text',
      text: `Annotation context (IDs only — call get_node_detail for any node whose content you need):\n\n${contextText}\n\nUse the screenshot to read the gesture, fetch any node content you need via get_node_detail, then output the final JSON object {"reasoning": ..., "commands": [...]}.`,
    },
  ];

  const piContext: Context = {
    systemPrompt: ANNOTATION_INTENT_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userContentParts, timestamp: Date.now() },
    ],
  };

  const raw = await runAnnotationAgent(piContext, canvasId);

  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    console.error('[annotation-intent] no JSON object found in LLM output');
    return { reasoning: '', commands: [] };
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      reasoning?: unknown;
      commands?: unknown;
    };
    const reasoning =
      typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
    const commands = Array.isArray(parsed.commands)
      ? (parsed.commands as CanvasCommand[])
      : [];
    return { reasoning, commands };
  } catch (err) {
    console.error('[annotation-intent] failed to parse JSON:', err, jsonText);
    return { reasoning: '', commands: [] };
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
