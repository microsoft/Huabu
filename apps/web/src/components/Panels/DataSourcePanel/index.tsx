import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  SquareDashed,
  StickyNote,
  Type,
} from 'lucide-react';
import { useMemo, useState, useEffect } from 'react';

import { CanvasLayerTree } from './CanvasLayerTree';
import { SourceLibraryTree } from './SourceLibraryTree';
import { type DataSourceNodeLike, type DataSourceTreeItem } from './types';
import { getSources, type Source } from '../../../api/knowledge';
import useCanvasStore from '../../../store/canvasStore';
import { usePreviewStore } from '../../../store/previewStore';
import { GhostButton } from '../../Common/GhostButton';
import { SidebarPanel } from '../SidebarPanel';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

type SortType = 'alpha' | 'importance' | 'time' | 'manual';

type LayerTab = 'canvas' | 'sources';

const ICON_SIZE = 14;
const ICON_STROKE_WIDTH = 1.5;

const getNodeTitleAndIcon = (nodeType: string | undefined) => {
  switch (nodeType) {
    case 'frame':
      return {
        title: 'Block',
        icon: <SquareDashed size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'image':
      return {
        title: 'Image',
        icon: <ImageIcon size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'video':
      return {
        title: 'Video',
        icon: <Film size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'web':
      return {
        title: 'Website',
        icon: <Globe size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'pdf':
      return {
        title: 'PDF',
        icon: <FileText size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'note':
      return {
        title: 'Note',
        icon: <StickyNote size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    case 'text':
      return {
        title: 'Text',
        icon: <Type size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
    default:
      return {
        title: 'Block',
        icon: <SquareDashed size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
      };
  }
};

const getNodeDisplayName = (node: DataSourceNodeLike): string => {
  const raw = typeof node.data?.label === 'string' ? node.data.label : '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'Node';
};

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
    for (const kid of kids) visit(kid, depth + 1);
  };

  for (const rootId of roots) visit(rootId, 0);
  return out;
};

export const DataSourcePanel = ({
  isCollapsed,
  onToggle,
}: DataSourcePanelProps) => {
  const nodes = useCanvasStore(
    (s) => s.nodes,
  ) as unknown as DataSourceNodeLike[];
  const [tab, setTab] = useState<LayerTab>('canvas');
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    if (tab === 'sources') {
      getSources().then(setSources).catch(console.error);
    }
  }, [tab]);

  const [sortType, setSortType] = useState<SortType>('alpha');
  const [showSortMenu, setShowSortMenu] = useState(false);

  const processedNodes = useMemo(() => {
    const filtered = [...nodes];

    if (sortType !== 'manual') {
      filtered.sort((a, b) => {
        switch (sortType) {
          case 'importance': {
            const areaA =
              (Number(a.measured?.width) || Number(a.width) || 0) *
              (Number(a.measured?.height) || Number(a.height) || 0);
            const areaB =
              (Number(b.measured?.width) || Number(b.width) || 0) *
              (Number(b.measured?.height) || Number(b.height) || 0);
            return areaB - areaA;
          }
          case 'time':
            return 1;
          case 'alpha':
          default:
            return getNodeDisplayName(a).localeCompare(getNodeDisplayName(b));
        }
      });
    }
    return filtered.reverse();
  }, [nodes, sortType]);

  const layerItems = useMemo(
    () => buildTreeItems(processedNodes),
    [processedNodes],
  );

  const sourceItems = useMemo(() => {
    return sources.map((s) => ({
      id: s.sourceId,
      depth: 0,
      node: {
        id: s.sourceId,
        type: s.type || 'text',
        data: {
          label: s.title || s.src || 'Untitled',
          ...s,
        },
      },
    }));
  }, [sources]);

  const visibleItems = tab === 'canvas' ? layerItems : sourceItems;

  const getNodeIcon = (nodeType: string | undefined) => {
    return getNodeTitleAndIcon(nodeType).icon;
  };

  return (
    <SidebarPanel
      title="Data Sources"
      tabs={
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={
              tab === 'canvas'
                ? 'bg-background text-foreground rounded px-2 py-1 text-sm font-medium'
                : 'text-muted-foreground hover:text-foreground rounded px-2 py-1 text-sm font-semibold'
            }
            onClick={() => setTab('canvas')}
          >
            Canvas
          </button>
          <button
            type="button"
            className={
              tab === 'sources'
                ? 'bg-background text-foreground rounded px-2 py-1 text-sm font-semibold'
                : 'text-muted-foreground hover:text-foreground rounded px-2 py-1 text-sm font-semibold'
            }
            onClick={() => setTab('sources')}
          >
            Sources
          </button>
        </div>
      }
      tools={
        <div className="flex items-center gap-1">
          <GhostButton title="Search" onClick={() => {}}>
            <Search size={16} />
          </GhostButton>

          <div className="relative">
            <GhostButton
              title="Sort"
              onClick={() => setShowSortMenu(!showSortMenu)}
            >
              <SlidersHorizontal
                size={16}
                className={sortType !== 'manual' ? 'text-blue-500' : ''}
              />
            </GhostButton>

            {showSortMenu && (
              <div className="bg-popover border-border absolute top-full right-0 z-50 mt-1 w-32 rounded border py-1 shadow-lg">
                {[
                  { id: 'alpha', label: 'Alphabetical', desc: 'A-Z' },
                  { id: 'importance', label: 'Importance', desc: 'Size' },
                  { id: 'time', label: 'Time', desc: 'Newest' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    className={`hover:bg-accent flex w-full justify-between px-3 py-1.5 text-left text-xs ${
                      sortType === opt.id ? 'font-bold text-blue-500' : ''
                    }`}
                    onClick={() => {
                      setSortType(opt.id as SortType);
                      setShowSortMenu(false);
                    }}
                  >
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/*    <GhostButton title="Sort" onClick={() => {}}>*/}
          {/*  <SlidersHorizontal size={16} />*/}
          {/*</GhostButton>*/}
          {/*<GhostButton title="More" onClick={() => {}}>*/}
          {/*  <MoreVertical size={16} />*/}
          {/*</GhostButton>*/}
        </div>
      }
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={16} />}
      iconExpanded={<PanelLeftClose size={16} />}
      className="border-border border-r"
    >
      {tab === 'canvas' ? (
        <CanvasLayerTree
          items={visibleItems}
          getIcon={getNodeIcon}
          getDisplayName={getNodeDisplayName}
          onDragStart={() => setSortType('manual')}
        />
      ) : (
        <SourceLibraryTree
          items={visibleItems}
          getIcon={getNodeIcon}
          getDisplayName={getNodeDisplayName}
          onItemClick={(item) => {
            const data = {
              label: item.node.data?.label,
              ...item.node.data,
            } as Record<string, unknown>;

            // Trigger preview in the central ExpandedNodePanel
            useCanvasStore.getState().closeExpanded();
            usePreviewStore
              .getState()
              .openPreview(item.node.type || 'text', data);
          }}
        />
      )}
    </SidebarPanel>
  );
};
