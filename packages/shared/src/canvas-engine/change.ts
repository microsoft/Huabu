// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas change records — a human-readable summary of a mutation plus
 * the **inverse deltas** needed to undo it.
 *
 * Change records are built from a batch's {@link Delta} list and undone by
 * `applyDeltas(state, record.revertDeltas)`. This avoids per-command inverse
 * logic. An update's revert row holds the previous value of exactly the
 * fields the edit changed and is merged into the node as it is then; a
 * deletion's revert row holds the whole deleted node, because nothing else
 * does once its record is gone. Records stored before rows became partial
 * hold whole nodes and are read by the same code. Old logs have no exact
 * sibling order. OrderedDelta inversion below is whole-batch only;
 * per-entity Review extraction/coalescing remains entity-only.
 *
 * Pure functions only — host-agnostic, shared by server (producer) and
 * web (renderer / reverter).
 */

import {
  invertDelta,
  isWholeNode,
  mergeNodeFields,
  nodeFieldChanges,
  replacedNodeType,
  type Delta,
  type NodeFields,
  type OrderedDelta,
} from './delta.js';
import { createId } from '../utils/id.js';

import type { CanvasNode, CanvasEdge } from './interfaces.js';

/** Coarse classification of a change, for icon / wording on the card. */
export type CanvasChangeKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'connect'
  | 'disconnect'
  | 'edge-update';

export interface CanvasChangeRecord {
  /** Stable id for this change row (dedupe / remove on accept/revert). */
  id: string;
  kind: CanvasChangeKind;
  /** Human-readable description, e.g. `Created: Market analysis`. */
  label: string;
  nodeId?: string;
  nodeType?: string;
  nodeLabel?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  sourceNodeLabel?: string;
  targetNodeLabel?: string;
  /**
   * Inverse deltas, ready to apply via `applyDeltas` to undo this change.
   * Always present and structurally complete (deltas are self-inverting).
   */
  revertDeltas: Delta[];
  /**
   * UPDATE changes only. Fingerprint of the node's post-apply `data` over
   * {@link fingerprintKeys}. Staleness: before reverting, the client
   * recomputes the current node's fingerprint over the SAME keys; a
   * mismatch means a field THIS edit changed was modified again afterwards
   * (human / another agent), so the revert is blocked to avoid clobbering
   * it. CREATE / DELETE / edge changes carry no fingerprint — their
   * revertability is purely existence-based (see the change card's
   * staleness check), so they omit this.
   */
  appliedFingerprint?: string;
  /**
   * UPDATE changes only. The `data` keys this edit actually changed
   * (raw prev→next diff). Staleness compares only these, so unrelated
   * later mutations (preprocessing regenerating `label` / `summary`, a
   * re-measure, …) never falsely block revert. Absent for CREATE /
   * DELETE / edge changes.
   */
  fingerprintKeys?: string[];
}

function nodeData(node: NodeFields | undefined): Record<string, unknown> {
  return node?.data ?? {};
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function labelOf(node: NodeFields | undefined, known?: string): string {
  if (!node) return 'unknown';
  const label = nodeData(node)['label'];
  return truncate((typeof label === 'string' && label) || known || node.id, 24);
}

/**
 * The `data` keys whose value actually changed between two payloads.
 *
 * This is the whole story for UPDATE staleness: the delta's `prev`/`next`
 * come from `diffCanvasState(prestate, engine(prestate))`, so a key
 * appears here IFF the engine (i.e. the agent's command) changed it.
 * Fields the agent did not touch (a later preprocessing `summary` /
 * regenerated `label`, a re-measured height, …) are simply absent — no
 * allow/deny classification of "content vs system" is needed: if the
 * agent didn't change it, changing it afterwards can never conflict with
 * reverting the agent's edit.
 */
function changedKeys(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out.push(k);
  }
  return out;
}

