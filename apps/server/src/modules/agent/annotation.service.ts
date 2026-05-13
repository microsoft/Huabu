/**
 * Annotation Recognition Service
 *
 * Converts a freehand annotation cluster (screenshot + minimal context
 * payload) into the canvas commands that realise the user's gesture.
 * Runs the unified `runAgent` loop with the `'annotation'` tool scope
 * and the `'annotation-recognized'` origin stamp, then drains the
 * SSE-shaped event stream to assemble the JSON response the route
 * returns.
 *
 * The tool set, system prompt, and `NodeOrigin` stamp differ from the
 * chat / operate agent (annotation is user-authored, not AI-authored),
 * but everything else — model selection, abort wiring, turn cap,
 * `canvas_commands` server-side execution — is shared with `runAgent`.
 */

import { runAgent } from './agent.service.js';
import { buildAgentNodeRef } from './node-ref.js';
import { loadAgent, renderAgentTemplate } from '../../prompt/agent-loader.js';

import type { Context } from '@earendil-works/pi-ai';
import type {
  AnnotationClusterContext,
  AnnotationCommandResponse,
  CanvasCommand,
  WireNodeRef,
} from '@sediment/shared';

// ---------------------------------------------------------------------------
// Cluster context serialization
// ---------------------------------------------------------------------------

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Render the cluster payload as a short text block for the user message.
 *
 * Each wire ref is enriched server-side via {@link buildAgentNodeRef}
 * to derive the `nodes/<safeLabel>.md` path the model can pass
 * straight to `read`. Edges stay as bare ids — they have no label,
 * and the model uses `inspect_edges` for direction / style.
 */
