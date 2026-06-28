/**
 * Chat-turn context assembly.
 *
 * Single entry point that turns one inbound chat request into the
 * per-turn pi-ai user messages. Previously this logic was inlined in
 * the POST `/api/agent` handler and interleaved with SSE / abort /
 * persistence concerns; consolidating it here keeps the route thin
 * and gives every internal chat scope (ask / operate) one place to
 * reason about "what context does the agent see this turn".
 *
 * Behaviour-preserving: the message order, `[SYSTEM …]` tagging, and
 * auto-snapshot dedup are an exact move of the former route body. The
 * structured-envelope rewrite builds on top of this seam.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isSketchRasterAttachment } from './attachment-visibility.js';
import {
  ARTIFACT_URL_REGEX,
  resolveArtifactImageUrl,
} from '../../artifact/utils.js';
import { getCanvasStore } from '../../storage/index.js';

import type { ChatEnvelope } from './envelope.js';
import type { ChatTurnRecord, PiMessage } from '../store/chat-thread-store.js';
import type { ChatAttachment } from '@sediment/shared';

/**
 * Hard cap on the decoded byte size of an image we are willing to
 * inline as base64 in a vision content part. Anything larger is
 * dropped (an explanatory text part is emitted in its place so the
 * agent can request a downsampled version) so a hostile or
 * accidentally-huge artifact cannot blow up the Node process — and,
 * just as importantly, so the resulting request body stays below
 * every upstream LLM provider's body-size limit. Most providers
 * we target reject requests around 8–10 MB total; vision-capable
 * Copilot endpoints can be tighter still. 4 MB per image leaves
 * head-room for system prompt + tool schemas + multiple attachments
 * without tripping `413 Request Entity Too Large` from the provider.
 */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Decoded byte size of a base64 string (no allocation). */
function base64DecodedByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61 /* '=' */) padding++;
  if (b64.charCodeAt(len - 2) === 61 /* '=' */) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Outcome of resolving an image URL for vision inlining.
 *
 * - `inline`: we have base64 bytes the LLM can see.
 * - `skipped`: we resolved the URL but the image was too large to
 *   inline (`reason: 'too_large'`) or the source wasn't an image
 *   (`reason: 'not_image'` / `'fetch_failed'`). The caller should
 *   surface a textual placeholder instead of dropping the part
 *   silently — the agent then knows to ask for a downsampled
 *   version or to inspect the node directly.
 */
type ResolvedImage =
  | { kind: 'inline'; data: string; mimeType: string }
  | {
      kind: 'skipped';
      reason: 'too_large' | 'not_image' | 'fetch_failed';
      sizeBytes?: number;
    };

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

