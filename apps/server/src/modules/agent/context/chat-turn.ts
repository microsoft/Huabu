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

import { renderAgentTemplate } from '../../../prompt/index.js';
import {
  ARTIFACT_URL_REGEX,
  resolveArtifactImageUrl,
} from '../../artifact/utils.js';
import { getCanvasStore } from '../../storage/index.js';
import { appendMetadataTags } from '../user-message-metadata.js';
import { buildChatEnvelope } from './envelope.js';

import type { ChatEnvelope, ChatEnvelopeParams } from './envelope.js';
import type { LoadedAgent } from '../../../prompt/index.js';
import type { ChatTurnRecord, PiMessage } from '../store/chat-thread-store.js';
import type { Context } from '@earendil-works/pi-ai';
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
type UserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    >;

/**
 * Build a pi-ai user message content array, supporting text + images.
 *
 * Attachment types handled:
 *  - image  → resolve URL to base64 and include as vision input
 *  - pdf    → resolve URL; will be sent as image for vision analysis
 *  - text   → inline content as text part (e.g. text excerpted from a node)
 *  - file   → use content if available, otherwise try reading from artifact
 *  - web    → inline content as text part
 */
async function buildUserContent(
  text: string,
  attachments: ChatAttachment[] | undefined,
  canvasId: string | null,
): Promise<UserContent> {
  if (!attachments || attachments.length === 0) return text;

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text', text }];

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
 * Inputs needed to assemble one chat turn: everything the envelope
 * builder needs, plus the resolved agent config the pi-ai serializer
 * uses for its message templates.
 */
export interface ChatTurnParams extends ChatEnvelopeParams {
  /** Resolved agent config (provides message templates). */
  agentCfg: LoadedAgent;
}

/**
 * Serialize a structured {@link ChatEnvelope} into the per-turn pi-ai
 * user messages, pushing them onto `context.messages` in canonical
 * order:
 *   1. workspace-memory pre-read (first turn only)
 *   2. selected-node reference preamble
 *   3. node-neighbourhood preamble (anchored requests)
 *   4. user-invoked skill bodies
 *   5. the user's message (with selection / skill / attachment tags)
 *
 * This is the one place the pi-ai-specific `[SYSTEM …]` encoding and
 * base64 vision-part resolution live. Returns the final tagged
 * user-message content so the caller can forward it to the
 * external-agent (ACP) dispatch path.
 */
export async function serializeChatEnvelopeToPiAi(
  context: Context,
  env: ChatEnvelope,
  opts: { canvasId: string | null; agentCfg: LoadedAgent },
): Promise<UserContent> {
  const { messages, userContent } = await renderEnvelopeMessages(env, opts);
  context.messages.push(...messages);
  return userContent;
}

/**
 * Render a {@link ChatEnvelope} into the ordered pi-ai user messages
 * for one turn, WITHOUT touching any `Context`. This is the pure core
 * behind {@link serializeChatEnvelopeToPiAi}; it is also used to
 * rebuild historical turns from their persisted envelopes (the
 * structured-persistence path) so the `[SYSTEM …]` encoding is never
 * the source of truth on disk.
 *
 * Canonical order:
 *   1. workspace-memory pre-read (first turn only)
 *   2. selected-node reference preamble
 *   3. node-neighbourhood preamble (anchored requests)
 *   4. user-invoked skill bodies
 *   5. the user's message (with selection / skill / attachment tags)
 *
 * Returns the rendered messages plus the final tagged user-message
 * content (the ACP dispatch path consumes the latter).
 */
export async function renderEnvelopeMessages(
  env: ChatEnvelope,
  opts: { canvasId: string | null; agentCfg: LoadedAgent },
): Promise<{ messages: PiMessage[]; userContent: UserContent }> {
  const { canvasId, agentCfg } = opts;
  const messages: PiMessage[] = [];

  // 1. Workspace-memory pre-read (cross-canvas profile; first turn only).
  if (env.preamble.workspaceMemory) {
    messages.push({
      role: 'user',
      content: `[SYSTEM Workspace memory \u2014 cross-canvas user profile, eagerly loaded for the first turn]\n${env.preamble.workspaceMemory}`,
      timestamp: Date.now(),
    });
  }

  // Merge the off-canvas uploads with selection-derived vision parts.
  // Order matches the legacy assembly: uploads, deduped selection
  // images, then composite snapshots. `undefined` when all empty so
  // `buildUserContent` short-circuits to a plain string.
  const { imageAttachments, snapshotAttachments } = env.focus.selection;
  const allAttachments =
    env.user.attachments.length > 0 ||
    imageAttachments.length > 0 ||
    snapshotAttachments.length > 0
      ? [...env.user.attachments, ...imageAttachments, ...snapshotAttachments]
      : undefined;

  let userContent = await buildUserContent(
    env.user.text,
    allAttachments,
    canvasId ?? null,
  );

  // 2. Selected-node reference preamble. Each entry carries
  // { id, type, label?, filename } — `filename` is pre-computed so the
  // agent can `read` it verbatim. Richer detail is fetched on demand.
  if (env.focus.selection.refs.length > 0) {
    messages.push({
      role: 'user',
      content: renderAgentTemplate(agentCfg, 'selectedNodesPreamble', {
        refsJson: JSON.stringify(env.focus.selection.refs, null, 2),
      }),
      timestamp: Date.now(),
    });
  }

  // 3. Node-neighbourhood preamble (anchored requests only).
  if (env.preamble.nodeNeighbourhood) {
    messages.push({
      role: 'user',
      content: renderAgentTemplate(agentCfg, 'nodeNeighbourhoodPreamble', {
        spatial: env.preamble.nodeNeighbourhood,
      }),
      timestamp: Date.now(),
    });
  }

  // 4. User-invoked skill bodies. The agent treats these as
  // authoritative for this turn — distinct from the on-demand
  // catalogue surface where the model decides whether to `read()`.
  if (env.skills.resolved.length > 0) {
    const sections = env.skills.resolved
      .map(
        (s) =>
          `<skill id="${s.id}" name="${s.name}">\n${s.body.trimEnd()}\n</skill>`,
      )
      .join('\n\n');
    const quotedIds = env.skills.resolved.map((s) => `"${s.id}"`).join(', ');
    const header =
      env.skills.resolved.length === 1
        ? `[SYSTEM Skill — the user explicitly invoked ${quotedIds}. Apply its guidance to this turn.]`
        : `[SYSTEM Skills — the user explicitly invoked ${quotedIds}. Apply their guidance to this turn.]`;
    messages.push({
      role: 'user',
      content: `${header}\n\n${sections}`,
      timestamp: Date.now(),
    });
  }

  // 5. The user's message, with selection / skill / attachment
  // breadcrumbs. `appendMetadataTags` partitions `attachments`
  // internally: user-visible items become the UI breadcrumb tag,
  // sketch-raster artifacts become the LLM-only hint tag.
  userContent = appendMetadataTags(userContent, {
    selectedNodeIds: env.focus.selection.topLevelIds,
    invokedSkills: env.skills.invokedIds,
    attachments: allAttachments,
  });
  messages.push({
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  });

  return { messages, userContent };
}

/**
 * Assemble one chat turn: build the structured {@link ChatEnvelope}
 * (memory read, auto-snapshot, skill resolution, neighbourhood render)
 * and serialize it into pi-ai messages on `context`.
 *
 * Mutates `context.messages` in place — the caller owns persistence.
 * Returns the final tagged user-message content for the ACP path.
 */
export async function applyChatTurnMessages(
  context: Context,
  params: ChatTurnParams,
): Promise<UserContent> {
  const env = await buildChatEnvelope(params);
  return serializeChatEnvelopeToPiAi(context, env, {
    canvasId: params.canvasId,
    agentCfg: params.agentCfg,
  });
}

/**
 * Rebuild the flat pi-ai message array for a thread from its stored
 * turns: re-serialise each turn's envelope into the canonical user
 * messages, then append that turn's persisted assistant/tool
 * transcript. This is how the structured-persistence path reconstructs
 * the `Context.messages` the agent runs over, so the `[SYSTEM …]`
 * encoding never has to be the source of truth on disk.
 */
export async function rebuildContextMessages(
  turns: readonly ChatTurnRecord[],
  opts: { canvasId: string | null; agentCfg: LoadedAgent },
): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  for (const turn of turns) {
    const { messages } = await renderEnvelopeMessages(turn.envelope, opts);
    out.push(...messages, ...turn.transcript);
  }
  return out;
}
