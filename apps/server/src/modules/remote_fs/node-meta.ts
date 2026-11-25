// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Target classification + portable node lookup/serialization for the Remote
 * File System (RFS).
 *
 * RFS downloads are storage-backend-independent:
 *
 * 1. **Primary ID-first targets (`download/<id>`):** `<id>` resolves first
 *    against live node IDs in `space(canvasId)` (serving a canonical Markdown
 *    sidecar assembled from topology + `handle.nodes.read(id)`), and otherwise
 *    against `space(canvasId).artifacts` (`<artifactKey>`).
 * 2. **Legacy prefixed targets:** `artifacts/<key>`, `upload/<name>`, and
 *    `nodes/<safe_label>.md` remain readable via portable `SpaceBlobs` /
 *    `SpaceNodes` ports without touching Disk paths.
 * 3. **Private or unrecognised paths** (`space.json`, `.memory/*`, traversal,
 *    etc.) are rejected uniformly across all backends.
 */

import path from 'node:path';

import {
  encodeBasis,
  RFS_HEADERS,
  type CanvasNodeType,
  type RfsNodeEdges,
  type RfsNodeMeta,
} from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { toFrontmatter } from '../../utils/markdown-frontmatter.js';
import { toSafeFilename } from '../../utils/naming.js';
import { space, type NodeContent } from '../storage/index.js';

import type { CanvasEdge, CanvasNode } from '@huabu/shared/canvas-engine';

const RESERVED_SINGLE_SEGMENTS: ReadonlySet<string> = new Set([
  'space.json',
  'skill.md',
  'memory.md',
]);

export type RfsDownloadTarget =
  | { readonly kind: 'id-or-artifact'; readonly value: string }
  | { readonly kind: 'artifact'; readonly key: string }
  | { readonly kind: 'upload'; readonly name: string }
  | { readonly kind: 'legacy-node'; readonly filename: string }
  | { readonly kind: 'invalid' };

/**
 * Classify a raw `download/*` wildcard parameter without touching the
 * filesystem. Rejects traversal, hidden dot-segments, and private Space files
 * identically on Disk, SQLite, and Postgres.
 */
export function parseRfsDownloadTarget(rawPath: string): RfsDownloadTarget {
  if (
    !rawPath ||
    rawPath.startsWith('/') ||
    rawPath.endsWith('/') ||
    rawPath.includes('\\') ||
    rawPath.includes('\0')
  ) {
    return { kind: 'invalid' };
  }
  const segments = rawPath.split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..')) {
    return { kind: 'invalid' };
  }
  if (segments.length === 1) {
    const [value] = segments;
    if (value.startsWith('.') || RESERVED_SINGLE_SEGMENTS.has(value)) {
      return { kind: 'invalid' };
    }
    return { kind: 'id-or-artifact', value };
  }
  if (segments.length === 2) {
    const [prefix, child] = segments;
    if (child.startsWith('.')) return { kind: 'invalid' };
    if (prefix === 'artifacts') return { kind: 'artifact', key: child };
    if (prefix === 'upload') return { kind: 'upload', name: child };
    if (prefix === 'nodes' && child.endsWith('.md') && child.length > 3) {
      return { kind: 'legacy-node', filename: child };
    }
  }
  return { kind: 'invalid' };
}

/** A node's metadata plus its incident edges (grouped by direction). */
export interface RfsNodeLookup {
  meta: RfsNodeMeta;
  edges: RfsNodeEdges;
  /** Read version of the Space this metadata was taken at. */
  basis: string;
}

/** Portable node download payload: metadata headers + serialized Markdown. */
export interface RfsResolvedNode extends RfsNodeLookup {
  readonly markdown: string;
}

function serializeRfsNodeMarkdown(
  match: CanvasNode,
  sidecar: NodeContent | null,
): string {
  const data = (match.data ?? {}) as Record<string, unknown>;
  const type = (match.type ?? 'note') as CanvasNodeType;
  const label =
    typeof sidecar?.label === 'string' && sidecar.label.length > 0
      ? sidecar.label
      : typeof data.label === 'string' && data.label.length > 0
        ? data.label
        : undefined;
  const src =
    typeof sidecar?.src === 'string' && sidecar.src.length > 0
      ? sidecar.src
      : typeof data.src === 'string' && data.src.length > 0
        ? data.src
        : undefined;

  const fm: Record<string, unknown> = {
    id: match.id,
    type,
  };
  if (label !== undefined) fm.label = label;
  if (src !== undefined) fm.src = src;
  if (typeof sidecar?.summary === 'string' && sidecar.summary.length > 0) {
    fm.summary = sidecar.summary;
  }
  if (Array.isArray(sidecar?.keywords) && sidecar.keywords.length > 0) {
    fm.keywords = sidecar.keywords;
  }
  if (
    sidecar?.properties &&
    typeof sidecar.properties === 'object' &&
    Object.keys(sidecar.properties).length > 0
  ) {
    fm.properties = sidecar.properties;
  }
  if (
    Array.isArray(sidecar?.propertyDisplayKeys) &&
    sidecar.propertyDisplayKeys.length > 0
  ) {
    fm.propertyDisplayKeys = sidecar.propertyDisplayKeys;
  }
  if (sidecar?.dataSchema !== undefined) {
    fm.dataSchema = sidecar.dataSchema;
  }
  const content = typeof sidecar?.content === 'string' ? sidecar.content : '';
  return `${toFrontmatter(fm)}\n${content}`;
}

