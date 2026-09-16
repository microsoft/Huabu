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
