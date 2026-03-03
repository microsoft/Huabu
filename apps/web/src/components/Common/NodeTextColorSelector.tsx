import { clsx } from 'clsx';
import { Baseline } from 'lucide-react';
import { useState } from 'react';

import useCanvasStore from '@/store/canvasStore.ts';

import type { NodeStyle } from '@/components/Nodes/types.ts';

const PRESET_TEXT_COLORS = [
  {
    name: 'Default',
    value: '#191919',
    preview: 'bg-gray-800',
    ring: 'ring-gray-800',
  },
  {
    name: 'Orange',
    value: '#f97316',
    preview: 'bg-orange-500',
    ring: 'ring-orange-500',
  },
  {
    name: 'Amber',
    value: '#f59e0b',
    preview: 'bg-amber-500',
    ring: 'ring-amber-500',
  },
  {
    name: 'Green',
    value: '#10b981',
    preview: 'bg-emerald-500',
    ring: 'ring-emerald-500',
  },
  {
    name: 'Blue',
    value: '#3b82f6',
    preview: 'bg-blue-500',
    ring: 'ring-blue-500',
  },
  {
    name: 'Purple',
    value: '#a855f7',
    preview: 'bg-purple-500',
    ring: 'ring-purple-500',
  },
];

export const NodeTextColorSelector = ({
  nodeId,
  style = {},
  currentTextColor,
}: {
  nodeId: string;
  style?: NodeStyle;
  currentTextColor?: string;
}) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isOpen, setIsOpen] = useState(false);

  const activeColor =
    PRESET_TEXT_COLORS.find((c) => c.value === currentTextColor) ||
    PRESET_TEXT_COLORS[0];

  const handleColorSelect = (colorValue: string) => {
    updateNodeData(nodeId, { style: { ...style, textColor: colorValue } });
    setIsOpen(false);
  };

  return (
    <div className="relative flex items-center">
      <button
        className="border-border hover:bg-muted flex items-center justify-center rounded border p-1 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="Change Text Color"
      >
        <Baseline size={14} style={{ color: activeColor.value }} />
      </button>

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
            {PRESET_TEXT_COLORS.map((color) => (
              <button
                key={color.name}
                onClick={() => handleColorSelect(color.value)}
                className={clsx(
                  'h-4 w-4 rounded-full border transition-all hover:scale-125',
                  color.preview,
                  'border-border',
                  currentTextColor === color.value
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
