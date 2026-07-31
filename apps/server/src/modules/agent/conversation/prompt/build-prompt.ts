/**
 * Chat-turn context assembly — the orchestrator.
 *
 * Single entry point that turns one inbound chat request (a structured
 * {@link ChatEnvelope}) into the per-turn pi-ai user message(s). This
 * file owns only the COMPOSITION: how the context sections, the
 * attachment block, and the user's own words are ordered and stitched
 * into the final message. The shape of each individual piece lives in
 * its own renderer alongside this file, so the prompt is easy to read
 * off the file tree:
 *
 *   node-element.ts   — the `<node>` element (shared primitive)
 *   selected-nodes.ts — `<selected_nodes>`       block
 *   neighbourhood.ts  — `<canvas_neighbourhood>` block (anchor)
 *   invoked-skills.ts — `<invoked_skills>`       block
 *   attachments.ts    — `<attachment>` parts (+ vision images)
 *   sketch-hint.ts    — sketch-raster reuse hint (selection)
 *   image-inlining.ts — image URL → base64 vision bytes
 *   profile.ts        — per-backend switches (built-in / ACP)
 *
 * `renderTurn(env, profile)` builds shared canonical parts; both backends
 * call it and differ only by their {@link RenderProfile}.
 */

import { buildAttachmentParts } from './attachments.js';
import { renderInvokedSkillsSection } from './invoked-skills.js';
import { renderNeighbourhoodSection } from './neighbourhood.js';
import { INTERNAL_PROFILE } from './profile.js';
import { renderSelectedNodesSection } from './selected-nodes.js';
import { renderSketchRasterHint } from './sketch-hint.js';
import { chatEnvelopeFromSubmission } from '../../agenetes/handle.js';

import type { ChatEnvelope } from '../envelope.js';
import type { ContentPart, UserContent } from './attachments.js';
import type { RenderProfile } from './profile.js';
import type { AgentInput, AgentInputPart, AgentTurn } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';

/** A pi-ai conversation message (the built-in agent's context unit). */
type PiMessage = Message;

/** Interruption notice injected into the LLM context after an aborted turn,
 *  telling the model not to resume the interrupted task. */
const INTERRUPTED_NOTICE =
  '[SYSTEM Interrupted] The user interrupted the previous operation. ' +
  'Do NOT continue or retry the interrupted task. ' +
  'Wait for the next user message and treat it as a new request.';

/**
 * Render a {@link ChatEnvelope} into a flat `ContentPart[]` (text +
 * vision parts) per the backend {@link RenderProfile}. This is the
 * single source of truth for per-turn composition; both backends call
 * it and only differ by their profile. The built-in agent feeds the
 * parts straight to pi-ai; the external/ACP adapter maps them onto its
 * content-block wire. Returns an empty array when the turn has nothing.
 */