async function resolveImageUrl(
  url: string,
  defaultCanvasId: string | null,
): Promise<ResolvedImage> {
  // Canvas-scoped artifacts + already-baked data: URLs go through the
  // shared helper. It returns the input unchanged for unrelated URLs
  // (external http(s), bare paths, etc.).
  //
  // `defaultCanvasId` is used when `url` is a bare artifact key
  // (`<id><ext>`) rather than a full URL. Bare keys are the canonical
  // form that the front-end now sends; full URLs are kept for legacy
  // / external references.
  const resolved = await resolveArtifactImageUrl(
    url,
    (canvasId, filename) => {
      try {
        return getCanvasStore(canvasId).resolveArtifactFilePath(filename);
      } catch {
        return null;
      }
    },
    defaultCanvasId,
  );
  if (resolved.startsWith('data:')) {
    const parsed = parseDataUrl(resolved);
    if (!parsed) {
      return { kind: 'skipped', reason: 'not_image' };
    }
    // Apply the same byte cap we enforce on external fetches — a
    // multi-MB canvas artifact would otherwise sail through and tip
    // the request over the upstream LLM's body limit.
    const sizeBytes = base64DecodedByteLength(parsed.data);
    if (sizeBytes > MAX_INLINE_IMAGE_BYTES) {
      return { kind: 'skipped', reason: 'too_large', sizeBytes };
    }
    return { kind: 'inline', data: parsed.data, mimeType: parsed.mimeType };
  }

  // External image URLs: fetch and inline as base64 so the LLM can see them.
  if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
    try {
      const res = await fetch(resolved, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { kind: 'skipped', reason: 'fetch_failed' };
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        return { kind: 'skipped', reason: 'not_image' };
      }

      // Cap the inlined payload so a hostile / accidentally-huge URL
      // (e.g. a multi-GB camera RAW served from a CDN) cannot exhaust
      // the Node process's heap. We honour Content-Length up-front when
      // present, and stream-read otherwise so we can stop reading the
      // moment the cap is exceeded — without this, `arrayBuffer()`
      // happily buffers the whole response regardless of size.
      const declaredSize = Number(res.headers.get('content-length') ?? '');
      if (
        Number.isFinite(declaredSize) &&
        declaredSize > MAX_INLINE_IMAGE_BYTES
      ) {
        return {
          kind: 'skipped',
          reason: 'too_large',
          sizeBytes: declaredSize,
        };
      }

      const body = res.body;
      if (!body) {
        // No streamable body — fall back to the buffered path but still
        // bound the result.
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES) {
          return {
            kind: 'skipped',
            reason: 'too_large',
            sizeBytes: buffer.byteLength,
          };
        }
        return {
          kind: 'inline',
          data: buffer.toString('base64'),
          mimeType: contentType.split(';')[0],
        };
      }

      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_INLINE_IMAGE_BYTES) {
          // Release the stream so the underlying connection can close.
          await reader.cancel().catch(() => {});
          return { kind: 'skipped', reason: 'too_large', sizeBytes: total };
        }
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      return {
        kind: 'inline',
        data: buffer.toString('base64'),
        mimeType: contentType.split(';')[0],
      };
    } catch {
      return { kind: 'skipped', reason: 'fetch_failed' };
    }
  }

  // Unknown scheme (bare relative path, etc.) — we can't load bytes.
  return { kind: 'skipped', reason: 'fetch_failed' };
}

/** pi-ai user-message content: text and/or vision parts. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
type UserContent = string | ContentPart[];

/**
 * If `attachments` includes pre-snapshotted sketch artifacts, build a
 * one-line directive pointing the agent at those urls so it does not
 * re-issue `snapshot_nodes` for the same node ids on this turn. Returns
 * `undefined` when there are no sketch-raster artifacts.
 */
function buildSketchRasterHint(
  attachments: ChatAttachment[],
): string | undefined {
  const sketchRasters = attachments.filter(isSketchRasterAttachment);
  if (sketchRasters.length === 0) return undefined;
  const items = sketchRasters
    .map((a) => {
      const ids = a.originNodeIds ?? (a.originNodeId ? [a.originNodeId] : []);
      const shortIds = ids.map((id) => id.slice(0, 13)).join(', ');
      return shortIds ? `${a.url} (nodes: ${shortIds})` : a.url;
    })
    .join('; ');
  return `pre-snapshotted sketch artifacts are ready for generate_image.referenceArtifactSrcs — pass these urls directly without re-calling snapshot_nodes for the same node ids: ${items}`;
}

/**
 * Resolve a turn's attachments into pi-ai content parts (text excerpts
 * + base64 vision images). Unlike the former `buildUserContent`, this
 * returns ONLY the attachment-derived parts — the user's own text is
 * composed separately by {@link renderEnvelopeMessages} so it can be
 * placed last, after every context section.
 *
 * Attachment types handled:
 *  - image  → resolve URL to base64 and include as vision input
 *  - pdf    → resolve URL; will be sent as image for vision analysis
 *  - text   → inline content as text part (e.g. text excerpted from a node)
 *  - file   → use content if available, otherwise try reading from artifact
 *  - web    → inline content as text part
 */
