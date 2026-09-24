// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { memo, useRef } from 'react';

import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { resolveFarLabelLayout } from '@/config/semanticZoom';

import { NODE_BORDER_WIDTH } from './design/nodeBoundary';
import { FarZoomLabel } from './semanticZoom/FarZoomLabel';

import type { CanvasNodeType, NodeData } from './types';

interface SemanticPlaceholderProps {
  type: CanvasNodeType;
  data: NodeData;
  /** Whether minimal LOD is currently active. */
  active: boolean;
  /** Canvas-space width of the node. */
  width: number;
  /** Canvas-space height of the node. */
  height: number;
  zoom: number;
  label?: { title: string; description?: string };
  borderRadius?: number;
}

/** Keep continuous zoom updates inside the lightweight visible label layer. */
export const ViewportSemanticPlaceholder = memo(
  function ViewportSemanticPlaceholder(
    props: Omit<SemanticPlaceholderProps, 'zoom'>,
  ) {
    const zoom = useStore((state) => (props.active ? state.transform[2] : 1));
    return <SemanticPlaceholder {...props} zoom={zoom} />;
  },
);

/** Text-only minimal layer; the existing node shell owns all surface styling. */
export function SemanticPlaceholder({
  type,
  data,
  active,
  width,
  height,
  zoom,
  label,
  borderRadius,
}: SemanticPlaceholderProps) {
  const rawLabel =
    label?.title ||
    ('label' in data && typeof data.label === 'string' ? data.label : null) ||
    ('title' in data && typeof data.title === 'string' ? data.title : null) ||
    NODE_TYPE_LABEL[type] ||
    type;

  const previousRetained = useRef<boolean | undefined>(undefined);
  const layout = resolveFarLabelLayout(
    Math.max(0, width - NODE_BORDER_WIDTH * 2) * zoom,
    Math.max(0, height - NODE_BORDER_WIDTH * 2) * zoom,
    previousRetained.current,
  );
  previousRetained.current = layout.labelRetained;

  return (
    <div
      className="semantic-lod-placeholder pointer-events-none absolute inset-0 z-10 overflow-hidden"
      style={{ borderRadius }}
      data-lod={active ? 'minimal' : 'full'}
      aria-hidden={!active}
    >
      <FarZoomLabel
        title={rawLabel}
        description={label?.description}
        width={layout.availableWidth}
        height={layout.availableHeight}
        lines={layout.lines}
        verticalInset={layout.verticalInset}
        horizontalInset={layout.horizontalInset}
        zoom={zoom}
        visible={active && layout.labelRetained}
      />
    </div>
  );
}
