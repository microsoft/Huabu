// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  NodeResizeControl,
  ResizeControlVariant,
  useInternalNode,
  useNodeId,
  useStore,
  type ResizeControlProps,
} from '@xyflow/react';
import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { isAlwaysAutoHeightNodeType } from '@huabu/shared/canvas-engine';

import { ResizeGrip } from '@/components/Panels/Canvas/selectionChrome/ResizeGrip';
import { useRenderedNodeGeometry } from '@/components/Panels/Canvas/useRenderedNodeGeometry';
import { NODE_CONTROL_CHROME } from '@/config/nodeInteractionChrome';

import {
  resizeCornerInset,
  SELECTION_OUTLINE_WIDTH,
} from './design/nodeSelectionGeometry';

import type { TextResizeMode } from '@/hooks/useTextAutoSize';

type Position = NonNullable<ResizeControlProps['position']>;
export interface ResizeControlPolicy {
  position: Position;
  edge: boolean;
  mode: TextResizeMode;
  lockAspect: boolean;
  cursor: string;
}

const corners = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;
const edges = ['left', 'right', 'top', 'bottom'] as const;

// Paint above SelectionOutlines, outside the node's stacking context. Native
// controls remain the sole input owner; this HUD never intercepts a pointer.
function useCornerGeometry(isNotMouse: boolean) {
  const id = useNodeId();
  const node = useInternalNode(id ?? '');
  const domNode = useStore((state) => state.domNode);
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const x = node?.internals.positionAbsolute.x ?? 0;
  const y = node?.internals.positionAbsolute.y ?? 0;
  const width =
    (node?.style?.width as number | undefined) ?? node?.measured.width ?? 0;
  const height =
    (node?.style?.height as number | undefined) ?? node?.measured.height ?? 0;
  const { geometry: renderedGeometry } = useRenderedNodeGeometry(
    id ?? '',
    domNode,
    node?.resizing === true,
    {
      nodeX: x,
      nodeY: y,
      nodeWidth: width,
      nodeHeight: height,
      viewportX: tx,
      viewportY: ty,
      zoom,
    },
  );
  if (!node || !domNode) return null;
  const size = NODE_CONTROL_CHROME.size[isNotMouse ? 'touch' : 'mouse'];
  const renderedInset = renderedGeometry
    ? renderedGeometry.radius -
      (renderedGeometry.radius + SELECTION_OUTLINE_WIDTH) * Math.SQRT1_2 -
      size / 2
    : null;
  const inset =
    renderedInset ?? resizeCornerInset(node.type, width, height, zoom, size);
  const left = renderedGeometry?.x ?? x * zoom + tx;
  const top = renderedGeometry?.y ?? y * zoom + ty;
  const renderedWidth = renderedGeometry?.width ?? width * zoom;
  const renderedHeight = renderedGeometry?.height ?? height * zoom;
  return {
    id,
    domNode,
    zoom,
    size,
    inset,
    left,
    top,
    width: renderedWidth,
    height: renderedHeight,
    localLeft: (left - x * zoom - tx) / zoom,
    localTop: (top - y * zoom - ty) / zoom,
  };
}

type CornerGeometry = ReturnType<typeof useCornerGeometry>;

const CornerGripOverlay = memo(function CornerGripOverlay({
  isNotMouse,
  geometry,
}: {
  isNotMouse: boolean;
  geometry: CornerGeometry;
}) {
  if (!geometry) return null;
  const { id, domNode, left, top, width, height, size, inset } = geometry;
  return createPortal(
    <>
      {corners.map((position) => (
        <ResizeGrip
          key={position}
          isNotMouse={isNotMouse}
          data-node-resize-grip={`${id}:${position}`}
          className="node-resize-grip absolute z-999"
          style={{
            left:
              left +
              (position.endsWith('right') ? width : 0) -
              size / 2 +
              (position.endsWith('right') ? -inset : inset),
            top:
              top +
              (position.startsWith('bottom') ? height : 0) -
              size / 2 +
              (position.startsWith('bottom') ? -inset : inset),
          }}
        />
      ))}
    </>,
    domNode,
  );
});

