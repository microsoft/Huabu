// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canonical structural projection and revision for a Space record.
 *
 * The projection is intentionally independent of `version`, timestamps, and
 * markdown-sidecar fields. This lets a structure autosave prove that its
 * topology still descends from the server's topology even when node-only
 * commits advanced the global version in the meantime.
 */

import { createHash } from 'node:crypto';

/** Fields persisted in a node markdown sidecar, never in slim topology. */
export const CANVAS_STRUCTURE_NODE_CONTENT_FIELDS = [
  'content',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
] as const;

/** Read-time diagnostics derived from storage, never authored topology. */
export const CANVAS_STRUCTURE_NODE_DERIVED_FIELDS = [
  'contentMissing',
  'artifactMissing',
  'contentDuplicate',
  'duplicateFiles',
] as const;

/** React Flow bookkeeping that must not perturb a structural baseline. */
export const CANVAS_STRUCTURE_NODE_RUNTIME_FIELDS = [
  'selected',
  'dragging',
  'measured',
  'resizing',
  'handles',
  'internals',
] as const;

/** React Flow bookkeeping carried on edges. */
export const CANVAS_STRUCTURE_EDGE_RUNTIME_FIELDS = ['selected'] as const;

const omittedNodeDataFields = new Set<string>([
  ...CANVAS_STRUCTURE_NODE_CONTENT_FIELDS,
  ...CANVAS_STRUCTURE_NODE_DERIVED_FIELDS,
]);
const omittedNodeFields = new Set<string>(CANVAS_STRUCTURE_NODE_RUNTIME_FIELDS);
const omittedEdgeFields = new Set<string>(CANVAS_STRUCTURE_EDGE_RUNTIME_FIELDS);

export interface CanvasStructureSource {
  title: string | null;
  state: {
    nodes: readonly unknown[];
    edges: readonly unknown[];
    [key: string]: unknown;
  };
}

export interface SlimCanvasStructure {
  title: string | null;
  state: {
    nodes: unknown[];
    edges: unknown[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectNodeData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!omittedNodeDataFields.has(key)) projected[key] = field;
  }
  return projected;
}

function projectNode(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (omittedNodeFields.has(key)) continue;
    projected[key] = key === 'data' ? projectNodeData(field) : field;
  }
  return projected;
}

function projectEdge(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!omittedEdgeFields.has(key)) projected[key] = field;
  }
  return projected;
}

/**
 * Project a hydrated or persisted Space record to its canonical slim
 * structure. Array order remains significant because it is the node/edge
 * render order; unrelated state keys and record metadata are excluded.
 */
export function projectSlimCanvasStructure(
  source: CanvasStructureSource,
): SlimCanvasStructure {
  return {
    title: source.title,
    state: {
      nodes: source.state.nodes.map(projectNode),
      edges: source.state.edges.map(projectEdge),
    },
  };
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

/**
 * Convert to JSON semantics while recursively sorting object keys. Arrays
 * retain order. Unsupported object properties are omitted just as they are by
 * JSON.stringify; unsupported array elements become `null`.
 */
function canonicalizeJson(
  value: unknown,
  ancestors: Set<object>,
): CanonicalJson | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Cannot compute structureRevision for bigint data');
  }
  if (typeof value !== 'object') return undefined;
  if (ancestors.has(value)) {
    throw new TypeError('Cannot compute structureRevision for cyclic data');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeJson(item, ancestors) ?? null);
    }

    const record = value as Record<string, unknown>;
    const canonical: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(record).sort()) {
      const field = canonicalizeJson(record[key], ancestors);
      if (field !== undefined) canonical[key] = field;
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON bytes hashed by {@link structureRevisionOf}. */
export function canonicalSlimCanvasStructureJson(
  source: CanvasStructureSource,
): string {
  const canonical = canonicalizeJson(
    projectSlimCanvasStructure(source),
    new Set(),
  );
  if (canonical === undefined) {
    throw new TypeError('Canvas structure is not JSON serializable');
  }
  return JSON.stringify(canonical);
}

/**
 * Opaque SHA-256 revision of title + slim nodes + edges.
 *
 * The algorithm prefix permits a future canonicalization upgrade without
 * making clients interpret the token; consumers compare it as an opaque
 * string only.
 */
export function structureRevisionOf(source: CanvasStructureSource): string {
  const digest = createHash('sha256')
    .update(canonicalSlimCanvasStructureJson(source), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}
