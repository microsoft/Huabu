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
   * Fingerprint of the node's post-apply state (node changes only).
   * Used for staleness detection: before reverting, the client compares
   * the node's current fingerprint against this; a mismatch means the
   * node was modified afterwards (human / another agent) and the revert
   * is blocked so it never clobbers a newer change.
   */
  appliedFingerprint?: string;
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
 * Stable, order-independent fingerprint of a node's mutable content.
 *
 * Hashes the `data` payload via djb2 over canonically-keyed JSON. Opaque
 * and deterministic — the same algorithm MUST run on both the producer
 * (server, stamping `appliedFingerprint`) and the consumer (web,
 * computing the current fingerprint to compare), so it lives here.
 */
export function fingerprintNode(node: CanvasNode | undefined): string {
  const data = nodeData(node);
  const json = JSON.stringify(data, Object.keys(data).sort());
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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

  const records: CanvasChangeRecord[] = [];

  for (const d of deltas) {
    switch (d.type) {
      case 'INSERT_NODE':
        records.push({
          id: createId('change'),
          kind: 'create',
          label: `Created: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
          revertDeltas: [invertDelta(d)],
          appliedFingerprint: fingerprintNode(d.node),
        });
        break;

      case 'REPLACE_NODE':
        records.push({
          id: createId('change'),
          kind: 'update',
          label: `Updated: ${labelOf(d.next)}`,
          nodeId: d.next.id,
          nodeType: (d.next.type ?? 'note') as string,
          nodeLabel: labelOf(d.next),
          revertDeltas: [invertDelta(d)],
          appliedFingerprint: fingerprintNode(d.next),
        });
        break;

      case 'DELETE_NODE':
        records.push({
          id: createId('change'),
          kind: 'delete',
          label: `Deleted: ${labelOf(d.node)}`,
          nodeId: d.node.id,
          nodeType: (d.node.type ?? 'note') as string,
          nodeLabel: labelOf(d.node),
          revertDeltas: [invertDelta(d)],
          appliedFingerprint: fingerprintNode(d.node),
        });
        break;

      case 'INSERT_EDGE':
        records.push({
          id: createId('change'),
          kind: 'connect',
          label: 'Connected',
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
          label: 'Disconnected',
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
          label: 'Edge updated',
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
