/**
 * Chat-turn context assembly — the orchestrator.
 *
 * Single entry point that turns one inbound chat request (a structured
 * {@link ChatEnvelope}) into the per-turn pi-ai user message(s). This
 * file owns only the COMPOSITION: how the context sections, the
 * attachment block, and the user's own words are ordered and stitched
 * into the final message. The shape of each individual piece lives in
 * its own renderer under `./render/`, so the prompt is easy to read off
 * the file tree:
 *
 *   render/node-element.ts   — the `<node>` element (shared primitive)
 *   render/selected-nodes.ts — `<selected_nodes>`       block
 *   render/neighbourhood.ts  — `<canvas_neighbourhood>` block (anchor)
 *   render/invoked-skills.ts — `<invoked_skills>`       block
 *   render/attachments.ts    — `<attachment>` parts (+ vision images)
 *   render/sketch-hint.ts    — sketch-raster reuse hint (selection)
 *   render/image-inlining.ts — image URL → base64 vision bytes
 *   render/profile.ts        — per-backend switches (built-in / ACP)
 *
 * `renderTurn(env, profile)` builds the shared `ContentPart[]`; both
 * backends call it and differ only by their {@link RenderProfile}.
 * `renderEnvelopeMessages` wraps it for the built-in pi-ai path.
 */

import { buildAttachmentParts } from './render/attachments.js';
import { renderInvokedSkillsSection } from './render/invoked-skills.js';
import { renderNeighbourhoodSection } from './render/neighbourhood.js';
import { INTERNAL_PROFILE } from './render/profile.js';
import { renderSelectedNodesSection } from './render/selected-nodes.js';
import { renderSketchRasterHint } from './render/sketch-hint.js';

import type { ChatEnvelope } from './envelope.js';
import type { ContentPart, UserContent } from './render/attachments.js';
import type { RenderProfile } from './render/profile.js';
import type { ChatTurnRecord, PiMessage } from '../store/chat-thread-store.js';

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
  opts: { canvasId: string | null },
): Promise<ContentPart[]> {
  const { canvasId } = opts;
  const { imageAttachments, snapshotAttachments } = env.focus.selection;
  const uploads = env.user.attachments;
  const selection = [...imageAttachments, ...snapshotAttachments];

  const skillsSection = renderInvokedSkillsSection(env.skills.resolved);
  const selectedNodesSection = renderSelectedNodesSection(
    env.focus.selection.refs,
    profile,
  );
  const neighbourhoodSection = renderNeighbourhoodSection(
    env.preamble.neighbourhood,
    profile,
  );
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
  const hint =
    profile.includeSelectionVisuals && selectionParts.length > 0
      ? renderSketchRasterHint(selection)
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
      profile.nodeReadVerb === 'read-node'
        ? 'read-node <id> for more'
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

/**
 * Render a {@link ChatEnvelope} into the per-turn pi-ai user message,
 * WITHOUT touching any `Context`. Wraps {@link renderTurn} with the
 * built-in profile; the shape is never the source of truth on disk.
 */
export async function renderEnvelopeMessages(
  env: ChatEnvelope,
  opts: { canvasId: string | null },
): Promise<{ messages: PiMessage[] }> {
  const parts = await renderTurn(env, INTERNAL_PROFILE, opts);
  if (parts.length === 0) return { messages: [] };
  // Bare-text fast path: a single text part collapses to a plain string.
  const content: UserContent =
    parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  return {
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };
}

/**
 * Rebuild the flat pi-ai message array for a thread from its stored
 * turns: re-serialise each turn's envelope into the canonical user
 * message, then append that turn's persisted assistant/tool transcript.
 * This is how the structured-persistence path reconstructs the
 * `Context.messages` the agent runs over, so the rendered shape never
 * has to be the source of truth on disk.
 */
export async function rebuildContextMessages(
  turns: readonly ChatTurnRecord[],
  opts: { canvasId: string | null },
): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  for (const turn of turns) {
    const { messages } = await renderEnvelopeMessages(turn.envelope, opts);
    out.push(...messages, ...turn.transcript);
  }
  return out;
}
