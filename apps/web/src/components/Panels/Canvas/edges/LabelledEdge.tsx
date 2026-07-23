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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getAccentTokens } from '@/components/Nodes/accentTokens';
import useCanvasStore from '@/store/canvasStore';
import { useNodeCollapseStore } from '@/store/nodeCollapseStore';
import { TEXT_NODE_PADDING_X } from '@/utils/node/nodeFontConfig';
import { measureTextContent } from '@/utils/node/textMeasure';

import { getEdgeRenderZ } from './edgeZ';

import type { CanvasEdgeId, EdgeStyle } from '@sediment/shared';
import type { EdgeProps } from '@xyflow/react';

/** Hard cap matching the agent-facing `EdgeStyleSchema`. */
const LABEL_MAX_LENGTH = 120;

/** Canvas-space width (px) at which an idle label wraps onto multiple lines. */
const LABEL_WRAP_CAP = 120;
/** Approximate left + right border budget used by tight-width measurement. */
const LABEL_BORDER_INSET = 2;
/** Rendered label font size (px) — kept in sync with the `text-[10px]` class. */
const LABEL_FONT_SIZE = 10;
/**
 * Font used to *measure* the label's tight width. `buildFontStr` only honours
 * `bold`, so `font-medium` is measured as normal and renders a hair wider — a
 * few px of slack (see `tightMaxWidth`) absorbs the gap.
 */
const LABEL_FONT = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  lineHeight: 1.375,
} as const;

function getEdgeStyle(data: EdgeProps['data']): EdgeStyle {
  return (data?.edgeStyle as EdgeStyle | undefined) ?? {};
}

