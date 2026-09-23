// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_SELECTION_CHROME } from '@/config/nodeInteractionChrome';

import type { ComponentProps } from 'react';

type Props = Omit<ComponentProps<'div'>, 'style' | 'children'> & {
  rect: { x: number; y: number; width: number; height: number };
  radius?: number;
  variant?: 'solid' | 'dashed' | 'offset';
  outlineOffset?: number;
};

/** Paint only: callers own geometry, portals, visibility, and gesture policy. */
export function SelectionOutline({
  rect,
  radius = 0,
  variant = 'solid',
  outlineOffset = 0,
  ...props
}: Props) {
  const { width, color, dashArray } = NODE_SELECTION_CHROME;
  return (
    <div
      {...props}
      aria-hidden
      data-selection-outline={variant}
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: radius,
        // Preserve fractional stroke widths without CSS border snapping.
        boxShadow:
          variant === 'solid' ? `0 0 0 ${width}px ${color}` : undefined,
        outline: variant === 'offset' ? `${width}px solid ${color}` : undefined,
        outlineOffset: variant === 'offset' ? outlineOffset : undefined,
      }}
    >
      {variant === 'dashed' && (
        <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
          <rect
            width={rect.width}
            height={rect.height}
            rx={radius}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeDasharray={dashArray}
          />
        </svg>
      )}
    </div>
  );
}
