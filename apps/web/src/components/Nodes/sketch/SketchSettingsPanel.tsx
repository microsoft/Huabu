import clsx from 'clsx';
import { Eraser } from 'lucide-react';

import { Button } from '@/components/Common/Button';
import {
  FLOATING_TOOLBAR_CLASS,
  FloatingToolbar,
} from '@/components/Common/FloatingToolbar';
import useCanvasStore from '@/store/canvasStore';

import { SketchControls } from './SketchControls';

/**
 * Floating panel that hosts the sketch tool's color + thickness controls
 * plus a draw / erase mode toggle.
 *
 * Mounted by `CanvasToolbar` directly above the Sketch button while
 * the sketch tool is active (`pendingNodeType === 'sketch'`).
 * Anchoring to the button keeps the panel visually attached to the action
 * that opened it, regardless of toolbar width / screen size.
 *
 * Bound directly to `canvasStore.sketchDraft`; the values are then read by
 * `SketchOverlay` for the live preview and persisted onto each new
 * sketch node so the chosen look survives reload.
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
      <SketchControls
        color={sketchDraft.strokeColor}
        size={sketchDraft.strokeSize}
        onColorChange={(strokeColor) =>
          // Picking a color implies the user wants to draw, not erase.
          setSketchDraft({ strokeColor, mode: 'draw' })
        }
        onSizeChange={(strokeSize) =>
          // Adjusting thickness implies the user wants to draw, not erase.
          setSketchDraft({ strokeSize, mode: 'draw' })
        }
      />
      <FloatingToolbar.Divider />
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={isErasing ? 'Switch to draw mode' : 'Switch to eraser mode'}
        onClick={() => setSketchDraft({ mode: isErasing ? 'draw' : 'erase' })}
        className={clsx(isErasing && 'text-info bg-bg-default')}
      >
        <Eraser />
      </Button>
    </div>
  );
}
