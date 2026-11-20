// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const NODE_QUERY_PARAM = 'node';
const MAX_NODE_ID_LENGTH = 256;
const NODE_ID_PATTERN = /^node-[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type NodeDeepLinkIntent =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'target'; nodeId: string };

export function readNodeDeepLinkIntent(search: string): NodeDeepLinkIntent {
  const params = new URLSearchParams(search);
  const values = params.getAll(NODE_QUERY_PARAM);
  if (values.length === 0) return { kind: 'none' };
  if (values.length !== 1) return { kind: 'invalid' };

  const nodeId = values[0];
  if (
    nodeId.length === 0 ||
    nodeId.length > MAX_NODE_ID_LENGTH ||
    !NODE_ID_PATTERN.test(nodeId)
  ) {
    return { kind: 'invalid' };
  }

  return { kind: 'target', nodeId };
}

export function buildNodeDeepLink(
  origin: string,
  canvasId: string,
  nodeId: string,
): string {
  const url = new URL(`/canvas/${encodeURIComponent(canvasId)}`, origin);
  url.searchParams.set(NODE_QUERY_PARAM, nodeId);
  return url.href;
}

/** A node addressed from document text, optionally in another Space. */
export interface NodeReference {
  nodeId: string;
  /** Present only for the absolute deep-link form. */
  canvasId?: string;
}

const CANVAS_PATH_PATTERN = /^\/canvas\/([^/]+)\/?$/;

function isNodeId(value: string): boolean {
  return value.length <= MAX_NODE_ID_LENGTH && NODE_ID_PATTERN.test(value);
}

/** Markdown href that addresses a node of the Space the document lives in. */
export function buildNodeReferenceHref(nodeId: string): string {
  return `#${nodeId}`;
}

/**
 * Recognise the two in-app node link forms authored in Markdown: the
 * Space-relative `#node-<id>` and a same-origin `/canvas/<id>?node=<id>` deep
 * link. Anything else is an ordinary document link.
 */
export function parseNodeReferenceHref(
  href: string | null | undefined,
  origin: string,
): NodeReference | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) {
    const nodeId = trimmed.slice(1);
    return isNodeId(nodeId) ? { nodeId } : null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = CANVAS_PATH_PATTERN.exec(url.pathname);
  const intent = readNodeDeepLinkIntent(url.search);
  if (!match || intent.kind !== 'target') return null;
  try {
    return { canvasId: decodeURIComponent(match[1]), nodeId: intent.nodeId };
  } catch {
    return null;
  }
}
