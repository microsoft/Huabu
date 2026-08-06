// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { cn } from '@/components/Common/cn';
import {
  FLOATING_TOOLBAR_CLASS,
  FloatingToolbar,
} from '@/components/Common/FloatingToolbar';
import {
  SKETCH_ERASER_RADIUS_MAX_PX,
  SKETCH_ERASER_RADIUS_MIN_PX,
} from '@/config/canvas';
import { useToolStore } from '@/store/toolStore';

import { SketchColorPresetPicker } from './SketchColorPresetPicker';
import { SketchModeSwitcher } from './SketchModeSwitcher';
import {
  SKETCH_COLOR_OPTIONS,
  SKETCH_SIZE_MAX,
  SKETCH_SIZE_MIN,
} from './sketchPath';
import { SketchPresetPicker } from './SketchPresetPicker';

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
 * Bound directly to `toolStore.sketchDraft`; the values are then
 * read by `SketchOverlay` for the live preview / cursor and persisted
 * onto each new sketch node so the chosen look survives reload.
 */
interface SketchSettingsPanelProps {
  touch?: boolean;
  showModeSwitcher?: boolean;
}

export function SketchSettingsPanel({
  touch = false,
  showModeSwitcher = true,
}: SketchSettingsPanelProps) {
  const { t } = useTranslation();
  const sketchDraft = useToolStore((s) => s.sketchDraft);
  const colorPresets = useToolStore((s) => s.colorPresets);
  const strokeSizePresets = useToolStore((s) => s.strokeSizePresets);
  const eraserSizePresets = useToolStore((s) => s.eraserSizePresets);
  const activeStrokeSizePreset = useToolStore((s) => s.activeStrokeSizePreset);
  const activeEraserSizePreset = useToolStore((s) => s.activeEraserSizePreset);
  const activeColorPreset = useToolStore((s) => s.activeColorPreset);
  const selectSketchColorPreset = useToolStore(
    (s) => s.selectSketchColorPreset,
  );
  const updateSketchColorPreset = useToolStore(
    (s) => s.updateSketchColorPreset,
  );
  const selectSketchSizePreset = useToolStore((s) => s.selectSketchSizePreset);
  const updateSketchSizePreset = useToolStore((s) => s.updateSketchSizePreset);
  const isErasing = sketchDraft.mode === 'erase';

  return (
    <div
      role="presentation"
      className={cn(
        FLOATING_TOOLBAR_CLASS,
        'absolute bottom-full left-1/2 mb-3 -translate-x-1/2',
        touch ? 'p-1.5' : 'px-1.5 py-1',
      )}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {showModeSwitcher ? (
        <>
          <SketchModeSwitcher size={touch ? 'md' : 'sm'} />
          <FloatingToolbar.Divider />
        </>
      ) : null}

      {/*
        Settings for the active tool only. The wrapper keeps a stable
        row while the controls swap between pen and eraser presets.
      */}
      <div
        className={cn(
          'flex items-center justify-end gap-2',
          touch ? 'h-9' : 'h-8',
        )}
      >
        {isErasing ? (
          <SketchPresetPicker
            presets={eraserSizePresets}
            activeIndex={activeEraserSizePreset}
            min={SKETCH_ERASER_RADIUS_MIN_PX}
            max={SKETCH_ERASER_RADIUS_MAX_PX}
            label={t('node.eraserSize')}
            touch={touch}
            onSelect={(index) => selectSketchSizePreset('eraser', index)}
            onChange={(index, value) =>
              updateSketchSizePreset('eraser', index, value)
            }
          />
        ) : (
          <>
            <SketchColorPresetPicker
              colors={SKETCH_COLOR_OPTIONS}
              presets={colorPresets}
              activeIndex={activeColorPreset}
              label={t('node.strokeColor')}
              onSelect={selectSketchColorPreset}
              onChange={updateSketchColorPreset}
            />
            <SketchPresetPicker
              presets={strokeSizePresets}
              activeIndex={activeStrokeSizePreset}
              min={SKETCH_SIZE_MIN}
              max={SKETCH_SIZE_MAX}
              label={t('node.strokeThickness')}
              touch={touch}
              onSelect={(index) => selectSketchSizePreset('stroke', index)}
              onChange={(index, value) =>
                updateSketchSizePreset('stroke', index, value)
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
