/**
 * Canvas-wide search result list rendered inside the left layer
 * panel. Replaces the layer tree whenever
 * `searchStore.query` is non-empty (the parent panel handles the
 * toggle).
 *
 * Behaviour parity with the previous floating overlay:
 *   - Results stream in already grouped by node (per emission
 *     order). We bucket adjacent rows by `nodeId`, render a header
 *     row per group with the canonical node icon (Spline for edges),
 *     and indent match rows beneath their header.
 *   - ↑ / ↓ navigates the flat (header + visible match) list, live-
 *     follows on the canvas (`fitView` + `openExpanded` when the
 *     target has a real preview).
 *   - Enter on a header toggles collapse; Enter on a match seeks
 *     inside the open preview.
 *   - ←/→ collapse / expand the current group.
 *   - Highlight ranges painted via CSS Custom Highlight on both the
 *     canvas DOM and the (optional) expanded preview body.
 *
 * What changed vs the overlay:
 *   - No drag handling, no `position: fixed`. The list fills the
 *     panel's content area (`min-h-0 flex-1`) and scrolls inline
 *     via Virtuoso.
 *   - No input or close button — those live in
 *     `CanvasSearchInput` above this list inside the same panel.
 *   - No "Start typing to search…" placeholder either: the parent
 *     only mounts this component when there's an active query, so
 *     the empty-state copy is just "No matches".
 */

