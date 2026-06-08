/**
 * `LabelledEdge` — the single edge component registered with React Flow.
 *
 * Renders an editable HTML label at the edge midpoint via React Flow's
 * `EdgeLabelRenderer` portal so users can double-click the edge to type
 * a label directly on the canvas. The label is the same field the
 * agent writes via `CONNECT_NODES` / `SET_EDGE_STYLE`, so human and AI
 * edits share one source of truth.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';

import type { CanvasEdgeId, EdgeStyle } from '@sediment/shared';
import type { EdgeProps } from '@xyflow/react';

/** Hard cap matching the agent-facing `EdgeStyleSchema`. */
const LABEL_MAX_LENGTH = 120;

function getEdgeStyle(data: EdgeProps['data']): EdgeStyle {
  return (data?.edgeStyle as EdgeStyle | undefined) ?? {};
}

export function LabelledEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    markerStart,
    data,
    selected,
  } = props;

  const edgeStyle = getEdgeStyle(data);
  // `data.edgeStyle.lineType` is the source of truth; fall back to the
  // React Flow `type` for legacy edges that pre-date that field.
  const lineType =
    edgeStyle.lineType ??
    (props.type === 'straight'
      ? 'straight'
      : props.type === 'smoothstep' || props.type === 'step'
        ? 'step'
        : 'bezier');

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  if (lineType === 'straight') {
    [edgePath, labelX, labelY] = getStraightPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
    });
  } else if (lineType === 'step') {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
      />
      <EdgeLabelRenderer>
        <EdgeLabelEditor
          edgeId={id}
          labelX={labelX}
          labelY={labelY}
          value={edgeStyle.label ?? ''}
          selected={!!selected}
        />
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * Editable pill rendered on top of the edge midpoint.
 *
 * Visibility:
 *  - Non-empty label: always visible.
 *  - Empty + edge selected: dashed "Add label" hint (double-click to type).
 *  - Empty + not selected: hidden.
 *
 * Edit lifecycle: double-click to enter edit mode; Enter or blur
 * commits; Shift+Enter inserts a newline; Escape reverts; clearing the
 * text deletes the label.
 */
function EdgeLabelEditor({
  edgeId,
  labelX,
  labelY,
  value,
  selected,
}: {
  edgeId: string;
  labelX: number;
  labelY: number;
  value: string;
  selected: boolean;
}) {
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The contentEditable element is managed entirely imperatively —
  // React must never render children into it, or toggling
  // `contentEditable` makes React reconcile children against DOM nodes
  // the browser is now editing, which throws `NotFoundError` and
  // white-screens the canvas. This effect is the sole writer of
  // `textContent`, and only runs while NOT editing.
  useEffect(() => {
    if (editing) return;
    const el = ref.current;
    if (!el) return;
    if (el.textContent !== value) {
      el.textContent = value;
    }
  }, [value, editing]);

  const enterEdit = useCallback(() => {
    if (editing) return;
    setEditing(true);
    // Wait for `contentEditable=true` to land, then place the caret
    // at the end of the existing text.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const raw = ref.current?.textContent ?? '';
    const trimmed = raw.slice(0, LABEL_MAX_LENGTH).trim();
    if (trimmed === value.trim()) {
      // No-op edit — restore canonical DOM in case the user typed and
      // then deleted everything back to the original.
      if (ref.current && ref.current.textContent !== value) {
        ref.current.textContent = value;
      }
      return;
    }
    executeCommands([
      {
        type: 'SET_EDGE_STYLE',
        edges: [
          {
            edge: edgeId as CanvasEdgeId,
            style:
              trimmed.length === 0
                ? { label: undefined, labelSource: undefined }
                : { label: trimmed, labelSource: 'user' },
          },
        ],
      },
    ]);
  }, [edgeId, executeCommands, value]);

  const cancel = useCallback(() => {
    if (ref.current) ref.current.textContent = value;
    setEditing(false);
  }, [value]);

  const hasLabel = value.length > 0;
  if (!hasLabel && !selected && !editing) return null;

  // Pill colour tracks the edge selection highlight: selected or
  // actively editing → info blue; otherwise neutral surface.
  const useInfoColors = selected || editing;
  const showPlaceholderHint = !hasLabel && !editing;

  const pillClasses = [
    'block min-w-[40px] max-w-[92px] cursor-text rounded-md border px-2 py-0.5',
    'text-[11px] font-medium leading-snug whitespace-pre-wrap break-words',
    'outline-none',
    useInfoColors
      ? 'bg-info-bg text-fg-default border-info'
      : 'bg-surface text-fg-default border-edge-default',
    showPlaceholderHint ? 'border-dashed' : '',
    editing ? 'focus:ring-1 focus:ring-[color:var(--color-info)]' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      // `nodrag nopan` keeps clicks on the pill from being interpreted
      // as canvas drag / pan gestures.
      className="nodrag nopan absolute"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        pointerEvents: 'all',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        enterEdit();
      }}
    >
      {/* Editable pill — never render React children inside (see effect above). */}
      <div
        ref={ref}
        contentEditable={editing}
        suppressContentEditableWarning
        aria-label="Edge label"
        title={hasLabel && !editing ? value : undefined}
        spellCheck={editing}
        onBlur={commit}
        onPaste={(e) => {
          // Strip clipboard HTML; insert plain text at the caret.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
        onKeyDown={(e) => {
          if (!editing) return;
          // Stop canvas shortcuts (Backspace/Delete/arrows) from
          // firing while typing.
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            ref.current?.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
            ref.current?.blur();
          }
        }}
        className={pillClasses}
      />
      {showPlaceholderHint && (
        // Sibling overlay (not a CSS pseudo, which `innerText` can
        // leak into `textContent` in some browsers). `pointer-events-
        // none` lets the double-click pass through to the editable
        // div underneath.
        <div
          aria-hidden="true"
          className="text-fg-subtle pointer-events-none absolute inset-0 flex items-center justify-center px-2 py-0.5 text-[11px] font-medium select-none"
        >
          Add label
        </div>
      )}
    </div>
  );
}
