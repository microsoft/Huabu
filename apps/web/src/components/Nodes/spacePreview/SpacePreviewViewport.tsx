// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Minus, Plus, RotateCcw } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { Button } from '@/components/Common/Button';

import {
  readSpacePreviewViewport,
  writeSpacePreviewViewport,
  type SpacePreviewViewportState,
} from './viewportPersistence';

import type { GetSpacePreviewSceneResponse } from '@huabu/shared';

const MIN_PREVIEW_ZOOM = 0.5;
const MAX_PREVIEW_ZOOM = 8;
const MAX_HOST_ZOOM_COMPENSATION = 3;
const PREVIEW_TEXT_SCREEN_PX = 14;
const PREVIEW_TEXT_PADDING_SCREEN_PX = 10;

interface ViewportSize {
  width: number;
  height: number;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, zoom));
}

export function spacePreviewTextMetrics({
  bounds,
  localZoom,
  hostZoom,
  viewportSize,
}: {
  bounds: GetSpacePreviewSceneResponse['bounds'];
  localZoom: number;
  hostZoom: number;
  viewportSize: ViewportSize;
}): { fontSize: number; padding: number } {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    const hostZoomOutCompensation = Math.min(
      MAX_HOST_ZOOM_COMPENSATION,
      Math.max(1, 1 / hostZoom),
    );
    return {
      fontSize: (PREVIEW_TEXT_SCREEN_PX * hostZoomOutCompensation) / localZoom,
      padding:
        (PREVIEW_TEXT_PADDING_SCREEN_PX * hostZoomOutCompensation) / localZoom,
    };
  }
  const viewBoxWidth = Math.max(1, bounds.width / localZoom);
  const viewBoxHeight = Math.max(1, bounds.height / localZoom);
  const layoutUnitsPerPixel = Math.max(
    viewBoxWidth / viewportSize.width,
    viewBoxHeight / viewportSize.height,
  );
  const compensatedHostZoom = Math.min(
    1,
    Math.max(hostZoom, 1 / MAX_HOST_ZOOM_COMPENSATION),
  );
  const sceneUnitsPerScreenPixel = layoutUnitsPerPixel / compensatedHostZoom;
  return {
    fontSize: PREVIEW_TEXT_SCREEN_PX * sceneUnitsPerScreenPixel,
    padding: PREVIEW_TEXT_PADDING_SCREEN_PX * sceneUnitsPerScreenPixel,
  };
}