export async function renderTurn(
  env: ChatEnvelope,
  profile: RenderProfile,
  opts: { canvasId: string | null; includeNeighbourhood?: boolean },
): Promise<ContentPart[]> {
  const { canvasId, includeNeighbourhood = true } = opts;
  const { imageAttachments, snapshotAttachments } = env.focus.selection;
  const uploads = env.user.attachments;
  const selection = [...imageAttachments, ...snapshotAttachments];

  const skillsSection = renderInvokedSkillsSection(env.skills.resolved);
  const selectedNodesSection = renderSelectedNodesSection(
    env.focus.selection.refs,
    profile,
  );
  // The neighbourhood is a volatile "current canvas state" block, so it
  // rides ONLY the live turn (the tail of the assembled prompt) and is
  // omitted from rebuilt history. Keeping committed turns free of it
  // leaves the message prefix byte-stable and append-only, which is what
  // the provider's prompt/KV cache needs to keep hitting; a fresh copy
  // is re-injected on the current turn instead of N stale snapshots
  // piling up. `rebuildContextMessages` passes `false`; the live
  // built-in / ACP turn keeps the default `true`.
  const neighbourhoodSection = includeNeighbourhood
    ? renderNeighbourhoodSection(env.focus.anchor, profile)
    : undefined;
  const hasContext = Boolean(
    skillsSection || selectedNodesSection || neighbourhoodSection,
  );
  const selectionParts =
    profile.includeSelectionVisuals && selection.length > 0
      ? await buildAttachmentParts(selection, canvasId ?? null)
      : [];
  const uploadParts =
    uploads.length > 0
      ? await buildAttachmentParts(uploads, canvasId ?? null)
      : [];
  // Both backends raster the selection, so both get the reuse hint when
  // pre-snapshotted artifacts are present; the wording (built-in tools vs
  // asking the canvas agent) is chosen per profile inside the renderer.
  const hint =
    profile.includeSelectionVisuals && selectionParts.length > 0
      ? renderSketchRasterHint(selection, profile)
      : undefined;
  const userText = env.user.text;

  // Empty turn → nothing to render.
  if (
    !userText.trim() &&
    selectionParts.length === 0 &&
    uploadParts.length === 0 &&
    !hasContext
  ) {
    return [];
  }

  // Common case: bare text only.
  if (!hasContext && selectionParts.length === 0 && uploadParts.length === 0) {
    return [{ type: 'text', text: userText }];
  }

  const parts: ContentPart[] = [];
  if (skillsSection) parts.push({ type: 'text', text: skillsSection });
  if (selectedNodesSection) {
    parts.push({ type: 'text', text: selectedNodesSection });
  }
  if (selectionParts.length > 0) {
    const followUp =
      profile.toolset === 'reachback'
        ? 'download its `file` for more'
        : 'read() / inspect_nodes() for more';
    parts.push({
      type: 'text',
      text: `<selected_nodes_visuals>\nRenders of the selected canvas nodes. Each has an \`origin\` id — ${followUp}.${hint ? `\n${hint}` : ''}`,
    });
    parts.push(...selectionParts);
    parts.push({ type: 'text', text: '</selected_nodes_visuals>' });
  }
  if (neighbourhoodSection) {
    parts.push({ type: 'text', text: neighbourhoodSection });
  }
  if (uploadParts.length > 0) {
    parts.push({
      type: 'text',
      text: '<attachments>\nThe user uploaded the content below to this turn (off-canvas, not on the canvas).',
    });
    parts.push(...uploadParts);
    parts.push({ type: 'text', text: '</attachments>' });
  }
  // Slash-command turns lead with the BARE task (no <user_request>
  // wrapper) so ACP still recognises `/cmd`; everyone else wraps + trails.
  if (profile.leadWithTask) {
    parts.unshift({ type: 'text', text: userText });
  } else {
    parts.push({
      type: 'text',
      text: `<user_request>\n${userText}\n</user_request>`,
    });
  }
  return parts;
}

function partsToAgentInputs(parts: readonly AgentInputPart[]): AgentInput[] {
  if (parts.length === 0) return [];
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return [{ type: 'text', text: parts[0].text }];
  }
  return [{ type: 'parts', parts }];
}

/** Render one Huabu envelope into the built-in route's canonical inputs. */
export async function renderInternalAgentInputs(
  env: ChatEnvelope,
  opts: { canvasId: string | null; includeNeighbourhood?: boolean },
): Promise<AgentInput[]> {
  return partsToAgentInputs(await renderTurn(env, INTERNAL_PROFILE, opts));
}

