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

import type { CanvasNode } from './interfaces.js';

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
        // CREATE: revertability is purely existence-based — the revert
        // (DELETE_NODE) is meaningful iff the node still exists. No
        // fingerprint: a create carries no "prev" to diff against, and
        // whatever the user does to the node afterwards, the card just
        // reverts to "delete it" (blocked once it's already gone).
        records.push({
          id: createId('change'),
          kind: 'create',
          label: `Created: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
          revertDeltas: [invertDelta(d)],
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