/**
 * What a CREATE review record fingerprints. A CREATE has no `prev` to diff,
 * so it can't derive its changed keys the way an UPDATE does — instead it
 * fingerprints what a revert (deleting the node) would actually destroy: the
 * body and the custom properties. Cosmetic (`style`) and auto-derived
 * (`label` / `summary` / `keywords`, stamped by preprocessing AFTER
 * creation) fields are deliberately excluded so they never flip a fresh
 * create to "stale"; a genuine edit to the body or a property still does.
 *
 * Not the content revision: see {@link CONTENT_REVISION_KEYS}.
 */
const PRIMARY_CONTENT_KEYS = [
  'content',
  'src',
  'dataSchema',
  'properties',
  'propertyDisplayKeys',
];

/**
 * The fields a node's content revision covers: the body and the source
 * pointer, and nothing else. Custom properties (`properties`,
 * `propertyDisplayKeys`) are independent small items written per key without
 * a revision, like colour or position; title, summary and keywords are
 * derived or renamed separately.
 */
export const CONTENT_REVISION_KEYS = ['content', 'src', 'dataSchema'] as const;

/** Body keys present on a node's `data`, for CREATE fingerprinting. */
function primaryKeysOf(data: Record<string, unknown>): string[] {
  return PRIMARY_CONTENT_KEYS.filter(
    (k) => k in data || !['content', 'src', 'dataSchema'].includes(k),
  );
}

function canonicalizeNestedObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeNestedObject);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalizeNestedObject(v)]),
  );
}

