import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Bold, Italic, Type, Underline, Strikethrough } from 'lucide-react';
import { useCallback, useState, useRef, useEffect } from 'react';

import { GhostButton } from '@/components/Common/GhostButton.tsx';
import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector.tsx';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from './NodeWrapper.tsx';

import type { CanvasTextNodeData, NodeStyle } from './types.ts';

const FONT_FAMILIES = [
  { name: 'Default', value: 'ui-sans-serif, system-ui, sans-serif' },
  {
    name: 'Serif',
    value: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    name: 'Mono',
    value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  { name: 'Hand', value: '"Comic Sans MS", "Chalkboard SE", sans-serif' },
];

export type TextNodeType = Node<CanvasTextNodeData, 'text'>;

export const TextNode = ({ id, data, selected }: NodeProps<TextNodeType>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const updateStyle = useCallback(
    (newStyle: Partial<NodeStyle>) => {
      updateNodeData(id, {
        style: {
          ...data.style,
          ...newStyle,
        },
      });
    },
    [id, data.style, updateNodeData],
  );

  const style = data.style || {};
  const isBold = style.fontWeight === 'bold';
  const isItalic = style.fontStyle === 'italic';
  const fontSize = style.fontSize || 16;
  const fontFamily = style.fontFamily || FONT_FAMILIES[0].value;
  const textColor = style.textColor;
  const textDecoration = style.textDecoration || '';

  const [inputFontSize, setInputFontSize] = useState<string | number>(fontSize);
  useEffect(() => {
    setInputFontSize(fontSize);
  }, [fontSize]);

  const toggleDecoration = (value: string) => {
    let current = textDecoration.split(' ').filter(Boolean);
    if (current.includes(value)) {
      current = current.filter((v) => v !== value);
    } else {
      current.push(value);
    }
    updateStyle({ textDecoration: current.join(' ') });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleBlur = () => setIsEditing(false);

  const TextToolbar = (
    <div className="flex w-full items-center gap-1">
      <div className="text-muted-foreground flex flex-1 items-center text-xs font-medium">
        <Type size={14} />
      </div>
      <div className="bg-border h-3 w-px" />
      <div
        className="hover:bg-muted text-muted-foreground border-border flex items-center rounded border bg-transparent p-0.5 transition-colors"
        title="Font Family"
      >
        <select
          className="h-full w-16 cursor-pointer bg-transparent text-xs outline-none"
          value={fontFamily}
          onChange={(e) => updateStyle({ fontFamily: e.target.value })}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.name} value={f.value} className="text-black">
              {f.name}
            </option>
          ))}
        </select>
      </div>

      <div
        className="hover:bg-muted text-muted-foreground border-border flex items-center justify-center rounded border bg-transparent p-0.5 transition-colors"
        title="Font Size"
      >
        <input
          type="number"
          className="w-6 [appearance:textfield] bg-transparent text-center text-xs font-medium outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={inputFontSize}
          min={8}
          max={200}
          onChange={(e) => {
            const valStr = e.target.value;
            setInputFontSize(valStr);
            const val = Number(valStr);
            if (valStr !== '' && !isNaN(val) && val >= 0) {
              updateStyle({ fontSize: val });
            }
          }}
          onBlur={() => {
            if (inputFontSize === '' || Number(inputFontSize) === 0) {
              setInputFontSize(fontSize);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const newVal = (Number(inputFontSize) || 16) + 1;
              updateStyle({ fontSize: newVal });
              setInputFontSize(newVal);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const newVal = Math.max(1, (Number(inputFontSize) || 16) - 1);
              updateStyle({ fontSize: newVal });
              setInputFontSize(newVal);
            }
          }}
        />
        <span className="px-0.5 text-[8px] opacity-50 select-none">px</span>
      </div>

      <div className="bg-border mx-1 h-3 w-px" />

      <GhostButton
        onClick={() =>
          updateStyle({
            fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
          })
        }
        className={clsx(
          'rounded p-1',
          style.fontWeight === 'bold'
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Bold size={14} />
      </GhostButton>

      <GhostButton
        onClick={() =>
          updateStyle({
            fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic',
          })
        }
        className={clsx(
          'rounded p-1',
          style.fontStyle === 'italic'
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Italic size={14} />
      </GhostButton>

      <GhostButton
        onClick={() => toggleDecoration('underline')}
        className={clsx(
          'p-1',
          textDecoration.includes('underline')
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Underline size={14} />
      </GhostButton>

      <GhostButton
        onClick={() => toggleDecoration('line-through')}
        className={clsx(
          'p-1',
          textDecoration.includes('line-through')
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Strikethrough size={14} />
      </GhostButton>

      <div className="bg-border mx-1 h-3 w-px" />

      <NodeTextColorSelector
        nodeId={id}
        currentTextColor={data.style?.textColor}
        style={data.style}
      />
      <NodeBgColorSelector
        nodeId={id}
        currentColor={data.style?.backgroundColor}
        style={data.style}
      />
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'text'}
      selected={selected}
      toolbar={TextToolbar}
      keepAspectRatio={false}
      className="transition-all duration-200"
    >
      <div
        className="flex h-full flex-col p-2"
        onDoubleClick={handleDoubleClick}
        style={{
          color: textColor,
          fontWeight: isBold ? 'bold' : 'normal',
          fontStyle: isItalic ? 'italic' : 'normal',
          fontFamily: fontFamily,
          fontSize: `${fontSize}px`,
          lineHeight: 1.5,
          textDecoration: textDecoration,
        }}
      >
        <textarea
          ref={textareaRef}
          className={clsx(
            'placeholder:text-muted-foreground/30 h-full w-full resize-none overflow-hidden bg-transparent outline-none',
            isEditing
              ? 'nodrag cursor-text'
              : 'pointer-events-none cursor-grab select-none',
          )}
          placeholder="Double click to edit..."
          defaultValue={data.content}
          onChange={(e) => {
            const content = e.target.value;
            const isLabelUserSet = data.labelSource === 'user';
            const patch: Record<string, unknown> = { content };
            if (!isLabelUserSet) {
              const firstLine = content.split('\n')[0].trim().slice(0, 50);
              if (firstLine) {
                patch.label = firstLine;
                patch.labelSource = 'auto';
              }
            }
            updateNodeData(id, patch);
          }}
          onBlur={handleBlur}
          readOnly={!isEditing}
          style={{
            color: 'inherit',
            fontWeight: 'inherit',
            fontStyle: 'inherit',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        />
      </div>
    </NodeWrapper>
  );
};
