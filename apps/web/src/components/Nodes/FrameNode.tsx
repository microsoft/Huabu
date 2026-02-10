import { type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Ungroup, Lock, Unlock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

type FrameNodeData = NodeDataProps & {};
export type FrameNodeType = Node<FrameNodeData, 'frame'>;

export const FrameNode = ({ id, data, selected }: NodeProps<FrameNodeType>) => {
  const unframe = useCanvasStore((state) => state.unframe);
  const toggleFrameLock = useCanvasStore((state) => state.toggleFrameLock);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

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

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'frame'}
      selected={selected && !isEditingLabel}
      // toolbar={FrameToolbar}
      keepAspectRatio={false}
      allowOverflow
      className={clsx(frameBorderClassName, 'bg-white')}
    >
      <div className="relative h-full p-2">
        <div className="absolute -top-6 left-0 z-10 flex items-center gap-1">
          <div className="relative inline-grid items-center">
            <span className="invisible col-start-1 row-start-1 px-1.5 text-xs font-medium whitespace-pre">
              {draftLabel || ' '}
            </span>

            <input
              ref={labelInputRef}
              value={draftLabel}
              readOnly={!isEditingLabel}
              title="Edit frame name"
              size={1}
              className={clsx(
                'nodrag col-start-1 row-start-1 w-full !min-w-0 bg-transparent px-1.5 text-xs font-medium outline-none',
                isEditingLabel
                  ? 'text-foreground cursor-text'
                  : 'text-muted-foreground hover:text-foreground cursor-pointer',
              )}
              onChange={(e) => isEditingLabel && setDraftLabel(e.target.value)}
              onClick={() => !isEditingLabel && setIsEditingLabel(true)}
              onBlur={() => isEditingLabel && commitLabel()}
              onKeyDown={(e) => {
                if (!isEditingLabel) return;
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitLabel();
                }
                if (e.key === 'Escape') {
                  setDraftLabel(label);
                  setIsEditingLabel(false);
                }
              }}
            />
          </div>

          <div className="text-muted-foreground flex items-center gap-1">
            <div className="bg-border h-3 w-px" />
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
          </div>
        </div>
      </div>
    </NodeWrapper>
  );
};
