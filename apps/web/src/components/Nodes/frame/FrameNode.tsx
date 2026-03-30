import { type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { LayoutGrid, Ungroup } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import useCanvasStore from '../../../store/canvasStore.ts';
import { Button } from '../../Common/Button.tsx';
import { Input } from '../../Common/Input.tsx';
import { NodeWrapper } from '../NodeWrapper.tsx';

import type { CanvasFrameNodeData } from '../types.ts';

export type FrameNodeType = Node<CanvasFrameNodeData, 'frame'>;

export const FrameNode = memo(
  ({ id, data, selected }: NodeProps<FrameNodeType>) => {
    const unframe = useCanvasStore((state) => state.unframe);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const layoutGroup = useCanvasStore((state) => state.layoutGroup);

    const FrameToolbar = (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title="Layout Children"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            layoutGroup(id);
          }}
        >
          <LayoutGrid />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title="Unframe"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            unframe(id);
          }}
        >
          <Ungroup />
        </Button>
      </div>
    );

    const label = useMemo(() => {
      const raw = typeof data.label === 'string' ? data.label : '';
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : 'Frame';
    }, [data.label]);

    const [isEditingLabel, setIsEditingLabel] = useState(false);
    const [draftLabel, setDraftLabel] = useState(label);
    const labelInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (isEditingLabel) return;
      setDraftLabel(label);
    }, [isEditingLabel, label]);

    useEffect(() => {
      if (!isEditingLabel) return;
      labelInputRef.current?.focus();
      labelInputRef.current?.select();
    }, [isEditingLabel]);

    const commitLabel = () => {
      const next = draftLabel.trim() || 'Frame';
      updateNodeData(id, { label: next, labelSource: 'user' });
      setIsEditingLabel(false);
    };

    // Rendered in the zoom-invariant overlay so the label keeps a fixed screen size
    const labelOverlay = (
      <div className="relative inline-grid items-center">
        <span className="invisible col-start-1 row-start-1 px-1.5 text-xs font-medium whitespace-pre">
          {draftLabel || ' '}
        </span>

        <Input
          ref={labelInputRef}
          value={draftLabel}
          readOnly={!isEditingLabel}
          title="Edit frame name"
          wrapperClassName="col-start-1 row-start-1 min-w-0 w-full"
          tooltipOffset={0}
          size={1}
          className={clsx(
            'nodrag col-start-1 row-start-1 w-full min-w-0! bg-transparent px-1.5 text-xs font-medium outline-none',
            isEditingLabel
              ? 'text-fg-default cursor-text'
              : 'text-fg-muted hover:text-fg-default cursor-pointer',
          )}
          onChange={(e) => {
            if (!isEditingLabel) return;
            setDraftLabel(e.target.value);
          }}
          onClick={() => {
            if (isEditingLabel) return;
            setIsEditingLabel(true);
          }}
          onBlur={() => {
            if (!isEditingLabel) return;
            commitLabel();
          }}
          onKeyDown={(e) => {
            if (!isEditingLabel) return;
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitLabel();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraftLabel(label);
              setIsEditingLabel(false);
            }
          }}
        />
      </div>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'frame'}
        selected={selected && !isEditingLabel}
        toolbar={FrameToolbar}
        overlayContent={labelOverlay}
        overlayOffsetY={-24}
        keepAspectRatio={false}
        allowOverflow
        className="bg-surface"
      >
        <div className="h-full" />
      </NodeWrapper>
    );
  },
);
