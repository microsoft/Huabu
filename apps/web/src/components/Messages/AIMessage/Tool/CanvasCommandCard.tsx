/**
 * CanvasCommandCard — display-only renderer for the `canvas_commands`
 * internal tool. Lists the canvas mutations the agent performed. Revert
 * is owned by the broadcast-fed ChangeReviewCard (above the chat input),
 * so this card carries no per-change actions.
 */

import { Check, ChevronRight, Command } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  partIsExecuting,
  reconstructChangesFromCommands,
  type ToolPart,
} from './helpers';
import { NodeRef } from '../../../Common/NodeRef';
import { Spinner } from '../../../Common/Spinner';

import type { CanvasCommandsToolPart } from '@sediment/shared';

export function CanvasCommandCard({ part }: ToolPart<CanvasCommandsToolPart>) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const toolResponse = part.data ?? null;
  const isExecuting = partIsExecuting(part);

  // Reconstruct display rows from the command list. Canvas state (and
  // revert) is owned by the sync broadcast + ChangeReviewCard, so these
  // rows are display-only (never revertible).
  const displayChanges = useMemo(() => {
    const data =
      toolResponse?.status === 'success'
        ? ((toolResponse.data ?? {}) as Record<string, unknown>)
        : {};
    const commands = (data.commands ?? []) as Array<Record<string, unknown>>;
    return commands.length > 0 ? reconstructChangesFromCommands(commands) : [];
  }, [toolResponse]);

  const hasChanges = displayChanges.length > 0;

  const statusIcon = isExecuting ? (
    <Spinner size="xs" className="text-info" />
  ) : (
    <Check size={12} className="text-fg-muted" />
  );

  // Render inline change list (live or reconstructed from history)
  if (hasChanges) {
    const title =
      displayChanges.length === 1
        ? 'Canvas 1 change'
        : `Canvas ${displayChanges.length} changes`;

    // Single change → simple inline row (matches read-node single style)
    if (displayChanges.length === 1) {
      const change = displayChanges[0];
      // Render clickable node chips (source → target for edges, single chip
      // for node changes) instead of a bare label. `snapshotLabel` is
      // undefined for reconstructed changes, so NodeRef resolves the live
      // label (or shows a struck-through "deleted" chip when the node is gone).
      const content =
        change.sourceNodeId && change.targetNodeId ? (
          <>
            {change.label.split(':')[0] || 'Connected'}{' '}
            <NodeRef
              nodeId={change.sourceNodeId}
              snapshotLabel={change.sourceNodeLabel}
            />{' '}
            →{' '}
            <NodeRef
              nodeId={change.targetNodeId}
              snapshotLabel={change.targetNodeLabel}
            />
          </>
        ) : change.nodeId ? (
          <>
            {change.label.split(':')[0]}:{' '}
            <NodeRef nodeId={change.nodeId} snapshotLabel={change.nodeLabel} />
          </>
        ) : (
          change.label
        );
      return (
        <div className="flex justify-start">
          <div className="w-full">
            <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
              {statusIcon}
              <Command size={12} className="text-fg-muted/60 flex-shrink-0" />
              <span className="flex-1 truncate">{content}</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex justify-start">
        <div className="w-full">
          {/* Header row */}
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors">
            {statusIcon}
            <Command size={12} className="text-fg-muted/60 flex-shrink-0" />
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              className="flex flex-1 items-center gap-1 truncate text-left"
            >
              <span>{title}</span>
              <ChevronRight
                size={10}
                className={`text-fg-muted/50 flex-shrink-0 transition-transform ${!isCollapsed ? 'rotate-90' : ''}`}
              />
            </button>
          </div>

          {/* Change rows */}
          {!isCollapsed && (
            <div className="border-edge-default/40 ml-4 flex max-h-[24vh] flex-col gap-1 overflow-y-auto border-l py-1 pl-3">
              {displayChanges.map((change) => {
                const renderLabel = () => {
                  if (change.sourceNodeId && change.targetNodeId) {
                    const verb = change.label.split(':')[0] || 'Connected';
                    return (
                      <>
                        {verb}{' '}
                        <NodeRef
                          nodeId={change.sourceNodeId}
                          snapshotLabel={change.sourceNodeLabel}
                        />{' '}
                        →{' '}
                        <NodeRef
                          nodeId={change.targetNodeId}
                          snapshotLabel={change.targetNodeLabel}
                        />
                      </>
                    );
                  }
                  if (change.nodeId) {
                    const prefix = change.label.split(':')[0];
                    return (
                      <>
                        {prefix}:{' '}
                        <NodeRef
                          nodeId={change.nodeId}
                          snapshotLabel={change.nodeLabel}
                        />
                      </>
                    );
                  }
                  return change.label;
                };

                return (
                  <div
                    key={change.id}
                    className="text-fg-muted flex items-center gap-2 pr-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {renderLabel()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Truly empty → simple row
  return (
    <div className="flex justify-start">
      <div className="w-full">
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
          {statusIcon}
          <Command size={12} className="text-fg-muted/60 flex-shrink-0" />
          <span className="flex-1 truncate">Canvas commands</span>
        </div>
      </div>
    </div>
  );
}
