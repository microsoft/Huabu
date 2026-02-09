import { type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Layers, Ungroup, Lock, Unlock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import useStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

type FrameNodeData = NodeDataProps & {};
export type FrameNodeType = Node<FrameNodeData, 'frame'>;

export const FrameNode = ({ id, data, selected }: NodeProps<FrameNodeType>) => {
  const unframe = useStore((state) => state.unframe);
  const toggleFrameLock = useStore((state) => state.toggleFrameLock);
  const updateNodeData = useStore((state) => state.updateNodeData);

  const frameBorderClassName = selected
    ? "ring-0 hover:ring-0 before:pointer-events-none before:absolute before:inset-0 before:rounded before:content-[''] before:border before:border-theme-500"
    : "ring-0 hover:ring-0 before:pointer-events-none before:absolute before:inset-0 before:overflow-hidden before:rounded before:content-[''] before:text-icon before:[background:repeating-linear-gradient(90deg,currentColor_0_10px,transparent_10px_18px)_top/100%_1px_no-repeat,repeating-linear-gradient(90deg,currentColor_0_10px,transparent_10px_18px)_bottom/100%_1px_no-repeat,repeating-linear-gradient(0deg,currentColor_0_10px,transparent_10px_18px)_left/1px_100%_no-repeat,repeating-linear-gradient(0deg,currentColor_0_10px,transparent_10px_18px)_right/1px_100%_no-repeat]";

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
    updateNodeData(id, { label: next });
    setIsEditingLabel(false);
  };

  const FrameToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Label */}
      <div className="text-muted-foreground flex flex-1 items-center gap-2 text-xs font-medium">
        <Layers size={14} />
        <span className="truncate">{label}</span>
      </div>

      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <GhostButton
          title="Unframe"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            unframe(id);
          }}
        >
          <Ungroup size={14} />
        </GhostButton>
        {/* Lock auto-frame */}
        <GhostButton
          title={data.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFrameLock(id);
          }}
        >
          {data.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </GhostButton>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected && !isEditingLabel}
      toolbar={FrameToolbar}
      keepAspectRatio={false}
      allowOverflow
      className={clsx(frameBorderClassName, 'bg-white')}
    >
      <div className="relative h-full w-full p-2">
        <div className="absolute -top-6 left-2 z-10">
          <input
            ref={labelInputRef}
            className={
              isEditingLabel
                ? 'border-border text-foreground nodrag h-6 border bg-white px-2 text-xs font-medium outline-none'
                : 'text-muted-foreground hover:text-foreground nodrag h-6 rounded border border-transparent bg-transparent px-1 text-xs font-medium outline-none'
            }
            value={draftLabel}
            readOnly={!isEditingLabel}
            title="Edit frame name"
            onChange={(e) => {
              if (!isEditingLabel) return;
              setDraftLabel(e.target.value);
            }}
            onPointerDown={(e) => {
              if (!isEditingLabel) return;
              e.stopPropagation();
            }}
            onClick={() => {
              if (!isEditingLabel) setIsEditingLabel(true);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (!isEditingLabel) return;

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
            onBlur={() => {
              if (!isEditingLabel) return;
              commitLabel();
            }}
          />
        </div>
      </div>
    </NodeWrapper>
  );
};
