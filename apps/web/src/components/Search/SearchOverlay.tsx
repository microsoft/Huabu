/**
 * Canvas-wide search overlay.
 *
 * Floating panel anchored top-centre by default and **draggable**
 * (grab the header bar) so a long results list can be moved off
 * any node the user wants to see while picking a hit. Opened by
 * Cmd+F outside any preview. Lists matches across every node on
 * the active canvas, grouped by tier (metadata first, then
 * content). Clicking a row focuses the matching node on the canvas
 * (`fitView` + select) and, for content matches, opens the
 * in-canvas preview so the highlight layer can render the snippet
 * in context.
 *
 * Keyboard:
 *   - Esc        : close
 *   - Enter      : jump to first result
 *   - ↑ / ↓      : navigate the result list
 *
 * Closes automatically when the canvas switches (the store's
 * `canvasId` changes), so we don't show stale results.
 */

import { Search, X, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTextHighlight } from '../../hooks/useTextHighlight';
import useCanvasStore from '../../store/canvasStore';
import { useSearchStore, type SearchResultRow } from '../../store/searchStore';
import { Button } from '../Common/Button';
import { cn } from '../Common/cn';

const ROW_HEIGHT = 52;

export const SearchOverlay = (): JSX.Element | null => {
  const scope = useSearchStore((s) => s.scope);
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const isStreaming = useSearchStore((s) => s.isStreaming);
  const contentPhase = useSearchStore((s) => s.contentPhase);
  const truncated = useSearchStore((s) => s.truncated);
  const error = useSearchStore((s) => s.error);
  const setQuery = useSearchStore((s) => s.setQuery);
  const close = useSearchStore((s) => s.close);

  const canvasId = useCanvasStore((s) => s.canvasId);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const openExpanded = useCanvasStore((s) => s.openExpanded);
  const rfInstance = useCanvasStore((s) => s.rfInstance);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // Canvas DOM root used as the highlight scope. Resolved lazily on
  // open via `[data-canvas-root]` so the same `useTextHighlight` hook
  // that paints inline matches in the preview also paints them on
  // node bodies / labels visible on the canvas itself.
  const [canvasRoot, setCanvasRoot] = useState<HTMLElement | null>(null);
  // Drag offset relative to viewport (px). `null` = use default
  // top-centre anchor. Drag state lives in the component (and not
  // the store) because position is purely transient UI — clearing
  // it on close gives a fresh overlay back to centre next time.
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    panelX: number;
    panelY: number;
  } | null>(null);

  // Only render for canvas-scope. Node-scope uses InPreviewSearchBar.
  const isCanvasScope = scope?.kind === 'canvas';

  // Auto-focus on open + reset drag offset so each new session
  // starts from the default anchor.
  useEffect(() => {
    if (isCanvasScope) {
      setOffset(null);
      setCanvasRoot(
        document.querySelector<HTMLElement>('[data-canvas-root]') ?? null,
      );
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      // Drop the reference so the highlight hook clears its ranges
      // (it bails when `container` is null).
      setCanvasRoot(null);
    }
  }, [isCanvasScope]);

  // Paint the same `::highlight(sediment-search)` ranges over node
  // labels and Milkdown bodies that are visible on the canvas. The
  // hook's MutationObserver picks up nodes that mount lazily (e.g.
  // a note's editor surface).
  useTextHighlight({
    container: isCanvasScope ? canvasRoot : null,
    query,
    maxRanges: 800,
  });

  // Close on canvas switch so stale results don't show through.
  useEffect(() => {
    if (scope && scope.canvasId !== canvasId) close();
  }, [scope, canvasId, close]);

  // Reset selection when results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  const focusNodeOnCanvas = useCallback(
    (nodeId: string) => {
      selectNodes([nodeId], false);
      if (rfInstance) {
        void rfInstance.fitView({
          nodes: [{ id: nodeId }],
          duration: 400,
          maxZoom: 1,
        });
      }
    },
    [selectNodes, rfInstance],
  );

  const jumpToResult = useCallback(
    (row: SearchResultRow) => {
      const { nodeId } = row.match;
      focusNodeOnCanvas(nodeId);
      // Always open the expanded preview on Enter / row click so the
      // gesture behaves consistently across tiers. Without this, PDFs
      // (whose sidecar body is intentionally empty — the text layer is
      // re-extracted on demand) would only ever surface as metadata
      // matches and the row would feel inert when activated.
      openExpanded(nodeId);
    },
    [focusNodeOnCanvas, openExpanded],
  );

  // Live-follow the active row on the canvas so ↑ / ↓ visibly pans /
  // zooms to each hit. Without this the viewport stays parked on
  // wherever the user last clicked, which makes it feel like Cmd+F
  // "only ever focuses the first match". `fitView` is animated and
  // idempotent so re-running it on the same node is a no-op.
  useEffect(() => {
    if (!isCanvasScope) return;
    const row = results[activeIdx];
    if (!row) return;
    focusNodeOnCanvas(row.match.nodeId);
  }, [isCanvasScope, results, activeIdx, focusNodeOnCanvas]);

  // Keyboard handling lives on `window` (not on the panel's React
  // `onKeyDown`) because the live-follow effect calls `selectNodes`,
  // which makes React Flow focus the selected node wrapper — pulling
  // focus out of the search input and silencing any panel-scoped
  // keydown handler. Binding at the window level keeps Esc / Enter /
  // arrows working regardless of which element ended up focused.
  // Capture phase so we beat any canvas-level Escape handler (the
  // expanded preview panel listens at the bubble phase, so capture +
  // `stopPropagation` cleanly avoids closing both at once).
  //
  // LOAD-BEARING — capture phase + stopPropagation here suppresses
  // *all* canvas-level Enter / Arrow / Escape handlers while the
  // overlay is mounted. That is intentional (we own the keyboard
  // while searching), but if you ever add a global shortcut that
  // also fires on these keys, you'll need to negotiate via
  // `e.defaultPrevented` or a dedicated key-router rather than
  // expecting your bubble-phase listener to run.
  useEffect(() => {
    if (!isCanvasScope) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const row = results[activeIdx];
        if (row) jumpToResult(row);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(results.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isCanvasScope, results, activeIdx, jumpToResult, close]);

  // Drag handlers — bound to the whole panel. Click-vs-drag is
  // disambiguated by a movement threshold: pointer capture (and the
  // actual panel translation) is only started after the cursor moves
  // more than `DRAG_THRESHOLD` pixels from the pointerdown origin.
  // This keeps row clicks (jump-to-result), button clicks, and text
  // selection inside the input working without an explicit drag
  // handle — a small wobble during a click never starts a drag, and
  // a real drag naturally suppresses the click on the underlying
  // result row (the row's `click` synth needs pointerdown + pointerup
  // on the same element; pointer capture redirects the up event to
  // the panel, so the row click never fires).
  const DRAG_THRESHOLD_PX = 4;
  const onPanelPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!panelRef.current) return;
      // Native text fields must keep selection / focus, scrollbars
      // must keep dragging the scroll thumb — never intercept those.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea')) return;
      const rect = panelRef.current.getBoundingClientRect();
      dragOriginRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        panelX: rect.left,
        panelY: rect.top,
      };
    },
    [],
  );

  const onPanelPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const dx = e.clientX - origin.pointerX;
      const dy = e.clientY - origin.pointerY;
      // Below the threshold: still possibly a click; do nothing.
      if (
        !e.currentTarget.hasPointerCapture(e.pointerId) &&
        dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
      ) {
        return;
      }
      // Promote to drag on first crossing. Pointer capture redirects
      // the eventual pointerup to the panel, which is what suppresses
      // the click on whatever row sat under the cursor.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      // Clamp inside viewport — leave 8px breathing room so the
      // panel can't be dragged completely off-screen.
      const panel = panelRef.current;
      const margin = 8;
      const w = panel?.offsetWidth ?? 0;
      const h = panel?.offsetHeight ?? 0;
      const nextX = Math.min(
        Math.max(margin, origin.panelX + dx),
        window.innerWidth - w - margin,
      );
      const nextY = Math.min(
        Math.max(margin, origin.panelY + dy),
        window.innerHeight - h - margin,
      );
      setOffset({ x: nextX, y: nextY });
    },
    [],
  );

  const onPanelPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragOriginRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-row-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const grouped = useMemo(() => {
    const meta = results.filter((r) => r.tier === 'meta');
    const content = results.filter((r) => r.tier === 'content');
    return { meta, content };
  }, [results]);

  if (!isCanvasScope) return null;

  const showEmpty =
    !isStreaming && query.trim().length > 0 && results.length === 0 && !error;

  // Outer wrapper: no flex when dragged so absolute positioning takes
  // over; otherwise centre via flex so the default anchor remains
  // viewport-relative (no layout thrash on window resize).
  const wrapperClass = offset
    ? 'pointer-events-none fixed inset-0 z-1200'
    : 'pointer-events-none fixed inset-x-0 top-12 z-1200 flex justify-center';

  const panelStyle: React.CSSProperties | undefined = offset
    ? { position: 'absolute', left: offset.x, top: offset.y }
    : undefined;

  return (
    <div className={wrapperClass} onClick={(e) => e.stopPropagation()}>
      <div
        ref={panelRef}
        style={panelStyle}
        className="border-edge-default bg-surface pointer-events-auto flex w-100 max-w-[92vw] cursor-grab flex-col overflow-hidden rounded-lg border shadow-xl select-none active:cursor-grabbing"
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={onPanelPointerUp}
        onPointerCancel={onPanelPointerUp}
      >
        {/* Input row. The whole panel is draggable; the input has
            `cursor-text` + `select-text` so it overrides the panel's
            grab cursor and keeps native text editing intact. */}
        <div className="border-edge-default flex items-center gap-1.5 border-b py-1.5 pr-1.5 pl-2">
          <Search size={14} className="text-fg-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search on canvas…"
            onChange={(e) => setQuery(e.target.value)}
            className="placeholder:text-fg-subtle text-fg-default min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none select-text"
          />
          {isStreaming && (
            <Loader2
              size={12}
              className="text-fg-subtle shrink-0 animate-spin"
              aria-label="Searching"
            />
          )}
          <span className="text-fg-subtle shrink-0 text-[11px] tabular-nums">
            {results.length > 0 ? `${results.length}` : ''}
          </span>
          <Button
            variant="solid"
            tone="neutral"
            shape="pill"
            iconOnly
            size="sm"
            className="p-0.5"
            title="Close (Esc)"
            onClick={close}
          >
            <X />
          </Button>
        </div>

        {/* Results / status */}
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
          {error && (
            <div className="text-danger px-3 py-3 text-sm">{error}</div>
          )}

          {!error && grouped.meta.length > 0 && (
            <ResultGroup
              label="Titles, summaries & keywords"
              rows={grouped.meta}
              indexBase={0}
              activeIdx={activeIdx}
              onClickRow={(idx, row) => {
                setActiveIdx(idx);
                jumpToResult(row);
              }}
            />
          )}

          {!error && grouped.content.length > 0 && (
            <ResultGroup
              label="In note contents"
              rows={grouped.content}
              indexBase={grouped.meta.length}
              activeIdx={activeIdx}
              onClickRow={(idx, row) => {
                setActiveIdx(idx);
                jumpToResult(row);
              }}
            />
          )}

          {!error && showEmpty && (
            <div className="text-fg-subtle px-3 py-5 text-center text-xs">
              No matches
            </div>
          )}

          {!error && query.trim().length === 0 && (
            <div className="text-fg-subtle px-3 py-5 text-center text-xs">
              Start typing to search this canvas.
            </div>
          )}

          {!error && isStreaming && contentPhase && (
            <div className="text-fg-subtle border-edge-default border-t px-3 py-1.5 text-[11px]">
              Searching note contents…
            </div>
          )}

          {!error && truncated && (
            <div className="text-warning border-edge-default border-t px-3 py-1.5 text-[11px]">
              Showing first {results.length}. Refine your query.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface ResultGroupProps {
  label: string;
  rows: SearchResultRow[];
  /** Global index offset so keyboard nav crosses both groups. */
  indexBase: number;
  activeIdx: number;
  onClickRow: (globalIdx: number, row: SearchResultRow) => void;
}

const ResultGroup = ({
  label,
  rows,
  indexBase,
  activeIdx,
  onClickRow,
}: ResultGroupProps): JSX.Element => (
  <div>
    <div className="bg-bg-default text-fg-subtle sticky top-0 px-3 py-1 text-[11px] tracking-wide uppercase">
      {label}
    </div>
    <ul>
      {rows.map((row, i) => {
        const globalIdx = indexBase + i;
        const active = globalIdx === activeIdx;
        return (
          <li
            key={row.key}
            data-row-idx={globalIdx}
            style={{ minHeight: ROW_HEIGHT }}
            className={cn(
              'border-edge-default hover:bg-hover flex cursor-pointer flex-col gap-0.5 border-b px-3 py-2 last:border-b-0',
              active && 'bg-info-bg',
            )}
            onClick={() => onClickRow(globalIdx, row)}
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="text-fg-muted truncate font-medium">
                {row.match.label ?? row.match.nodeId}
              </span>
              <span className="text-fg-subtle shrink-0 uppercase">
                {row.match.field}
              </span>
            </div>
            <SnippetLine
              text={row.match.snippet}
              matchStart={row.match.matchStart}
              matchLength={row.match.matchLength}
            />
          </li>
        );
      })}
    </ul>
  </div>
);

const SnippetLine = ({
  text,
  matchStart,
  matchLength,
}: {
  text: string;
  matchStart: number;
  matchLength: number;
}): JSX.Element => {
  const before = text.slice(0, matchStart);
  const hit = text.slice(matchStart, matchStart + matchLength);
  const after = text.slice(matchStart + matchLength);
  return (
    <div className="text-fg-default truncate text-xs">
      <span className="text-fg-muted">{before}</span>
      <mark className="bg-warning-bg text-fg-default">{hit}</mark>
      <span className="text-fg-muted">{after}</span>
    </div>
  );
};
