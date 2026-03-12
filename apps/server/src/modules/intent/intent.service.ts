/**
 * @file intent.service.ts
 *
 * Intent recognition service.
 * Receives an AgentBaseContext and returns a ranked list of intent candidates
 * by calling the LLM to analyze the canvas state and recent user actions.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getIntentDb } from './intent.db.js';
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
      const origin = a.nodes[0]?.origin
        ? ` (via ${a.nodes[0].origin.type})`
        : '';
      return `Created ${a.nodes.length} node(s)${origin}: ${labels}`;
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

const INTENT_SYSTEM_PROMPT = `You are an intent-recognition engine embedded in a research canvas application called Sediment.

The canvas lets users collect, organize, and synthesize research material using typed nodes (note, text, web, pdf, image, video) that can be grouped into frames and connected by edges.

## Your task
Analyze the provided canvas snapshot and recent user action trail to **infer the user's intent** — what the user most likely wants to do next.
Apply a sensemaking lens before generating suggestions. First, determine which sensemaking stage the user is currently in based on the canvas state and action history:
1. **Foraging** — actively collecting and importing new material.
2. **Organizing** — structuring existing material.
3. **Synthesizing** — integrating and condensing information .
4. **Presenting** — refining layout and appearance for communication.
Use the detected stage to bias your intent suggestions toward actions that are natural for that stage, while still considering cross-stage transitions.

Return **3–5 most likely intents** the user wants to pursue next.

## Guidelines
- Focus on seleted nodes. If nodes are selected, the user's intent is very likely related to those nodes.
- The **latest action** is the strongest signal.
- Use REAL node labels (from the [id] tags in the canvas state) when referencing existing nodes.
- Keep labels short (verb + object, ≤ 8 words).
- Consider common research intents such as: synthesize/merge, diverge/brainstorm, compare/contrast, extract, reorganize, annotate or summarize, bridge gaps, and refine or restructure.

## Output format
Return **only** a JSON array (no markdown fences, no commentary). Each element:
{
  "label": "short actionable description",
  "confidence": 0.0–1.0,
  "description": "one-sentence rationale"
}
Sorted by confidence descending.`;

/**
 * Call the LLM to analyse the canvas context and return intent candidates.
 * When a screenshot is available, sends it as a multimodal image for visual reasoning.
 */
async function llmIntentRecognition(
  ctx: AgentBaseContext,
): Promise<IntentCandidate[]> {
  const llm = getLLM();
  const contextText = serializeContext(ctx);

  const userContentParts: ContentPart[] = [
    { type: 'text', text: `Current canvas state:\n\n${contextText}` },
  ];

  appendScreenshot(
    userContentParts,
    ctx.screenshot,
    'Above is a screenshot of the current canvas viewport. Use the spatial layout to inform your intent suggestions.',
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
      confidence: Number(item.confidence ?? 0),
      description: item.description ? String(item.description) : undefined,
      actions: [],
    }));
  } catch {
    console.error('[intent] Failed to parse LLM response:', raw);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM-based action resolution (step 2)
// ---------------------------------------------------------------------------

const ACTION_RESOLVE_SYSTEM_PROMPT = `You are an action-planning engine embedded in a research canvas application called Sediment.

The canvas lets users collect, organize, and synthesize research material using typed nodes (note, text, web, pdf, image, video) that can be grouped into frames and connected by edges.

## Your task
Given the user-chosen intent and selected nodes, produce **exactly one** ordered sequence of atomic operations that best fulfils the intent.
The provided intent is the **strongest guiding signal** — decompose it into a combination of multiple atomic operations to fully realise it.

## Decomposition examples
- **Merge/synthesize** two nodes → ADD_NODE (create a merged note) → UPDATE_NODE_DATA (fill it with synthesized content) → DELETE_NODES (remove the original two nodes) → CONNECT (link the new node to related context).
- **Brainstorm/diverge** from a node → ADD_NODE (create several new idea nodes around the source) → UPDATE_NODE_DATA (populate each with a distinct angle or question) → CONNECT (link each new node back to the source).

## Available atomic operations

| op | Parameters | Description |
|----|-----------|-------------|
| ADD_NODE | nodeType, label?, content?, src?, position?, width?, height? | Create a new node |
| DELETE_NODES | nodeIds[] | Remove nodes by ID |
| CONNECT | sourceId, targetId | Draw an edge between two nodes |
| DISCONNECT | sourceId, targetId | Remove an edge between two nodes |
| UPDATE_NODE_DATA | nodeId, patch{} | Update a node's data — content, label, or any field |
| GROUP_INTO_FRAME | nodeIds[], frameLabel? | Group nodes into a new frame |
| UNFRAME | frameId | Dissolve a frame, releasing its children |
| MOVE_INTO_FRAME | nodeId, frameId | Move a node into an existing frame |
| MOVE_OUT_OF_FRAME | nodeId | Remove a node from its parent frame |
| SELECT_NODES | nodeIds[] | Select one or more nodes |
| ALIGN_NODES | direction (left/center-h/right/top/center-v/bottom) | Align selected nodes |
| SPREAD_NODES | (none) | Spread apart overlapping selected nodes |

## Referencing newly created nodes
Use **$0, $1, $2, ...** as placeholder IDs. $0 = the node created by the 1st ADD_NODE, $1 = the 2nd, etc.

## Guidelines
- Focus on seleted nodes. If nodes are selected, the user's intent is very likely related to those nodes.
- Use REAL node IDs (from the [id] tags in the canvas state) when referencing existing nodes.
- Keep the plan minimal — only include steps required to fulfil the intent.
- Make every action as concrete as possible.

## Output format
Return **only** a JSON array of action objects (no markdown fences, no commentary).`;

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
