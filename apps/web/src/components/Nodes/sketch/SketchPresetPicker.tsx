// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SketchSizePicker } from './SketchSizePicker';

import type { SketchSizePresets } from '@/store/toolStore';

interface SketchPresetPickerProps {
  presets: SketchSizePresets;
  activeIndex: number;
  min: number;
  max: number;
  label: string;
  touch?: boolean;
  onSelect: (index: number) => void;
  onChange: (index: number, value: number) => void;
}

export function SketchPresetPicker({
  presets,
  activeIndex,
  min,
  max,
  label,
  touch = false,
  onSelect,
  onChange,
}: SketchPresetPickerProps) {
  return (
    <div className="flex items-center">
      {presets.map((value, index) => (
        <SketchSizePicker
          key={index}
          value={value}
          min={min}
          max={max}
          label={label}
          touch={touch}
          grouped
          selected={index === activeIndex}
          onSelect={() => onSelect(index)}
          onChange={(nextValue) => onChange(index, nextValue)}
        />
      ))}
    </div>
  );
}
