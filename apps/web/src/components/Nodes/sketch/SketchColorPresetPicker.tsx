// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { cn } from '@/components/Common/cn';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';

import type { ColorPreset } from '@/components/Common/ColorPicker';
import type { SketchColorPresets } from '@/store/toolStore';

interface SketchColorPresetPickerProps {
  colors: readonly ColorPreset[];
  presets: SketchColorPresets;
  activeIndex: number;
  label: string;
  onSelect: (index: number) => void;
  onChange: (index: number, color: string) => void;
}

export function SketchColorPresetPicker({
  colors,
  presets,
  activeIndex,
  label,
  onSelect,
  onChange,
}: SketchColorPresetPickerProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="flex items-center">
      {presets.map((color, index) => {
        const isActive = index === activeIndex;
        const swatchColor =
          colors.find((preset) => preset.token === color)?.value ?? color;
        return (
          <FloatingToolbar.ColorPicker
            key={index}
            colors={colors}
            value={color}
            title={label}
            open={openIndex === index}
            triggerClassName={cn(
              'h-6 w-7 bg-transparent ring-0 enabled:hover:bg-hover',
              isActive && 'bg-bg-default',
            )}
            onOpenChange={(open) => {
              if (open && !isActive) {
                onSelect(index);
                setOpenIndex(null);
                return;
              }
              setOpenIndex(open ? index : null);
            }}
            onSelect={(nextColor) => {
              onChange(index, nextColor);
              setOpenIndex(null);
            }}
          >
            <span
              className="border-edge-default h-3.5 w-3.5 rounded-full border"
              style={{ backgroundColor: swatchColor }}
            />
          </FloatingToolbar.ColorPicker>
        );
      })}
    </div>
  );
}