import { Spline, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { getNodeIcon } from '../../../config/nodeIcons';
import { scheduleScrollToMatch } from '../../../hooks/searchDom';
import { useTextHighlight } from '../../../hooks/useTextHighlight';
import useCanvasStore from '../../../store/canvasStore';
import { usePreviewStore } from '../../../store/previewStore';
import {
  useSearchStore,
  type SearchResultRow,
} from '../../../store/searchStore';
import { cn } from '../../Common/cn';
import { toast } from '../../Common/Toast';
import { NodePreviews } from '../../Nodes/previews';

const ROW_HEIGHT = 52;

/**
 * True when `nodeType` has a dedicated `NodePreviews` entry — i.e.
 * `ExpandedNodePanel` will render real content for it rather than the
 * "Preview not available for {type}" placeholder. Search uses this to
 * decide whether to auto-open the expanded panel when focusing a
 * result: opening a placeholder panel would split the canvas, hide
 * other nodes, and add a redundant close step without surfacing any
 * extra match context, so we skip it for those types and just centre
 * the canvas on the node instead.
 */
const hasNodePreview = (nodeType: string): boolean => nodeType in NodePreviews;

export const CanvasSearchResults = (): JSX.Element => {
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const isStreaming = useSearchStore((s) => s.isStreaming);
  const contentPhase = useSearchStore((s) => s.contentPhase);
  const truncated = useSearchStore((s) => s.truncated);
  const error = useSearchStore((s) => s.error);
  const collapsedNodeIds = useSearchStore((s) => s.collapsedNodeIds);
  const toggleNodeCollapse = useSearchStore((s) => s.toggleNodeCollapse);
  const scope = useSearchStore((s) => s.scope);

  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const openExpanded = useCanvasStore((s) => s.openExpanded);
  const closeExpanded = useCanvasStore((s) => s.closeExpanded);
  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const rfInstance = useCanvasStore((s) => s.rfInstance);
  // Surfaces the existence of an expanded preview panel (drives the
  // "also highlight + scroll inside the preview" follow-up below).
  // We don't read the payload — just need a render tick when it
  // mounts / unmounts so we can re-query the DOM for the panel root.
  const previewType = usePreviewStore((s) => s.previewType);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [canvasRoot, setCanvasRoot] = useState<HTMLElement | null>(null);
  const [previewPanelEl, setPreviewPanelEl] = useState<HTMLElement | null>(
    null,
  );

  // Resolve the canvas highlight root once on mount and whenever the
  // search scope flips back on (e.g. after `close()` + new query).
  // The element is owned by React Flow and is stable across renders,
  // so a one-shot read on `scope` is enough.
  useEffect(() => {
    if (!scope) {
      setCanvasRoot(null);
      return;
    }
    setCanvasRoot(
      document.querySelector<HTMLElement>('[data-canvas-root]') ?? null,
    );
  }, [scope]);

  // Resolve the expanded-preview panel root in lock-step with the
  // canvas / preview stores. Reading `document` inside this effect
  // (after the React commit phase) guarantees the panel's DOM is
  // already mounted when an `openExpanded` / `openPreview` call from
  // `jumpToResult` flips the relevant store flag.
  useEffect(() => {
    setPreviewPanelEl(
      document.querySelector<HTMLElement>('[data-search-scope="node"]') ?? null,
    );
  }, [expandedNodeId, previewType]);

  // Paint the same `::highlight(sediment-search)` ranges over node
  // labels and Milkdown bodies that are visible on the canvas *and*,
  // when an expanded preview is open, over its body. The hook's
  // MutationObserver picks up nodes that mount lazily (e.g. a note's
  // editor surface, pdf.js text-layer spans).
  useTextHighlight({
    container: [canvasRoot, previewPanelEl],
    query,
    maxRanges: 800,
  });

  // Reset selection when results identity changes (new query / scope).
  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  // ──────────────────────────────────────────────────────────────────
  // Per-node grouping (VS Code-style).
  //
  // Results stream in already in (node, field) emission order. We just
  // bucket consecutive rows by `nodeId` while preserving that order,
  // so the first node to surface a match shows up at the top of the
  // list — which keeps the typed-from-zero typing experience
  // (incremental, no re-ordering) intact.
  // ──────────────────────────────────────────────────────────────────

  const nodeGroups = useMemo(() => {
    const byId = new Map<string, NodeGroup>();
    const order: string[] = [];
    for (const row of results) {
      const id = row.match.nodeId;
      const existing = byId.get(id);
      if (existing) {
        existing.rows.push(row);
        continue;
      }
      const fresh: NodeGroup = {
        nodeId: id,
        nodeType: row.match.nodeType,
        label: row.match.label ?? '',
        rows: [row],
        // Edge groups carry the endpoint ids so `focusOnCanvas` can
        // `fitView` on both ends of the edge instead of selecting a
        // non-existent "edge node". `kind` defaults to `'node'` for
        // back-compat with older server payloads.
        edgeEndpoints:
          row.match.kind === 'edge' &&
          row.match.sourceNodeId &&
          row.match.targetNodeId
            ? {
                source: row.match.sourceNodeId,
                target: row.match.targetNodeId,
              }
            : undefined,
      };
      byId.set(id, fresh);
      order.push(id);
    }
    const out: NodeGroup[] = [];
    for (const id of order) {
      const g = byId.get(id);
      if (g) out.push(g);
    }
    return out;
  }, [results]);

  const visibleRows = useMemo(() => {
    const out: VisibleRow[] = [];
    for (const g of nodeGroups) {
      out.push({ kind: 'header', group: g });
      if (!collapsedNodeIds.has(g.nodeId)) {
        for (const r of g.rows) out.push({ kind: 'match', group: g, row: r });
      }
    }
    return out;
  }, [nodeGroups, collapsedNodeIds]);

  // Clamp activeIdx whenever `visibleRows` shrinks (user collapsed a
  // group, streaming reset the list, etc.) so it can never dangle past
  // the end and silently disable Enter / live-follow.
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (activeIdx !== 0) setActiveIdx(0);
      return;
    }
    if (activeIdx >= visibleRows.length) {
      setActiveIdx(visibleRows.length - 1);
    }
  }, [visibleRows, activeIdx]);

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

  /**
   * Re-anchor the canvas viewport on a result group. Node groups
   * select + fit on the single node; edge groups fit on both
   * endpoints together (no selection — the edge itself is selected
   * by React Flow only via direct click, and we don't want to steal
   * keyboard focus to it from the search input).
   */
  const focusGroupOnCanvas = useCallback(
    (group: NodeGroup) => {
      if (group.edgeEndpoints) {
        if (rfInstance) {
          void rfInstance.fitView({
            nodes: [
              { id: group.edgeEndpoints.source },
              { id: group.edgeEndpoints.target },
            ],
            duration: 400,
            maxZoom: 1,
          });
        }
        return;
      }
      focusNodeOnCanvas(group.nodeId);
    },
    [focusNodeOnCanvas, rfInstance],
  );

  const jumpToResult = useCallback(
    (row: SearchResultRow) => {
      const { nodeId, nodeType } = row.match;
      // Edge rows share the group focus path: fit on both endpoints,
      // never open the (non-existent) edge preview.
      if (row.match.kind === 'edge') {
        const endpoints =
          row.match.sourceNodeId && row.match.targetNodeId
            ? {
                source: row.match.sourceNodeId,
                target: row.match.targetNodeId,
              }
            : undefined;
        focusGroupOnCanvas({
          nodeId,
          nodeType,
          label: row.match.label ?? '',
          rows: [row],
          edgeEndpoints: endpoints,
        });
        closeExpanded();
        return;
      }
      focusNodeOnCanvas(nodeId);
      // Only auto-expand when the node type renders real preview
      // content. Types without a `NodePreviews` entry (frame, group,
      // prompt, plain text, …) would otherwise pop up the "Preview
      // not available for {type}" placeholder, which adds nothing
      // beyond what's already visible on the canvas and forces the
      // user to close it before continuing. For those, close any
      // stale preview left over from a previous result so the user
      // is left looking at the focused node on the canvas instead of
      // an unrelated panel.
      if (hasNodePreview(nodeType)) {
        openExpanded(nodeId);
      } else {
        closeExpanded();
      }
    },
    [focusNodeOnCanvas, focusGroupOnCanvas, openExpanded, closeExpanded],
  );

  // Live-follow the active visible row on the canvas. Both header and
  // match rows centre the canvas on the underlying node and (when the
  // type has a real preview) open its expanded panel, so the gesture
  // is consistent: ↑ / ↓ always re-anchors the viewport on the row's
  // node. Only the *match* rows also seek inside the preview (handled
  // by the next effect).
  useEffect(() => {
    const v = visibleRows[activeIdx];
    if (!v) return;
    focusGroupOnCanvas(v.group);
    if (v.group.edgeEndpoints) {
      closeExpanded();
    } else if (hasNodePreview(v.group.nodeType)) {
      openExpanded(v.group.nodeId);
    } else {
      closeExpanded();
    }
  }, [visibleRows, activeIdx, focusGroupOnCanvas, openExpanded, closeExpanded]);

  // Scroll-into-view follow-up for **match rows only** — when an
  // expanded preview is (or will be) open for the active row's node,
  // seek to the matching text inside its body.
  useEffect(() => {
    const v = visibleRows[activeIdx];
    if (!v || v.kind !== 'match' || !query) return;
    // Edge label matches have no in-preview body to scroll — the label
    // is already painted right on the edge by the highlight layer.
    if (v.row.match.kind === 'edge') return;
    const nth = v.row.match.occurrenceIndex;
    const cancel = scheduleScrollToMatch(
      () => document.querySelector<HTMLElement>('[data-search-scope="node"]'),
      query,
      nth,
      {
        onTimeout: () =>
          toast(
            'Match not visible in preview — scroll manually or press Cmd+F inside it for an in-preview search.',
            { tone: 'info', duration: 4000 },
          ),
      },
    );
    return cancel;
  }, [visibleRows, activeIdx, query]);

  // Keyboard handling lives on `window` (not on a panel-scoped
  // `onKeyDown`) because the live-follow effect calls `selectNodes`,
  // which makes React Flow focus the selected node wrapper — pulling
  // focus out of the search input and silencing any subtree-scoped
  // keydown handler. Capture phase so we beat the in-preview find
  // bar and any canvas-level Arrow / Enter handlers while a query
  // is active.
  //
  // LOAD-BEARING — capture phase + stopPropagation here suppresses
  // *all* canvas-level Enter / Arrow handlers while the result list
  // is mounted. That is intentional (we own the keyboard while
  // searching); Escape is handled by `CanvasSearchInput` (which
  // clears the query and closes the scope — that unmounts this
  // component and the keydown listener cleans up).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const v = visibleRows[activeIdx];
        if (!v) return;
        if (v.kind === 'header') {
          toggleNodeCollapse(v.group.nodeId);
        } else {
          jumpToResult(v.row);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(visibleRows.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const v = visibleRows[activeIdx];
        if (!v) return;
        if (v.kind === 'match') {
          for (let i = activeIdx - 1; i >= 0; i--) {
            const candidate = visibleRows[i];
            if (
              candidate.kind === 'header' &&
              candidate.group.nodeId === v.group.nodeId
            ) {
              setActiveIdx(i);
              break;
            }
          }
        } else if (!collapsedNodeIds.has(v.group.nodeId)) {
          toggleNodeCollapse(v.group.nodeId);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const v = visibleRows[activeIdx];
        if (!v || v.kind !== 'header') return;
        if (collapsedNodeIds.has(v.group.nodeId)) {
          toggleNodeCollapse(v.group.nodeId);
        } else if (v.group.rows.length > 0) {
          setActiveIdx((i) => Math.min(visibleRows.length - 1, i + 1));
        }
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    visibleRows,
    activeIdx,
    collapsedNodeIds,
    toggleNodeCollapse,
    jumpToResult,
  ]);

  // Keep the active row scrolled into view via Virtuoso's imperative
  // API.
  useEffect(() => {
    if (visibleRows.length === 0) return;
    virtuosoRef.current?.scrollIntoView({
      index: activeIdx,
      behavior: 'auto',
      align: 'center',
    });
  }, [activeIdx, visibleRows.length]);

  const showEmpty =
    !isStreaming && query.trim().length > 0 && results.length === 0 && !error;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Truncation banner. VS Code-style: lives at the TOP so the
          user spots the warning before scrolling and knows the list
          is incomplete. */}
      {!error && truncated && (
        <div className="border-edge-default bg-warning-bg/40 flex items-start gap-2 border-b px-3 py-2 text-xs">
          <TriangleAlert
            size={14}
            className="text-warning mt-0.5 shrink-0"
            aria-hidden
          />
          <span className="text-fg-muted">
            The result set only contains a subset of all matches. Be more
            specific in your search to narrow down the results.
          </span>
        </div>
      )}

      {error && <div className="text-danger px-3 py-3 text-sm">{error}</div>}

      {!error && nodeGroups.length > 0 && (
        <Virtuoso
          ref={virtuosoRef}
          // Fills the remaining panel height; the parent wraps this
          // component in `min-h-0 flex-1` so the panel scroller (the
          // SidebarPanel content) doesn't fight with Virtuoso's own.
          className="min-h-0 flex-1"
          data={visibleRows}
          computeItemKey={(_, v) =>
            v.kind === 'header' ? `h:${v.group.nodeId}` : `m:${v.row.key}`
          }
          increaseViewportBy={200}
          itemContent={(index, v) =>
            v.kind === 'header' ? (
              <NodeHeaderItem
                group={v.group}
                collapsed={collapsedNodeIds.has(v.group.nodeId)}
                active={index === activeIdx}
                onClick={() => {
                  setActiveIdx(index);
                  toggleNodeCollapse(v.group.nodeId);
                }}
              />
            ) : (
              <NodeMatchItem
                row={v.row}
                active={index === activeIdx}
                onClick={() => {
                  setActiveIdx(index);
                  jumpToResult(v.row);
                }}
              />
            )
          }
        />
      )}

      {!error && nodeGroups.length === 0 && showEmpty && (
        <div className="text-fg-subtle px-3 py-5 text-center text-xs">
          No matches
        </div>
      )}

      {!error && isStreaming && contentPhase && (
        <div className="text-fg-subtle border-edge-default border-t px-3 py-1.5 text-[11px]">
          Searching note contents…
        </div>
      )}
    </div>
  );
};