export const SpacePreviewViewport = memo(
  ({
    scene,
    hostCanvasId,
    previewNodeId,
    hostZoom,
  }: {
    scene: GetSpacePreviewSceneResponse;
    hostCanvasId: string;
    previewNodeId: string;
    hostZoom: number;
  }) => {
    const { t } = useTranslation();
    const clipPrefix = useId().replaceAll(':', '');
    const rootRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{
      pointerId: number;
      clientX: number;
      clientY: number;
      viewport: SpacePreviewViewportState;
    } | null>(null);
    const [viewport, setViewport] = useState<SpacePreviewViewportState>(
      () =>
        readSpacePreviewViewport(hostCanvasId, previewNodeId) ?? {
          x: scene.bounds.x,
          y: scene.bounds.y,
          zoom: 1,
        },
    );
    const viewportRef = useRef(viewport);
    const [viewportSize, setViewportSize] = useState<ViewportSize>({
      width: 0,
      height: 0,
    });

    const reset = useCallback(() => {
      setViewport({ x: scene.bounds.x, y: scene.bounds.y, zoom: 1 });
    }, [scene.bounds.x, scene.bounds.y]);

    useEffect(() => {
      viewportRef.current = viewport;
      const timeout = window.setTimeout(() => {
        writeSpacePreviewViewport(hostCanvasId, previewNodeId, viewport);
      }, 150);
      return () => window.clearTimeout(timeout);
    }, [hostCanvasId, previewNodeId, viewport]);

    useEffect(
      () => () => {
        writeSpacePreviewViewport(
          hostCanvasId,
          previewNodeId,
          viewportRef.current,
        );
      },
      [hostCanvasId, previewNodeId],
    );

    const zoomBy = useCallback(
      (factor: number) =>
        setViewport((current) => ({
          ...current,
          zoom: clampZoom(current.zoom * factor),
        })),
      [],
    );

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const factor = Math.pow(2, -event.deltaY * 0.002);
        zoomBy(factor);
      };
      root.addEventListener('wheel', onWheel, {
        capture: true,
        passive: false,
      });
      return () => root.removeEventListener('wheel', onWheel, true);
    }, [zoomBy]);

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const updateSize = () => {
        setViewportSize({
          width: root.clientWidth,
          height: root.clientHeight,
        });
      };
      updateSize();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(updateSize);
      observer.observe(root);
      return () => observer.disconnect();
    }, []);

    const viewBox = useMemo(() => {
      const width = Math.max(1, scene.bounds.width / viewport.zoom);
      const height = Math.max(1, scene.bounds.height / viewport.zoom);
      return `${viewport.x} ${viewport.y} ${width} ${height}`;
    }, [scene.bounds.height, scene.bounds.width, viewport]);

    const nodeById = useMemo(
      () => new Map(scene.nodes.map((node) => [node.id, node])),
      [scene.nodes],
    );
    const textMetrics = useMemo(
      () =>
        spacePreviewTextMetrics({
          bounds: scene.bounds,
          localZoom: viewport.zoom,
          hostZoom,
          viewportSize,
        }),
      [hostZoom, scene.bounds, viewport.zoom, viewportSize],
    );

    return (
      /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- The inert scene is one labelled application focus region with canvas-style pan and zoom. */
      <div
        ref={rootRef}
        className="nodrag nopan nowheel bg-bg-default relative min-h-0 flex-1 overflow-hidden"
        role="application"
        tabIndex={0}
        aria-label={t('spacePreview.viewport', { title: scene.title })}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            viewport,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const visibleWidth = scene.bounds.width / drag.viewport.zoom;
          const visibleHeight = scene.bounds.height / drag.viewport.zoom;
          const unitsPerPixel = Math.max(
            visibleWidth / Math.max(event.currentTarget.clientWidth, 1),
            visibleHeight / Math.max(event.currentTarget.clientHeight, 1),
          );
          setViewport({
            ...drag.viewport,
            x: drag.viewport.x - (event.clientX - drag.clientX) * unitsPerPixel,
            y: drag.viewport.y - (event.clientY - drag.clientY) * unitsPerPixel,
          });
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur();
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const step = 24 / viewport.zoom;
          if (event.key === '+' || event.key === '=') zoomBy(1.2);
          else if (event.key === '-') zoomBy(1 / 1.2);
          else if (event.key === '0') reset();
          else if (event.key === 'ArrowLeft')
            setViewport((current) => ({ ...current, x: current.x - step }));
          else if (event.key === 'ArrowRight')
            setViewport((current) => ({ ...current, x: current.x + step }));
          else if (event.key === 'ArrowUp')
            setViewport((current) => ({ ...current, y: current.y - step }));
          else if (event.key === 'ArrowDown')
            setViewport((current) => ({ ...current, y: current.y + step }));
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <svg
          className="pointer-events-none h-full w-full"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <defs>
            {scene.nodes.map((node, index) =>
              node.imageSrc ? (
                <clipPath id={`${clipPrefix}-image-${index}`} key={node.id}>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={10}
                  />
                </clipPath>
              ) : null,
            )}
          </defs>
          {scene.edges.map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            return (
              <line
                key={edge.id}
                x1={source.x + source.width / 2}
                y1={source.y + source.height / 2}
                x2={target.x + target.width / 2}
                y2={target.y + target.height / 2}
                className="stroke-edge-default"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {scene.nodes.map((node, index) => {
            const textPadding = Math.min(
              textMetrics.padding,
              node.width / 4,
              node.height / 4,
            );
            const textFontSize = Math.min(
              textMetrics.fontSize,
              Math.max(1, node.height - textPadding * 2),
            );
            return (
              <g key={node.id}>
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={node.kind === 'frame' ? 4 : 10}
                  className={
                    node.kind === 'frame'
                      ? 'stroke-edge-default fill-transparent'
                      : node.kind === 'nested-preview'
                        ? 'fill-info-bg stroke-info'
                        : 'fill-surface stroke-edge-default'
                  }
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={
                    node.kind === 'nested-preview' ? '6 4' : undefined
                  }
                />
                {node.imageSrc ? (
                  <image
                    href={resolveArtifactUrl(node.imageSrc, scene.canvasId)}
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    preserveAspectRatio="xMidYMid meet"
                    clipPath={`url(#${clipPrefix}-image-${index})`}
                  />
                ) : node.previewText ? (
                  <foreignObject
                    x={node.x + textPadding}
                    y={node.y + textPadding}
                    width={Math.max(1, node.width - textPadding * 2)}
                    height={Math.max(1, node.height - textPadding * 2)}
                  >
                    <div
                      className="text-fg-default h-full overflow-hidden leading-snug break-words whitespace-pre-wrap"
                      data-preview-adaptive-text
                      style={{ fontSize: textFontSize }}
                    >
                      {node.previewText}
                    </div>
                  </foreignObject>
                ) : node.label ? (
                  <foreignObject
                    x={node.x + textPadding}
                    y={node.y + textPadding}
                    width={Math.max(1, node.width - textPadding * 2)}
                    height={Math.max(1, node.height - textPadding * 2)}
                  >
                    <div
                      className="text-fg-muted h-full overflow-hidden leading-snug break-words"
                      data-preview-adaptive-label
                      style={{ fontSize: textFontSize }}
                    >
                      {node.label}
                    </div>
                  </foreignObject>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="absolute right-2 bottom-2 flex gap-1">
          <Button
            variant="outline"
            size="sm"
            iconOnly
            title={t('spacePreview.zoomOut')}
            onClick={() => zoomBy(1 / 1.2)}
          >
            <Minus />
          </Button>
          <Button
            variant="outline"
            size="sm"
            iconOnly
            title={t('spacePreview.resetView')}
            onClick={reset}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="outline"
            size="sm"
            iconOnly
            title={t('spacePreview.zoomIn')}
            onClick={() => zoomBy(1.2)}
          >
            <Plus />
          </Button>
        </div>
      </div>
      /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
    );
  },
);

SpacePreviewViewport.displayName = 'SpacePreviewViewport';