function buildResolvedNode(
  match: CanvasNode,
  sidecar: NodeContent | null,
  edgeList: readonly CanvasEdge[],
  stamps: { lineage: string; version: number },
): RfsResolvedNode {
  const data = (match.data ?? {}) as {
    label?: string;
    locked?: boolean;
    src?: string;
  };
  const type = (match.type ?? 'note') as CanvasNodeType;
  const meta: RfsNodeMeta = {
    id: match.id,
    type,
  };
  const label =
    typeof sidecar?.label === 'string' && sidecar.label.length > 0
      ? sidecar.label
      : typeof data.label === 'string' && data.label.length > 0
        ? data.label
        : undefined;
  if (label) meta.label = label;
  const src =
    typeof sidecar?.src === 'string'
      ? sidecar.src
      : typeof data.src === 'string'
        ? data.src
        : undefined;
  if (src) meta.src = src;
  if (typeof data.locked === 'boolean') meta.locked = data.locked;
  const content =
    typeof sidecar?.content === 'string' ? sidecar.content : undefined;
  meta.rev = nodeRevisionOf({ ...sidecar, type, content, src });

  const edges: RfsNodeEdges = {
    parents: edgeList.filter((e) => e.target === match.id).map((e) => e.source),
    children: edgeList
      .filter((e) => e.source === match.id)
      .map((e) => e.target),
  };

  return {
    meta,
    edges,
    basis: encodeBasis(stamps.lineage, stamps.version),
    markdown: serializeRfsNodeMarkdown(match, sidecar),
  };
}

/**
 * Resolve a node by its canonical `<nodeId>` through portable `Space` ports.
 */
export async function resolveRfsNodeById(
  canvasId: string,
  nodeId: string,
): Promise<RfsResolvedNode | null> {
  const handle = space(canvasId);
  const stamps = await handle.save.stamps();
  const canvas = await handle.read();
  if (!canvas || !stamps) return null;

  const nodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const match = nodes.find((n) => n.id === nodeId);
  if (!match) return null;

  const sidecar = (await handle.nodes.read(nodeId))?.record ?? null;
  const edgeList = (canvas.state.edges ?? []) as CanvasEdge[];
  return buildResolvedNode(match, sidecar, edgeList, stamps);
}

/**
 * Resolve a legacy `nodes/<filename>.md` download target through portable
 * `Space` ports so historical callers work identically across backends.
 */
export async function resolveRfsNodeByFilename(
  canvasId: string,
  filename: string,
): Promise<RfsResolvedNode | null> {
  const handle = space(canvasId);
  const stamps = await handle.save.stamps();
  const canvas = await handle.read();
  if (!canvas || !stamps) return null;

  const snapshots = await handle.nodes.list();
  const nodes = (canvas.state.nodes ?? []) as CanvasNode[];
  let matchedNode: CanvasNode | undefined;
  for (const node of nodes) {
    const sidecar = snapshots.get(node.id)?.record ?? null;
    const data = (node.data ?? {}) as { label?: unknown };
    const rawLabel =
      typeof sidecar?.label === 'string'
        ? sidecar.label
        : typeof data.label === 'string'
          ? data.label
          : '';
    const primary = `${toSafeFilename(rawLabel, node.id)}.md`;
    const disambiguated = rawLabel
      ? `${toSafeFilename(`${rawLabel} (${node.id})`, node.id)}.md`
      : primary;
    if (filename === primary || filename === disambiguated) {
      matchedNode = node;
      break;
    }
  }
  if (!matchedNode) return null;

  const sidecar = snapshots.get(matchedNode.id)?.record ?? null;
  const edgeList = (canvas.state.edges ?? []) as CanvasEdge[];
  return buildResolvedNode(matchedNode, sidecar, edgeList, stamps);
}

/**
 * Serialise the node metadata into `X-Huabu-*` response headers. The `label`
 * is percent-encoded (Unicode-safe on the wire; the caller URL-decodes it) and
 * the incident edges are a compact JSON string (`{"parents":…,"children":…}`).
 */
export function rfsMetaHeaders(lookup: RfsNodeLookup): Record<string, string> {
  const { meta, edges } = lookup;
  const headers: Record<string, string> = {
    [RFS_HEADERS.nodeId]: meta.id,
    [RFS_HEADERS.nodeType]: meta.type,
    [RFS_HEADERS.edges]: JSON.stringify(edges),
    [RFS_HEADERS.basis]: lookup.basis,
  };
  if (meta.label !== undefined) {
    headers[RFS_HEADERS.nodeLabel] = encodeURIComponent(meta.label);
  }
  if (meta.src !== undefined) headers[RFS_HEADERS.src] = meta.src;
  if (meta.locked !== undefined) {
    headers[RFS_HEADERS.locked] = String(meta.locked);
  }
  return headers;
}

/** Basename helper for filenames pulled from a request path. */
export function baseName(rel: string): string {
  return path.basename(rel);
}