export function LabelledEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
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

  // When an endpoint node is collapsed to its zoom-LOD mark (a centred circle),
  // terminate the edge on that circle instead of the node's hidden card
  // footprint, so the edge stays visually attached to the mark at any aspect
  // ratio. A collapsed node publishes its mark's LIVE canvas-space centre +
  // clip radius, so the edge follows the mark wherever it sits during the
  // corner → centre glide — not a phantom circle at the node centre. Only
  // collapsed question nodes publish geometry; everything else keeps React
  // Flow's handle point.
  const sourceMark = useNodeCollapseStore((s) => s.marks[source]);
  const targetMark = useNodeCollapseStore((s) => s.marks[target]);

  let sx = sourceX;
  let sy = sourceY;
  let tx = targetX;
  let ty = targetY;
  if (sourceMark) {
    const { cx, cy, radius } = sourceMark;
    const dx = tx - cx;
    const dy = ty - cy;
    const len = Math.hypot(dx, dy) || 1;
    sx = cx + (dx / len) * radius;
    sy = cy + (dy / len) * radius;
  }
  if (targetMark) {
    const { cx, cy, radius } = targetMark;
    const dx = sx - cx;
    const dy = sy - cy;
    const len = Math.hypot(dx, dy) || 1;
    tx = cx + (dx / len) * radius;
    ty = cy + (dy / len) * radius;
  }

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
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
    });
  } else if (lineType === 'step') {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      sourcePosition,
      targetPosition,
    });
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      sourcePosition,
      targetPosition,
    });
  }

  // ── Arrow rendering ────────────────────────────────────────────────
  //
  // We use React Flow's built-in SVG `<marker>` (via `markerEnd` /
  // `markerStart` from `applyEdgeStyle`) for every edge type. An earlier
  // attempt to render bezier arrows manually as a `<polygon>` rotated by
  // a non-endpoint tangent was reverted: SVG's `orient="auto"` (= tangent
  // at the endpoint) combined with the path's auto-shortening to the
  // marker's `refX` is what guarantees (a) the arrow back is always
  // flush with the line where the line meets it, and (b) the line is
  // never visible past the arrowhead. A custom rotation breaks both
  // invariants; for our bezier construction `orient="auto"` happens to
  // be axis-aligned, but that's still less jarring than the artifacts
  // a non-matching rotation introduces.
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
  editing: boolean;
  setEditing: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the label on the *same* layer as its edge instead of a fixed
  // high value. The shared `.react-flow__edgelabel-renderer` portal has
  // no z-index of its own and does NOT establish a stacking context, so
  // this number competes directly with the edge SVGs and node wrappers
  // in the viewport (DOM order: edges → edge-label renderer → nodes).
  //
  // Under `zIndexMode="manual"` React Flow paints the edge SVG at
  // `edge.zIndex` verbatim (Sediment assigns that value in `Canvas.tsx`),
  // so `getEdgeRenderZ` simply mirrors `edge.zIndex` and the label always
  // shares its edge line's exact layer. Because DOM order paints the label
  // after the edge but before nodes, at equal z the label sits above its
  // own edge line yet behind any node on the same level — and naturally
  // stays below higher nodes / above lower ones, exactly like the edge.
  // Selection does NOT lift the label (design-tool style:
  // `<ReactFlow elevateNodesOnSelect={false}>` and no edge-z bump);
  // selection feedback comes from stroke/marker styling.
  const edgeZIndex = useStore(
    useCallback(
      (s) => getEdgeRenderZ(s.edgeLookup.get(edgeId)?.zIndex),
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
  // `index.css`); otherwise -> the edge's own stroke colour.
  const useInfoColors = selected || editing;
  const showPlaceholderHint = !hasLabel && !editing;

  // An edge label conveys a *relationship*, which must stay legible even when
  // the connected nodes have shrunk. The pill lives inside the zoomed viewport
  // (`EdgeLabelRenderer`), so a fixed canvas font would render at `font ×
  // zoom` — ~3px at 25% zoom. Counter-scale by a bounded inverse zoom so the
  // label defends roughly its base on-screen size when zoomed out, without
  // shrinking when zoomed in (floor 1×) or ballooning / colliding at very low
  // zoom (cap 2.5×). Only the pill scales (see `pillStyle`); the positioning
  // wrapper is untouched so the midpoint anchor never drifts.
  const zoom = useStore((s) => s.transform[2]);
  const labelScale = Math.min(Math.max(1 / zoom, 1), 2.5);
  // The inverse scale keeps relationship text legible when zoomed out, but
  // scaling the pill's padding by the same amount makes its whitespace look
  // larger than a TextNode's. Counter-scale only the horizontal padding so
  // both surfaces retain the same screen-space inset. Reuse TextNode's
  // canonical padding to keep the two visual contracts in sync.
  const horizontalPadding = TEXT_NODE_PADDING_X / labelScale;

  // Hovering an idle pill expands it to the full label so a long relationship
  // phrase can be read without selecting the edge (see `clampLabel`).
  const [hovered, setHovered] = useState(false);

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
  // Border stays deliberately thin so an unselected pill reads as a quiet
  // annotation on its edge rather than a heavy chip — it no longer tracks the
  // edge's `strokeWidth` (a chunky 8px edge used to get a chunky pill border).
  const borderPx = useInfoColors ? 1.5 : 1;
  // Tint the text toward the edge's own colour so a label visibly belongs to
  // its edge — but via the SAME readability-safe formula as node accents
  // (`getAccentTokens(...).fg`, the single source of truth) rather than the raw
  // stroke colour, which for a pale palette edge (light yellow/green) would be
  // unreadable on the near-white pill. Reusing the shared token also inherits
  // its white/achromatic special-case. Only applied when the edge has an
  // explicit colour and is not selected/editing (those use the neutral
  // info-tinted foreground).
  const textColor =
    !useInfoColors && edgeStrokeColor
      ? getAccentTokens(edgeStrokeColor).fg
      : undefined;
  // Measure the label's longest wrapped line (pretext, no DOM reflow — the
  // same engine node auto-size uses) and pin the pill's max-width to it, so a
  // wrapped label hugs its text instead of padding out to the full wrap cap
  // (a fixed max-width leaves dead space on the shorter lines). While editing
  // we keep the full cap so typing wraps naturally. `Math.ceil(...) + slack`
  // covers the medium/normal weight measurement gap.
  const tightMaxWidth = useMemo(() => {
    if (!hasLabel) return undefined;
    const horizontalInset = horizontalPadding * 2 + LABEL_BORDER_INSET;
    const contentCap = LABEL_WRAP_CAP - horizontalInset;
    const { width } = measureTextContent(value, {
      ...LABEL_FONT,
      fontSize: LABEL_FONT_SIZE,
      maxWidth: contentCap,
    });
    return Math.min(LABEL_WRAP_CAP, Math.ceil(width) + horizontalInset + 3);
  }, [value, hasLabel, horizontalPadding]);
  const pillStyle = {
    borderColor,
    borderWidth: `${borderPx}px`,
    color: textColor,
    paddingLeft: `${horizontalPadding}px`,
    paddingRight: `${horizontalPadding}px`,
    // Idle: hug the measured longest line; editing: keep the full wrap cap.
    maxWidth: editing ? LABEL_WRAP_CAP : tightMaxWidth,
    // Bounded inverse-zoom scaling (see `labelScale`). `transform-origin:
    // center` scales the pill about its own middle, which coincides with the
    // wrapper's translate anchor, so the label stays centred on the edge
    // midpoint at every zoom.
    transform: `scale(${labelScale})`,
    transformOrigin: 'center',
  };

  // Cap the pill width so very long labels wrap onto multiple lines instead of
  // stretching into a ribbon that overlaps nearby nodes. `whitespace-pre-wrap`
  // preserves explicit Shift+Enter newlines; `break-words` handles long single
  // tokens.
  //
  // The empty min-size (`min-w` / `min-h`) is applied whenever the
  // pill has no characters, so the "Add label" hint box and the empty
  // editing box share the exact same dimensions — clicking the hint
  // doesn't make the box visibly shrink. `border-solid` ensures the
  // dynamic `borderStyle` from `pillStyle` defaults to solid even
  // when Tailwind's reset would otherwise leave it as `none`.
  // Idle labels clamp to three lines. Hover, selection, or editing reveals the
  // complete relationship without permanently covering nearby nodes.
  const clampLabel = hasLabel && !useInfoColors && !hovered;
  const pillClasses = [
    'sediment-edge-label',
    'max-w-[120px] cursor-text rounded-md border-solid py-0.5 transition-shadow',
    'text-[10px] font-medium leading-snug break-words',
    'outline-none',
    hovered || useInfoColors ? 'shadow-sm' : 'shadow-none',
    useInfoColors ? 'bg-info-bg text-fg-default' : 'bg-surface text-fg-default',
    clampLabel
      ? 'line-clamp-3 w-fit whitespace-pre-wrap'
      : 'inline-block whitespace-pre-wrap',
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
        aria-label={t('node.edgeLabel')}
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
