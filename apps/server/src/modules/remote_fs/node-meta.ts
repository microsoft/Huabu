// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Path mapping + node-metadata lookup for the Remote File System (RFS).
 *
 * Two concerns live here:
 *
 * 1. **Virtual → physical path mapping.** The RFS presents a clean read
 *    layout (`nodes/`, `artifacts/`, `upload/`) while on disk
 *    the artifact and upload regions are hidden `.`-dirs (`.artifacts/`,
 *    `.upload/`) alongside the private bookkeeping dirs. {@link toPhysicalRel}
 *    rewrites the two aliased prefixes and {@link resolveReadable} maps a
 *    request path to an absolute path, guarding against traversal (via
 *    `safeResolve`) and refusing the private dirs that must never be projected
 *    to an external agent.
 *
 * 2. **Node metadata.** When a download targets a `nodes/<label>.md` file, we
 *    surface a small allow-list of the node's attributes (id/type/label/src/
 *    locked) plus its incident edges (grouped into parents/children). The
 *    file → node mapping and `label` / `rev` come from the on-disk sidecar
 *    (the canonical source); type / src / locked / edges come from
 *    structural state. All of it is serialised into the `X-Huabu-*`
 *    response headers (label percent-encoded, edges as JSON).
 */

import path from 'node:path';

import {
  RFS_HEADERS,
  type RfsNodeEdges,
  type RfsNodeMeta,
} from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  ALWAYS_SKIP,
  safeResolve,
  toPhysicalRel,
} from '../agent/tools/handlers/fs-sandbox.js';
import { space } from '../storage/index.js';

import type { CanvasNodeType } from '@huabu/shared';
import type { CanvasNode, CanvasEdge } from '@huabu/shared/canvas-engine';

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
 * The file → node mapping is the Disk tree's sidecar-to-record mapping, NOT a
 * re-derived `toSafeFilename(label)` — topology never carries `data.label`, so
 * the derived path would collapse to `nodes/<id>.md` and never match a real
 * label-named file. It stays Disk-shaped on purpose (§6.4.3, disposition B):
 * inverting a filename is only meaningful where the file is really there, so
 * until a second backend exists RFS's file plane is Disk's. The record and the
 * sidecar themselves come from the portable ports.
 */
export async function lookupNodeByPath(
  canvasId: string,
  physicalRel: string,
): Promise<RfsNodeLookup | null> {
  if (!NODE_FILE_RE.test(physicalRel)) return null;

  const handle = space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return null;

  const nodeId = handle.diskTree?.nodeIdForPath(physicalRel) ?? null;
  if (!nodeId) return null;

  const nodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const match = nodes.find((n) => n.id === nodeId);
  if (!match) return null;

  const sidecar = (await handle.nodes.read(nodeId))?.record ?? null;
  const data = (match.data ?? {}) as {
    locked?: boolean;
    src?: string;
  };
  const meta: RfsNodeMeta = {
    id: match.id,
    type: (match.type ?? 'note') as CanvasNodeType,
  };
  // Label lives in the sidecar frontmatter (topology never carries it).
  if (sidecar?.label) meta.label = sidecar.label;
  const src =
    typeof sidecar?.src === 'string'
      ? sidecar.src
      : typeof data.src === 'string'
        ? data.src
        : undefined;
  if (src) meta.src = src;
  if (typeof data.locked === 'boolean') meta.locked = data.locked;
  // Revision hashes the node's *canonical* authored content — the on-disk
  // body (topology strips `data.content`). Media nodes carry only a
  // `src`, so a missing body is fine.
  const content =
    typeof sidecar?.content === 'string' ? sidecar.content : undefined;
  meta.rev = nodeRevisionOf({ content, src });

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