interface NodeGroup {
  nodeId: string;
  nodeType: string;
  /** Server-supplied display label (may be empty / falsy for placeholders). */
  label: string;
  rows: SearchResultRow[];
  /**
   * Edge-only: source + target node ids for an edge label match.
   * Lets the focus logic `fitView` on both endpoints (since the
   * "edge" itself isn't a node React Flow can recenter on).
   */
  edgeEndpoints?: { source: string; target: string };
}

type VisibleRow =
  | { kind: 'header'; group: NodeGroup }
  | { kind: 'match'; group: NodeGroup; row: SearchResultRow };

interface NodeHeaderItemProps {
  group: NodeGroup;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
}

const NodeHeaderItem = ({
  group,
  collapsed,
  active,
  onClick,
}: NodeHeaderItemProps): JSX.Element => {
  // Edge groups: render the connection glyph; node groups: per-type icon.
  // `getNodeIcon` falls back to the frame icon for unknown types, which
  // would mis-represent an edge as a frame in the list — short-circuit.
  const Icon = group.edgeEndpoints ? Spline : getNodeIcon(group.nodeType);
  const displayLabel = group.label || group.nodeId;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={!collapsed}
      className={cn(
        'border-edge-default hover:bg-hover flex w-full items-center gap-1.5 border-b px-2 py-1.5 text-left text-xs',
        active && 'bg-info-bg',
      )}
    >
      {collapsed ? (
        <ChevronRight
          size={12}
          className="text-fg-subtle shrink-0"
          aria-hidden
        />
      ) : (
        <ChevronDown
          size={12}
          className="text-fg-subtle shrink-0"
          aria-hidden
        />
      )}
      <Icon size={14} strokeWidth={1.5} className="text-fg-muted shrink-0" />
      <span className="text-fg-default min-w-0 flex-1 truncate font-medium">
        {displayLabel}
      </span>
      <span className="text-fg-subtle shrink-0 tabular-nums">
        {group.rows.length}
      </span>
    </button>
  );
};

interface NodeMatchItemProps {
  row: SearchResultRow;
  active: boolean;
  onClick: () => void;
}

const NodeMatchItem = ({
  row,
  active,
  onClick,
}: NodeMatchItemProps): JSX.Element => (
  <button
    type="button"
    tabIndex={-1}
    style={{ minHeight: ROW_HEIGHT }}
    className={cn(
      'border-edge-default hover:bg-hover flex w-full cursor-pointer flex-col gap-0.5 border-b px-3 py-2 pl-7 text-left',
      active && 'bg-info-bg',
    )}
    onClick={onClick}
  >
    <div className="flex items-center gap-2 text-xs">
      <span className="text-fg-subtle shrink-0 uppercase">
        {row.match.field}
      </span>
    </div>
    <SnippetLine
      text={row.match.snippet}
      matchStart={row.match.matchStart}
      matchLength={row.match.matchLength}
    />
  </button>
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
