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
 *   render/image-inlining.ts — image URL → base64 vision bytes
 *
 * The final per-turn message is laid out as:
 *   1. an XML context block (selected nodes / neighbourhood / skills),
 *   2. an `<attachments>` block (text excerpts + base64 vision images),
 *   3. the user's own words last, wrapped in `<user_request>`.
 * When the turn carries no context and no attachments, the message is
 * just the user's plain text — no XML scaffolding for the common case.
 */

import {
  buildAttachmentParts,
  buildSketchRasterHint,
} from './render/attachments.js';
import { renderInvokedSkillsSection } from './render/invoked-skills.js';
import { renderNeighbourhoodSection } from './render/neighbourhood.js';
import { renderSelectedNodesSection } from './render/selected-nodes.js';

import type { ChatEnvelope } from './envelope.js';
import type { ContentPart, UserContent } from './render/attachments.js';
import type { ChatTurnRecord, PiMessage } from '../store/chat-thread-store.js';

/**
 * Render the per-turn context sections (selected nodes, neighbourhood,
 * invoked skills) into a single XML-tagged text block, or `undefined`
 * when the turn carries none. Each section is wrapped in its own tag so
 * the model can parse the boundaries unambiguously; the user's own
 * words are intentionally NOT included here — the caller appends them
 * last (see {@link renderEnvelopeMessages}).
 */
function buildContextSections(env: ChatEnvelope): string | undefined {
  const blocks = [
    renderSelectedNodesSection(env.focus.selection.refs),
    renderNeighbourhoodSection(env.preamble.neighbourhood),
    renderInvokedSkillsSection(env.skills.resolved),
  ].filter((block): block is string => Boolean(block));

  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

/**
 * Render a {@link ChatEnvelope} into the per-turn pi-ai user message,
 * WITHOUT touching any `Context`. Used both to build the current turn's
 * message and to rebuild historical turns from their persisted
 * envelopes (the structured-persistence path), so the rendered shape is
 * never the source of truth on disk.
 *
 * A turn collapses to a SINGLE user message. Its content is laid out as:
 *   1. an XML context block (`<selected_nodes>`, `<canvas_neighbourhood>`,
 *      `<invoked_skills>`) — present only when the turn carries any;
 *   2. an `<attachments>` block of `<attachment>` items (text excerpts +
 *      base64 vision images) — present only when the turn carries any;
 *   3. the user's own words last, wrapped in `<user_request>` (with the
 *      LLM-only sketch-raster hint appended when present).
 *
 * When the turn has no context sections and no attachments, the message
 * is just the user's plain text — no XML scaffolding for the common case.
 *
 * Returns an array of zero or one message: empty only when the turn is
 * entirely empty (no text, attachments, selection, or skills), which the
 * caller treats as "nothing to render".
 */
export async function renderEnvelopeMessages(
  env: ChatEnvelope,
  opts: { canvasId: string | null },
): Promise<{ messages: PiMessage[] }> {
  const { canvasId } = opts;

  // Merge the off-canvas uploads with selection-derived vision parts.
  // Order matches the legacy assembly: uploads, deduped selection
  // images, then composite snapshots.
  const { imageAttachments, snapshotAttachments } = env.focus.selection;
  const allAttachments = [
    ...env.user.attachments,
    ...imageAttachments,
    ...snapshotAttachments,
  ];

  const contextSections = buildContextSections(env);
  const attachmentParts =
    allAttachments.length > 0
      ? await buildAttachmentParts(allAttachments, canvasId ?? null)
      : [];

  // The user's own words go last. The only render-time metadata still
  // appended is the LLM-only sketch-raster hint ("reuse the
  // pre-snapshotted rasters, don't re-call snapshot_nodes"). Selection /
  // skills / attachments are NOT re-encoded here — history reload reads
  // them straight from the stored envelope.
  const hint = buildSketchRasterHint(allAttachments);
  const userText = hint
    ? `${env.user.text}\n[SYSTEM hint:${hint}]`
    : env.user.text;

  // Empty turn → nothing to render.
  if (
    !env.user.text.trim() &&
    attachmentParts.length === 0 &&
    !contextSections
  ) {
    return { messages: [] };
  }

  // Common case: plain text only, no context sections, no attachments.
  // Skip the XML scaffolding entirely.
  let content: UserContent;
  if (!contextSections && attachmentParts.length === 0) {
    content = userText;
  } else {
    const parts: ContentPart[] = [];
    if (contextSections) parts.push({ type: 'text', text: contextSections });
    if (attachmentParts.length > 0) {
      // Delimit the attachment parts with an <attachments> tag so the
      // block is as unambiguously bounded as the other context sections.
      // The opening / closing tags are their own text parts because the
      // attachment list can interleave vision (image) parts that cannot
      // carry inline markup.
      parts.push({
        type: 'text',
        text: '<attachments>\nThe user attached the content below to this turn (off-canvas uploads and node excerpts).',
      });
      parts.push(...attachmentParts);
      parts.push({ type: 'text', text: '</attachments>' });
    }
    parts.push({
      type: 'text',
      text: `<user_request>\n${userText}\n</user_request>`,
    });
    content = parts;
  }

  return {
    messages: [
      {
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    ],
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
