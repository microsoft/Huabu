// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useViewport } from '@xyflow/react';
import { Frame } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import useCanvasStore from '@/store/canvasStore';

import type { FrameRefNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type FrameRefNodeType = Node<FrameRefNodeData, 'frameRef'>;

const LABEL_MIN_SCREEN_WIDTH = 48;

export const FrameRefNode = memo(
  ({ id, data, selected }: NodeProps<FrameRefNodeType>) => {
    const { t } = useTranslation();
    const resolved = useCanvasStore((state) => state.worldReferences[id]);
    const resolutionError = useCanvasStore(
      (state) => state.worldReferenceError,
    );
    const internalNode = useInternalNode(id);
    const { zoom } = useViewport();
    const source = resolved?.kind === 'frameRef' ? resolved.source : undefined;
    const status = resolved?.kind === 'frameRef' ? resolved.status : undefined;
    const width =
      (typeof internalNode?.style?.width === 'number'
        ? internalNode.style.width
        : internalNode?.measured?.width) ?? LABEL_MIN_SCREEN_WIDTH;
    const label = resolutionError
      ? t('world.loadFailed')
      : status === 'canvas-missing'
        ? t('world.missingSpace')
        : status === 'node-missing'
          ? t('world.missingNode')
          : source?.label || t('layers.filterLabels.frameRef');

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="frameRef"
        selected={selected}
        allowOverflow
        resizable={false}
        className="border-edge-default border-dashed"
        overlayContent={
          <div className="text-fg-muted flex min-w-0 items-center gap-1.5 px-1.5 text-xs font-medium">
            <Frame
              className={
                resolutionError ||
                status === 'canvas-missing' ||
                status === 'node-missing'
                  ? 'text-danger'
                  : 'text-fg-muted'
              }
              size={14}
            />
            <span className="truncate">{label}</span>
          </div>
        }
        overlayOffsetY={-24}
        overlayVisible
        overlayInteractionPriority={selected ? 2 : 0}
        overlayMaxWidth={Math.max(LABEL_MIN_SCREEN_WIDTH, width * zoom)}
      >
        <div className="h-full w-full" />
      </NodeWrapper>
    );
  },
);

FrameRefNode.displayName = 'FrameRefNode';
