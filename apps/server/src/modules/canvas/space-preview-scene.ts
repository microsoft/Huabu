// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  SPACE_PREVIEW_MAX_EDGES,
  SPACE_PREVIEW_MAX_IMAGE_SRC_LENGTH,
  SPACE_PREVIEW_MAX_NODES,
  SPACE_PREVIEW_MAX_RESPONSE_BYTES,
  SPACE_PREVIEW_MAX_TEXT_LENGTH,
  type GetSpacePreviewSceneResponse,
  type SpacePreviewSceneNode,
} from '@huabu/shared';
import {
  createAbsolutePositionGetter,
  getNodeDefaultSize,
  indexById,
  type NestableNode,
  stripMarkdown,
} from '@huabu/shared/canvas-engine';

import { getStructuredStore, space } from '../storage/index.js';

type StoredNode = NestableNode & {
  type?: string;
  style?: { width?: number | string; height?: number | string };
  measured?: { width?: number; height?: number };
};

interface StoredEdge {
  id: string;
  source: string;
  target: string;
  data?: { label?: unknown };
  label?: unknown;
}

export class SpacePreviewSceneError extends Error {
  readonly statusCode: 403 | 404 | 422;

  constructor(statusCode: 403 | 404 | 422, message: string) {
    super(message);
    this.name = 'SpacePreviewSceneError';
    this.statusCode = statusCode;
  }
}

function dimension(
  measured: number | undefined,
  styled: number | string | undefined,
  fallback: number | undefined,
): number {
  if (typeof measured === 'number' && measured > 0) return measured;
  const parsed =
    typeof styled === 'number' ? styled : Number.parseFloat(styled ?? '');
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback && fallback > 0 ? fallback : 100;
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function boundedPreviewText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = stripMarkdown(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized
    ? normalized.slice(0, SPACE_PREVIEW_MAX_TEXT_LENGTH)
    : undefined;
}

function boundedImageSrc(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > SPACE_PREVIEW_MAX_IMAGE_SRC_LENGTH ||
    value.startsWith('data:') ||
    value.startsWith('blob:')
  ) {
    return undefined;
  }
  return value;
}

function sceneKind(type: string | undefined): SpacePreviewSceneNode['kind'] {
  if (type === 'frame' || type === 'frameRef') return 'frame';
  if (type === 'spacePreview' || type === 'canvasRef') {
    return 'nested-preview';
  }
  return 'content';
}

function sceneBounds(
  nodes: readonly SpacePreviewSceneNode[],
): GetSpacePreviewSceneResponse['bounds'] {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function enforceResponseBudget(
  response: GetSpacePreviewSceneResponse,
): GetSpacePreviewSceneResponse {
  while (
    response.nodes.length > 0 &&
    Buffer.byteLength(JSON.stringify(response), 'utf8') >
      SPACE_PREVIEW_MAX_RESPONSE_BYTES
  ) {
    const removed = response.nodes.pop();
    if (!removed) break;
    response.truncated.nodes = true;
    response.edges = response.edges.filter(
      (edge) => edge.source !== removed.id && edge.target !== removed.id,
    );
    response.truncated.edges = true;
    response.bounds = sceneBounds(response.nodes);
  }
  return response;
}

/** Project one authorized ordinary Space into a bounded inert scene. */
export async function getSpacePreviewScene(
  canvasId: string,
): Promise<GetSpacePreviewSceneResponse> {
  const spaces = await getStructuredStore().spaces().list();
  if (![...spaces].some((space) => space.canvasId === canvasId)) {
    throw new SpacePreviewSceneError(404, 'Target Space was not found');
  }

  const target = space(canvasId);
  let canvas;
  try {
    canvas = await target.read();
  } catch {
    // A record the port refuses to produce is a malformed target, which is
    // the same 422 the shape checks below raise. Reading it as a file used to
    // put that judgement here; the port makes it once for every reader, and
    // this route still owns what the caller is told.
    throw new SpacePreviewSceneError(422, 'Target Space is malformed');
  }
  if (!canvas) {
    throw new SpacePreviewSceneError(404, 'Target Space was not found');
  }

  // Node records are read the one lenient way the port defines, which is also
  // how the Space's own view renders it: a record that cannot be produced is
  // omitted and the projection falls back to topology data below, and a
  // record a user broke by hand recovers the same way it does when its Space
  // is opened. The 422 stays for a malformed *Space record*, which is the
  // damage that makes the whole projection meaningless.
  const contentByNodeId = await target.nodes.list();

  if (
    !Array.isArray(canvas.state?.nodes) ||
    !Array.isArray(canvas.state.edges)
  ) {
    throw new SpacePreviewSceneError(422, 'Target Space is malformed');
  }

  const sourceNodes = canvas.state.nodes as StoredNode[];
  const included = sourceNodes.slice(0, SPACE_PREVIEW_MAX_NODES);
  const byId = indexById(sourceNodes);
  const absolutePosition = createAbsolutePositionGetter(byId);
  const nodes: SpacePreviewSceneNode[] = [];
  for (const node of included) {
    const position = absolutePosition(node.id);
    if (!position || !node.type) continue;
    const defaults = getNodeDefaultSize(node.type);
    const content = contentByNodeId.get(node.id)?.record;
    const previewText =
      node.type === 'note' || node.type === 'text'
        ? boundedPreviewText(content?.content ?? node.data?.content)
        : undefined;
    const imageSrc =
      node.type === 'image'
        ? boundedImageSrc(content?.src ?? node.data?.src)
        : undefined;
    nodes.push({
      id: node.id as `node-${string}`,
      kind: sceneKind(node.type),
      x: position.x,
      y: position.y,
      width: dimension(node.measured?.width, node.style?.width, defaults.width),
      height: dimension(
        node.measured?.height,
        node.style?.height,
        defaults.height,
      ),
      ...(boundedLabel(content?.label ?? node.data?.label) !== undefined
        ? { label: boundedLabel(content?.label ?? node.data?.label) }
        : {}),
      ...(previewText !== undefined ? { previewText } : {}),
      ...(imageSrc !== undefined ? { imageSrc } : {}),
    });
  }

  const includedIds = new Set(nodes.map((node) => node.id));
  const sourceEdges = canvas.state.edges as StoredEdge[];
  const eligibleEdges = sourceEdges.filter(
    (edge) =>
      includedIds.has(edge.source as `node-${string}`) &&
      includedIds.has(edge.target as `node-${string}`),
  );
  const edges = eligibleEdges.slice(0, SPACE_PREVIEW_MAX_EDGES).map((edge) => ({
    id: edge.id,
    source: edge.source as `node-${string}`,
    target: edge.target as `node-${string}`,
    ...(boundedLabel(edge.data?.label ?? edge.label) !== undefined
      ? { label: boundedLabel(edge.data?.label ?? edge.label) }
      : {}),
  }));

  return enforceResponseBudget({
    canvasId: canvas.canvasId as `canvas-${string}`,
    title: canvas.title,
    version: canvas.version,
    bounds: sceneBounds(nodes),
    nodes,
    edges,
    truncated: {
      nodes: sourceNodes.length > nodes.length,
      edges: eligibleEdges.length > edges.length,
    },
  });
}