/** Keep gesture policy independent of rendering and of persisted node geometry. */
export function nodeResizePolicy(
  type: string,
  keepAspectRatio = false,
): ResizeControlPolicy[] {
  const media = type === 'image' || type === 'video';
  const widthOnly = isAlwaysAutoHeightNodeType(type);
  return [
    ...(media
      ? []
      : edges.filter(
          (side) => !widthOnly || side === 'left' || side === 'right',
        )
    ).map((position) => ({
      position,
      edge: true,
      mode: widthOnly ? ('width' as const) : ('fit' as const),
      lockAspect: widthOnly ? false : keepAspectRatio,
      cursor:
        position === 'left' || position === 'right' ? 'ew-resize' : 'ns-resize',
    })),
    ...corners.map((position) => ({
      position,
      edge: false,
      mode: widthOnly ? ('scale' as const) : ('fit' as const),
      lockAspect: widthOnly || media || keepAspectRatio,
      cursor:
        position === 'top-left' || position === 'bottom-right'
          ? 'nwse-resize'
          : 'nesw-resize',
    })),
  ];
}

interface Props {
  type: string;
  keepAspectRatio: boolean;
  isNotMouse: boolean;
  minWidth?: number;
  minHeight?: number;
  onResizeStart: (
    event: unknown,
    params: { x: number; y: number; width: number; height: number },
    policy: ResizeControlPolicy,
  ) => void;
  onResize: ResizeControlProps['onResize'];
  onResizeEnd: ResizeControlProps['onResizeEnd'];
}

// Stable callbacks keep XYFlow from replacing the active native drag binding.
const Control = memo(function Control({
  policy,
  geometry,
  isNotMouse,
  onResizeStart,
  onResize,
  onResizeEnd,
  ...props
}: Omit<Props, 'type' | 'keepAspectRatio'> & {
  policy: ResizeControlPolicy;
  geometry: CornerGeometry;
}) {
  const { position, edge, mode, lockAspect, cursor } = policy;
  const zoom = geometry?.zoom ?? 1;
  const inset = (geometry?.inset ?? 0) / zoom;
  const callbacks = useRef({ onResizeStart, onResize, onResizeEnd });
  useLayoutEffect(() => {
    callbacks.current = { onResizeStart, onResize, onResizeEnd };
  }, [onResizeStart, onResize, onResizeEnd]);
  const start = useCallback<NonNullable<ResizeControlProps['onResizeStart']>>(
    (event, params) => {
      callbacks.current.onResizeStart(event, params, {
        position,
        edge,
        mode,
        lockAspect,
        cursor,
      });
    },
    [position, edge, mode, lockAspect, cursor],
  );
  const resize = useCallback<NonNullable<ResizeControlProps['onResize']>>(
    (event, params) => callbacks.current.onResize?.(event, params),
    [],
  );
  const end = useCallback<NonNullable<ResizeControlProps['onResizeEnd']>>(
    (event, params) => callbacks.current.onResizeEnd?.(event, params),
    [],
  );
  return (
    <NodeResizeControl
      {...props}
      position={position}
      variant={edge ? ResizeControlVariant.Line : ResizeControlVariant.Handle}
      autoScale={false}
      keepAspectRatio={lockAspect}
      resizeDirection={mode === 'width' ? 'horizontal' : undefined}
      onResizeStart={start}
      onResize={resize}
      onResizeEnd={end}
      className={
        edge ? 'node-resize-edge !border-transparent' : 'node-resize-corner'
      }
      style={
        edge
          ? {
              cursor,
            }
          : {
              width:
                NODE_CONTROL_CHROME.hitSize[isNotMouse ? 'touch' : 'mouse'] /
                zoom,
              height:
                NODE_CONTROL_CHROME.hitSize[isNotMouse ? 'touch' : 'mouse'] /
                zoom,
              border: 0,
              background: 'transparent',
              borderRadius: 0,
              left:
                (geometry?.localLeft ?? 0) +
                (position.endsWith('right')
                  ? (geometry?.width ?? 0) / zoom - inset
                  : inset),
              top:
                (geometry?.localTop ?? 0) +
                (position.startsWith('bottom')
                  ? (geometry?.height ?? 0) / zoom - inset
                  : inset),
              cursor,
              zIndex: 6,
            }
      }
    />
  );
});

export const NodeResizeControls = memo(function NodeResizeControls({
  type,
  keepAspectRatio,
  ...props
}: Props) {
  const geometry = useCornerGeometry(props.isNotMouse);
  return (
    <>
      {nodeResizePolicy(type, keepAspectRatio).map((policy) => (
        <Control
          key={policy.position}
          {...props}
          policy={policy}
          geometry={geometry}
        />
      ))}
      <CornerGripOverlay isNotMouse={props.isNotMouse} geometry={geometry} />
    </>
  );
});
