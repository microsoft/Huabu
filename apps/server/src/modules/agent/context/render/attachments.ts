/**
 * Attachment → content-part renderer.
 *
 * Turns a turn's attachments (off-canvas uploads + node excerpts) into
 * the pi-ai content parts that sit inside the `<attachments>` block. The
 * user's own words are composed separately by the orchestrator
 * (`render-turn.ts`) so they land last, after every context section.
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

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveImageUrl, MAX_INLINE_IMAGE_BYTES } from './image-inlining.js';
import { escapeXmlAttr } from './node-element.js';
import { ARTIFACT_URL_REGEX } from '../../../artifact/utils.js';
import { getCanvasStore } from '../../../storage/index.js';
import { isSketchRasterAttachment } from '../attachment-chips.js';

import type { ChatAttachment } from '@sediment/shared';

/** pi-ai user-message content: text and/or vision parts. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export type UserContent = string | ContentPart[];

/**
 * If `attachments` includes pre-snapshotted sketch artifacts, build a
 * one-line directive pointing the agent at those urls so it does not
 * re-issue `snapshot_nodes` for the same node ids on this turn. Returns
 * `undefined` when there are no sketch-raster artifacts.
 */
export function buildSketchRasterHint(
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
 * + base64 vision images). Returns ONLY the attachment-derived parts —
 * the user's own text is composed separately by the orchestrator so it
 * can be placed last, after every context section.
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
            // can call `snapshot_nodes` for a downscaled PNG.
            const mb = resolved.sizeBytes
              ? (resolved.sizeBytes / (1024 * 1024)).toFixed(1)
              : '?';
            parts.push({
              type: 'text',
              text: `<attachment type="image" name="${escapeXmlAttr(label)}"${originAttr}>\nomitted from vision (~${mb} MB exceeds the ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB inline cap). Call \`snapshot_nodes\` on the origin node id to get a downscaled PNG, or \`read\` the node's sidecar for its description.\n</attachment>`,
            });
          }
        }
        // If the image also carries extracted text content (e.g. PDF capture with OCR text)
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="text" name="${escapeXmlAttr(label)}"${originAttr}>\n${att.content}\n</attachment>`,
          });
        }
        break;
      }

      case 'pdf': {
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="pdf" name="${escapeXmlAttr(label)}"${originAttr}>\n${att.content}\n</attachment>`,
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
        // Text excerpted from a node — content is always present
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="text"${originAttr}>\n${att.content}\n</attachment>`,
          });
        }
        break;
      }

      case 'web': {
        // Web URL content
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `<attachment type="web" name="${escapeXmlAttr(label)}"${att.url ? ` url="${escapeXmlAttr(att.url)}"` : ''}>\n${att.content}\n</attachment>`,
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
            text: `<attachment type="file" name="${escapeXmlAttr(label)}"${originAttr}>\n${att.content}\n</attachment>`,
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
              text: `<attachment type="file" name="${escapeXmlAttr(label)}">\n${fileContent}\n</attachment>`,
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
