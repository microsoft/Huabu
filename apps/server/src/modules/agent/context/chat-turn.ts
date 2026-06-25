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
import { getSkill } from '../../../prompt/index.js';
import {
  ARTIFACT_URL_REGEX,
  resolveArtifactImageUrl,
} from '../../artifact/utils.js';
import { renderNodeNeighbourhoodMarkdown } from '../../canvas/node-neighbourhood.js';
import { getCanvasStore } from '../../storage/index.js';
import { readWorkspaceMemory } from '../memory/index.js';
import { buildAgentNodeRef } from '../node-ref.js';
import { isUserInvokableSkill } from '../skills.route.js';
import { snapshotNodesToArtifacts } from '../tools/handlers/snapshot-node.js';
import { appendMetadataTags } from '../user-message-metadata.js';

import type { LoadedAgent } from '../../../prompt/index.js';
import type { AgentNodeRef } from '../node-ref.js';
import type { Context } from '@earendil-works/pi-ai';
import type { ChatAttachment, WireSelectionNode } from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

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
 * Collect image attachments from selected canvas nodes (including frame children).
 * Enables vision analysis when users select image nodes on the canvas.
 */
function collectImageAttachments(nodes: WireSelectionNode[]): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];

  for (const node of nodes) {
    if (node.type === 'image' && node.src) {
      attachments.push({
        type: 'image',
        source: 'selection',
        url: node.src,
        label: node.label ?? `Image node ${node.id}`,
        originNodeId: node.id,
      });
    }
    if (node.children) {
      attachments.push(...collectImageAttachments(node.children));
    }
  }

  return attachments;
}

/**
 * Walk the wire selection (frame children included) and collect the
 * ids of every `sketch` node. Used to drive the auto-snapshot step
 * that turns selected strokes into a vision-ready PNG attachment
 * before the LLM ever sees the user's prompt.
 */
