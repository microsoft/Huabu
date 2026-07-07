/**
 * On-canvas overlay shown around in-progress sketch clusters.
 *
 * Each overlay rectangle:
 *  - Lives in flow coordinates (renders inside <ViewportPortal> so it pans
 *    and zooms with the canvas, just like the sketch strokes themselves).
 *  - Computes its bounding box live from the canvas-store sketch nodes
 *    so it grows as the user keeps drawing and disappears when strokes are
 *    deleted.
 *  - Carries a status pill in its top-left corner via the shared
 *    `StatusBadge` component (zoom-invariant): preparing → pending →
 *    running → done.
 */

import { ViewportPortal } from '@xyflow/react';
import { Blend, Check, Undo2 } from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';

import { applyDeltas } from '@sediment/shared/canvas-engine';

import {
  useAcpThreadChangesStore,
  isChangeStale,
} from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';
import { usePanelStore } from '@/store/panelStore';

import { Button } from '../../Common/Button';
import { StatusBadge } from '../../Common/StatusBadge';

import type { SketchProcessingCluster } from '@/store/intentStore';
import type { CanvasChangeRecord, Delta } from '@sediment/shared/canvas-engine';
import type { Node, Edge } from '@xyflow/react';

const EMPTY_RECORDS: CanvasChangeRecord[] = [];

/** Walk the parent chain to compute a node's absolute flow-space position. */
function absolutePosition(
  node: Node,
  byId: Map<string, Node>,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: Node | undefined = node;
  while (cur) {
    x += cur.position.x;
    y += cur.position.y;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return { x, y };
}

/**
 * Compute the union bbox (in absolute flow coordinates) of all sketch
 * nodes whose ids appear in `strokeIds`. Returns `null` when every stroke
 * has been deleted.
 */
function computeBbox(
  strokeIds: string[],
  byId: Map<string, Node>,
): { x: number; y: number; width: number; height: number } | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let any = false;

  for (const id of strokeIds) {
    const node = byId.get(id);
    if (!node || node.type !== 'sketch') continue;
    const { x, y } = absolutePosition(node, byId);
    const initialSize = (
      node.data as { initialSize?: { width: number; height: number } }
    ).initialSize ?? { width: 0, height: 0 };
    const w =
      (node.measured?.width ?? (node.style?.width as number | undefined)) ||
      initialSize.width;
    const h =
      (node.measured?.height ?? (node.style?.height as number | undefined)) ||
      initialSize.height;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w);
    y2 = Math.max(y2, y + h);
    any = true;
  }

  if (!any) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Mounts a flow-space rectangle + status pill for every cluster currently
 * tracked in the intent store. Renders nothing when no clusters are active.
 */
export const SketchProcessingOverlay = memo(() => {
  const clusters = useIntentStore((s) => s.processingClusters);

  if (clusters.length === 0) return null;

  return (
    <ViewportPortal>
      {clusters.map((cluster) => (
        <ClusterOverlay key={cluster.id} cluster={cluster} />
      ))}
    </ViewportPortal>
  );
});
SketchProcessingOverlay.displayName = 'SketchProcessingOverlay';

const ClusterOverlay = memo(
  ({ cluster }: { cluster: SketchProcessingCluster }) => {
    // Subscribe to the canvas nodes so the bbox follows live edits and
    // disappears when the strokes are deleted.
    const nodes = useCanvasStore((s) => s.nodes);
    const bbox = useMemo(() => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return computeBbox(cluster.strokeIds, byId);
    }, [nodes, cluster.strokeIds]);

    const acceptCluster = useIntentStore((s) => s.acceptCluster);
    const revertCluster = useIntentStore((s) => s.revertCluster);
    const openSketchCluster = useChatStore((s) => s.openSketchCluster);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);
    // Pass canvasId so opening the sketch inspector also evicts any
    // persisted question-replay pointer for this canvas — sketch and
    // replay are mutually exclusive views.
    const canvasId = useCanvasStore((s) => s.canvasId);
    const edges = useCanvasStore((s) => s.edges);

    const handleOpenInspector = () => {
      openSketchCluster(cluster.id, canvasId || undefined);
      requestOpenRightPanel();
    };

    // Change-review records for this cluster's synthetic thread — the
    // overlay's Keep / Revert / Preview act on them exactly like the chat
    // ChangeReviewCard does.
    const records = useAcpThreadChangesStore((s) =>
      cluster.threadId
        ? (s.byThread[cluster.threadId] ?? EMPTY_RECORDS)
        : EMPTY_RECORDS,
    );
    const revertable = useMemo(
      () => records.filter((r) => !isChangeStale(r, nodes, edges)),
      [records, nodes, edges],
    );

    // Press-and-hold preview: temporarily apply the thread's inverse deltas
    // (reverse order) without autosave; restore the snapshot on release.
    const snapshotRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
    const handlePreviewAllDown = useCallback(() => {
      if (snapshotRef.current || revertable.length === 0) return;
      const state = useCanvasStore.getState();
      snapshotRef.current = { nodes: state.nodes, edges: state.edges };
      const deltas: Delta[] = [];
      for (let i = revertable.length - 1; i >= 0; i--) {
        deltas.push(...revertable[i].revertDeltas);
      }
      const next = applyDeltas(
        { nodes: state.nodes, edges: state.edges },
        deltas,
      );
      state._setStateNoAutosave({
        nodes: next.nodes as Node[],
        edges: next.edges as Edge[],
      });
    }, [revertable]);
    const handlePreviewUp = useCallback(() => {
      const snap = snapshotRef.current;
      if (!snap) return;
      snapshotRef.current = null;
      useCanvasStore
        .getState()
        ._setStateNoAutosave({ nodes: snap.nodes, edges: snap.edges });
    }, []);

    const showActions = cluster.status === 'done';
    const anyRevertible = revertable.length > 0;

    if (!bbox) return null;

    return (
      <div
        className="border-fg-subtle/30 pointer-events-none absolute rounded-md border border-dashed bg-white/40"
        style={{
          left: bbox.x,
          top: bbox.y,
          width: bbox.width,
          height: bbox.height,
        }}
      >
        {/* Status pill + action bar — top-left, zoom-invariant via the shared
            StatusBadge. Action bar sits immediately to the right of the pill
            once recognition is done. */}
        <StatusBadge
          status={cluster.status}
          offset={{ top: -22, left: -2 }}
          onClick={handleOpenInspector}
          title="Open recognition details in chat panel"
          trailing={
            showActions && (
              <div className="pointer-events-auto flex items-center gap-0.5 rounded-md p-0.5">
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  title="Keep changes"
                  onClick={() => acceptCluster(cluster.id)}
                >
                  <Check />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  title="Revert changes"
                  disabled={!anyRevertible}
                  onClick={() => revertCluster(cluster.id)}
                >
                  <Undo2 />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  title="Hold to preview before"
                  disabled={!anyRevertible}
                  onPointerDown={handlePreviewAllDown}
                  onPointerUp={handlePreviewUp}
                  onPointerLeave={handlePreviewUp}
                >
                  <Blend />
                </Button>
              </div>
            )
          }
        />
      </div>
    );
  },
);
ClusterOverlay.displayName = 'ClusterOverlay';
