import { type Node, type NodeProps, useReactFlow } from '@xyflow/react';
import { clsx } from 'clsx';
import { Bold, Italic, Type } from 'lucide-react';
import { useCallback, useState, useRef } from 'react';

import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector.tsx';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector.tsx';

import {
  NodeWrapper,
  type NodeDataProps,
  type NodeStyle,
} from './NodeWrapper.tsx';

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

const FONT_SIZES = [12, 14, 16, 20, 24, 32, 48, 64];

type TextNodeData = NodeDataProps & {
  content?: string;
};

export type TextNodeType = Node<TextNodeData, 'text'>;

export const TextNode = ({ id, data, selected }: NodeProps<TextNodeType>) => {
  const { updateNodeData } = useReactFlow();
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

  const handleDoubleClick = () => {
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleBlur = () => setIsEditing(false);

  const TextToolbar = (
    <div className="flex w-full items-center gap-2">
      <div
        className="hover:text-main text-muted-foreground relative flex items-center justify-center"
        title="Font Family"
      >
        <Type size={14} />

        <select
          className="absolute inset-0 cursor-pointer opacity-0"
          value={fontFamily}
          onChange={(e) => updateStyle({ fontFamily: e.target.value })}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.name} value={f.value}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      <div
        className="hover:text-main text-muted-foreground relative flex w-8 items-center justify-center"
        title="Font Size"
      >
        <button
          className="border-border hover:bg-muted flex h-6 w-6 items-center justify-center rounded-md border transition-colors"
          onClick={(e) => {
            e.stopPropagation();
          }}
          title="Change Text Color"
        >
          <span className="text-xs font-medium">{fontSize}</span>
        </button>

        <select
          className="absolute inset-0 cursor-pointer opacity-0"
          value={fontSize}
          onChange={(e) => updateStyle({ fontSize: Number(e.target.value) })}
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>
      </div>

      <div className="bg-border mx-1 h-3 w-px" />

      <button
        onClick={() =>
          updateStyle({
            fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
          })
        }
        className={clsx(
          'rounded p-1',
          style.fontWeight === 'bold'
            ? 'text-theme-500 bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Bold size={14} />
      </button>

      <button
        onClick={() =>
          updateStyle({
            fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic',
          })
        }
        className={clsx(
          'rounded p-1',
          style.fontStyle === 'italic'
            ? 'text-theme-500 bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Italic size={14} />
      </button>

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
          onChange={(e) => updateNodeData(id, { content: e.target.value })}
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
