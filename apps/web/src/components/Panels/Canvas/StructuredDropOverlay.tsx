// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useViewport, ViewportPortal } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { frameVisualMetricsForSize } from '@/components/Nodes/frame/frameDesign';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

export const StructuredDropOverlay = memo(function StructuredDropOverlay() {
  const { t } = useTranslation();
  const { zoom } = useViewport();
  const preview = useGesturePreviewStore((s) => s.structuredDropPreview);
  const node = useInternalNode(preview?.nodeId ?? '');
  if (!preview || !node) return null;

  const borderRadius =
    node.type === 'frame'
      ? frameVisualMetricsForSize(preview.width, preview.height).borderRadius
      : nodeMetricsForSize(preview.width, preview.height).radius;
  const opensTrack = preview.kind === 'insert-new';
  const gap = preview.masonry?.gap;

  if (gap) {
    const column = preview.context.axis === 'column';
    return (
      <ViewportPortal>
        <div
          data-structured-drop={preview.kind}
          data-structured-gap={gap.slot}
          data-canvas-grounding-exclude
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: gap.x,
            top: gap.y,
            width: gap.width,
            height: gap.height,
            zIndex: node.internals.z - 1,
          }}
        >
          {opensTrack ? (
            <>
              <div
                data-track-insert-line
                className="bg-info/35 absolute rounded-full"
                style={{
                  left: column ? gap.width / 2 - 0.75 / zoom : 0,
                  top: column ? 0 : gap.height / 2 - 0.75 / zoom,
                  width: column ? 1.5 / zoom : gap.width,
                  height: column ? gap.height : 1.5 / zoom,
                }}
              />
              <div
                data-track-insert-label
                className="bg-surface text-info border-info/35 absolute flex items-center gap-1 rounded-lg border px-2 py-1 text-sm leading-[18px] font-medium whitespace-nowrap"
                style={{
                  left: column ? gap.width / 2 : 8 / zoom,
                  top: column ? 0 : gap.height / 2,
                  transform: column
                    ? `translateX(-50%) scale(${1 / zoom})`
                    : `translateY(-50%) scale(${1 / zoom})`,
                  transformOrigin: column ? 'top center' : 'left center',
                }}
              >
                <Plus size={14} />
                {t(column ? 'node.frameDropNewColumn' : 'node.frameDropNewRow')}
              </div>
            </>
          ) : null}
        </div>
      </ViewportPortal>
    );
  }

  return (
    <ViewportPortal>
      <div data-canvas-grounding-exclude aria-hidden className="contents">
        <div
          data-structured-drop={preview.kind}
          className={
            opensTrack
              ? 'bg-info/10 border-info/50 pointer-events-none absolute flex items-center justify-center border border-dashed'
              : 'bg-info/5 border-info/35 pointer-events-none absolute border border-dashed'
          }
          style={{
            left: preview.x,
            top: preview.y,
            width: preview.width,
            height: preview.height,
            borderRadius,
            zIndex: node.internals.z - 1,
          }}
        >
          {opensTrack ? (
            <Plus className="text-info" size={20} strokeWidth={2.5} />
          ) : null}
        </div>
      </div>
    </ViewportPortal>
  );
});
