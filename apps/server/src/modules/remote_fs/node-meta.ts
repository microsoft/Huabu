/**
 * Path mapping + node-metadata lookup for the Remote File System (RFS).
 *
 * Two concerns live here:
 *
 * 1. **Virtual → physical path mapping.** The RFS presents a clean read
 *    layout (`nodes/`, `artifacts/`, `upload/`, `canvas.json`) while on disk
 *    the artifact and upload regions are hidden `.`-dirs (`.artifacts/`,
 *    `.upload/`) alongside the private bookkeeping dirs. {@link toPhysicalRel}
 *    rewrites the two aliased prefixes and {@link resolveReadable} maps a
 *    request path to an absolute path, guarding against traversal (via
 *    `safeResolve`) and refusing the private dirs that must never be projected
 *    to an external agent.
 *
 * 2. **Node metadata.** When a download targets a `nodes/<label>.md` file, we
 *    surface a small allow-list of the node's attributes (id/type/label/src/
 *    locked) plus its incident edges (grouped into parents/children), sourced
 *    from `canvas.json` state (not frontmatter). All of it is serialised into
 *    the `X-Huabu-*` response headers (label percent-encoded, edges as JSON).
 */

import path from 'node:path';

import {
  RFS_HEADERS,
  type RfsNodeEdges,
  type RfsNodeMeta,
} from '@sediment/shared';

import {
  ALWAYS_SKIP,
  safeResolve,
} from '../agent/tools/handlers/fs-sandbox.js';
import { getCanvasStore } from '../storage/index.js';
import { toSafeFilename } from '../storage/naming.js';

import type { CanvasNodeType } from '@sediment/shared';
import type { CanvasNode, CanvasEdge } from '@sediment/shared/canvas-engine';

/** Virtual read-region prefixes and the on-disk `.`-dir they map onto. */
const VIRTUAL_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['artifacts/', '.artifacts/'],
  ['upload/', '.upload/'],
];

/**
 * Rewrite a request path's virtual prefix (`artifacts/`, `upload/`) to its
 * hidden on-disk counterpart. Any other path (e.g. `nodes/…`, `canvas.json`,
 * or an explicit `.artifacts/…`) passes through unchanged.
 */
export function toPhysicalRel(requestRel: string): string {
  const norm = requestRel.replace(/^\/+/, '');
  for (const [virtual, physical] of VIRTUAL_PREFIX) {
    if (norm.startsWith(virtual)) return physical + norm.slice(virtual.length);
  }
  return norm;
}

/** First path segment (used to gate private dirs). */
function firstSegment(rel: string): string {
  const norm = rel.replace(/^\/+/, '');
  const slash = norm.indexOf('/');
  return slash === -1 ? norm : norm.slice(0, slash);
}

/**
 * Resolve a request path to an absolute file path under the canvas root,
 * refusing traversal and the private bookkeeping dirs ({@link ALWAYS_SKIP} —
 * `.history` / `.memory` / `.git` / `node_modules`). Any other explicit path
 * under the canvas is readable. Returns both the absolute path and the
 * physical canvas-relative path (post virtual-prefix mapping).
 *
 * @throws if the path escapes the canvas root or targets a private dir.
 */
export function resolveReadable(
  canvasId: string,
  requestRel: string,
): { absPath: string; physicalRel: string } {
  const physicalRel = toPhysicalRel(requestRel);
  const seg = firstSegment(physicalRel);
  if (ALWAYS_SKIP.has(seg)) {
    throw new Error(`Path "${requestRel}" is not readable.`);
  }
  // `safeResolve` throws on any escape of `<workspace>/<canvasDir>/`.
  const absPath = safeResolve(canvasId, physicalRel);
  return { absPath, physicalRel };
}

/** A node's metadata plus its incident edges (grouped by direction). */
export interface RfsNodeLookup {
  meta: RfsNodeMeta;
  edges: RfsNodeEdges;
}

/** Canvas-relative regex for a node markdown file. */
const NODE_FILE_RE = /^nodes\/[^/]+\.md$/;

/**
 * Look up the node whose markdown file is `physicalRel` (`nodes/<label>.md`),
 * returning its metadata allow-list and incident edges. Returns `null` when
 * the path is not a node file or no node currently claims it — callers then
 * serve the bytes without `X-Huabu-*` headers.
 *
 * Filenames mirror `buildAgentNodeRef`: `nodes/${toSafeFilename(label, id)}.md`.
 */
export function lookupNodeByPath(
  canvasId: string,
  physicalRel: string,
): RfsNodeLookup | null {
  if (!NODE_FILE_RE.test(physicalRel)) return null;

  const canvas = getCanvasStore(canvasId).read();
  if (!canvas) return null;

  const nodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const match = nodes.find((n) => {
    const data = (n.data ?? {}) as { label?: string };
    return `nodes/${toSafeFilename(data.label, n.id)}.md` === physicalRel;
  });
  if (!match) return null;

  const data = (match.data ?? {}) as {
    label?: string;
    locked?: boolean;
    src?: string;
  };
  const meta: RfsNodeMeta = {
    id: match.id,
    type: (match.type ?? 'note') as CanvasNodeType,
  };
  if (data.label) meta.label = data.label;
  if (typeof data.src === 'string') meta.src = data.src;
  if (typeof data.locked === 'boolean') meta.locked = data.locked;

  const edgeList = (canvas.state.edges ?? []) as CanvasEdge[];
  const edges: RfsNodeEdges = {
    parents: edgeList.filter((e) => e.target === match.id).map((e) => e.source),
    children: edgeList
      .filter((e) => e.source === match.id)
      .map((e) => e.target),
  };

  return { meta, edges };
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
