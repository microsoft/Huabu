import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CanvasLayerTree } from './CanvasLayerTree';
import { LayerFilterBar } from './LayerFilterBar';
import {
  buildAvailableFilterKeys,
  nodeMatchesFilterKey,
  type LayerFilterKey,
} from './layerFilterKey';
import { QuestionStatusDot } from './QuestionStatusDot';
import { getNodeIcon } from '../../../config/nodeIcons';
import useCanvasStore from '../../../store/canvasStore';
import { useExternalImportsStore } from '../../../store/externalImportsStore';
import { usePanelStore } from '../../../store/panelStore';
import { SketchIcon } from '../../Nodes/sketch/SketchIcon';
import { SidebarPanel } from '../SidebarPanel';

import type { DataSourceNodeLike, DataSourceTreeItem } from './types';
import type {
  CanvasNodeType,
  ExternalNoteItem,
  OfficeFormat,
  QuestionNodeStatus,
  SketchStroke,
} from '@sediment/shared';

interface CanvasLayerPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

const ICON_SIZE = 14;
const ICON_STROKE_WIDTH = 1.5;

const renderNodeIcon = (node: DataSourceNodeLike) => {
  // Sketch nodes render a tiny polyline preview of their strokes so the
  // layer panel reflects each drawing's actual shape. Falls back to the
  // lucide Pencil icon if the node has no strokes yet (legacy / empty).
  if (node.type === 'sketch') {
    const strokes = node.data.strokes as SketchStroke[] | undefined;
    const initialSize = node.data.initialSize as
      | { width: number; height: number }
      | undefined;
    if (strokes && strokes.length > 0 && initialSize) {
      return (
        <SketchIcon
          strokes={strokes}
          initialSize={initialSize}
          size={ICON_SIZE}
        />
      );
    }
  }

  const Icon = getNodeIcon(node.type, node.data);
  const iconEl = <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />;

  // Question nodes carry an execution lifecycle (pending → running →
  // done | error). We overlay a tiny status dot so the layer panel
  // doubles as an "ambient" status board for in-flight conversations,
  // mirroring what the on-canvas `StatusBadge` shows.
  if (node.type === 'question') {
    const status = node.data.status as QuestionNodeStatus | undefined;
    if (!status) return iconEl;
    return (
      <span className="relative inline-flex">
        {iconEl}
        <QuestionStatusDot
          status={status}
          viewed={node.data.viewed as boolean | undefined}
          errorMessage={node.data.errorMessage as string | undefined}
        />
      </span>
    );
  }

  return iconEl;
};

const getNodeDisplayName = (node: DataSourceNodeLike): string => {
  return node.data.label;
};

export const EXTERNAL_ROW_ID_PREFIX = 'external::';

const buildExternalTreeItem = (
  item: ExternalNoteItem,
  label: string,
): DataSourceTreeItem => ({
  id: `${EXTERNAL_ROW_ID_PREFIX}${item.relativePath}`,
  depth: 0,
  externalRelativePath: item.relativePath,
  node: {
    id: `${EXTERNAL_ROW_ID_PREFIX}${item.relativePath}`,
    type: 'note',
    data: { label },
  },
});

const buildTreeItems = (nodes: DataSourceNodeLike[]): DataSourceTreeItem[] => {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const childrenByParent = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of nodes) {
    const parentId = n.parentId;
    if (parentId && byId.has(parentId)) {
      const arr = childrenByParent.get(parentId) ?? [];
      arr.push(n.id);
      childrenByParent.set(parentId, arr);
    } else {
      roots.push(n.id);
    }
  }

  const out: DataSourceTreeItem[] = [];

  const visit = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node) return;
    out.push({ id, node, depth });
    const kids = childrenByParent.get(id) ?? [];
    // Reverse children so higher z-order (later in nodes array) appears first
    for (let i = kids.length - 1; i >= 0; i -= 1) visit(kids[i], depth + 1);
  };

  // Reverse roots so higher z-order (later in nodes array) appears first
  for (let i = roots.length - 1; i >= 0; i -= 1) visit(roots[i], 0);
  return out;
};

