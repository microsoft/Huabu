// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas-wide search result list rendered inside the left layer
 * panel. Replaces the layer tree whenever
 * `searchStore.query` is non-empty (the parent panel handles the
 * toggle).
 *
 * Behaviour parity with the previous floating overlay:
 *   - Results are grouped by node and then field in first-seen order,
 *     with one heading per field and the canonical node icon per node.
 *   - ↑ / ↓ navigates the flat (header + visible match) list and
 *     follows on the canvas without opening Preview Workspace tabs.
 *   - Enter on a header toggles collapse; Enter on a match opens the
 *     owning node and hands content matches to preview-local search
 *     or reveals the matching Question conversation occurrence.
 *   - ←/→ collapse / expand the current group.
 *   - Highlight ranges are painted on the canvas DOM only; expanded
 *     previews own an independent search layer.
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

import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { usePreviewSearchStore } from '@/store/previewSearchStore';
import { revealNodesOnCanvas } from '@/utils/canvasViewport';

import { shouldCanvasSearchOwnKeyboard } from './canvasSearchKeyboard';
import { CanvasSearchNodeIcon } from './LayerNodeIcon';
import {
  LAYER_ROW_ICON_CLASS,
  LAYER_ROW_SELECTED_FOREGROUND_CLASS,
  LAYER_ROW_SURFACE_CLASS,
  layerRowBackground,
} from './layerRowStyles';
import { scheduleScrollToMatch } from '../../../hooks/searchDom';
import { useTextHighlight } from '../../../hooks/useTextHighlight';
import useCanvasStore from '../../../store/canvasStore';
import { openPreviewNode } from '../../../store/previewWorkspace/actions';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from '../../../store/previewWorkspace/store';
import {
  useSearchStore,
  type SearchResultRow,
} from '../../../store/searchStore';
import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { toast } from '../../Common/Toast';
import { hasNodePreview } from '../../Nodes/previews';

const ROW_HEIGHT = 28;

