import { Eraser } from 'lucide-react';

import {
  FLOATING_TOOLBAR_CLASS,
  FloatingToolbar,
} from '@/components/Common/FloatingToolbar';
import { RangeSlider } from '@/components/Common/RangeSlider';
import {
  SKETCH_ERASER_RADIUS_MAX_PX,
  SKETCH_ERASER_RADIUS_MIN_PX,
} from '@/config/canvas';
import { NODE_ICON } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';

import { SketchControls } from './SketchControls';

const PenIcon = NODE_ICON.sketch;

/**
 * Floating panel that hosts the sketch tool's settings.
 *
 * Single-row layout:
 *
 *   [Pen][Eraser] | <settings for active tool>
 *
 * The two icon-only buttons on the left act as a compact mode
 * switcher. A vertical divider separates them from the per-tool
 * settings on the right, which swap based on the active mode so
 * the controls always match the selected tool.
 *
 * Bound directly to `canvasStore.sketchDraft`; the values are then
 * read by `SketchOverlay` for the live preview / cursor and persisted
 * onto each new sketch node so the chosen look survives reload.
 */
export function SketchSettingsPanel() {
  const sketchDraft = useCanvasStore((s) => s.sketchDraft);
  const setSketchDraft = useCanvasStore((s) => s.setSketchDraft);
  const isErasing = sketchDraft.mode === 'erase';

  return (
    <div
      className={`${FLOATING_TOOLBAR_CLASS} absolute bottom-full left-1/2 mb-3 -translate-x-1/2`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Mode switcher: icon-only, on the left. */}
      <FloatingToolbar.ToggleButton
        active={!isErasing}
        title="Pen"
        size="md"
        onClick={() => setSketchDraft({ mode: 'draw' })}
      >
        <PenIcon size={16} />
      </FloatingToolbar.ToggleButton>
      <FloatingToolbar.ToggleButton
        active={isErasing}
        title="Eraser"
        size="md"
        onClick={() => setSketchDraft({ mode: 'erase' })}
      >
        <Eraser size={16} />
      </FloatingToolbar.ToggleButton>

      <FloatingToolbar.Divider />

      {/*
        Settings for the active tool only. The wrapper keeps a stable
        width so the toolbar doesn't visibly resize when switching
        between pen and eraser modes (pen has an extra color picker).
      */}
      <div className="flex h-9 min-w-52 items-center justify-end gap-2">
        {isErasing ? (
          <RangeSlider
            value={sketchDraft.eraserSize}
            min={SKETCH_ERASER_RADIUS_MIN_PX}
            max={SKETCH_ERASER_RADIUS_MAX_PX}
            label="Eraser size"
            size="md"
            onChange={(eraserSize) => setSketchDraft({ eraserSize })}
          />
        ) : (
          <SketchControls
            color={sketchDraft.strokeColor}
            size={sketchDraft.strokeSize}
            sliderSize="md"
            onColorChange={(strokeColor) => setSketchDraft({ strokeColor })}
            onSizeChange={(strokeSize) => setSketchDraft({ strokeSize })}
          />
        )}
      </div>
    </div>
  );
}
