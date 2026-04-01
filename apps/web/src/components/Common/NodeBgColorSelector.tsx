import { clsx } from 'clsx';
import { useState } from 'react';

import { NODE_BG_COLORS } from '@/config/colors';
import useCanvasStore from '@/store/canvasStore.ts';

import { Button } from './Button';
import { ColorPicker } from './ColorPicker';

import type { NodeStyle } from '@/components/Nodes/types.ts';

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
    NODE_BG_COLORS.find((c) => c.value === currentColor) || NODE_BG_COLORS[0];

  const handleColorSelect = (colorValue: string) => {
    updateNodeData(nodeId, {
      style: { ...style, backgroundColor: colorValue },
    });
    setIsOpen(false);
  };

  return (
    <div className="relative flex items-center">
      <Button
        variant="outline"
        iconOnly
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="Change Color"
        className="h-6 rounded-sm"
      >
        <div
          className={clsx(
            'h-3.5 w-3.5 rounded-full border',
            activeColor.value,
            activeColor.border,
          )}
        />
      </Button>

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
            className="border-edge-default shadow-bottom animate-in fade-in zoom-in bg-surface absolute bottom-full left-1/2 z-50 mb-2 flex -translate-x-1/2 rounded-full border px-2 py-1.5 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <ColorPicker
              colors={NODE_BG_COLORS}
              activeValue={currentColor ?? NODE_BG_COLORS[0].value}
              onSelect={handleColorSelect}
              classMode
            />
          </div>
        </>
      )}
    </div>
  );
};
