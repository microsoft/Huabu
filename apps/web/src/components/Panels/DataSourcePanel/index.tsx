import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  SquareDashed,
  StickyNote,
  Type,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  DataSourceTreeView,
  type DataSourceNodeLike,
  type DataSourceTreeItem,
} from './DataSourceTreeView';
import useStore from '../../../store/canvasStore';
import { GhostButton } from '../../Common/GhostButton';
import { SidebarPanel } from '../SidebarPanel';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

type LayerTab = 'layers' | 'notes';

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
  const nodes = useStore((s) => s.nodes) as unknown as DataSourceNodeLike[];
  const [tab, setTab] = useState<LayerTab>('layers');

  const layerItems = useMemo(() => buildTreeItems(nodes), [nodes]);

  const noteItems = useMemo(() => {
    const notes = nodes.filter((n) => n.type === 'note');
    return buildTreeItems(notes);
  }, [nodes]);

  const visibleItems = tab === 'layers' ? layerItems : noteItems;

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
              tab === 'layers'
                ? 'bg-background text-foreground rounded px-2 py-1 text-sm font-semibold'
                : 'text-muted-foreground hover:text-foreground rounded px-2 py-1 text-sm font-semibold'
            }
            onClick={() => setTab('layers')}
          >
            Layers
          </button>
          <button
            type="button"
            className={
              tab === 'notes'
                ? 'bg-background text-foreground rounded px-2 py-1 text-sm font-semibold'
                : 'text-muted-foreground hover:text-foreground rounded px-2 py-1 text-sm font-semibold'
            }
            onClick={() => setTab('notes')}
          >
            Notes
          </button>
        </div>
      }
      tools={
        <div className="flex items-center gap-1">
          <GhostButton title="Search" onClick={() => {}}>
            <Search size={16} />
          </GhostButton>
          <GhostButton title="Sort" onClick={() => {}}>
            <SlidersHorizontal size={16} />
          </GhostButton>
          <GhostButton title="More" onClick={() => {}}>
            <MoreVertical size={16} />
          </GhostButton>
        </div>
      }
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={18} />}
      iconExpanded={<PanelLeftClose size={18} />}
      className="border-border border-r"
    >
      <DataSourceTreeView
        items={visibleItems}
        getIcon={getNodeIcon}
        getDisplayName={getNodeDisplayName}
      />
    </SidebarPanel>
  );
};