function collectSketchNodeIds(nodes: WireSelectionNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      if (n.type === 'sketch') ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Flatten the wire selection (including frame children) into the
 * absolute minimum the agent needs to know up front: the L0
 * `AgentNodeRef` payload of `{ id, type, label?, filename }`. Anything
 * richer (content / preview / position / style) is one tool call away
 * via `read` or `inspect_nodes`, so we deliberately do not pay the
 * token cost of including it in every turn.
 *
 * `filename` is derived server-side via `buildAgentNodeRef` so the LLM
 * never has to apply the safeLabel rule itself — empirically it
 * mis-handles spaces and other kept-as-is characters often enough to
 * waste a turn on a 404'd `read`.
 */
function collectSelectedNodeRefs(nodes: WireSelectionNode[]): AgentNodeRef[] {
  const refs: AgentNodeRef[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      refs.push(buildAgentNodeRef({ id: n.id, type: n.type, label: n.label }));
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return refs;
}

/**
 * Collect the ids the user **explicitly selected** on the canvas
 * (top-level entries only — frame children are intentionally skipped).
 * Used to materialise the `[SYSTEM selectedNodeIds:[...]]` metadata
 * tag on the persisted user message so reloaded history renders the
 * same NodeRef chips the live composer showed at submit time.
 */
function collectSelectedNodeIds(nodes: WireSelectionNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) seen.add(n.id);
  return Array.from(seen);
}

/** Inputs needed to assemble one chat turn's user messages. */
export interface ChatTurnParams {
  /** Raw user prompt text. */
  content: string;
  /** User-uploaded (off-canvas) attachments from the request body. */
  attachments?: ChatAttachment[];
  /** Wire selection (top-level + frame children) for this turn. */
  selectedNodes?: WireSelectionNode[];
  /** Anchor node for neighbourhood preamble (e.g. question nodes). */
  anchorNodeId?: string;
  /** User-invoked skill ids parsed from `/<id>` tokens. */
  invokedSkills?: string[];
  /** Current canvas id (null for canvas-less threads). */
  canvasId: string | null;
  /** Resolved agent config (provides message templates). */
  agentCfg: LoadedAgent;
  /** True on the first turn of a thread (drives memory pre-read). */
  isFirstTurn: boolean;
  /** Logger for non-fatal diagnostics (auto-snapshot failures). */
  logger: FastifyBaseLogger;
}

/**
 * Assemble and push every per-turn user message onto `context.messages`
 * in canonical order:
 *   1. workspace-memory pre-read (first turn only)
 *   2. selected-node reference preamble
 *   3. node-neighbourhood preamble (anchored requests)
 *   4. user-invoked skill bodies
 *   5. the user's message (with selection / skill / attachment tags)
 *
 * Mutates `context.messages` in place — the caller owns persistence.
 *
 * Returns the final tagged user-message content so the caller can also
 * forward it to the external-agent (ACP) dispatch path, which consumes
 * the same payload as the message body.
 */
export async function applyChatTurnMessages(
  context: Context,
  params: ChatTurnParams,
): Promise<UserContent> {
  const {
    content,
    attachments,
    selectedNodes,
    anchorNodeId,
    invokedSkills,
    canvasId,
    agentCfg,
    isFirstTurn,
    logger,
  } = params;

  // Workspace-memory pre-read.
  //
  // For the *first turn* of a thread we eagerly inject workspace
  // memory as a SYSTEM context block. Reason: cross-canvas user
  // preferences (style, voice, response length) should influence
  // the very first reply, and we can't trust the agent to remember
  // to read memory/workspace.md before answering a trivial prompt.
  if (isFirstTurn) {
    const workspace = readWorkspaceMemory();
    if (workspace) {
      context.messages.push({
        role: 'user',
        content: `[SYSTEM Workspace memory \u2014 cross-canvas user profile, eagerly loaded for the first turn]\n${workspace}`,
        timestamp: Date.now(),
      });
    }
  }

  // Collect image attachments from selected canvas nodes for vision analysis
  const selectedImageAttachments = selectedNodes
    ? collectImageAttachments(selectedNodes)
    : [];

  // Auto-snapshot every selected sketch and image into PNG artifacts
  // so the LLM sees them as vision parts on the very first turn,
  // without having to call `snapshot_nodes` itself. We piggy-back on
  // the same content-addressed pipeline the tool uses, so selecting
  // an unchanged cluster repeatedly is essentially free. Failures are
  // logged but never block the user's prompt.
  //
  // The handler clusters per parent frame (≤ 200 px gap): nearby
  // image+sketch nodes composite into ONE PNG (images as backdrop,
  // strokes on top), distant nodes stay separate, and a singleton
  // image short-circuits to its original artifact. Any image whose
  // pixels end up inside a composite is marked consumed below so its
  // standalone `selectedImageAttachments` entry is dropped — sending
  // the same image bytes twice was the direct cause of 8 MB request
  // bodies that tripped `413 Request Entity Too Large`.
  const snapshotAttachments: ChatAttachment[] = [];
  const consumedSelectionImageIds = new Set<string>();
  if (selectedNodes && canvasId) {
    const sketchIds = collectSketchNodeIds(selectedNodes);
    const selectedImageIds = selectedImageAttachments
      .map((a) => a.originNodeId)
      .filter((id): id is string => typeof id === 'string');
    const snapshotIds = [...sketchIds, ...selectedImageIds];
    if (snapshotIds.length > 0) {
      try {
        const rasterResults = await snapshotNodesToArtifacts({
          nodeIds: snapshotIds,
          canvasId,
        });
        const selectedImageIdSet = new Set(selectedImageIds);
        for (const r of rasterResults) {
          const strokeIds = r.originNodeIds.filter(
            (id) => !selectedImageIdSet.has(id),
          );
          const imageIds = r.originNodeIds.filter((id) =>
            selectedImageIdSet.has(id),
          );
          // Singleton image pass-through (no strokes, exactly one
          // image — handler short-circuited to that node's original
          // artifact): leave it alone. The original
          // `selectedImageAttachments` entry already owns that vision
          // part with its richer label, so we neither emit a duplicate
          // `snapshotAttachment` here NOR mark the id as consumed.
          if (strokeIds.length === 0 && imageIds.length === 1) continue;
          // Anything else is a composite owned by this snapshot:
          //   - strokes + 0-or-N images → sketch cluster
          //   - 0 strokes + N images    → pure image overview cluster
          for (const iid of imageIds) consumedSelectionImageIds.add(iid);
          const nStrokes = strokeIds.length;
          const nImages = imageIds.length;
          const label =
            nStrokes === 0
              ? `Image cluster (${nImages} images)`
              : nImages > 0
                ? `Sketch cluster (${nStrokes} stroke node${
                    nStrokes === 1 ? '' : 's'
                  } + ${nImages} backdrop image${nImages === 1 ? '' : 's'})`
                : nStrokes === 1
                  ? 'Sketch (1 stroke node)'
                  : `Sketch cluster (${nStrokes} stroke nodes)`;
          snapshotAttachments.push({
            type: 'image',
            source: 'selection',
            url: r.src,
            label,
            originNodeIds: r.originNodeIds,
          });
        }
      } catch (err) {
        logger.warn(
          { err, snapshotIds, canvasId },
          '[agent.route] selection auto-snapshot failed',
        );
      }
    }
  }

  // Drop selection image attachments that are already composited
  // inside a snapshot artifact. The model still learns about them via
  // the `[SYSTEM selectedNodeIds:...]` metadata and the snapshot's
  // `originNodeIds` caption, so it can still call `inspect_nodes` /
  // `read` on them if needed.
  const dedupedImageAttachments =
    consumedSelectionImageIds.size === 0
      ? selectedImageAttachments
      : selectedImageAttachments.filter(
          (a) =>
            !a.originNodeId || !consumedSelectionImageIds.has(a.originNodeId),
        );

  const allAttachments =
    dedupedImageAttachments.length > 0 ||
    snapshotAttachments.length > 0 ||
    (attachments && attachments.length > 0)
      ? [
          ...(attachments ?? []),
          ...dedupedImageAttachments,
          ...snapshotAttachments,
        ]
      : undefined;

  // Build user message
  let userContent = await buildUserContent(
    content,
    allAttachments,
    canvasId ?? null,
  );

  // Inject a minimal selected-node reference list as a system message.
  // Each entry carries { id, type, label?, filename } — the `filename`
  // is pre-computed (`nodes/<safeLabel>.md`) so the agent can `read`
  // it verbatim without re-deriving the safeLabel rule. Anything
  // richer (content via `read`, layout/style via `inspect_nodes`) is
  // fetched on demand.
  if (selectedNodes && selectedNodes.length > 0) {
    const refs = collectSelectedNodeRefs(selectedNodes);
    if (refs.length > 0) {
      context.messages.push({
        role: 'user',
        content: renderAgentTemplate(agentCfg, 'selectedNodesPreamble', {
          refsJson: JSON.stringify(refs, null, 2),
        }),
        timestamp: Date.now(),
      });
    }
  }

  // Node-neighbourhood preamble. The actual user message arrives as
  // the next pipeline push, so this preamble carries ONLY the
  // surrounding-canvas markdown. The server resolves the
  // neighbourhood from canvas.json — the client just supplies the
  // anchor node id, no graph data on the wire. Empty result
  // (canvas/node missing, or no useful context) means we skip the
  // push entirely — no orphan `[SYSTEM Context]`.
  if (anchorNodeId && canvasId) {
    const spatial = renderNodeNeighbourhoodMarkdown(canvasId, anchorNodeId);
    if (spatial) {
      context.messages.push({
        role: 'user',
        content: renderAgentTemplate(agentCfg, 'nodeNeighbourhoodPreamble', {
          spatial,
        }),
        timestamp: Date.now(),
      });
    }
  }

  // User-invoked skills preamble.
  //
  // When the user typed `/<id>` tokens in the chat input (parsed
  // client-side, see `useInternalSlashCommands`), the skill ids are
  // forwarded here. We fetch each skill body and prepend a single
  // SYSTEM message so the agent treats the bodies as authoritative
  // for this turn — distinct from the on-demand catalogue surface
  // where the model decides whether to `read()` a skill.
  //
  // Security/scope rule: honoured ids must satisfy
  // {@link isUserInvokableSkill}. Unknown or non-invokable ids are
  // dropped silently (logged for diagnostics).
  if (invokedSkills && invokedSkills.length > 0) {
    const seen = new Set<string>();
    const injected: { id: string; name: string; body: string }[] = [];
    const dropped: {
      id: string;
      reason: 'unknown' | 'not-invokable';
    }[] = [];
    for (const rawId of invokedSkills) {
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const skill = getSkill(id);
      if (!skill) {
        dropped.push({ id, reason: 'unknown' });
        continue;
      }
      if (!isUserInvokableSkill(skill)) {
        dropped.push({ id, reason: 'not-invokable' });
        continue;
      }
      injected.push({ id: skill.id, name: skill.name, body: skill.body });
    }

    if (dropped.length > 0) {
      logger.warn(
        { dropped },
        '[agent] invokedSkills: dropped ids (unknown or not user-invokable)',
      );
    }

    if (injected.length > 0) {
      const sections = injected
        .map(
          (s) =>
            `<skill id="${s.id}" name="${s.name}">\n${s.body.trimEnd()}\n</skill>`,
        )
        .join('\n\n');
      const quotedIds = injected.map((s) => `"${s.id}"`).join(', ');
      const header =
        injected.length === 1
          ? `[SYSTEM Skill — the user explicitly invoked ${quotedIds}. Apply its guidance to this turn.]`
          : `[SYSTEM Skills — the user explicitly invoked ${quotedIds}. Apply their guidance to this turn.]`;
      context.messages.push({
        role: 'user',
        content: `${header}\n\n${sections}`,
        timestamp: Date.now(),
      });
    }
  }

  // Embed selection / skill / attachment breadcrumbs. selectedNodeIds
  // is derived from the wire selection — the wire never carries the id
  // list separately. `appendMetadataTags` partitions `attachments`
  // internally: user-visible items become the UI breadcrumb tag,
  // sketch-raster artifacts become the LLM-only hint tag.
  const selectedNodeIds = selectedNodes
    ? collectSelectedNodeIds(selectedNodes)
    : [];
  userContent = appendMetadataTags(userContent, {
    selectedNodeIds,
    invokedSkills,
    attachments: allAttachments,
  });
  context.messages.push({
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  });

  return userContent;
}
