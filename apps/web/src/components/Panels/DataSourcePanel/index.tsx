import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useMemo } from 'react';

import { CanvasLayerTree } from './CanvasLayerTree';
import { type DataSourceNodeLike, type DataSourceTreeItem } from './types';
import { getNodeIcon, NODE_TYPE_LABEL } from '../../../config/nodeIcons';
import useCanvasStore from '../../../store/canvasStore';
import { SidebarPanel } from '../SidebarPanel';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

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

  // Canvas layer tree: use original node order (hierarchy-based)
  const layerItems = useMemo(() => buildTreeItems(nodes), [nodes]);

  const getIcon = (nodeType: string | undefined) => {
    return getNodeTitleAndIcon(nodeType).icon;
  };

  return (
    <SidebarPanel
      title="Contents"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={16} />}
      iconExpanded={<PanelLeftClose size={16} />}
      className="border-edge-default border-r"
    >
      <CanvasLayerTree
        items={layerItems}
        getIcon={getIcon}
        getDisplayName={getNodeDisplayName}
      />
    </SidebarPanel>
  );
};