/** djb2 hash over a canonical (sorted-key) projection of `data`. */
function hashDataFields(
  data: Record<string, unknown>,
  keys: readonly string[],
): string {
  const picked: Record<string, unknown> = {};
  for (const k of [...keys].sort()) {
    if (k in data) {
      const value = data[k];
      picked[k] =
        k === 'properties' && value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : k === 'dataSchema'
            ? canonicalizeNestedObject(value)
            : value;
    }
  }
  const json = JSON.stringify(picked);
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint a node's `data` over an explicit key set. Deterministic and
 * host-agnostic: the producer (server, stamping `appliedFingerprint`) and
 * the consumer (web, recomputing to compare) MUST run the same algorithm
 * over the same {@link CanvasChangeRecord.fingerprintKeys}.
 */
export function fingerprintNodeFields(
  node: NodeFields | undefined,
  keys: readonly string[],
): string {
  return hashDataFields(nodeData(node), keys);
}

/**
 * A node's **revision token**: a deterministic djb2 hash over its body and
 * source pointer ({@link CONTENT_REVISION_KEYS}). Surfaced to
 * agents as an `ETag` on RFS downloads and as `rev` in per-turn refs /
 * neighbourhood, and (later) checked on the executor's content writes
 * (compare-and-swap).
 *
 * Stateless and host-agnostic: recomputed from the node on demand, yielding
 * the identical string on server (producer) and web / agent (consumer).
 * Cosmetic (`style`), geometry, auto-derived (`label` / `summary` /
 * `keywords`) fields and custom properties (`properties`,
 * `propertyDisplayKeys`) are excluded, so a re-measure, a preprocessing
 * regen or a tag added by somebody else never moves the revision and forces
 * a needless re-read or refuses a body save.
 *
 * IMPORTANT: `data.content` must be **hydrated** (the canonical on-disk
 * `nodes/<label>.md` body). Persisted topology deliberately strips `content` from
 * node data (`stripNodesForCanvas`), so hashing a node straight off
 * `getCanvasStore().read()` state would see an empty body and yield a constant
 * rev. Callers hydrate via `store.readNode(id).content` first (the RFS lookup,
 * the neighbourhood builder, and the executor's `hydrateNodes` all do), so the
 * three sites agree.
 */
export function nodeRevision(node: CanvasNode | undefined): string {
  return nodeRevisionOf({ ...nodeData(node), type: node?.type });
}

/**
 * {@link nodeRevision} for callers that hold the authored fields loosely
 * rather than a whole {@link CanvasNode} — e.g. a ref builder that already
 * extracted authored fields, or the RFS lookup that hydrated the on-disk
 * body. Only defined fields are hashed, so the result matches
 * `nodeRevision(node)` for the equivalent node. Single source of truth for
 * "which fields define a node's revision".
 */
export function nodeRevisionOf(fields: {
  type?: string;
  content?: string;
  src?: string;
  dataSchema?: unknown;
}): string {
  const data: Record<string, unknown> = {};
  const hasBody =
    fields.type === undefined ||
    ['note', 'text', 'data', 'web', 'pdf', 'office', 'question'].includes(
      fields.type,
    );
  if (hasBody && typeof fields.content === 'string')
    data.content = fields.content;
  if (typeof fields.src === 'string') data.src = fields.src;
  if (
    (fields.type === undefined || fields.type === 'data') &&
    fields.dataSchema !== undefined &&
    fields.dataSchema !== null
  ) {
    data.dataSchema = fields.dataSchema;
  }
  return hashDataFields(data, CONTENT_REVISION_KEYS);
}

/**
 * Invert a delta batch. To undo a sequence applied in order, invert each
 * delta and apply them in reverse order. Ordered batches must be applied
 * atomically; orderVersion is retained, not rolled back as a live writer version.
 */
export function invertDeltas(deltas: readonly Delta[]): Delta[];
export function invertDeltas(deltas: readonly OrderedDelta[]): OrderedDelta[];
export function invertDeltas(deltas: readonly OrderedDelta[]): OrderedDelta[] {
  const out: OrderedDelta[] = [];
  for (let i = deltas.length - 1; i >= 0; i--) {
    out.push(invertDelta(deltas[i]));
  }
  return out;
}

/** Check every member of an atomic review row against the same snapshot. */
export function isChangeStale(
  record: CanvasChangeRecord,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): boolean {
  return record.revertDeltas.some((delta, index) => {
    switch (delta.type) {
      case 'INSERT_NODE':
        return nodes.some((node) => node.id === delta.node.id);
      case 'DELETE_NODE':
      case 'REPLACE_NODE': {
        const applied = delta.type === 'DELETE_NODE' ? delta.node : delta.prev;
        const current = nodes.find((node) => node.id === applied.id);
        if (!current) return true;
        const keys =
          index === 0
            ? (record.fingerprintKeys ?? [])
            : delta.type === 'DELETE_NODE'
              ? primaryKeysOf(nodeData(applied))
              : changedKeys(nodeData(delta.next), nodeData(applied));
        const expected =
          index === 0
            ? record.appliedFingerprint
            : fingerprintNodeFields(applied, keys);
        return (
          keys.length > 0 && fingerprintNodeFields(current, keys) !== expected
        );
      }
      case 'DELETE_EDGE':
        return !edges.some((edge) => edge.id === delta.edge.id);
      case 'INSERT_EDGE':
        return edges.some((edge) => edge.id === delta.edge.id);
      case 'REPLACE_EDGE':
        return !edges.some((edge) => edge.id === delta.prev.id);
      default:
        return false;
    }
  });
}

/** The Note a PDF row names; a partial row has no `type` of its own. */
function noteLinkOf(
  fields: NodeFields | undefined,
  nodeType: string | undefined,
): string | undefined {
  if (!fields || (fields.type ?? nodeType) !== 'pdf') return undefined;
  const id = nodeData(fields)['noteNodeId'];
  return typeof id === 'string' ? id : undefined;
}

function groupPdfNoteChanges(
  records: CanvasChangeRecord[],
): CanvasChangeRecord[] {
  const byNodeId = new Map(records.map((record) => [record.nodeId, record]));
  const grouped = new Set<CanvasChangeRecord>();
  for (const record of records) {
    const delta = record.revertDeltas[0];
    if (!delta) continue;
    const before =
      delta.type === 'REPLACE_NODE'
        ? delta.next
        : delta.type === 'INSERT_NODE'
          ? delta.node
          : undefined;
    const after =
      delta.type === 'REPLACE_NODE'
        ? delta.prev
        : delta.type === 'DELETE_NODE'
          ? delta.node
          : undefined;
    const beforeId = noteLinkOf(before, record.nodeType);
    const afterId = noteLinkOf(after, record.nodeType);
    if (beforeId === afterId) continue;
    for (const id of new Set([beforeId, afterId])) {
      const dependent = id && byNodeId.get(id);
      if (!dependent || dependent === record || grouped.has(dependent))
        continue;
      record.revertDeltas.push(...dependent.revertDeltas);
      grouped.add(dependent);
    }
  }
  return records.filter((record) => !grouped.has(record));
}

/**
 * Build change records from a batch's deltas. Ownership changes group the
 * PDF and Note inverses; other rows represent one node or edge.
 *
 * @param deltas The batch deltas (server diff prestate → poststate).
 * @param opts.nodeLabelById Optional label lookup for edge endpoints
 *   whose nodes are not themselves part of this batch, and for updated nodes
 *   whose row does not carry a label (it did not change).
 * @param opts.nodeTypeById Type lookup for updated nodes, whose row carries
 *   a type only when the type changed.
 */
export function extractCanvasChanges(
  deltas: readonly Delta[],
  opts?: {
    nodeLabelById?: ReadonlyMap<string, string>;
    nodeTypeById?: ReadonlyMap<string, string>;
  },
): CanvasChangeRecord[] {
  // Harvest node labels from the batch's own node deltas, then fall back
  // to the caller-supplied map for edge endpoints outside the batch.
  const labelById = new Map<string, string>(opts?.nodeLabelById ?? []);
  for (const d of deltas) {
    const node =
      d.type === 'INSERT_NODE' || d.type === 'DELETE_NODE'
        ? d.node
        : d.type === 'REPLACE_NODE'
          ? d.next
          : undefined;
    if (node) {
      const lbl = nodeData(node)['label'];
      if (typeof lbl === 'string' && lbl) labelById.set(node.id, lbl);
    }
  }

  const endpointLabel = (id: string): string | undefined => labelById.get(id);

  // Display label for an edge endpoint, mirroring node labels: prefer the
  // harvested/looked-up label, fall back to the raw id, and truncate the
  // same way so the baked-in `label` reads consistently with node rows.
  const endpointDisplay = (id: string): string =>
    truncate(endpointLabel(id) || id, 24);

  const records: CanvasChangeRecord[] = [];

  for (const d of deltas) {
    switch (d.type) {
      case 'INSERT_NODE': {
        // CREATE: revertable while the node exists AND its authored body
        // (content / src) is unchanged — editing the created note's body
        // must block the delete-revert so it can't wipe the user's work.
        // label / summary / style are excluded (auto or cosmetic).
        const keys = primaryKeysOf(nodeData(d.node));
        records.push({
          id: createId('change'),
          kind: 'create',
          label: `Created: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
          revertDeltas: [invertDelta(d)],
          fingerprintKeys: keys,
          appliedFingerprint: fingerprintNodeFields(d.node, keys),
        });
        break;
      }

      case 'REPLACE_NODE': {
        // UPDATE: scope staleness to exactly the fields this edit changed
        // (raw prev→next diff). Fields the agent didn't touch are absent,
        // so later system rewrites of them (preprocessing regenerating
        // `label` / `summary`, a re-measure, …) can never flip it.
        //
        // The revert row holds only those fields, so reverting puts back
        // what this edit changed and leaves later edits of other fields
        // alone. A whole-node row (old format) is reduced first.
        const changes = nodeFieldChanges(d.prev, d.next);
        if (!changes) break;
        const keys = changedKeys(
          nodeData(changes.prev),
          nodeData(changes.next),
        );
        const known = labelById.get(d.next.id);
        const nodeType =
          replacedNodeType(d) ??
          opts?.nodeTypeById?.get(d.next.id) ??
          // Only a PDF links a Note.
          (keys.includes('noteNodeId') ? 'pdf' : 'note');
        records.push({
          id: createId('change'),
          kind: 'update',
          label: `Updated: ${labelOf(changes.next, known)}`,
          nodeId: d.next.id,
          nodeType,
          nodeLabel: labelOf(changes.next, known),
          revertDeltas: [
            {
              type: 'REPLACE_NODE',
              prev: changes.next,
              next: changes.prev,
              // The type the node has once the revert is applied.
              nodeType: changes.prev.type ?? nodeType,
              ...(d.hidden ? { hidden: true as const } : {}),
            },
          ],
          fingerprintKeys: keys,
          appliedFingerprint: fingerprintNodeFields(changes.next, keys),
        });
        break;
      }

      case 'DELETE_NODE': {
        // DELETE: existence-based — the revert (INSERT_NODE) is
        // meaningful iff the node is still absent (blocked once it's
        // back).
        if (!isWholeNode(d.node)) break;
        records.push({
          id: createId('change'),
          kind: 'delete',
          label: `Deleted: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
          // The whole node: after the deletion this row is the only place
          // its content is kept. A row already reduced to an id cannot be
          // reverted and yields no record.
          revertDeltas: [invertDelta(d)],
        });
        break;
      }

      case 'INSERT_EDGE':
        records.push({
          id: createId('change'),
          kind: 'connect',
          label: `Connected: ${endpointDisplay(d.edge.source)} → ${endpointDisplay(d.edge.target)}`,
          sourceNodeId: d.edge.source,
          targetNodeId: d.edge.target,
          sourceNodeLabel: endpointLabel(d.edge.source),
          targetNodeLabel: endpointLabel(d.edge.target),
          revertDeltas: [invertDelta(d)],
        });
        break;

      case 'DELETE_EDGE':
        records.push({
          id: createId('change'),
          kind: 'disconnect',
          label: `Disconnected: ${endpointDisplay(d.edge.source)} → ${endpointDisplay(d.edge.target)}`,
          sourceNodeId: d.edge.source,
          targetNodeId: d.edge.target,
          sourceNodeLabel: endpointLabel(d.edge.source),
          targetNodeLabel: endpointLabel(d.edge.target),
          revertDeltas: [invertDelta(d)],
        });
        break;

      case 'REPLACE_EDGE':
        records.push({
          id: createId('change'),
          kind: 'edge-update',
          label: `Edge updated: ${endpointDisplay(d.next.source)} → ${endpointDisplay(d.next.target)}`,
          sourceNodeId: d.next.source,
          targetNodeId: d.next.target,
          sourceNodeLabel: endpointLabel(d.next.source),
          targetNodeLabel: endpointLabel(d.next.target),
          revertDeltas: [invertDelta(d)],
        });
        break;
    }
  }

  return groupPdfNoteChanges(records);
}

// ── Coalescing (net effect per entity) ─────────────────────────────────────
//
// Multiple agent batches editing the SAME node/edge produce one change
// record each, so the card would show many "Updated: X" rows. Coalescing
// folds every record targeting the same entity into a single NET change:
// the revert restores the state from BEFORE the first edit, and a
// create+delete (or an edit that nets to nothing) drops out entirely.

/** The forward change of one node that a record's inverse row implies. */
type NodeForward =
  | { op: 'insert'; node: CanvasNode }
  | { op: 'delete'; node: NodeFields }
  | {
      op: 'replace';
      prev: NodeFields;
      next: NodeFields;
      /** The node's type before the change, when the row states it. */
      nodeType?: string;
      hidden?: true;
    };

type Forward =
  | { key: string; kind: 'node'; change: NodeForward }
  | {
      key: string;
      kind: 'edge';
      before: CanvasEdge | null;
      after: CanvasEdge | null;
    };

function forwardOf(rec: CanvasChangeRecord): Forward | null {
  const rd = rec.revertDeltas[0];
  if (!rd) return null;
  switch (rd.type) {
    case 'DELETE_NODE': // forward was INSERT: absent → node
      return {
        key: `node:${rd.node.id}`,
        kind: 'node',
        change: { op: 'insert', node: rd.node as CanvasNode },
      };
    case 'INSERT_NODE': // forward was DELETE: node → absent
      return {
        key: `node:${rd.node.id}`,
        kind: 'node',
        change: { op: 'delete', node: rd.node },
      };
    case 'REPLACE_NODE': // forward REPLACE: before=rd.next, after=rd.prev
      return {
        key: `node:${rd.prev.id}`,
        kind: 'node',
        change: {
          op: 'replace',
          prev: rd.next,
          next: rd.prev,
          ...(rd.nodeType !== undefined ? { nodeType: rd.nodeType } : {}),
          ...(rd.hidden ? { hidden: true as const } : {}),
        },
      };
    case 'DELETE_EDGE':
      return {
        key: `edge:${rd.edge.id}`,
        kind: 'edge',
        before: null,
        after: rd.edge,
      };
    case 'INSERT_EDGE':
      return {
        key: `edge:${rd.edge.id}`,
        kind: 'edge',
        before: rd.edge,
        after: null,
      };
    case 'REPLACE_EDGE':
      return {
        key: `edge:${rd.prev.id}`,
        kind: 'edge',
        before: rd.next,
        after: rd.prev,
      };
    default:
      return null;
  }
}

/**
 * One side of two replaces of a node in a row: per field, the value the
 * `pick`ed change gives it when that change names the field, the other
 * change's value otherwise.
 */
function pickFields(
  primary: { prev: NodeFields; next: NodeFields },
  primarySide: 'prev' | 'next',
  other: { prev: NodeFields; next: NodeFields },
): NodeFields {
  const out: Record<string, unknown> = { id: primary.next.id };
  const names = (change: { prev: NodeFields; next: NodeFields }): Set<string> =>
    new Set([...Object.keys(change.prev), ...Object.keys(change.next)]);
  const dataNames = (change: {
    prev: NodeFields;
    next: NodeFields;
  }): Set<string> =>
    new Set([
      ...Object.keys(change.prev.data ?? {}),
      ...Object.keys(change.next.data ?? {}),
    ]);
  const primaryNames = names(primary);
  for (const key of new Set([...primaryNames, ...names(other)])) {
    if (key === 'id' || key === 'data') continue;
    const from = primaryNames.has(key) ? primary : other;
    const value = (from[primarySide] as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  const primaryData = dataNames(primary);
  const data: Record<string, unknown> = {};
  for (const key of new Set([...primaryData, ...dataNames(other)])) {
    const from = primaryData.has(key) ? primary : other;
    const value = from[primarySide].data?.[key];
    if (value !== undefined) data[key] = value;
  }
  out['data'] = data;
  return out as NodeFields;
}

/**
 * The net of `first` followed by `second` on one node; `null` when together
 * they change nothing (created then deleted, edited and edited back).
 */
function composeNodeChanges(
  first: NodeForward | null,
  second: NodeForward,
): NodeForward | null {
  if (!first) return second;
  if (first.op === 'insert') {
    if (second.op === 'delete') return null;
    if (second.op === 'replace') {
      return {
        op: 'insert',
        node: mergeNodeFields(first.node, second.prev, second.next),
      };
    }
    return second;
  }
  if (first.op === 'replace') {
    if (second.op === 'replace') {
      // Per field: the value before the first edit that touched it, and the
      // value after the last one that did.
      const changes = nodeFieldChanges(
        pickFields(first, 'prev', second),
        pickFields(second, 'next', first),
      );
      return changes
        ? {
            op: 'replace',
            ...changes,
            ...(first.nodeType !== undefined
              ? { nodeType: first.nodeType }
              : {}),
            ...(first.hidden && second.hidden ? { hidden: true as const } : {}),
          }
        : null;
    }
    if (second.op === 'delete') {
      // The node as it was before the first edit is what a revert restores.
      return {
        op: 'delete',
        node: isWholeNode(second.node)
          ? mergeNodeFields(second.node, first.next, first.prev)
          : second.node,
      };
    }
    return second;
  }
  // Deleted, then created again under the same id.
  if (second.op === 'insert' && isWholeNode(first.node)) {
    const changes = nodeFieldChanges(first.node, second.node);
    return changes ? { op: 'replace', ...changes } : null;
  }
  return second;
}

function netNodeDelta(change: NodeForward | null): Delta | null {
  if (!change) return null;
  if (change.op === 'insert') return { type: 'INSERT_NODE', node: change.node };
  if (change.op === 'delete') return { type: 'DELETE_NODE', node: change.node };
  return {
    type: 'REPLACE_NODE',
    prev: change.prev,
    next: change.next,
    ...(change.nodeType !== undefined ? { nodeType: change.nodeType } : {}),
    ...(change.hidden ? { hidden: true as const } : {}),
  };
}

function netEdgeDelta(
  before: CanvasEdge | null,
  after: CanvasEdge | null,
): Delta | null {
  if (!before && !after) return null;
  if (!before && after) return { type: 'INSERT_EDGE', edge: after };
  if (before && !after) return { type: 'DELETE_EDGE', edge: before };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    type: 'REPLACE_EDGE',
    prev: before as CanvasEdge,
    next: after as CanvasEdge,
  };
}

/**
 * Fold a list of change records so each canvas entity (node / edge) is
 * represented by at most one NET record. Order follows first appearance;
 * the merged record keeps the FIRST constituent's `id` (stable across
 * re-coalescing) and drops entities whose net effect is nothing.
 */
export function coalesceChanges(
  records: readonly CanvasChangeRecord[],
): CanvasChangeRecord[] {
  const groups = new Map<string, CanvasChangeRecord[]>();
  const order: string[] = [];
  const labelById = new Map<string, string>();
  const typeById = new Map<string, string>();
  // Flatten grouped rows before netting each entity, then rebuild ownership groups.
  const individual = records.flatMap((record) =>
    record.revertDeltas.map((delta, index) => ({
      ...record,
      id:
        index === 0
          ? record.id
          : `${record.id}:${forwardOf({ ...record, revertDeltas: [delta] })?.key}`,
      revertDeltas: [delta],
    })),
  );
  for (const r of individual) {
    if (r.nodeId && r.nodeLabel) labelById.set(r.nodeId, r.nodeLabel);
    const own = r.revertDeltas[0];
    // A grouped row's dependents carry the group's type, not their own.
    if (
      r.nodeId &&
      r.nodeType &&
      own?.type === 'REPLACE_NODE' &&
      own.prev.id === r.nodeId
    )
      typeById.set(r.nodeId, r.nodeType);
    if (r.sourceNodeId && r.sourceNodeLabel)
      labelById.set(r.sourceNodeId, r.sourceNodeLabel);
    if (r.targetNodeId && r.targetNodeLabel)
      labelById.set(r.targetNodeId, r.targetNodeLabel);
    const f = forwardOf(r);
    if (!f) continue;
    let group = groups.get(f.key);
    if (!group) {
      group = [];
      groups.set(f.key, group);
      order.push(f.key);
    }
    group.push(r);
  }

  const netDeltas: Delta[] = [];
  const idByKey = new Map<string, string>();
  for (const key of order) {
    const grp = groups.get(key);
    if (!grp || grp.length === 0) continue;
    const forwards = grp.flatMap((record) => {
      const forward = forwardOf(record);
      return forward ? [forward] : [];
    });
    const first = forwards[0];
    const last = forwards[forwards.length - 1];
    if (!first || !last) continue;
    const net =
      first.kind === 'node'
        ? netNodeDelta(
            forwards.reduce<NodeForward | null>(
              (acc, forward) =>
                forward.kind === 'node'
                  ? composeNodeChanges(acc, forward.change)
                  : acc,
              null,
            ),
          )
        : netEdgeDelta(first.before, last.kind === 'edge' ? last.after : null);
    if (net) {
      netDeltas.push(net);
      idByKey.set(key, grp[0].id);
    }
  }

  // Rebuild records from the net deltas, then restore the stable id.
  return extractCanvasChanges(netDeltas, {
    nodeLabelById: labelById,
    nodeTypeById: typeById,
  }).map((rec) => {
    const f = forwardOf(rec);
    const id = f ? idByKey.get(f.key) : undefined;
    return id ? { ...rec, id } : rec;
  });
}
