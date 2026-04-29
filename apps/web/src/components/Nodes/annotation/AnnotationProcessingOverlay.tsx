/**
 * On-canvas overlay shown around in-progress annotation clusters.
 *
 * Each overlay rectangle:
 *  - Lives in flow coordinates (renders inside <ViewportPortal> so it pans
 *    and zooms with the canvas, just like the annotation strokes themselves).
 *  - Computes its bounding box live from the canvas-store annotation nodes
 *    so it grows as the user keeps drawing and disappears when strokes are
 *    deleted.
 *  - Carries a status pill in its top-left corner, identical in style to the
 *    QuestionNode status badge: preparing → pending → running → done.
 */

import { ViewportPortal, useStore } from '@xyflow/react';
import { Blend, Check, Clock, Loader, Pencil, Undo2 } from 'lucide-react';
import { memo, useMemo } from 'react';

import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';
import { usePanelStore } from '@/store/panelStore';

import { useCanvasChangePreview } from '../../../hooks/useCanvasChanges';
import { Button } from '../../Common/Button';

import type {
  AnnotationProcessingCluster,
  AnnotationProcessingStatus,
} from '@/store/intentStore';
import type { Node } from '@xyflow/react';

interface StatusConfig {
  icon: typeof Clock;
  label: string;
  iconBg: string;
  pillBg: string;
  pillFg: string;
  spin?: boolean;
}

const STATUS_CONFIG: Record<AnnotationProcessingStatus, StatusConfig> = {
  preparing: {
    icon: Pencil,
    label: 'Preparing',
    iconBg: 'var(--fg-subtle)',
    pillBg: 'color-mix(in srgb, var(--fg-subtle) 10%, white 20%)',
    pillFg: 'var(--fg-subtle)',
  },
  pending: {
    icon: Clock,
    label: 'Pending',
    iconBg: 'var(--warning)',
    pillBg: 'color-mix(in srgb, var(--warning) 10%, white 20%)',
    pillFg: 'var(--warning)',
  },
  running: {
    icon: Loader,
    label: 'Running',
    iconBg: 'var(--info)',
    pillBg: 'color-mix(in srgb, var(--info) 10%, white 20%)',
    pillFg: 'var(--info)',
    spin: true,
  },
  done: {
    icon: Check,
    label: 'Done',
    iconBg: 'var(--success)',
    pillBg: 'color-mix(in srgb, var(--success) 10%, white 20%)',
    pillFg: 'var(--success)',
  },
};

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
 * Compute the union bbox (in absolute flow coordinates) of all annotation
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
    if (!node || node.type !== 'annotation') continue;
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
export const AnnotationProcessingOverlay = memo(() => {
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
AnnotationProcessingOverlay.displayName = 'AnnotationProcessingOverlay';

const ClusterOverlay = memo(
  ({ cluster }: { cluster: AnnotationProcessingCluster }) => {
    // Counter-scale the status pill so it stays visually constant while the
    // canvas zooms (the rectangle itself scales naturally with the viewport).
    const zoom = useStore((s) => s.transform[2]);
    const inverseZoom = zoom > 0 ? 1 / zoom : 1;

    // Subscribe to the canvas nodes so the bbox follows live edits and
    // disappears when the strokes are deleted.
    const nodes = useCanvasStore((s) => s.nodes);
    const bbox = useMemo(() => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return computeBbox(cluster.strokeIds, byId);
    }, [nodes, cluster.strokeIds]);

    const acceptCluster = useIntentStore((s) => s.acceptCluster);
    const revertCluster = useIntentStore((s) => s.revertCluster);
    const openAnnotationCluster = useChatStore((s) => s.openAnnotationCluster);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);

    const handleOpenInspector = () => {
      openAnnotationCluster(cluster.id);
      requestOpenRightPanel();
    };

    const changes = useMemo(() => cluster.changes ?? [], [cluster.changes]);
    const { handlePreviewAllDown, handlePreviewUp } =
      useCanvasChangePreview(changes);

    const showActions = cluster.status === 'done' && changes.length > 0;
    const anyRevertible = changes.some((c) => c.revertible);

    if (!bbox) return null;

    const cfg = STATUS_CONFIG[cluster.status];
    const Icon = cfg.icon;

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
        {/* Status pill + action bar — top-left, zoom-invariant. Action bar
            sits immediately to the right of the pill once recognition is done. */}
        <div
          className="absolute z-10 flex items-center gap-1"
          style={{
            top: -22 * inverseZoom,
            left: -2 * inverseZoom,
            transform: `scale(${inverseZoom})`,
            transformOrigin: 'top left',
          }}
        >
          <button
            type="button"
            onClick={handleOpenInspector}
            title="Open recognition details in chat panel"
            className="hover:ring-edge-default pointer-events-auto flex cursor-pointer items-center gap-1 rounded-full py-0.5 pr-2 pl-0.5 shadow-sm transition hover:ring-2"
            style={{
              backgroundColor: cfg.pillBg,
              color: cfg.pillFg,
            }}
          >
            <div
              className="flex h-5 w-5 items-center justify-center rounded-full"
              style={{ backgroundColor: cfg.iconBg }}
            >
              <Icon
                size={12}
                color="white"
                style={
                  cfg.spin
                    ? { animation: 'question-icon-spin 4s linear infinite' }
                    : undefined
                }
              />
            </div>
            <span className="text-xs font-semibold">{cfg.label}</span>
          </button>

          {showActions && (
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
          )}
        </div>
      </div>
    );
  },
);
ClusterOverlay.displayName = 'ClusterOverlay';