function serializeClusterContext(ctx: AnnotationClusterContext): string {
  const lines: string[] = [];
  lines.push(
    `Annotation bbox: (${ctx.bbox.x}, ${ctx.bbox.y}) ${ctx.bbox.width}x${ctx.bbox.height}px`,
  );
  lines.push(`Stroke count: ${ctx.strokeCount}`);

  const renderRef = (r: WireNodeRef): string => {
    const ref = buildAgentNodeRef(r);
    const labelPart = ref.label ? ` "${ref.label}"` : '';
    return `  - ${ref.id}${labelPart} (${ref.type}) → ${ref.filename}`;
  };

  if (ctx.enclosedNodes.length > 0) {
    lines.push(`Enclosed nodes (${ctx.enclosedNodes.length}):`);
    for (const ref of ctx.enclosedNodes) lines.push(renderRef(ref));
  } else {
    lines.push('Enclosed nodes: (none)');
  }

  if (ctx.nearbyNodes.length > 0) {
    lines.push(`Nearby nodes (${ctx.nearbyNodes.length}, by proximity):`);
    for (const ref of ctx.nearbyNodes) lines.push(renderRef(ref));
  } else {
    lines.push('Nearby nodes: (none)');
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recognize annotation intent and return executable canvas commands.
 *
 * Runs the unified `runAgent` loop with the annotation tool scope and
 * the `'annotation-recognized'` origin stamp. The model issues read /
 * inspect calls as needed and then invokes `canvas_commands` for
 * real — `handleCanvasCommands` runs server-side and injects origin /
 * provenance / labelSource onto every CREATE / MERGE entry. We drain
 * the SSE-shaped event stream, pick out the `canvas_commands`
 * tool_result payload and the final assistant text, and hand both to
 * the client.
 *
 * Returns an empty `commands` array when the model finishes without
 * invoking `canvas_commands` (e.g. it judged the gesture ambiguous);
 * `reasoning` still carries any explanation the model wrote.
 */
export async function recognizeAnnotationCommands(
  screenshot: string,
  clusterContext: AnnotationClusterContext,
  canvasId?: string,
): Promise<AnnotationCommandResponse> {
  const agentCfg = loadAgent('annotation');
  const base64 = screenshot.startsWith('data:')
    ? screenshot.replace(/^data:[^;]+;base64,/, '')
    : screenshot;

  const contextText = serializeClusterContext(clusterContext);

  const userContent: ContentPart[] = [
    { type: 'image', data: base64, mimeType: 'image/png' },
    {
      type: 'text',
      text: renderAgentTemplate(agentCfg, 'annotationClusterPreamble', {
        contextText,
      }),
    },
  ];

  const piContext: Context = {
    systemPrompt: agentCfg.systemPrompt,
    messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
  };

  const collectedCommands: CanvasCommand[] = [];
  const reasoningParts: string[] = [];

  // ── Diagnostics ────────────────────────────────────────────────────
  // Track which tool calls the LLM actually issued and what the handler
  // returned, so we can distinguish "LLM never called canvas_commands"
  // (the JSON-in-prose failure mode) from "called it but commands array
  // came back empty" (handler issue) from "handler errored".
  const toolStartCounts = new Map<string, number>();
  const toolResultCounts = new Map<string, number>();
  let canvasCommandsErrorPayload: string | null = null;

  const stream = runAgent({
    scope: 'annotation',
    canvasId,
    origin: agentCfg.runtime.defaultOrigin ?? { type: 'annotation-recognized' },
    context: piContext,
    maxIterations: agentCfg.runtime.maxIterations,
  });

  for await (const event of stream) {
    if (event.type === 'tool_start') {
      const n = (toolStartCounts.get(event.data.toolName) ?? 0) + 1;
      toolStartCounts.set(event.data.toolName, n);
      const argsStr = JSON.stringify(event.data.toolArgs ?? {});
      console.log(
        `[annotation] → tool_start #${n} ${event.data.toolName} args=${argsStr.length > 800 ? argsStr.slice(0, 800) + `…(${argsStr.length} chars total)` : argsStr}`,
      );
    } else if (event.type === 'tool_result') {
      const n = (toolResultCounts.get(event.data.toolName) ?? 0) + 1;
      toolResultCounts.set(event.data.toolName, n);
      const result = event.data.toolResult ?? '';
      console.log(
        `[annotation] ← tool_result #${n} ${event.data.toolName} (${result.length} chars): ${result.length > 800 ? result.slice(0, 800) + '…' : result}`,
      );
      if (event.data.toolName === 'canvas_commands') {
        const extracted = extractCommandsFromToolResult(result);
        console.log(
          `[annotation]   ↳ canvas_commands extracted ${extracted.length} command(s): [${extracted.map((c) => c.type).join(', ')}]`,
        );
        if (extracted.length === 0) {
          canvasCommandsErrorPayload = result;
        }
        collectedCommands.push(...extracted);
      }
    } else if (event.type === 'done' && event.data.message) {
      reasoningParts.push(event.data.message);
    } else if (event.type === 'text_delta' && event.data.content) {
      // text_delta arrives before `done` and may carry the model's
      // pre-tool-call reasoning sentence even when the loop hits the
      // turn cap (no `done` event in that branch).
      reasoningParts.push(event.data.content);
    } else if (event.type === 'error') {
      console.warn('[annotation] error event:', event.data.error);
    }
  }

  const reasoningText = reasoningParts.join('').trim();
  console.log('[annotation] run summary', {
    toolStarts: Object.fromEntries(toolStartCounts),
    toolResults: Object.fromEntries(toolResultCounts),
    canvasCommandsCalled: (toolStartCounts.get('canvas_commands') ?? 0) > 0,
    collectedCommandCount: collectedCommands.length,
    reasoningPreview: reasoningText.slice(0, 200),
    suspectedFailureMode:
      (toolStartCounts.get('canvas_commands') ?? 0) === 0
        ? 'LLM_NEVER_INVOKED_TOOL (JSON likely written into assistant text)'
        : canvasCommandsErrorPayload
          ? 'TOOL_INVOKED_BUT_RESULT_HAD_NO_COMMANDS'
          : 'OK',
  });

  return {
    reasoning: reasoningText,
    commands: collectedCommands,
  };
}

/**
 * Pull the `commands` array out of a `canvas_commands` tool result
 * payload. The handler returns `{ source, canvasId, commands }` JSON;
 * pi-agent-core wraps thrown errors in a `{ status: 'error', ... }`
 * envelope (see `runAgent`'s `tool_execution_end` branch). We tolerate
 * both shapes and silently drop malformed payloads — annotation
 * already handles "no commands" as a valid no-op outcome.
 */
function extractCommandsFromToolResult(payload: string): CanvasCommand[] {
  try {
    const parsed = JSON.parse(payload) as { commands?: unknown };
    if (Array.isArray(parsed.commands)) {
      return parsed.commands as CanvasCommand[];
    }
  } catch {
    // Non-JSON or error envelope — leave commands empty.
  }
  return [];
}
