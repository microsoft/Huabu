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
  useStore,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';

import { getEdgeRenderZ } from './edgeZ';

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
        <EdgeLabelHost
          edgeId={id}
          labelX={labelX}
          labelY={labelY}
          value={edgeStyle.label ?? ''}
          selected={!!selected}
          edgeStrokeColor={
            typeof style?.stroke === 'string' ? style.stroke : undefined
          }
          edgeStrokeWidth={
            typeof style?.strokeWidth === 'number'
              ? style.strokeWidth
              : typeof style?.strokeWidth === 'string'
                ? Number(style.strokeWidth) || undefined
                : undefined
          }
        />
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * Window event dispatched from the canvas-level `onEdgeDoubleClick`
 * handler — see `Canvas.tsx`. The matching `LabelledEdge` listens for
 * its own id and jumps straight into edit mode so users can double-
 * click an edge directly without first single-clicking to reveal the
 * placeholder pill.
 */
export const EDIT_EDGE_LABEL_EVENT = 'sediment:edit-edge-label';

export interface EditEdgeLabelDetail {
  edgeId: string;
}

/**
 * Lightweight gate around {@link EdgeLabelEditor}. Owns the `editing`
 * state so we can decide whether to mount the heavy editor at all
 * without breaking its in-progress edit lifecycle. When the label is
 * empty AND the edge isn't selected AND the user isn't editing, this
 * returns null and the editor (with its per-edge `useStore`
 * subscription on `edgeLookup`/`nodeLookup`) is never mounted —
 * which keeps render cost flat for canvases full of unlabelled edges.
 */
