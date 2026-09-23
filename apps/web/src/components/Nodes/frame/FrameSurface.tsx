// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { forwardRef } from 'react';

import { cn } from '@/components/Common/cn';

import { FRAME_DESIGN_CONFIG, frameSurfaceStyle } from './frameDesign';

import type { ComponentPropsWithoutRef } from 'react';

export interface FrameSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  accent: string | null;
  borderRadius?: number;
}

/**
 * Store-free Frame shell shared by the canvas node and visual playgrounds.
 */
export const FrameSurface = forwardRef<HTMLDivElement, FrameSurfaceProps>(
  ({ accent, borderRadius, className, style, ...props }, ref) => {
    const resolvedBorderRadius =
      borderRadius ?? FRAME_DESIGN_CONFIG.tiers[1].borderRadius;

    return (
      <div
        ref={ref}
        className={cn('bg-surface', className)}
        style={{
          ...frameSurfaceStyle(accent),
          borderRadius: resolvedBorderRadius,
          ...style,
        }}
        {...props}
      />
    );
  },
);

FrameSurface.displayName = 'FrameSurface';
