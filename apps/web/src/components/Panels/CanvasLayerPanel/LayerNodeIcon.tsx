// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Spline } from 'lucide-react';

import { getQuestionNodeStatus } from '@huabu/shared';

import { QuestionStatusDot } from './QuestionStatusDot';
import { getNodeIcon } from '../../../config/nodeIcons';
import useCanvasStore from '../../../store/canvasStore';
import { SketchIcon } from '../../Nodes/sketch/SketchIcon';

import type { SketchStroke } from '@huabu/shared';

export function LayerNodeIcon({
  node,
}: {
  node: { type?: string; data: Record<string, unknown> };
}) {
  if (node.type === 'sketch') {
    const strokes = node.data.strokes as SketchStroke[] | undefined;
    const initialSize = node.data.initialSize as
      | { width: number; height: number }
      | undefined;
    if (strokes && strokes.length > 0 && initialSize) {
      return (
        <SketchIcon strokes={strokes} initialSize={initialSize} size={14} />
      );
    }
  }

  const Icon = getNodeIcon(node.type, node.data);
  const icon = <Icon size={14} className="h-3.5! w-3.5!" />;
  if (node.type === 'question') {
    const status = getQuestionNodeStatus(node.data);
    if (status !== 'idle') {
      return (
        <span className="relative inline-flex">
          {icon}
          <QuestionStatusDot
            status={status}
            viewed={node.data.viewed as boolean | undefined}
            errorMessage={node.data.errorMessage as string | undefined}
          />
        </span>
      );
    }
  }
  return icon;
}

export function CanvasSearchNodeIcon({
  nodeId,
  nodeType,
  isEdge,
}: {
  nodeId: string;
  nodeType: string;
  isEdge: boolean;
}) {
  const node = useCanvasStore((state) =>
    isEdge ? undefined : state.nodes.find((entry) => entry.id === nodeId),
  );
  if (isEdge) return <Spline size={14} className="h-3.5! w-3.5!" />;
  return <LayerNodeIcon node={node ?? { type: nodeType, data: {} }} />;
}
