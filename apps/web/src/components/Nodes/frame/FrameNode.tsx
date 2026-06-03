import {
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
  resolveAccent,
  type FrameLayoutMode,
} from '@sediment/shared';
import { clampGridCount } from '@sediment/shared/canvas-engine';
import clsx from 'clsx';
import { Columns3, Move, Rows3, Ungroup } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { CanvasFrameNodeData } from '@/components/Nodes/types.ts';
import type { Node, NodeProps } from '@xyflow/react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { Input } from '@/components/Common/Input.tsx';
import { getAccentTokens } from '@/components/Nodes/accentTokens.ts';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

export type FrameNodeType = Node<CanvasFrameNodeData, 'frame'>;

// ── Toolbar metadata ───────────────────────────────────────────────────

const LAYOUT_MODE_OPTIONS: Array<{
  value: FrameLayoutMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: 'free', label: 'Free', icon: <Move /> },
  { value: 'column', label: 'Column', icon: <Columns3 /> },
  { value: 'row', label: 'Row', icon: <Rows3 /> },
];

/**
 * Compact numeric input styled to match the W / H size inputs used in
 * the multi-select toolbar. Narrower (`w-8`) since the value is at most
 * two digits.
 */
const COUNT_INPUT_CLASS =
  'border-edge-default focus:border-info nodrag w-8 rounded border bg-transparent px-1.5 py-0.5 text-center text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

// ── Component ──────────────────────────────────────────────────────────

export const FrameNode = memo(
  ({ id, data, selected }: NodeProps<FrameNodeType>) => {
    const unframe = useCanvasStore((state) => state.unframe);
    const tryRename = useCanvasStore((state) => state.tryRename);
    const dispatchUiIntent = useCanvasStore((state) => state.dispatchUiIntent);
    // Subscribe to the live child count so the count input's upper
    // bound tracks "items inside this frame". Returns a plain number,
    // so this subscription only re-renders FrameNode when the count
    // itself changes.
    const childCount = useCanvasStore(
      (state) => state.nodes.filter((n) => n.parentId === id).length,
    );

    const layoutMode: FrameLayoutMode = data.layoutMode ?? 'free';
    const isStructuredLayout = layoutMode === 'column' || layoutMode === 'row';
    const count = clampGridCount(data.gridCount);

    // Local draft for the count input so the user can type freely
    // without the value reformatting on every keystroke. Re-synced
    // from the canonical value when it changes externally.
    const [countDraft, setCountDraft] = useState(String(count));
    useEffect(() => {
      setCountDraft(String(count));
    }, [count]);

    /**
     * Effective upper bound for the count input:
     *  - At most `FRAME_GRID_MAX_COUNT` (12).
     *  - At most `childCount` so the "no empty track" invariant can
     *    always be satisfied. Empty frames still allow a count of 1.
     */
    const maxCount = Math.min(
      FRAME_GRID_MAX_COUNT,
      Math.max(FRAME_GRID_MIN_COUNT, childCount || FRAME_GRID_MIN_COUNT),
    );

    const commitCount = () => {
      const trimmed = countDraft.trim();
      if (trimmed === '') {
        setCountDraft(String(count));
        return;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) {
        setCountDraft(String(count));
        return;
      }
      // Clamp to [min, maxCount] — exceeding child count is silently
      // capped so the "no empty track" invariant always holds.
      const next = Math.min(maxCount, Math.max(FRAME_GRID_MIN_COUNT, parsed));
      setCountDraft(String(next));
      if (next === count) return;
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: layoutMode,
        gridCount: next,
      });
    };

    // Accent picker → derived background colour (unchanged).
    const accent = resolveAccent(data.style?.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;
    const wrapperData = useMemo(() => {
      const baseStyle = data.style ?? {};
      const nextStyle = accentTokens
        ? { ...baseStyle, backgroundColor: accentTokens.bg }
        : { ...baseStyle, backgroundColor: undefined };
      return { ...data, style: nextStyle };
    }, [data, accentTokens]);

    const setMode = (next: FrameLayoutMode) => {
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: next,
        // Seed the track count when switching into a structured mode so
        // the very first layout pass has a stable value.
        ...((next === 'column' || next === 'row') && {
          gridCount: data.gridCount ?? FRAME_GRID_DEFAULT_COUNT,
        }),
      });
    };

    const FrameActions = (
      <>
        <FloatingToolbar.Select
          options={LAYOUT_MODE_OPTIONS}
          value={layoutMode}
          onChange={setMode}
        />

        {isStructuredLayout && (
          <input
            type="number"
            inputMode="numeric"
            aria-label={layoutMode === 'column' ? 'Columns' : 'Rows'}
            title={
              layoutMode === 'column'
                ? `Columns (1–${maxCount})`
                : `Rows (1–${maxCount})`
            }
            min={FRAME_GRID_MIN_COUNT}
            max={maxCount}
            step={1}
            value={countDraft}
            onChange={(e) => setCountDraft(e.target.value)}
            onBlur={commitCount}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                commitCount();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setCountDraft(String(count));
                (e.target as HTMLInputElement).blur();
              }
            }}
            className={COUNT_INPUT_CLASS}
          />
        )}

        <FloatingToolbar.Divider />

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
        // In structured layout the container size is content-driven;
        // disable manual resize handles so the user can't drift the
        // bounds off the layout.
        resizable={!isStructuredLayout}
        allowOverflow
      >
        <div className="h-full w-full" />
      </NodeWrapper>
    );
  },
);