/**
 * Compare two tree items by the fields actually consumed by the layer
 * tree's rows. Crucially this ignores `selected` and other non-visible
 * node fields so we can reuse the cached item ref whenever the only
 * change was a selection toggle.
 */
const isSameTreeItem = (
  a: DataSourceTreeItem,
  b: DataSourceTreeItem,
): boolean => {
  if (a.depth !== b.depth) return false;
  const an = a.node;
  const bn = b.node;
  if (an.type !== bn.type) return false;
  if (an.parentId !== bn.parentId) return false;
  if (an.data.label !== bn.data.label) return false;
  if (an.data.locked !== bn.data.locked) return false;
  // SketchIcon depends on these references; reuse cached item when they
  // are reference-equal (the sketch store updates immutably).
  if (an.data.strokes !== bn.data.strokes) return false;
  if (an.data.initialSize !== bn.data.initialSize) return false;
  // Question nodes drive a status dot — invalidate the cached item
  // whenever any of the visible status fields change so the row
  // re-renders. Non-question nodes hit only the cheap equality checks
  // above thanks to the short-circuit on `type`.
  if (an.type === 'question') {
    if (an.data.status !== bn.data.status) return false;
    if (an.data.viewed !== bn.data.viewed) return false;
    if (an.data.errorMessage !== bn.data.errorMessage) return false;
  }
  return true;
};

