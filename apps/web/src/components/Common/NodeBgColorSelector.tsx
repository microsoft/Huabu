import { clsx } from 'clsx';
import { useState } from 'react';

import useCanvasStore from '@/store/canvasStore.ts';

import { IconButton } from './IconButton';

import type { NodeStyle } from '@/components/Nodes/types.ts';

const PRESET_COLORS = [
  {
    name: 'Transparent',
    value: 'bg-transparent',
    border: 'border-info',
    ring: 'ring-transparent',
  },
  {
    name: 'White',
    value: 'bg-white',
    border: 'border-border',
    ring: 'ring-gray-200',
  },
  {
    name: 'Red',
    value: 'bg-red-50',
    border: 'border-red-200',
    ring: 'ring-red-200',
  },
  {
    name: 'Orange',
    value: 'bg-orange-50',
    border: 'border-orange-200',
    ring: 'ring-orange-200',
  },
  {
    name: 'Yellow',
    value: 'bg-yellow-50',
    border: 'border-yellow-200',
    ring: 'ring-yellow-200',
  },
  {
    name: 'Green',
    value: 'bg-green-50',
    border: 'border-green-200',
    ring: 'ring-green-200',
  },
  {
    name: 'Blue',
    value: 'bg-blue-50',
    border: 'border-blue-200',
    ring: 'ring-blue-200',
  },
  {
    name: 'Purple',
    value: 'bg-purple-50',
    border: 'border-purple-200',
    ring: 'ring-purple-200',
  },
];

export const NodeBgColorSelector = ({
  nodeId,
  style = {},
  currentColor,
}: {
  nodeId: string;
  style?: NodeStyle;
  currentColor?: string;
}) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isOpen, setIsOpen] = useState(false);

  const activeColor =
    PRESET_COLORS.find((c) => c.value === currentColor) || PRESET_COLORS[0];

  const handleColorSelect = (colorValue: string) => {
    updateNodeData(nodeId, {
      style: { ...style, backgroundColor: colorValue },
    });
    setIsOpen(false);
  };

  return (
    <div className="relative flex items-center">
      <IconButton
        variant="outline"
        className="border-border rounded-full border p-px hover:scale-110"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="Change Color"
        size="sm"
      >
        <div
          className={clsx(
            'h-4 w-4 rounded-full border',
            activeColor.value,
            activeColor.border,
          )}
        />
      </IconButton>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }}
          />

          <div
            className="border-border shadow-bottom animate-in fade-in zoom-in absolute bottom-full left-1/2 z-50 mb-2 flex -translate-x-1/2 gap-2 rounded-full border bg-white px-2 py-1.5 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {PRESET_COLORS.map((color) => (
              <button
                key={color.name}
                onClick={() => handleColorSelect(color.value)}
                className={clsx(
                  'h-4 w-4 rounded-full border transition-all hover:scale-110',
                  color.value,
                  color.border,
                  currentColor === color.value
                    ? `ring-2 ${color.ring} ring-offset-1`
                    : '',
                )}
                title={color.name}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