function EdgeLabelHost(props: {
  edgeId: string;
  labelX: number;
  labelY: number;
  value: string;
  selected: boolean;
  edgeStrokeColor: string | undefined;
  edgeStrokeWidth: number | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const hasLabel = props.value.length > 0;
  if (!hasLabel && !props.selected && !editing) return null;
  return (
    <EdgeLabelEditor {...props} editing={editing} setEditing={setEditing} />
  );
}

/**
 * Editable pill rendered on top of the edge midpoint.
 *
 * Visibility:
 *  - Non-empty label: always visible.
 *  - Empty + edge selected: solid "Add label" hint pill (single-click to type).
 *  - Empty + not selected: hidden.
 *
 * Edit lifecycle: single-click the hint pill (or double-click the
 * edge / pill) to enter edit mode; Enter or blur commits;
 * Shift+Enter inserts a newline; Escape reverts; clearing the text
 * deletes the label.
 */
function EdgeLabelEditor({
  edgeId,
  labelX,
  labelY,
  value,
  selected,
  edgeStrokeColor,
  edgeStrokeWidth,
  editing,
  setEditing,
}: {
  edgeId: string;
  labelX: number;
  labelY: number;
  value: string;
  selected: boolean;
  /**
   * Already CSS-resolved (see `applyEdgeStyle`). Drives the label
   * border colour when the edge is NOT selected, so the pill always
   * visually "belongs" to its edge regardless of palette colour.
   */
  edgeStrokeColor: string | undefined;
  /**
   * Edge `strokeWidth` (px). Drives the label border thickness so a
   * 4px edge gets a beefier pill border than a 1px edge; clamped to
   * a small range so chunky edges don't produce chunky pills.
   */
  edgeStrokeWidth: number | undefined;
  editing: boolean;
  setEditing: (next: boolean) => void;
}) {
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the label on the *same* layer as its edge instead of a fixed
  // high value. The shared `.react-flow__edgelabel-renderer` portal has
  // no z-index of its own and does NOT establish a stacking context, so
  // this number competes directly with the edge SVGs and node wrappers
  // in the viewport (DOM order: edges → edge-label renderer → nodes).
  //
  // `getEdgeRenderZ` is a faithful mirror of React Flow's internal
  // edge render formula (`edge.zIndex + max(endpoints.internals.z)`),
  // so the label always shares its edge line's exact layer. Because DOM
  // order paints the label after the edge but before nodes, at equal z
  // the label sits above its own edge line yet behind any node on the
  // same level — and naturally stays below higher nodes / above lower
  // ones, exactly like the edge. Selection lift is handled by Canvas
  // bumping the edge's `zIndex` by `EDGE_SELECTED_Z_BUMP` in
  // `displayEdges`, which the label inherits via `edge.zIndex`.
  const edgeZIndex = useStore(
    useCallback(
      (s) => {
        const edge = s.edgeLookup.get(edgeId);
        if (!edge) return 0;
        return getEdgeRenderZ(
          edge.zIndex,
          s.nodeLookup.get(edge.source)?.internals.z,
          s.nodeLookup.get(edge.target)?.internals.z,
        );
      },
      [edgeId],
    ),
  );

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
  }, [editing, setEditing]);

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
  }, [edgeId, executeCommands, setEditing, value]);

  const cancel = useCallback(() => {
    if (ref.current) ref.current.textContent = value;
    setEditing(false);
  }, [setEditing, value]);

  // Listen for the canvas-level `onEdgeDoubleClick` signal so a
  // double-click on the edge path jumps straight into edit mode
  // without requiring a second click on the placeholder pill.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<EditEdgeLabelDetail>).detail;
      if (detail?.edgeId === edgeId) enterEdit();
    };
    window.addEventListener(EDIT_EDGE_LABEL_EVENT, handler);
    return () => window.removeEventListener(EDIT_EDGE_LABEL_EVENT, handler);
  }, [edgeId, enterEdit]);

  const hasLabel = value.length > 0;

  // Background tint tracks the selection / edit state, but the border
  // is always solid: selected / editing -> info blue (matches React
  // Flow's `.react-flow__edge.selected` stroke override in
  // `index.css`); otherwise -> the edge's own stroke colour. Border
  // thickness follows the edge `strokeWidth`, clamped to keep the pill
  // legible on both 1px hairline edges and chunky 8px edges.
  const useInfoColors = selected || editing;
  const showPlaceholderHint = !hasLabel && !editing;

  // When the edge has no explicit `style.stroke`, the SVG path renders
  // with React Flow's default token (`--xy-edge-stroke-default`, which
  // resolves to `#b1b1b7` light / `#3e3e3e` dark — see
  // `@xyflow/react/dist/base.css`). Fall back to the same token here
  // so the pill border matches a freshly-created edge's grey stroke
  // instead of jumping to info-blue once focus is lost.
  const borderColor = useInfoColors
    ? 'var(--color-info)'
    : (edgeStrokeColor ??
      'var(--xy-edge-stroke, var(--xy-edge-stroke-default))');
  const borderPx = Math.min(Math.max(edgeStrokeWidth ?? 1, 1), 3);
  const pillStyle = {
    borderColor,
    borderWidth: `${borderPx}px`,
  };

  // Cap the pill width so very long labels wrap onto multiple lines
  // instead of stretching into a long single-line ribbon that visually
  // dominates the canvas. The cap is generous (~30 CJK chars / ~50
  // Latin chars at 11px) so most labels still fit on one line, but
  // anything longer wraps naturally. `whitespace-pre-wrap` preserves
  // explicit Shift+Enter newlines; `break-words` lets very long
  // single tokens break instead of overflowing.
  //
  // The empty min-size (`min-w` / `min-h`) is applied whenever the
  // pill has no characters, so the "Add label" hint box and the empty
  // editing box share the exact same dimensions — clicking the hint
  // doesn't make the box visibly shrink. `border-solid` ensures the
  // dynamic `borderStyle` from `pillStyle` defaults to solid even
  // when Tailwind's reset would otherwise leave it as `none`.
  const pillClasses = [
    'sediment-edge-label',
    'inline-block max-w-[120px] cursor-text rounded-md border-solid px-2 py-0.5',
    'text-[11px] font-medium leading-snug whitespace-pre-wrap break-words',
    'outline-none',
    useInfoColors ? 'bg-info-bg text-fg-default' : 'bg-surface text-fg-default',
    hasLabel ? '' : 'min-w-[72px] min-h-[20px]',
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
        // Match the edge's own z-index (see `edgeZIndex` above) so the
        // label tracks its edge's layer: above the edge line, behind
        // sibling nodes on the same frame level.
        zIndex: edgeZIndex,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        // When the "Add label" hint is visible the edge is already
        // selected, so a single click on the pill is the most natural
        // way to start typing — promote it to enter edit mode. Pills
        // that already hold text still require a double click (so
        // single clicks can re-position the caret in the surrounding
        // canvas without accidentally entering edit).
        if (!showPlaceholderHint) return;
        e.stopPropagation();
        enterEdit();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        enterEdit();
      }}
    >
      {/*
       * Editable pill — never render React children inside (see effect
       * above). When the field is empty and not focused, an "Add
       * label" hint is painted via the `.sediment-edge-label:empty::
       * before` rule in `index.css`; that pseudo guarantees the hint
       * and editing states share the exact same DOM box (no sibling
       * overlay to drift).
       */}
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
        style={pillStyle}
        className={pillClasses}
      />
    </div>
  );
}