/** Lower canonical inputs to the pi harness without host-source inspection. */
export function agentInputsToPiMessages(
  inputs: readonly AgentInput[],
): PiMessage[] {
  return inputs.map((input): PiMessage => {
    switch (input.type) {
      case 'text':
        return {
          role: 'user',
          content: input.text,
          timestamp: Date.now(),
        };
      case 'parts':
        return {
          role: 'user',
          content: [...input.parts],
          timestamp: Date.now(),
        };
      case 'command': {
        const content: UserContent =
          input.context.length === 0
            ? input.text
            : [{ type: 'text', text: input.text }, ...input.context];
        return { role: 'user', content, timestamp: Date.now() };
      }
      default: {
        const _exhaustive: never = input;
        throw new Error(`Unhandled AgentInput: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });
}

/**
 * Render a {@link ChatEnvelope} into the per-turn pi-ai user message,
 * WITHOUT touching any `Context`. Wraps {@link renderTurn} with the
 * built-in profile; the shape is never the source of truth on disk.
 */
export async function renderEnvelopeMessages(
  env: ChatEnvelope,
  opts: { canvasId: string | null; includeNeighbourhood?: boolean },
): Promise<{ messages: PiMessage[] }> {
  const inputs = await renderInternalAgentInputs(env, opts);
  return { messages: agentInputsToPiMessages(inputs) };
}

/**
 * Rebuild the flat pi-ai message array for a thread from its L2-owned
 * turns: re-serialise each turn's request envelope into the canonical
 * user message, then project that turn's folded transcript back into
 * pi-ai assistant/tool-result messages. This is how the structured
 * persistence path reconstructs the `Context.messages` the agent runs
 * over, so the rendered shape never has to be the source of truth.
 */
export async function rebuildContextMessages(
  turns: readonly AgentTurn[],
  opts: { canvasId: string | null },
): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  for (const turn of turns) {
    out.push(...(await rebuildTurnMessages(turn, opts)));
  }
  return out;
}

/**
 * Rebuild one turn's slice of the pi-ai message array. Split out from
 * {@link rebuildContextMessages} so a caller that has to fit history into a
 * budget can keep or drop whole turns — a partial turn would leave a
 * `toolCall` without its `toolResult`, which the provider rejects.
 */
export async function rebuildTurnMessages(
  turn: AgentTurn,
  opts: { canvasId: string | null },
): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  const envelope = chatEnvelopeFromSubmission(turn.request);
  if (envelope) {
    // History turns render WITHOUT their neighbourhood: it was a
    // point-in-time snapshot only relevant while that turn was live.
    // Re-emitting a stale copy per historical turn would bloat the
    // context and, because it is baked into a committed message, would
    // never be reusable by the provider's prefix cache. The live turn
    // re-injects a fresh neighbourhood as the prompt tail instead.
    const { messages } = await renderEnvelopeMessages(envelope, {
      ...opts,
      includeNeighbourhood: false,
    });
    out.push(...messages);
  }
  out.push(...foldedTranscriptToPiMessages(turn));
  return out;
}

/**
 * Project a turn's folded Tier-2 transcript back into pi-ai messages for
 * LLM context replay. Text/thinking/tool_call fragments collapse into a
 * single assistant message; each resolved tool call emits a paired
 * tool-result message. Orphaned tool calls (no output captured) are
 * dropped so the reconstructed context never carries a dangling
 * `toolCall` the provider would reject. An aborted turn appends a system
 * interruption notice; a folded error appends a system error notice.
 */
function foldedTranscriptToPiMessages(turn: AgentTurn): PiMessage[] {
  const out: PiMessage[] = [];
  const content: Array<Record<string, unknown>> = [];
  const toolResults: PiMessage[] = [];
  let sawToolCall = false;
  let errorDetail: string | null = null;

  for (const msg of turn.transcript) {
    if (msg.type === 'text') {
      if (msg.data.content.length > 0) {
        content.push({ type: 'text', text: msg.data.content });
      }
    } else if (msg.type === 'thinking') {
      if (msg.data.content.length > 0) {
        content.push({ type: 'thinking', thinking: msg.data.content });
      }
    } else if (msg.type === 'tool_call') {
      const data = msg.data as {
        toolCallId: string;
        title?: string;
        internalToolName?: string;
        rawInput?: unknown;
        rawOutput?: unknown;
      };
      // Drop tool calls with no captured output: replaying a `toolCall`
      // with no matching `toolResult` is rejected by the provider.
      if (data.rawOutput === undefined) continue;
      const name = data.internalToolName ?? data.title ?? 'tool';
      const args =
        data.rawInput && typeof data.rawInput === 'object'
          ? (data.rawInput as Record<string, unknown>)
          : {};
      content.push({
        type: 'toolCall',
        id: data.toolCallId,
        name,
        arguments: args,
      });
      sawToolCall = true;
      const resultText =
        typeof data.rawOutput === 'string'
          ? data.rawOutput
          : JSON.stringify(data.rawOutput);
      toolResults.push({
        role: 'toolResult',
        toolCallId: data.toolCallId,
        toolName: name,
        content: [{ type: 'text', text: resultText }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as PiMessage);
    } else if (msg.type === 'error') {
      errorDetail = (msg.data as { error: string }).error;
    }
    // `plan` fragments are UI-only and never part of the LLM context.
  }

  if (content.length > 0) {
    out.push({
      role: 'assistant',
      content,
      stopReason: sawToolCall ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    } as unknown as PiMessage);
  }
  out.push(...toolResults);

  if (turn.meta?.stopReason === 'aborted') {
    out.push({
      role: 'user',
      content: INTERRUPTED_NOTICE,
      timestamp: Date.now(),
    });
  } else if (errorDetail) {
    out.push({
      role: 'user',
      content: `[SYSTEM Error] ${errorDetail}`,
      timestamp: Date.now(),
    });
  }

  return out;
}
