import { resolveAccent } from '@sediment/shared';
import clsx from 'clsx';
import { Ungroup } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { Input } from '@/components/Common/Input.tsx';
import { getAccentTokens } from '@/components/Nodes/accentTokens.ts';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

import type { CanvasFrameNodeData } from '@/components/Nodes/types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type FrameNodeType = Node<CanvasFrameNodeData, 'frame'>;

export const FrameNode = memo(
  ({ id, data, selected }: NodeProps<FrameNodeType>) => {
    const unframe = useCanvasStore((state) => state.unframe);
    const tryRename = useCanvasStore((state) => state.tryRename);

    // Single source of styling: the accent picker (added by NodeWrapper).
    // When an accent is set, derive the same `bg` token used by
    // SemanticPlaceholder and inject it as the wrapper's backgroundColor so
    // the frame fills with the chosen tint. When no accent is set we
    // explicitly null the backgroundColor so any legacy persisted value can
    // not leak through and make Transparent appear coloured.
    const accent = resolveAccent(data.style?.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;
    const wrapperData = useMemo(() => {
      const baseStyle = data.style ?? {};
      const nextStyle = accentTokens
        ? { ...baseStyle, backgroundColor: accentTokens.bg }
        : { ...baseStyle, backgroundColor: undefined };
      return { ...data, style: nextStyle };
    }, [data, accentTokens]);

    const FrameActions = (
      <>
        <FloatingToolbar.ActionButton
          title="Unframe"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            unframe(id);
          }}
        >
          <Ungroup />
        </FloatingToolbar.ActionButton>
      </>
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
      // Route through tryRename so a sibling-label collision triggers the
      // shared alert + revert flow instead of silently overwriting state.
      void tryRename('node', id, next).then((accepted) => {
        if (!accepted) setDraftLabel(label);
      });
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
        data={wrapperData}
        type={'frame'}
        selected={selected && !isEditingLabel}
        actions={FrameActions}
        overlayContent={labelOverlay}
        overlayOffsetY={-24}
        keepAspectRatio={false}
        allowOverflow
      >
        <div className="h-full" />
      </NodeWrapper>
    );
  },
);
