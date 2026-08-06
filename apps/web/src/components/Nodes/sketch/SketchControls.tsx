// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';

import {
  SKETCH_COLOR_OPTIONS,
  SKETCH_SIZE_MAX,
  SKETCH_SIZE_MIN,
} from './sketchPath';
import { SketchSizePicker } from './SketchSizePicker';

interface SketchControlsProps {
  /** Current stroke color (accent palette token; legacy hex also accepted). */
  color: string;
  /** Current stroke thickness (perfect-freehand `size`). */
  size: number;
  /** Called with the picked palette token (see {@link SKETCH_COLOR_OPTIONS}). */
  onColorChange: (color: string) => void;
  /** Called with the new thickness (clamped to [min, max] by the slider). */
  onSizeChange: (size: number) => void;
  /**
   * Optional: fired once when the thickness slider drag begins / ends. Post-
   * draw toolbars use this to bracket the per-tick `onSizeChange` writes into
   * a single undo entry; the pre-draw settings panel (draft state, no undo)
   * omits them.
   */
  onSizeDragStart?: () => void;
  onSizeDragEnd?: () => void;
  touch?: boolean;
}

/**
 * Reusable color + thickness controls for the sketch tool.
 *
 * Used by:
 * - `SketchSettingsPanel` (pre-draw, bound to `toolStore.sketchDraft`)
 *   as the pen-mode settings row.
 * - `SketchNode`'s floating toolbar (post-draw, bound to the node's
 *   stroke data).
 *
 * Presentation-only: the parent decides where the values come from and
 * where edits go.
 */
export function SketchControls({
  color,
  size,
  onColorChange,
  onSizeChange,
  onSizeDragStart,
  onSizeDragEnd,
  touch = false,
}: SketchControlsProps) {
  const { t } = useTranslation();
  const [openControl, setOpenControl] = useState<'color' | 'size' | null>(null);
  return (
    <>
      <FloatingToolbar.ColorPicker
        colors={SKETCH_COLOR_OPTIONS}
        value={color}
        onSelect={onColorChange}
        title={t('node.strokeColor')}
        open={openControl === 'color'}
        onOpenChange={(open) => setOpenControl(open ? 'color' : null)}
      />
      <SketchSizePicker
        value={size}
        min={SKETCH_SIZE_MIN}
        max={SKETCH_SIZE_MAX}
        label={t('node.strokeThickness')}
        touch={touch}
        onChange={onSizeChange}
        onDragStart={onSizeDragStart}
        onDragEnd={onSizeDragEnd}
        open={openControl === 'size'}
        onOpenChange={(open) => setOpenControl(open ? 'size' : null)}
      />
    </>
  );
}
