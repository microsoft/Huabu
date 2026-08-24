// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Attachment → content-part renderer.
 *
 * Turns a turn's attachments (off-canvas uploads + node excerpts) into
 * the pi-ai content parts. The orchestrator (`build-prompt.ts`) calls
 * this once per provenance group and wraps each result in its own block
 * (`<selected_nodes_visuals>` for selection, `<attachments>` for
 * uploads). The user's own words are composed separately so they land
 * last, after every context section.
 *
 * Output shape (one `<attachment>` element per item; image attachments
 * additionally contribute a base64 vision part):
 *
 *   <attachment type="image" name="diagram.png" origin="n-1, n-2" />   ← caption, then the image bytes
 *   <attachment type="pdf" name="spec.pdf">…extracted text…</attachment>
 *   <attachment type="text" origin="n-3">…selected text…</attachment>
 *   <attachment type="web" name="MDN" url="https://…">…page text…</attachment>
 *   <attachment type="file" name="notes.txt">…file body…</attachment>
 *
 * Per-type handling:
 *   - image → resolve URL to base64 vision bytes (+ a caption element
 *     when origin nodes are known); too-large images degrade to a text
 *     placeholder pointing at `snapshot_nodes`.
 *   - pdf   → inline extracted text, else a self-closing element + url.
 *   - text  → inline the excerpt (always present for node selections).
 *   - web   → inline page text, else a self-closing element + url.
 *   - file  → inline content, else read it back from the artifact store,
 *     else a self-closing element + url.
 */

import path from 'node:path';

import { resolveImageUrl, MAX_INLINE_IMAGE_BYTES } from './image-inlining.js';
import { escapeXmlAttr, escapeXmlText } from './node-element.js';
import { isRasterizableImageMime } from '../../../../utils/mime.js';
import { ARTIFACT_URL_REGEX } from '../../../artifact/utils.js';
import { space } from '../../../storage/index.js';

import type { AgentInputPart } from '@agenetes/protocol';
import type { ChatAttachment } from '@huabu/shared';

/** pi-ai user-message content: text and/or vision parts. */
export type ContentPart = AgentInputPart;
export type UserContent = string | ContentPart[];

/**
 * Resolve a list of attachments into pi-ai content parts (text excerpts
 * + base64 vision images). Returns ONLY the attachment-derived parts —
 * the user's own text is composed separately by the orchestrator so it
 * can be placed last, after every context section.
 *
 * Called once per provenance group by the orchestrator (selection-derived
 * visuals vs off-canvas uploads) so each group lands in its own block.
 *
 * Attachment types handled:
 *  - image  → resolve URL to base64 and include as vision input
 *  - pdf    → resolve URL; will be sent as image for vision analysis
 *  - text   → inline content as text part (e.g. text excerpted from a node)
 *  - file   → use content if available, otherwise try reading from artifact
 *  - web    → inline content as text part
 */
export async function buildAttachmentParts(
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
    // Origin node ids surface as an XML `origin` attribute so the model
    // can follow up via inspect_nodes() / read() for surrounding context.
    const originAttr =
      originIds.length === 0
        ? ''
        : ` origin="${escapeXmlAttr(originIds.join(', '))}"`;

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
            text: `<attachment type="image" name="${escapeXmlAttr(label)}"${originAttr} />`,
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
            // exactly why and how to recover. The placeholder carries the
            // origin node ids (in the `origin` attribute) so the model
            // can call `snapshot_nodes` for a downscaled PNG — but only
            // when resvg can actually decode the source bytes.
            const mb = resolved.sizeBytes
              ? (resolved.sizeBytes / (1024 * 1024)).toFixed(1)
              : '?';
            const recovery =
              originIds.length > 0 && isRasterizableImageMime(resolved.mimeType)
                ? 'Call `snapshot_nodes` on the origin node id to get a downscaled PNG, or `read`'
                : 'Ask the user for a smaller copy, or `read`';
            parts.push({
              type: 'text',
              text: `<attachment type="image" name="${escapeXmlAttr(label)}"${originAttr}>\nomitted from vision (~${mb} MB exceeds the ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB inline cap). ${recovery} the node's sidecar for its description.\n</attachment>`,
            });
          } else if (resolved.reason === 'unsupported_type') {
            // Sending these bytes would make the provider reject the whole
            // request. `snapshot_nodes` cannot rescue them either — resvg
            // decodes a strict subset of what models accept — so say plainly
            // that the pixels are unavailable instead of inventing a fix.
            parts.push({
              type: 'text',
              text: `<attachment type="image" name="${escapeXmlAttr(label)}"${originAttr}>\nomitted from vision (${escapeXmlText(resolved.mimeType ?? 'unknown media type')} is not accepted by vision models, and cannot be converted server-side). You cannot see this image. \`read\` the node's sidecar for any description or label, and otherwise tell the user the image must be re-saved as PNG or JPEG to be visible.\n</attachment>`,
            });
          }
        }
        // If the image also carries extracted text content (e.g. PDF capture with OCR text)
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="text" name="${escapeXmlAttr(label)}"${originAttr}>\n${escapeXmlText(att.content)}\n</attachment>`,
          });
        }
        break;
      }

      case 'pdf': {
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="pdf" name="${escapeXmlAttr(label)}"${originAttr}>\n${escapeXmlText(att.content)}\n</attachment>`,
          });
        } else {
          parts.push({
            type: 'text',
            text: `<attachment type="pdf" name="${escapeXmlAttr(label)}"${att.url ? ` url="${escapeXmlAttr(att.url)}"` : ''} />`,
          });
        }
        break;
      }

      case 'text': {
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="text"${originAttr}>\n${escapeXmlText(att.content)}\n</attachment>`,
          });
        } else if (originIds.length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="node" name="${escapeXmlAttr(label)}"${originAttr} />`,
          });
        }
        break;
      }

      case 'web': {
        // Web URL content
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="web" name="${escapeXmlAttr(label)}"${att.url ? ` url="${escapeXmlAttr(att.url)}"` : ''}>\n${escapeXmlText(att.content)}\n</attachment>`,
          });
        } else if (att.url) {
          parts.push({
            type: 'text',
            text: `<attachment type="web" name="${escapeXmlAttr(label)}" url="${escapeXmlAttr(att.url)}" />`,
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
            text: `<attachment type="file" name="${escapeXmlAttr(label)}"${originAttr}>\n${escapeXmlText(att.content)}\n</attachment>`,
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
              const bytes =
                await space(resolvedCanvasId).blobs.read(resolvedFilename);
              // Attachments are inlined as text; binary bytes simply
              // decode to mojibake and the URL-only branch is used instead.
              if (bytes) fileContent = bytes.toString('utf-8');
            } catch {
              /* invalid artifact reference; fall back to including the URL */
            }
          }
          if (fileContent) {
            parts.push({
              type: 'text',
              text: `<attachment type="file" name="${escapeXmlAttr(label)}">\n${escapeXmlText(fileContent)}\n</attachment>`,
            });
          } else {
            parts.push({
              type: 'text',
              text: `<attachment type="file" name="${escapeXmlAttr(label)}" url="${escapeXmlAttr(att.url)}" />`,
            });
          }
        }
        break;
      }
    }
  }
  return parts;
}
