import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useMemo } from 'react';

import { CanvasLayerTree } from './CanvasLayerTree';
import { getNodeIcon } from '../../../config/nodeIcons';
import useCanvasStore from '../../../store/canvasStore';
import { SketchIcon } from '../../Nodes/sketch/SketchIcon';
import { SidebarPanel } from '../SidebarPanel';

import type { DataSourceNodeLike, DataSourceTreeItem } from './types';
import type { SketchStroke } from '@sediment/shared';

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

  const Icon = getNodeIcon(node.type);
  return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} />;
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

export const CanvasLayerPanel = ({
  isCollapsed,
  onToggle,
}: CanvasLayerPanelProps) => {
  const nodes = useCanvasStore(
    (s) => s.nodes,
  ) as unknown as DataSourceNodeLike[];

  // Canvas layer tree: use original node order (hierarchy-based)
  const layerItems = useMemo(() => buildTreeItems(nodes), [nodes]);

  return (
    <SidebarPanel
      title="Layers"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={16} />}
      iconExpanded={<PanelLeftClose size={16} />}
      className="border-edge-default border-r"
    >
      <CanvasLayerTree
        items={layerItems}
        getIcon={renderNodeIcon}
        getDisplayName={getNodeDisplayName}
      />
    </SidebarPanel>
  );
};
