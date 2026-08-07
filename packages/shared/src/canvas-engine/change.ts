// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas change records — a human-readable summary of a mutation plus
 * the **inverse deltas** needed to undo it.
 *
 * Built purely from a batch's {@link Delta} list (the same wire diff the
 * server broadcasts), so revert is a generic, complete operation:
 * `applyDeltas(state, record.revertDeltas)`. This avoids per-command
 * inverse logic — deltas carry the full prior/next node objects, so the
 * inverse is exact (including restored content) for every command type.
 *
 * Pure functions only — host-agnostic, shared by server (producer) and
 * web (renderer / reverter).
 */

import { invertDelta, type Delta } from './delta.js';
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

function nodeData(node: CanvasNode | undefined): Record<string, unknown> {
  return (node?.data ?? {}) as Record<string, unknown>;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function labelOf(node: CanvasNode | undefined): string {
  if (!node) return 'unknown';
  const label = nodeData(node)['label'];
  return truncate((typeof label === 'string' && label) || node.id, 24);
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
 * The authored *body* payload keys. A CREATE has no `prev` to diff, so it
 * can't derive its changed keys the way an UPDATE does — instead it
 * fingerprints only the body here, which is what a revert (deleting the
 * node) would actually destroy. Cosmetic (`style`) and auto-derived
 * (`label` / `summary` / `keywords`, stamped by preprocessing AFTER
 * creation) fields are deliberately excluded so they never flip a fresh
 * create to "stale"; a genuine edit to the body still does.
 */
const PRIMARY_CONTENT_KEYS = ['content', 'src'];

/** Body keys present on a node's `data`, for CREATE fingerprinting. */
function primaryKeysOf(data: Record<string, unknown>): string[] {
  return PRIMARY_CONTENT_KEYS.filter((k) => k in data);
}

/** djb2 hash over a canonical (sorted-key) projection of `data`. */
function hashDataFields(
  data: Record<string, unknown>,
  keys: readonly string[],
): string {
  const picked: Record<string, unknown> = {};
  for (const k of [...keys].sort()) {
    if (k in data) picked[k] = data[k];
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
  node: CanvasNode | undefined,
  keys: readonly string[],
): string {
  return hashDataFields(nodeData(node), keys);
}

/**
 * A node's **revision token**: a deterministic djb2 hash over its authored
 * content ({@link PRIMARY_CONTENT_KEYS} — `content` / `src`). Surfaced to
 * agents as an `ETag` on RFS downloads and as `rev` in per-turn refs /
 * neighbourhood, and (later) checked on the executor's content writes
 * (compare-and-swap).
 *
 * Stateless and host-agnostic: recomputed from the node on demand, yielding
 * the identical string on server (producer) and web / agent (consumer).
 * Cosmetic (`style`), geometry, and auto-derived (`label` / `summary` /
 * `keywords`) fields are excluded — the same discipline as CREATE
 * fingerprinting — so a re-measure or a preprocessing regen never moves the
 * revision and forces a needless re-read.
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
  return hashDataFields(nodeData(node), PRIMARY_CONTENT_KEYS);
}

/**
 * {@link nodeRevision} for callers that hold the authored fields loosely
 * rather than a whole {@link CanvasNode} — e.g. a ref builder that already
 * extracted `content` / `src`, or the RFS lookup that hydrated the on-disk
 * body. Only defined fields are hashed, so the result matches
 * `nodeRevision(node)` for the equivalent node. Single source of truth for
 * "which fields define a node's revision".
 */
export function nodeRevisionOf(fields: {
  content?: string;
  src?: string;
}): string {
  const data: Record<string, unknown> = {};
  if (typeof fields.content === 'string') data.content = fields.content;
  if (typeof fields.src === 'string') data.src = fields.src;
  return hashDataFields(data, PRIMARY_CONTENT_KEYS);
}

/**
 * Invert a delta batch. To undo a sequence applied in order, invert each
 * delta and apply them in reverse order.
 */
export function invertDeltas(deltas: readonly Delta[]): Delta[] {
  const out: Delta[] = [];
  for (let i = deltas.length - 1; i >= 0; i--) {
    out.push(invertDelta(deltas[i]));
  }
  return out;
}

/**
 * Build change records from a batch's deltas. One record per node/edge
 * delta. `revertDeltas` is the single inverse delta, ready to apply.
 *
 * @param deltas The batch deltas (server diff prestate → poststate).
 * @param opts.nodeLabelById Optional label lookup for edge endpoints
 *   whose nodes are not themselves part of this batch.
 */
export function extractCanvasChanges(
  deltas: readonly Delta[],
  opts?: { nodeLabelById?: ReadonlyMap<string, string> },
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
        const keys = changedKeys(nodeData(d.prev), nodeData(d.next));
        records.push({
          id: createId('change'),
          kind: 'update',
          label: `Updated: ${labelOf(d.next)}`,
          nodeId: d.next.id,
          nodeType: (d.next.type ?? 'note') as string,
          nodeLabel: labelOf(d.next),
          revertDeltas: [invertDelta(d)],
          fingerprintKeys: keys,
          appliedFingerprint: fingerprintNodeFields(d.next, keys),
        });
        break;
      }

      case 'DELETE_NODE': {
        // DELETE: existence-based — the revert (INSERT_NODE) is
        // meaningful iff the node is still absent (blocked once it's
        // back).
        records.push({
          id: createId('change'),
          kind: 'delete',
          label: `Deleted: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
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

  return records;
}

// ── Coalescing (net effect per entity) ─────────────────────────────────────
//
// Multiple agent batches editing the SAME node/edge produce one change
// record each, so the card would show many "Updated: X" rows. Coalescing
// folds every record targeting the same entity into a single NET change:
// the revert restores the state from BEFORE the first edit, and a
// create+delete (or an edit that nets to nothing) drops out entirely.

/** The forward change (before → after) a record's inverse delta implies. */
function forwardOf(rec: CanvasChangeRecord): {
  key: string;
  kind: 'node' | 'edge';
  before: CanvasNode | CanvasEdge | null;
  after: CanvasNode | CanvasEdge | null;
} | null {
  const rd = rec.revertDeltas[0];
  if (!rd) return null;
  switch (rd.type) {
    case 'DELETE_NODE': // forward was INSERT: absent → node
      return {
        key: `node:${rd.node.id}`,
        kind: 'node',
        before: null,
        after: rd.node,
      };
    case 'INSERT_NODE': // forward was DELETE: node → absent
      return {
        key: `node:${rd.node.id}`,
        kind: 'node',
        before: rd.node,
        after: null,
      };
    case 'REPLACE_NODE': // forward REPLACE: before=rd.next, after=rd.prev
      return {
        key: `node:${rd.prev.id}`,
        kind: 'node',
        before: rd.next,
        after: rd.prev,
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

function netNodeDelta(
  before: CanvasNode | null,
  after: CanvasNode | null,
): Delta | null {
  if (!before && !after) return null;
  if (!before && after) return { type: 'INSERT_NODE', node: after };
  if (before && !after) return { type: 'DELETE_NODE', node: before };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return {
    type: 'REPLACE_NODE',
    prev: before as CanvasNode,
    next: after as CanvasNode,
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
  for (const r of records) {
    if (r.nodeId && r.nodeLabel) labelById.set(r.nodeId, r.nodeLabel);
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
    const first = forwardOf(grp[0]);
    const last = forwardOf(grp[grp.length - 1]);
    if (!first || !last) continue;
    const net =
      first.kind === 'node'
        ? netNodeDelta(
            first.before as CanvasNode | null,
            last.after as CanvasNode | null,
          )
        : netEdgeDelta(
            first.before as CanvasEdge | null,
            last.after as CanvasEdge | null,
          );
    if (net) {
      netDeltas.push(net);
      idByKey.set(key, grp[0].id);
    }
  }

  // Rebuild records from the net deltas, then restore the stable id.
  return extractCanvasChanges(netDeltas, { nodeLabelById: labelById }).map(
    (rec) => {
      const f = forwardOf(rec);
      const id = f ? idByKey.get(f.key) : undefined;
      return id ? { ...rec, id } : rec;
    },
  );
}