export const CanvasSearchResults = (): React.JSX.Element => {
  const { t } = useTranslation();
  const query = useSearchStore((s) => s.query);
  const normalizedQuery = query.trim();
  const nodeTypes = useSearchStore((s) => s.nodeTypes);
  const results = useSearchStore((s) => s.results);
  const isStreaming = useSearchStore((s) => s.isStreaming);
  const contentPhase = useSearchStore((s) => s.contentPhase);
  const truncated = useSearchStore((s) => s.truncated);
  const error = useSearchStore((s) => s.error);
  const collapsedNodeIds = useSearchStore((s) => s.collapsedNodeIds);
  const toggleNodeCollapse = useSearchStore((s) => s.toggleNodeCollapse);
  const scope = useSearchStore((s) => s.scope);

  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const expandedNodeId = usePreviewWorkspaceStore(selectActiveNodeId);
  const rfInstance = useCanvasStore((s) => s.rfInstance);
  const canvasWrapper = useCanvasStore((s) => s.canvasWrapper);

  // Conversation-tier results open the owning question node's chat
  // thread in the right panel (instead of an expanded preview), then
  // highlight + scroll to the matched message there. The active preview node
  // gives us a render tick when the thread mounts / swaps so we can
  // re-query the chat DOM for the highlight + scroll roots.

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const cancelNavigationRef = useRef<(() => void) | null>(null);
  const [activeSelection, setActiveSelection] = useState<{
    key: string;
    nodeId: string;
  } | null>(null);
  const [canvasRoot, setCanvasRoot] = useState<HTMLElement | null>(null);
  const [chatThreadEl, setChatThreadEl] = useState<HTMLElement | null>(null);

  useEffect(() => () => cancelNavigationRef.current?.(), [query, scope]);

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

  // Paint the same `::highlight(huabu-search)` ranges over node labels
  // and Milkdown bodies visible on the canvas and, for conversation
  // matches, over the open question-node chat thread. Expanded previews
  // own a separate search layer and are deliberately excluded.
  // The hook's MutationObserver picks up nodes that mount lazily (e.g.
  // a note's editor surface, pdf.js text-layer spans, chat messages
  // hydrated from history).
  useTextHighlight({
    container: [canvasRoot, chatThreadEl],
    query: query.trim(),
    maxRanges: 800,
  });

  // Reset selection when results identity changes (new query / scope).
  useEffect(() => {
    setActiveSelection(null);
  }, [normalizedQuery, scope, nodeTypes]);

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
        // Edge groups carry the endpoint ids so navigation can
        // reveal both ends of the edge instead of selecting a
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
        const fields = new Map<
          SearchResultRow['match']['field'],
          SearchResultRow[]
        >();
        for (const row of g.rows) {
          const matches = fields.get(row.match.field);
          if (matches) matches.push(row);
          else fields.set(row.match.field, [row]);
        }
        for (const matches of fields.values()) {
          matches.forEach((row, index) =>
            out.push({
              kind: 'match',
              group: g,
              row,
              firstInField: index === 0,
            }),
          );
        }
      }
    }
    return out;
  }, [nodeGroups, collapsedNodeIds]);

  const selectedIndex = visibleRows.findIndex(
    (row) => visibleRowKey(row) === activeSelection?.key,
  );
  const activeIdx = Math.max(
    0,
    selectedIndex >= 0
      ? selectedIndex
      : visibleRows.findIndex(
          (row) =>
            row.kind === 'header' &&
            row.group.nodeId === activeSelection?.nodeId,
        ),
  );
  const setActiveIdx = useCallback(
    (index: number) => {
      const row = visibleRows[index];
      setActiveSelection(
        row ? { key: visibleRowKey(row), nodeId: row.group.nodeId } : null,
      );
    },
    [visibleRows],
  );

  // Re-read the addressed thread after its row or preview tab changes.
  useEffect(() => {
    if (!expandedNodeId) {
      setChatThreadEl(null);
      return;
    }
    const threadId = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === expandedNodeId)?.data.threadId;
    setChatThreadEl(
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-chat-thread-root]'),
      ).find(
        (element) =>
          element.dataset.chatThreadId === threadId &&
          !element.closest('[data-preview-active="false"]'),
      ) ?? null,
    );
  }, [expandedNodeId, activeIdx]);

  const focusNodeOnCanvas = useCallback(
    (nodeId: string) => {
      selectNodes([nodeId], false);
      if (rfInstance && canvasWrapper) {
        revealNodesOnCanvas(rfInstance, canvasWrapper, [nodeId], 400);
      }
    },
    [selectNodes, rfInstance, canvasWrapper],
  );

  /**
   * Reveal a result group without changing zoom. Node groups
   * select + reveal the single node; edge groups reveal both
   * endpoints together (no selection — the edge itself is selected
   * by React Flow only via direct click, and we don't want to steal
   * keyboard focus to it from the search input).
   */
  const focusGroupOnCanvas = useCallback(
    (group: NodeGroup) => {
      if (group.edgeEndpoints) {
        if (rfInstance && canvasWrapper) {
          revealNodesOnCanvas(
            rfInstance,
            canvasWrapper,
            [group.edgeEndpoints.source, group.edgeEndpoints.target],
            400,
          );
        }
        return;
      }
      focusNodeOnCanvas(group.nodeId);
    },
    [focusNodeOnCanvas, rfInstance, canvasWrapper],
  );

  /**
   * Open the owning question node's chat thread in the right panel so
   * a `conversation`-tier match can be highlighted + scrolled to in
   * the thread. Reads `threadId` / `agentBinding` straight off the
   * live node (the search payload only carries ids), so this no-ops
   * gracefully when the node has no thread (e.g. it was deleted
   * mid-search). Returns whether a thread was actually opened.
   */
  const openConversationForNode = useCallback((nodeId: string): boolean => {
    const { nodes } = useCanvasStore.getState();
    const node = nodes.find((n) => n.id === nodeId);
    const data = node?.data as { threadId?: string } | undefined;
    if (!data?.threadId) return false;
    openPreviewNode(nodeId);
    return true;
  }, []);

  const jumpToResult = useCallback(
    (row: SearchResultRow) => {
      if (!useSearchStore.getState().results.includes(row)) return;
      const navigationQuery = query.trim();
      cancelNavigationRef.current?.();
      cancelNavigationRef.current = null;
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
        return;
      }
      // Conversation matches live in the question node's chat thread.
      // Open that thread in the right panel (instead of an expanded
      // preview); the dedicated effect below highlights + scrolls to
      // the matched message inside it.
      if (
        row.match.field === 'conversation' ||
        (nodeType === 'question' && row.match.field === 'content')
      ) {
        if (openConversationForNode(nodeId) && query) {
          const node = useCanvasStore
            .getState()
            .nodes.find((entry) => entry.id === nodeId);
          const threadId = node?.data.threadId;
          cancelNavigationRef.current = scheduleScrollToMatch(
            () =>
              Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[data-chat-thread-root]',
                ),
              ).find(
                (element) =>
                  element.dataset.chatThreadId === threadId &&
                  !element.closest('[data-preview-active="false"]'),
              ) ?? null,
            navigationQuery,
            row.match.occurrenceIndex,
            {
              source:
                row.match.field === 'conversation'
                  ? row.match.source
                  : undefined,
              requireSource: row.match.field === 'conversation',
              getMatchRoot:
                row.match.field === 'content'
                  ? (root) => {
                      const content = useCanvasStore
                        .getState()
                        .nodes.find((entry) => entry.id === nodeId)
                        ?.data.content;
                      if (typeof content !== 'string' || !content.trim())
                        return null;
                      const prompts = Array.from(
                        root.querySelectorAll<HTMLElement>(
                          '[data-chat-prompt-content]',
                        ),
                      ).filter(
                        (prompt) =>
                          prompt.textContent?.trim() === content.trim(),
                      );
                      return prompts.length === 1 ? (prompts[0] ?? null) : null;
                    }
                  : undefined,
              onMatch: (range) => {
                setChatThreadEl(
                  range.startContainer.parentElement?.closest<HTMLElement>(
                    '[data-chat-thread-root]',
                  ) ?? null,
                );
              },
              onTimeout: () =>
                toast(t('search.conversationMatchNotVisible'), {
                  tone: 'info',
                  duration: 4000,
                }),
            },
          );
        }
        focusNodeOnCanvas(nodeId);
        return;
      }
      // Only open when the node type renders real preview content. Types
      // without a `NodePreviews` entry leave the user's current preview alone.
      if (hasNodePreview(nodeType)) {
        // Browsing results reuses the group's inspection slot (§9.2).
        openPreviewNode(nodeId, { transient: true, focusEditor: false });
        if (row.match.field === 'content') {
          usePreviewSearchStore
            .getState()
            .reveal(
              nodeId,
              navigationQuery,
              row.match.occurrenceIndex,
              row.match.source,
            );
        }
      } else if (nodeType === 'question') {
        openConversationForNode(nodeId);
      }
      focusNodeOnCanvas(nodeId);
    },
    [focusNodeOnCanvas, focusGroupOnCanvas, openConversationForNode, query, t],
  );

  // Live-follow only on the Canvas. Browsing with ↑ / ↓ must not open,
  // replace, or close Preview Workspace tabs; Enter or click confirms a row.
  useEffect(() => {
    const v = visibleRows[activeIdx];
    if (!v) return;
    focusGroupOnCanvas(v.group);
  }, [visibleRows, activeIdx, focusGroupOnCanvas]);

  // Keyboard handling lives on `window` (not on a panel-scoped
  // `onKeyDown`) because the live-follow effect calls `selectNodes`,
  // which makes React Flow focus the selected node wrapper — pulling
  // focus out of the search input and silencing any subtree-scoped
  // keydown handler. Capture phase so we beat the in-preview find
  // bar and any canvas-level Arrow / Enter handlers while a query
  // is active.
  //
  // Search keeps ownership while focus is in its input/results or React Flow
  // has moved focus onto a plain Canvas node wrapper. Editors and controls in
  // Chat, Preview, and Canvas keep their own Enter / Arrow behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!shouldCanvasSearchOwnKeyboard(e.target)) return;
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
        setActiveIdx(Math.min(visibleRows.length - 1, activeIdx + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx(Math.max(0, activeIdx - 1));
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
          setActiveIdx(Math.min(visibleRows.length - 1, activeIdx + 1));
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
    setActiveIdx,
  ]);

  // Keep the active row scrolled into view via Virtuoso's imperative
  // API.
  useEffect(() => {
    if (visibleRows.length === 0) return;
    const root = resultsRef.current;
    const focusedResult = root?.contains(document.activeElement)
      ? document.activeElement
      : null;
    let cancelled = false;
    virtuosoRef.current?.scrollIntoView({
      index: activeIdx,
      behavior: 'auto',
      align: 'center',
      done: () => {
        if (cancelled) return;
        const activeElement = document.activeElement;
        if (
          root &&
          (root.contains(activeElement) ||
            (focusedResult &&
              !focusedResult.isConnected &&
              activeElement === document.body))
        ) {
          root
            .querySelector<HTMLElement>(
              `[data-search-row-index="${activeIdx}"]`,
            )
            ?.focus({ preventScroll: true });
        }
      },
    });
    return () => {
      cancelled = true;
    };
  }, [activeIdx, visibleRows.length]);

  const showEmpty =
    !isStreaming && query.trim().length > 0 && results.length === 0 && !error;

  return (
    <div
      ref={resultsRef}
      className="flex h-full min-h-0 flex-col font-normal"
      data-canvas-search-results=""
    >
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
          <span className="text-fg-muted">{t('search.resultsTruncated')}</span>
        </div>
      )}

      {error && <div className="text-danger px-3 py-3 text-xs">{error}</div>}

      {!error && nodeGroups.length > 0 && (
        <Virtuoso
          ref={virtuosoRef}
          // Fills the remaining panel height; the parent wraps this
          // component in `min-h-0 flex-1` so the panel scroller (the
          // SidebarPanel content) doesn't fight with Virtuoso's own.
          className="min-h-0 flex-1"
          data={visibleRows}
          computeItemKey={(_, v) => visibleRowKey(v)}
          increaseViewportBy={200}
          itemContent={(index, v) =>
            v.kind === 'header' ? (
              <NodeHeaderItem
                index={index}
                group={v.group}
                hasPreviousGroup={index > 0}
                collapsed={collapsedNodeIds.has(v.group.nodeId)}
                active={index === activeIdx}
                onFocus={() => setActiveIdx(index)}
                onClick={() => {
                  setActiveIdx(index);
                  toggleNodeCollapse(v.group.nodeId);
                }}
              />
            ) : (
              <NodeMatchItem
                index={index}
                firstInField={v.firstInField}
                row={v.row}
                active={index === activeIdx}
                onFocus={() => setActiveIdx(index)}
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
          {t('search.noMatches')}
        </div>
      )}

      {!error && isStreaming && contentPhase && (
        <div className="text-fg-subtle border-edge-default border-t px-3 py-1.5 text-xs">
          {t('search.searchingNoteContents')}
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
   * Lets navigation reveal the endpoint bounds without treating
   * the edge itself as a node.
   */
  edgeEndpoints?: { source: string; target: string };
}

type VisibleRow =
  | { kind: 'header'; group: NodeGroup }
  | {
      kind: 'match';
      group: NodeGroup;
      row: SearchResultRow;
      firstInField: boolean;
    };

function visibleRowKey(row: VisibleRow): string {
  return row.kind === 'header' ? `h:${row.group.nodeId}` : `m:${row.row.key}`;
}

interface NodeHeaderItemProps {
  index: number;
  group: NodeGroup;
  hasPreviousGroup: boolean;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  onFocus: () => void;
}

const NodeHeaderItem = ({
  index,
  group,
  hasPreviousGroup,
  collapsed,
  active,
  onClick,
  onFocus,
}: NodeHeaderItemProps): React.JSX.Element => {
  const displayLabel = group.label || group.nodeId;
  return (
    <div className="px-2">
      {hasPreviousGroup && (
        <div role="separator" className="border-edge-default my-0.5 border-t" />
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        onFocus={onFocus}
        data-search-row-index={index}
        aria-expanded={!collapsed}
        className={cn(
          'flex h-7 w-full items-center justify-start gap-2 px-2 py-0 text-left text-xs font-normal',
          LAYER_ROW_SURFACE_CLASS,
          layerRowBackground({ selected: active }),
        )}
      >
        <span className="flex h-6 w-4 shrink-0 items-center justify-center">
          {collapsed ? (
            <ChevronRight
              size={12}
              className="text-fg-subtle h-3! w-3! shrink-0"
              aria-hidden
            />
          ) : (
            <ChevronDown
              size={12}
              className="text-fg-subtle h-3! w-3! shrink-0"
              aria-hidden
            />
          )}
        </span>
        <span
          className={cn(
            'flex shrink-0 [&_svg]:h-3.5! [&_svg]:w-3.5!',
            active ? LAYER_ROW_SELECTED_FOREGROUND_CLASS : LAYER_ROW_ICON_CLASS,
          )}
        >
          <CanvasSearchNodeIcon
            nodeId={group.nodeId}
            nodeType={group.nodeType}
            isEdge={!!group.edgeEndpoints}
          />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-normal',
            active ? LAYER_ROW_SELECTED_FOREGROUND_CLASS : 'text-fg-default',
          )}
        >
          {displayLabel}
        </span>
        <span className="text-fg-subtle shrink-0 tabular-nums">
          {group.rows.length}
        </span>
      </Button>
    </div>
  );
};

interface NodeMatchItemProps {
  index: number;
  firstInField: boolean;
  row: SearchResultRow;
  active: boolean;
  onClick: () => void;
  onFocus: () => void;
}

const NodeMatchItem = ({
  index,
  firstInField,
  row,
  active,
  onClick,
  onFocus,
}: NodeMatchItemProps): React.JSX.Element => {
  const { t } = useTranslation();
  return (
    <div className="px-2" data-search-field={row.match.field}>
      {firstInField && (
        <div className="text-fg-subtle px-3 pt-1 pl-[54px] text-xs uppercase">
          {t(`search.fields.${row.match.field}`)}
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        tabIndex={-1}
        style={{ minHeight: ROW_HEIGHT }}
        className={cn(
          'flex w-full cursor-pointer flex-col items-stretch justify-start gap-0 px-3 py-1 pl-[54px] text-left font-normal',
          LAYER_ROW_SURFACE_CLASS,
          layerRowBackground({ selected: active }),
        )}
        onClick={onClick}
        onFocus={onFocus}
        data-search-row-index={index}
        aria-label={`${t(`search.fields.${row.match.field}`)}: ${row.match.snippet}`}
      >
        <SnippetLine
          text={row.match.snippet}
          matchStart={row.match.matchStart}
          matchLength={row.match.matchLength}
        />
      </Button>
    </div>
  );
};

/**
 * Max characters of leading context shown before the highlighted
 * match. The server centres each match in a ~120-char window, but the
 * row truncates to a single line (`truncate` → `overflow: hidden`), so
 * a match buried 60 chars deep would be clipped off the right edge and
 * the user would never see the highlight (a real problem for long
 * conversation snippets and matches inside markdown tables, where the
 * hit is always deep in the body). Trimming the leading run keeps the
 * `<mark>` near the start of the row where it stays visible.
 */
const SNIPPET_LEAD_CHARS = 12;

const SnippetLine = ({
  text,
  matchStart,
  matchLength,
}: {
  text: string;
  matchStart: number;
  matchLength: number;
}): React.JSX.Element => {
  let before = text.slice(0, matchStart);
  const hit = text.slice(matchStart, matchStart + matchLength);
  const after = text.slice(matchStart + matchLength);
  // Keep the highlighted match in view: drop excess leading context so
  // the `<mark>` isn't pushed past the row's single-line clip. The
  // server may already have prefixed an ellipsis; collapse both into a
  // single leading ellipsis.
  if (before.length > SNIPPET_LEAD_CHARS) {
    before = '…' + before.slice(before.length - SNIPPET_LEAD_CHARS);
  }
  return (
    <div className="text-fg-default truncate text-xs">
      <span className="text-fg-muted">{before}</span>
      {/* Match the canvas / chat highlight paint (`::highlight(huabu-search)`
          uses `--pdf-highlight-bg`) so the in-list `<mark>` reads as the
          same yellow rather than the lighter `--warning-bg` cream. */}
      <mark className="text-fg-default bg-(--pdf-highlight-bg)">{hit}</mark>
      <span className="text-fg-muted">{after}</span>
    </div>
  );
};