async function buildAttachmentParts(
  attachments: ChatAttachment[],
  canvasId: string | null,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];

  for (const att of attachments) {
    const label = att.label ?? att.filename ?? 'attachment';
    // Collapse the singular `originNodeId` and the plural `originNodeIds`
    // into one list. Singular is the historical 1:1 case (PDF excerpt,
    // text selection, image-node send-to-chat); plural was added so a
    // single attachment can advertise N source nodes (e.g. one image
    // rendered from a sketch cluster of multiple strokes).
    const originIds = att.originNodeIds?.length
      ? att.originNodeIds
      : att.originNodeId
        ? [att.originNodeId]
        : [];
    const originRef =
      originIds.length === 0
        ? ''
        : originIds.length === 1
          ? ` (origin node id: ${originIds[0]})`
          : ` (origin node ids: ${originIds.join(', ')})`;

    switch (att.type) {
      case 'image': {
        // Caption the image with its source node ids so the model can
        // follow up via `inspect_nodes` / `get_canvas_outline` for
        // surrounding context (parent frame, position, neighbours).
        // Without this the image part is opaque — the model sees
        // pixels but does not know which canvas nodes they came from.
        if (originIds.length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Image: ${label}${originRef}]`,
          });
        }
        // Resolve image URL to base64 for vision
        if (att.url) {
          const resolved = await resolveImageUrl(att.url, canvasId);
          if (resolved.kind === 'inline') {
            parts.push({
              type: 'image',
              data: resolved.data,
              mimeType: resolved.mimeType,
            });
          } else if (resolved.reason === 'too_large') {
            // Don't silently drop a too-large image — tell the agent
            // exactly why and how to recover. The placeholder mentions
            // the origin node ids (already in `originRef`) so the
            // model can call `snapshot_nodes` for a downscaled PNG.
            const mb = resolved.sizeBytes
              ? (resolved.sizeBytes / (1024 * 1024)).toFixed(1)
              : '?';
            parts.push({
              type: 'text',
              text: `[Attached Image: ${label}${originRef} — omitted from vision (~${mb} MB exceeds the ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB inline cap). Call \`snapshot_nodes\` on the origin node id to get a downscaled PNG, or \`read\` the node's sidecar for its description.]`,
            });
          }
        }
        // If the image also carries extracted text content (e.g. PDF capture with OCR text)
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Text from ${label}${originRef}]:\n${att.content}`,
          });
        }
        break;
      }

      case 'pdf': {
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached PDF: ${label}${originRef}]:\n${att.content}`,
          });
        } else {
          parts.push({
            type: 'text',
            text: `[Attached PDF: ${label}]${att.url ? ` (URL: ${att.url})` : ''}`,
          });
        }
        break;
      }

      case 'text': {
        // Text excerpted from a node — content is always present
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Excerpt from ${originRef}]:\n${att.content}`,
          });
        }
        break;
      }

      case 'web': {
        // Web URL content
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Web Content: ${label}${att.url ? ` (${att.url})` : ''}]:\n${att.content}`,
          });
        } else if (att.url) {
          parts.push({
            type: 'text',
            text: `[Attached Web Link: ${label}] URL: ${att.url}`,
          });
        }
        break;
      }

      case 'file':
      default: {
        // File attachment — use content if provided, otherwise read from artifact
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached File: ${label}${originRef}]:\n${att.content}`,
          });
        } else if (att.url) {
          let fileContent: string | null = null;
          const artifactMatch = ARTIFACT_URL_REGEX.exec(att.url);
          // Three cases for `att.url`:
          //   1. Full canvas-scoped URL → pull canvasId + filename from regex.
          //   2. Bare artifact key (no slashes, not http(s)) → pair with
          //      the current canvas id (the chat thread's canvas).
          //   3. Anything else (external URL, data URL, etc.) → skip the
          //      filesystem lookup and fall through to the URL-only branch.
          let resolvedCanvasId: string | null = null;
          let resolvedFilename: string | null = null;
          if (artifactMatch) {
            resolvedCanvasId = artifactMatch[1] ?? null;
            resolvedFilename = path.basename(artifactMatch[2] ?? '');
          } else if (
            canvasId &&
            !att.url.startsWith('data:') &&
            !/^https?:/i.test(att.url) &&
            !att.url.includes('/')
          ) {
            resolvedCanvasId = canvasId;
            resolvedFilename = att.url;
          }
          if (resolvedCanvasId && resolvedFilename) {
            try {
              const filePath =
                getCanvasStore(resolvedCanvasId).resolveArtifactFilePath(
                  resolvedFilename,
                );
              if (filePath) {
                try {
                  fileContent = await readFile(filePath, 'utf-8');
                } catch {
                  /* file not readable as text */
                }
              }
            } catch {
              /* invalid artifact reference; fall back to including the URL */
            }
          }
          if (fileContent) {
            parts.push({
              type: 'text',
              text: `[AttachedFile: ${label}]:\n${fileContent}`,
            });
          } else {
            parts.push({
              type: 'text',
              text: `[Attached File: ${label}] (URL: ${att.url})`,
            });
          }
        }
        break;
      }
    }
  }
  return parts;
}

/**
 * Render the per-turn context sections (selected nodes, neighbourhood,
 * invoked skills) into a single XML-tagged text block, or `undefined`
 * when the turn carries none. Each section is wrapped in its own tag so
 * the model can parse the boundaries unambiguously; the user's own
 * words are intentionally NOT included here — the caller appends them
 * last (see {@link renderEnvelopeMessages}).
 */
function buildContextSections(env: ChatEnvelope): string | undefined {
  const blocks: string[] = [];

  // Selected-node references. Each entry carries { id, type, label?,
  // filename } — `filename` is pre-computed so the agent can `read` it
  // verbatim; richer detail is one tool call away.
  if (env.focus.selection.refs.length > 0) {
    blocks.push(
      [
        '<selected_nodes>',
        'Nodes the user selected. Pass `filename` straight to read() for full content; use `id` with inspect_nodes() for layout / style / spatial relations.',
        JSON.stringify(env.focus.selection.refs, null, 2),
        '</selected_nodes>',
      ].join('\n'),
    );
  }

  // Node-neighbourhood context for anchored requests (e.g. question
  // nodes). Lets the agent resolve references like "this" / "the one
  // above" against the surrounding canvas.
  if (env.preamble.nodeNeighbourhood) {
    blocks.push(
      [
        '<canvas_neighbourhood>',
        'The user\'s request was anchored at a node on the canvas. Use this neighbourhood to disambiguate references like "this", "the one above", or implicit pronouns.',
        env.preamble.nodeNeighbourhood,
        '</canvas_neighbourhood>',
      ].join('\n'),
    );
  }

  // User-invoked skill bodies — authoritative for this turn, distinct
  // from the on-demand catalogue the model may `read()` itself.
  if (env.skills.resolved.length > 0) {
    const quotedIds = env.skills.resolved.map((s) => `"${s.id}"`).join(', ');
    const intro =
      env.skills.resolved.length === 1
        ? `The user explicitly invoked the ${quotedIds} skill. Apply its guidance to this turn.`
        : `The user explicitly invoked the ${quotedIds} skills. Apply their guidance to this turn.`;
    const skillTags = env.skills.resolved
      .map(
        (s) =>
          `<skill id="${s.id}" name="${s.name}">\n${s.body.trimEnd()}\n</skill>`,
      )
      .join('\n');
    blocks.push(
      ['<invoked_skills>', intro, skillTags, '</invoked_skills>'].join('\n'),
    );
  }

  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

/**
 * Render a {@link ChatEnvelope} into the per-turn pi-ai user message,
 * WITHOUT touching any `Context`. Used both to build the current turn's
 * message and to rebuild historical turns from their persisted
 * envelopes (the structured-persistence path), so the rendered shape is
 * never the source of truth on disk.
 *
 * A turn now collapses to a SINGLE user message (previously up to four
 * separate user messages). Its content is laid out as:
 *   1. an XML context block (`<selected_nodes>`, `<canvas_neighbourhood>`,
 *      `<invoked_skills>`) — present only when the turn carries any;
 *   2. attachment parts (text excerpts + base64 vision images);
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
    parts.push(...attachmentParts);
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
