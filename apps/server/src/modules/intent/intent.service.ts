/**
 * @file intent.service.ts
 *
 * Intent recognition service.
 * Receives an AgentBaseContext and returns a ranked list of intent candidates
 * by calling the LLM to analyse the canvas state and recent user actions.
 */

import { getLLM } from '../agent/llm.js';

import type {
  AgentBaseContext,
  IntentCandidate,
  RecentAction,
} from '@sediment/shared';

// ---------------------------------------------------------------------------
// Context → natural-language serialisation
// ---------------------------------------------------------------------------

function serialiseContext(ctx: AgentBaseContext): string {
  const lines: string[] = [];

  // Nodes
  if (ctx.nodes.length > 0) {
    lines.push(`Canvas has ${ctx.nodes.length} node(s):`);
    for (const n of ctx.nodes) {
      const sel = n.selected ? ' [SELECTED]' : '';
      const frame = n.frameLabel ? ` (in frame "${n.frameLabel}")` : '';
      const snippet = n.snippet ? `: ${n.snippet}` : '';
      lines.push(`- ${n.type} "${n.label ?? n.id}"${sel}${frame}${snippet}`);
    }
  } else {
    lines.push('Canvas is empty.');
  }

  // Edges
  if (ctx.edges.length > 0) {
    lines.push('');
    lines.push('Connections:');
    for (const e of ctx.edges) {
      lines.push(
        `- "${e.source.label ?? e.source.id}" → "${e.target.label ?? e.target.id}"`,
      );
    }
  }

  // Recent actions
  if (ctx.recentActions.length > 0) {
    lines.push('');
    lines.push('Recent user actions (oldest → newest):');
    for (const a of ctx.recentActions) {
      lines.push(`- ${formatAction(a)}`);
    }
  }

  return lines.join('\n');
}

function formatAction(a: RecentAction): string {
  switch (a.action) {
    case 'node_created':
      return `Created ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_deleted':
      return `Deleted ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_edited':
      return `Edited ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_selected':
      return `Selected ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_expanded':
      return `Expanded ${a.node.nodeType} "${a.node.label ?? a.node.id}"`;
    case 'node_connected':
      return `Connected "${a.source.label ?? a.source.id}" → "${a.target.label ?? a.target.id}"`;
    case 'node_disconnected':
      return `Disconnected "${a.source.label ?? a.source.id}" → "${a.target.label ?? a.target.id}"`;
    case 'node_framed':
      return `Moved "${a.node.label ?? a.node.id}" into frame "${a.frame.label ?? a.frame.id}"`;
    case 'node_unframed':
      return `Removed "${a.node.label ?? a.node.id}" from frame "${a.frame.label ?? a.frame.id}"`;
  }
}

// ---------------------------------------------------------------------------
// LLM-based intent recognition
// ---------------------------------------------------------------------------

const INTENT_SYSTEM_PROMPT = `You are an intent-recognition engine embedded in a research canvas application called Sediment.

The canvas lets users collect, organise, and synthesise research material using typed nodes (note, text, web, pdf, image, video) that can be grouped into frames and connected by edges.

## Your task
Analyse the provided canvas snapshot — node types, labels, content snippets, selection state, connections, and the user's recent action trail — and infer the **3–5 most likely next actions** the user wants to take.

## Guidelines
- Prioritise actions that are **contextually relevant** to the most recent operations and the currently selected node(s). The latest action in the trail carries the strongest signal.
- If a single node is selected, suggest actions that directly operate on its content (e.g. summarise, expand, find related sources, generate questions).
- If multiple nodes are selected or connected, suggest higher-level synthesis actions (e.g. compare, merge, outline, identify contradictions).
- If the canvas is sparse or empty, suggest bootstrapping actions (e.g. add a research topic, import sources, start a web search).
- Keep labels short and action-oriented (verb + object, ≤ 8 words).

## Output format
Return **only** a JSON array (no markdown fences, no commentary). Each element:
{
  "label": "short actionable description",
  "confidence": 0.0–1.0,
  "description": "one-sentence rationale for why this action is relevant"
}
Sorted by confidence descending.`;

/**
 * Call the LLM to analyse the canvas context and return intent candidates.
 */
async function llmIntentRecognition(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  const llm = getLLM();
  const contextText = serialiseContext(ctx);

  const response = await llm.invoke([
    { role: 'system', content: INTENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Current canvas state:\n\n${contextText}`,
    },
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
      confidence: Number(item.confidence ?? 0),
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

/**
 * Perform intent recognition by calling the LLM with the canvas context.
 */
export async function recogniseIntent(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  try {
    return await llmIntentRecognition(ctx);
  } catch (err) {
    console.error('[intent] LLM intent recognition failed:', err);
    return [];
  }
}