export const CanvasLayerPanel = ({
  isCollapsed,
  onToggle,
}: CanvasLayerPanelProps) => {
  // `MainLayout` keeps this subtree mounted while the column animates to
  // width 0 (to avoid a content-swap flash mid-animation), so the local
  // `isCollapsed` prop is always `false`. We read the real collapse state
  // from `panelStore` and use it to freeze the `nodes` reference fed to
  // `buildTreeItems`. While collapsed, selection bumps on the canvas
  // (which rebuild `state.nodes` on every toggle) skip the O(N) tree
  // walk — but no DOM is unmounted, so the 220ms width animation stays
  // smooth.
  const isLeftCollapsed = usePanelStore((s) => s.isLeftCollapsed);
  const rawNodes = useCanvasStore(
    (s) => s.nodes,
  ) as unknown as DataSourceNodeLike[];
  const activeCanvasId = useCanvasStore((s) => s.canvasId);
  const collapsedFrameIds = useCanvasStore((s) => s.collapsedFrameIds);
  const setAllFramesCollapsed = useCanvasStore((s) => s.setAllFramesCollapsed);
  const externalPending = useExternalImportsStore((s) => s.pending);
  const connectExternal = useExternalImportsStore((s) => s.connect);
  const disconnectExternal = useExternalImportsStore((s) => s.disconnect);

  useEffect(() => {
    if (!activeCanvasId) return;
    connectExternal(activeCanvasId);
    return () => disconnectExternal();
  }, [activeCanvasId, connectExternal, disconnectExternal]);

  const frozenNodesRef = useRef(rawNodes);
  if (!isLeftCollapsed) {
    // Keep the cached reference in step with the live store whenever the
    // panel is visible. Writing the same ref value during render is safe
    // (no extra render scheduled).
    frozenNodesRef.current = rawNodes;
  }
  const nodes = isLeftCollapsed ? frozenNodesRef.current : rawNodes;

  // ============================================================
  // Filter state — purely panel-local. Lives in `useState` because
  // (a) the panel component stays mounted across collapse/expand,
  // (b) no other surface needs to observe these values.
  // ============================================================
  const [query, setQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<LayerFilterKey>>(
    () => new Set(),
  );
  // The regex *input* row is opt-in to keep the panel chrome quiet —
  // typed search is far less frequent than the at-a-glance chip toggles.
  // The type-chip row, on the other hand, is shown by default whenever
  // the canvas has at least two node types: chips ARE the filter
  // affordance the user sees first. Closing the search (× / Esc) only
  // hides the input row and clears `query`; chip selections are
  // intentionally preserved across open/close cycles.
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const handleToggleKey = useCallback((key: LayerFilterKey) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setQuery('');
  }, []);

  // Only show chips for types that actually exist on the canvas, in the
  // canonical `CANVAS_NODE_TYPES` order so toggling doesn't reshuffle
  // the row. Office is split per-format (Word / Excel / PowerPoint) so
  // each chip carries the same icon the canvas card and list row use
  // for that format — see `layerFilterKey.ts`.
  const availableKeys = useMemo<LayerFilterKey[]>(() => {
    const presentTypes = new Set<string>();
    const presentOfficeFormats = new Set<OfficeFormat>();
    for (const n of nodes) {
      if (!n.type) continue;
      presentTypes.add(n.type);
      if (n.type === 'office') {
        const fmt = (n.data as { format?: unknown } | undefined)?.format;
        if (fmt === 'docx' || fmt === 'xlsx' || fmt === 'pptx') {
          presentOfficeFormats.add(fmt);
        }
      }
    }
    if (externalPending.length > 0) presentTypes.add('note');
    return buildAvailableFilterKeys(presentTypes, presentOfficeFormats);
  }, [nodes, externalPending.length]);

  // Compile the regex once per `query` change. Invalid syntax returns a
  // null regex plus an `isRegexInvalid` flag; the bar shows a red border
  // and the filtered list is forced empty (see below) so the UX is
  // unambiguous — no silent "fallback to substring match".
  const { regex, isRegexInvalid } = useMemo(() => {
    if (!query) return { regex: null as RegExp | null, isRegexInvalid: false };
    try {
      return {
        regex: new RegExp(query, 'i'),
        isRegexInvalid: false,
      };
    } catch {
      return { regex: null as RegExp | null, isRegexInvalid: true };
    }
  }, [query]);

  const isFilterActive = query !== '' || selectedKeys.size > 0;

  // Canvas layer tree: use original node order (hierarchy-based).
  // We cache per-id item refs by content so that selection-only changes
  // (which rebuild every node object in the store via `{...n, selected}`)
  // do NOT invalidate the row props of unchanged items — this preserves
  // `SortableRow`'s `React.memo` and prevents O(N) row re-renders on
  // every click in the layer panel.
  const itemCacheRef = useRef<Map<string, DataSourceTreeItem>>(new Map());
  const layerItems = useMemo(() => {
    const fresh = buildTreeItems(nodes);
    const previous = itemCacheRef.current;
    const next = new Map<string, DataSourceTreeItem>();
    const stabilized = fresh.map((item) => {
      const cached = previous.get(item.id);
      const reused = cached && isSameTreeItem(cached, item) ? cached : item;
      next.set(item.id, reused);
      return reused;
    });
    itemCacheRef.current = next;
    return stabilized;
  }, [nodes]);

  // When filtering is active we switch to a flat "search results" view
  // (VS Code global-search style): hierarchy and indentation are dropped,
  // every match is rendered at depth 0. This sidesteps the messy
  // "ancestor frame might or might not pass the type filter" semantics
  // and keeps the drag / collapse code paths in the tree component
  // untouched. A second cache preserves item identity across renders so
  // `SortableRow`'s `React.memo` stays valid in flat mode too.
  const flatItemCacheRef = useRef<Map<string, DataSourceTreeItem>>(new Map());
  const filteredFlatItems = useMemo(() => {
    if (!isFilterActive) return null;
    // Invalid regex → empty list, the bar already shows the danger border.
    if (query !== '' && isRegexInvalid) return [] as DataSourceTreeItem[];

    const prev = flatItemCacheRef.current;
    const next = new Map<string, DataSourceTreeItem>();
    const out: DataSourceTreeItem[] = [];
    const hasTypeFilter = selectedKeys.size > 0;
    for (const item of layerItems) {
      const t = item.node.type as CanvasNodeType | undefined;
      // Empty `selectedKeys` means "no type constraint"; otherwise the
      // chip row acts as a whitelist and the node must match at least
      // one selected key (per-format for office, plain type otherwise).
      if (hasTypeFilter) {
        let matched = false;
        for (const key of selectedKeys) {
          if (
            nodeMatchesFilterKey(
              t,
              item.node.data as Record<string, unknown> | undefined,
              key,
            )
          ) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
      }
      if (regex && !regex.test(item.node.data.label)) continue;
      const cached = prev.get(item.id);
      const flat =
        cached && cached.node === item.node && cached.depth === 0
          ? cached
          : { id: item.id, node: item.node, depth: 0 };
      next.set(item.id, flat);
      out.push(flat);
    }
    flatItemCacheRef.current = next;
    return out;
  }, [layerItems, isFilterActive, isRegexInvalid, query, regex, selectedKeys]);

  const itemsToRender = isFilterActive ? (filteredFlatItems ?? []) : layerItems;
  const emptyText = isFilterActive ? 'No matching layers' : undefined;

  // Build external (not-yet-imported) note rows. Filter out any whose
  // frontmatter id already lives in the canvas state — handles the race
  // where the watcher saw the file before the canvas autosave landed.
  const externalItems = useMemo<DataSourceTreeItem[]>(() => {
    if (externalPending.length === 0) return [];
    const knownIds = new Set<string>();
    for (const n of rawNodes) knownIds.add(n.id);
    const hasTypeFilter = selectedKeys.size > 0;
    const out: DataSourceTreeItem[] = [];
    for (const item of externalPending) {
      if (item.noteId && knownIds.has(item.noteId)) continue;
      const label = item.fileName.replace(/\.md$/i, '');
      if (hasTypeFilter && !selectedKeys.has('note')) continue;
      if (regex && !regex.test(label)) continue;
      out.push(buildExternalTreeItem(item, label));
    }
    return out;
  }, [externalPending, rawNodes, selectedKeys, regex]);

  // Drive the collapse-all toolbar toggle: we need to know whether any
  // frame/group exists at all (to decide if the button renders) and
  // whether at least one of them is currently expanded (to flip the
  // icon between "collapse all" and "expand all"). Both derive from the
  // same single pass over `nodes`.
  const { hasAnyFrame, hasAnyExpandedFrame } = useMemo(() => {
    let any = false;
    let anyExpanded = false;
    for (const n of nodes) {
      if (n.type !== 'frame' && n.type !== 'group') continue;
      any = true;
      if (!collapsedFrameIds.has(n.id)) {
        anyExpanded = true;
        break; // We have everything the toggle needs.
      }
    }
    return { hasAnyFrame: any, hasAnyExpandedFrame: anyExpanded };
  }, [nodes, collapsedFrameIds]);

  const handleToggleAllFrames = useCallback(() => {
    setAllFramesCollapsed(hasAnyExpandedFrame);
  }, [hasAnyExpandedFrame, setAllFramesCollapsed]);

  // External rows render at the bottom so they don't push the active
  // canvas nodes off-screen when many `.md` files appear at once.
  const finalItems = useMemo(
    () =>
      externalItems.length === 0
        ? itemsToRender
        : [...itemsToRender, ...externalItems],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [externalItems, layerItems, filteredFlatItems, isFilterActive],
  );

  return (
    <SidebarPanel
      title="Layers"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={16} />}
      iconExpanded={<PanelLeftClose size={16} />}
      className="border-edge-default border-r"
      hideHeader
    >
      {/* Two-row split inside the panel so the scrollbar lane only
          spans the layer list, not the toolbar. SidebarPanel's own
          content wrapper still has `overflow-y-auto`, but the inner
          column here is `h-full` with its own scrolling region — the
          outer wrapper has no overflow to manage. */}
      <div className="flex h-full flex-col">
        <LayerFilterBar
          query={query}
          onQueryChange={setQuery}
          isRegexInvalid={isRegexInvalid}
          availableKeys={availableKeys}
          selectedKeys={selectedKeys}
          onToggleKey={handleToggleKey}
          isSearchOpen={isSearchOpen}
          onOpenSearch={() => setIsSearchOpen(true)}
          onCloseSearch={handleCloseSearch}
          hasAnyFrame={hasAnyFrame}
          hasAnyExpandedFrame={hasAnyExpandedFrame}
          onToggleAllFrames={handleToggleAllFrames}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CanvasLayerTree
            items={finalItems}
            getIcon={renderNodeIcon}
            getDisplayName={getNodeDisplayName}
            isFilterActive={isFilterActive}
            emptyText={emptyText}
          />
        </div>
      </div>
    </SidebarPanel>
  );
};
