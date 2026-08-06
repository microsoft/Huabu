// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Convert copied canvas nodes into the plain-text representation written to
 * the system clipboard.
 *
 * Huabu's own paste path never reads this text — it reads the serialized node
 * payload carried in `text/html` (see `clipboard.ts`). This module exists
 * purely so that pasting into an application outside Huabu produces something
 * a human would expect, instead of leaking serialized JSON.
 *
 * Each node type maps to whatever a user would consider "the text of this
 * node". Types whose content is not textual (images, sketches, portals) map to
 * nothing at all and are dropped from the output — for a single image node
 * that means no `text/plain` representation is written, so the receiving
 * application pastes only the image.
 *
 * `dragPayloadToMarkdown` is deliberately not reused here: it converts the
 * three-kind `DragPayload` union into Markdown for embedding into a note,
 * whereas this converts the full canvas node union into flat text for foreign
 * applications.
 */

/** Minimal structural view of a clipboard node, matching the copy payload. */
export interface PlainTextNode {
  type?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

function readString(
  data: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = data?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Text representation of a single node, or `''` when it has none. */
function nodeToPlainText(node: PlainTextNode): string {
  const { data } = node;

  switch (node.type) {
    // Body-bearing nodes paste as their content verbatim.
    case 'note':
    case 'text':
    case 'question':
      return readString(data, 'content');

    // A web node is its URL; the label is usually an auto-generated title and
    // would just add noise next to the link.
    case 'web':
      return readString(data, 'src');

    // File-backed and container nodes have no body, so the label is the only
    // meaningful text. Empty when unlabelled.
    case 'pdf':
    case 'office':
    case 'video':
    case 'audio':
    case 'frame':
    case 'canvasRef':
      return readString(data, 'label');

    // Images paste as images, sketches are pure geometry, and ref nodes are
    // pointers whose label is owned by their target.
    case 'image':
    case 'sketch':
    case 'nodeRef':
    case 'frameRef':
      return '';

    default:
      return readString(data, 'label');
  }
}

/**
 * Text representation of a copied selection, or `''` when nothing in the
 * selection has a textual form. Callers must skip the `text/plain` clipboard
 * representation entirely when this returns an empty string.
 */
export function nodesToPlainText(nodes: readonly PlainTextNode[]): string {
  return nodes.map(nodeToPlainText).filter(Boolean).join('\n\n');
}
