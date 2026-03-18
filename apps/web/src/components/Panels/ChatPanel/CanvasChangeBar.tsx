import { NODE_ICON } from '@/config/nodeIcons';

import { NodeRef } from '../../Messages/NodeRef';

import type { CanvasNodeType } from '@sediment/shared';

export interface CanvasChange {
  tool: string;
  label: string;
  nodeType?: string;
  nodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
}

interface CanvasChangeBarProps {
  changes: CanvasChange[];
}

export const CanvasChangeBar = ({ changes }: CanvasChangeBarProps) => {
  if (changes.length === 0) return null;

  return (
    <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-xl border p-3">
      <div className="text-foreground/70 text-xs font-medium">
        Canvas changes ({changes.length})
      </div>
      <div className="flex flex-col gap-1">
        {changes.map((change, i) => {
          const Icon =
            NODE_ICON[(change.nodeType as CanvasNodeType) ?? 'note'] ??
            NODE_ICON.note;

          const renderLabel = () => {
            if (
              change.tool === 'connect_nodes' &&
              change.sourceNodeId &&
              change.targetNodeId
            ) {
              return (
                <>
                  Connected <NodeRef nodeId={change.sourceNodeId} /> →{' '}
                  <NodeRef nodeId={change.targetNodeId} />
                </>
              );
            }
            if (change.nodeId) {
              const prefix = change.label.split(':')[0];
              const fallback = change.label.split(': ').slice(1).join(': ');
              return (
                <>
                  {prefix}:{' '}
                  <NodeRef nodeId={change.nodeId} fallbackLabel={fallback} />
                </>
              );
            }
            return change.label;
          };

          return (
            <div
              key={i}
              className="text-muted-foreground flex items-center gap-1.5 text-xs"
            >
              <Icon size={11} className="flex-shrink-0" />
              <span className="truncate">{renderLabel()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
