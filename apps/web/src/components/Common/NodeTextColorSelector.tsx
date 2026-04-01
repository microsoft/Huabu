import { Baseline } from 'lucide-react';
import { useState } from 'react';

import { STROKE_COLORS } from '@/config/colors';
import useCanvasStore from '@/store/canvasStore.ts';

import { Button } from './Button';
import { ColorPicker } from './ColorPicker';

import type { NodeStyle } from '@/components/Nodes/types.ts';

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

  const displayColor = currentTextColor || STROKE_COLORS[0].value;

  const handleColorSelect = (colorValue: string) => {
    updateNodeData(nodeId, {
      style: { ...style, textColor: colorValue },
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
        title="Change Text Color"
        className="h-6 rounded-sm"
      >
        <Baseline style={{ color: displayColor }} />
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
              colors={STROKE_COLORS}
              activeValue={currentTextColor ?? STROKE_COLORS[0].value}
              onSelect={handleColorSelect}
            />
          </div>
        </>
      )}
    </div>
  );
};
