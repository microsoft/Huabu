import clsx from 'clsx';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState, useEffect } from 'react';

import { CanvasLayerTree } from './CanvasLayerTree';
import { SourceLibraryTree } from './SourceLibraryTree';
import { type DataSourceNodeLike, type DataSourceTreeItem } from './types';
import { getSources, getSource, updateSource } from '../../../api/knowledge';
import { getNodeIcon, NODE_TYPE_LABEL } from '../../../config/nodeIcons';
import useCanvasStore from '../../../store/canvasStore';
import { usePreviewStore } from '../../../store/previewStore';
import { GhostButton } from '../../Common/GhostButton';
import { SidebarPanel } from '../SidebarPanel';

import type { Source } from '@sediment/shared';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

type SortType = 'alpha' | 'importance' | 'time' | 'manual';

type LayerTab = 'canvas' | 'sources';

const ICON_SIZE = 14;
const ICON_STROKE_WIDTH = 1.5;

const getNodeTitleAndIcon = (nodeType: string | undefined) => {
  const Icon = getNodeIcon(nodeType);
  const title =
    nodeType && nodeType in NODE_TYPE_LABEL
      ? NODE_TYPE_LABEL[nodeType as keyof typeof NODE_TYPE_LABEL]
      : 'Block';
  return {
    title,
    icon: <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />,
  };
};

const getNodeDisplayName = (node: DataSourceNodeLike): string => {
  return node.data.label;
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
    // Reverse children so higher z-order (later in nodes array) appears first
    for (let i = kids.length - 1; i >= 0; i -= 1) visit(kids[i], depth + 1);
  };

  // Reverse roots so higher z-order (later in nodes array) appears first
  for (let i = roots.length - 1; i >= 0; i -= 1) visit(roots[i], 0);
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

  // Canvas layer tree: use original node order (hierarchy-based)
  const layerItems = useMemo(() => buildTreeItems(nodes), [nodes]);

  // Source library: apply sorting
  const sourceItems = useMemo(() => {
    const sortedSources = [...sources];

    if (sortType !== 'manual') {
      sortedSources.sort((a, b) => {
        switch (sortType) {
          case 'alpha':
            return (a.title || a.src || 'Untitled').localeCompare(
              b.title || b.src || 'Untitled',
            );
          case 'time':
            // TODO: sort by created/updated time when available
            return 0;
          case 'importance':
            // TODO: implement importance sorting
            return 0;
          default:
            return 0;
        }
      });
    }

    return sortedSources.map((s) => ({
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
  }, [sources, sortType]);

  const getNodeIcon = (nodeType: string | undefined) => {
    return getNodeTitleAndIcon(nodeType).icon;
  };

  const handleSourceRename = async (sourceId: string, newName: string) => {
    try {
      await updateSource(sourceId, { title: newName });
      // Refresh sources list
      const updatedSources = await getSources();
      setSources(updatedSources);
    } catch (error) {
      console.error('Failed to rename source:', error);
    }
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
                ? 'bg-background text-foreground rounded px-2 py-1'
                : 'hover:text-foreground rounded px-2 py-1'
            }
            onClick={() => setTab('canvas')}
          >
            Canvas
          </button>
          <button
            type="button"
            className={
              tab === 'sources'
                ? 'bg-background text-foreground rounded px-2 py-1'
                : 'hover:text-foreground rounded px-2 py-1'
            }
            onClick={() => setTab('sources')}
          >
            Sources
          </button>
        </div>
      }
      tools={
        tab === 'sources' && (
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
                    { id: 'time', label: 'Time', desc: 'Newest' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      className={clsx(
                        'hover:bg-accent flex w-full justify-between px-3 py-1.5 text-left text-xs',
                        sortType === opt.id && 'font-bold text-blue-500',
                      )}
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
          </div>
        )
      }
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={16} />}
      iconExpanded={<PanelLeftClose size={16} />}
      className="border-border border-r"
    >
      {tab === 'canvas' ? (
        <CanvasLayerTree
          items={layerItems}
          getIcon={getNodeIcon}
          getDisplayName={getNodeDisplayName}
        />
      ) : (
        <SourceLibraryTree
          items={sourceItems}
          getIcon={getNodeIcon}
          getDisplayName={getNodeDisplayName}
          onRename={handleSourceRename}
          onItemClick={async (item) => {
            const nodes = useCanvasStore.getState().nodes;
            const targetNode = nodes.find(
              (n) => n.data?.sourceId === item.node.id,
            );

            if (targetNode) {
              const rfInstance = useCanvasStore.getState().rfInstance;
              useCanvasStore.getState().selectNodes([targetNode.id]);
              usePreviewStore.getState().closePreview();

              if (rfInstance) {
                void rfInstance.fitView({
                  nodes: [{ id: targetNode.id }],
                  duration: 800,
                  maxZoom: 1,
                });
              }
            } else {
              let data = {
                ...item.node.data,
              } as Record<string, unknown>;

              // For note/text types, fetch full content for preview
              const sourceType = item.node.type || 'text';
              if (sourceType === 'note' || sourceType === 'text') {
                try {
                  const fullSource = await getSource(item.node.id);
                  if (fullSource?.content) {
                    data = {
                      ...data,
                      content: fullSource.content,
                    };
                  }
                } catch (error) {
                  console.error('Failed to fetch source content:', error);
                }
              }

              // Trigger preview in the central ExpandedNodePanel
              useCanvasStore.getState().closeExpanded();
              usePreviewStore.getState().openPreview(sourceType, data);
            }
          }}
        />
      )}
    </SidebarPanel>
  );
};
