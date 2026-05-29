/**
 * CanvasCommandCard — renderer for the `canvas_commands` internal
 * tool. Displays the list of canvas mutations the agent performed,
 * with per-change revert / keep / preview controls (when revertible).
 */

import { Blend, Check, ChevronRight, Command, Undo2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import {
  partIsExecuting,
  reconstructChangesFromCommands,
  type ToolPart,
} from './helpers';
import { useCanvasChangePreview } from '../../../../hooks/useCanvasChanges';
import { Button } from '../../../Common/Button';
import { NodeRef } from '../../../Common/NodeRef';
import { Spinner } from '../../../Common/Spinner';

import type { CanvasChange } from '../../../../hooks/useCanvasChanges';
import type { CanvasCommand, CanvasCommandsToolPart } from '@sediment/shared';

export function CanvasCommandCard({
  messageId,
  part,
}: ToolPart<CanvasCommandsToolPart>) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const toolResponse = part.data ?? null;
  const isExecuting = partIsExecuting(part);
  const toolCallId = part.toolCallId;

  const data =
    toolResponse?.status === 'success'
      ? ((toolResponse.data ?? {}) as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const canvasChanges = (data.canvasChanges ?? []) as CanvasChange[];
  const commands = (data.commands ?? []) as Array<Record<string, unknown>>;

  // Use live canvasChanges if available; otherwise reconstruct from commands
  const displayChanges = useMemo(() => {
    if (canvasChanges.length > 0) return canvasChanges;
    if (commands.length > 0) return reconstructChangesFromCommands(commands);
    return [];
  }, [canvasChanges, commands]);

  const hasChanges = displayChanges.length > 0;
  const anyRevertible = displayChanges.some((c) => c.revertible);

  const upsertAssistantToolPart = useChatStore(
    (s) => s.upsertAssistantToolPart,
  );

  const {
    isNodeMissing,
    isNodePreviewing,
    handlePreviewDown,
    handlePreviewAllDown,
    handlePreviewUp,
  } = useCanvasChangePreview(canvasChanges);

  /**
   * Update the `canvasChanges` array nested inside this part's
   * typed `data` envelope. The renderers all read off
   * `canvasChanges`, so removing / clearing is just a filtered
   * rewrite of that array.
   */
  const writeChanges = useCallback(
    (mapper: (changes: CanvasChange[]) => CanvasChange[]) => {
      upsertAssistantToolPart(messageId, toolCallId, (existing) => {
        if (!existing) return part;
        if (existing.variant !== 'canvas_commands') return existing;
        const td = existing.data;
        if (!td || td.status !== 'success') return existing;
        const d = (td.data ?? {}) as Record<string, unknown>;
        const changes = (d.canvasChanges ?? []) as CanvasChange[];
        return {
          ...existing,
          data: {
            ...td,
            data: {
              ...d,
              canvasChanges: mapper(changes),
            },
          },
        };
      });
    },
    [messageId, toolCallId, upsertAssistantToolPart, part],
  );

  const removeChange = useCallback(
    (changeId: string) => {
      writeChanges((changes) => changes.filter((c) => c.id !== changeId));
    },
    [writeChanges],
  );

  const clearAllChanges = useCallback(() => {
    writeChanges(() => []);
  }, [writeChanges]);

  const revertChange = useCallback(
    (changeId: string) => {
      const change = canvasChanges.find((c) => c.id === changeId);
      if (change?.revertible) {
        const cmds: CanvasCommand[] = [];
        if (change.revertCommands) cmds.push(...change.revertCommands);
        else if (change.revertCommand) cmds.push(change.revertCommand);
        if (cmds.length > 0) {
          useCanvasStore.getState().executeCommands(cmds, 'ui');
        }
      }
      removeChange(changeId);
    },
    [canvasChanges, removeChange],
  );

  const revertAllChanges = useCallback(() => {
    const reversed = [...canvasChanges].reverse();
    const revertCmds: CanvasCommand[] = [];
    for (const change of reversed) {
      if (change.revertible) {
        if (change.revertCommands) revertCmds.push(...change.revertCommands);
        else if (change.revertCommand) revertCmds.push(change.revertCommand);
      }
    }
    if (revertCmds.length > 0) {
      useCanvasStore.getState().executeCommands(revertCmds, 'ui');
    }
    clearAllChanges();
  }, [canvasChanges, clearAllChanges]);

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

    // Single non-revertible change → simple inline row (matches read-node single style)
    if (displayChanges.length === 1 && !anyRevertible) {
      const change = displayChanges[0];
      return (
        <div className="flex justify-start">
          <div className="w-full">
            <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
              {statusIcon}
              <Command size={12} className="text-fg-muted/60 flex-shrink-0" />
              <span className="flex-1 truncate">{change.label}</span>
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
            {anyRevertible && (
              <div className="flex flex-shrink-0 items-center gap-1">
                <Button
                  onClick={clearAllChanges}
                  variant="outline"
                  size="sm"
                  className="h-5 rounded-sm"
                >
                  Keep all
                </Button>
                <Button
                  onClick={revertAllChanges}
                  variant="outline"
                  size="sm"
                  className="h-5 rounded-sm"
                >
                  Revert all
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  onPointerDown={handlePreviewAllDown}
                  onPointerUp={handlePreviewUp}
                  onPointerLeave={handlePreviewUp}
                >
                  <Blend />
                </Button>
              </div>
            )}
          </div>

          {/* Change rows */}
          {!isCollapsed && (
            <div className="border-edge-default/40 ml-4 flex max-h-[24vh] flex-col gap-1 overflow-y-auto border-l py-1 pl-3">
              {displayChanges.map((change) => {
                const allMissing =
                  (change.nodeId && isNodeMissing(change.nodeId)) ||
                  (change.sourceNodeId && isNodeMissing(change.sourceNodeId)) ||
                  (change.targetNodeId && isNodeMissing(change.targetNodeId));

                const renderLabel = () => {
                  if (change.sourceNodeId && change.targetNodeId) {
                    const verb = change.label.split(':')[0] || 'Connected';
                    return (
                      <>
                        {verb}{' '}
                        <NodeRef
                          nodeId={change.sourceNodeId}
                          snapshotLabel={change.sourceNodeLabel}
                          previewing={isNodePreviewing(change.sourceNodeId)}
                        />{' '}
                        →{' '}
                        <NodeRef
                          nodeId={change.targetNodeId}
                          snapshotLabel={change.targetNodeLabel}
                          previewing={isNodePreviewing(change.targetNodeId)}
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
                          previewing={isNodePreviewing(change.nodeId)}
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
                    {change.revertible && (
                      <div className="flex flex-shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          iconOnly
                          size="sm"
                          onClick={() => removeChange(change.id)}
                          title="Keep this change"
                        >
                          <Check />
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          size="sm"
                          onClick={() => revertChange(change.id)}
                          disabled={!change.revertible || !!allMissing}
                          title="Revert this change"
                        >
                          <Undo2 />
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          size="sm"
                          onPointerDown={() => handlePreviewDown(change)}
                          onPointerUp={handlePreviewUp}
                          onPointerLeave={handlePreviewUp}
                          disabled={!change.revertible}
                          title="Hold to preview before"
                        >
                          <Blend />
                        </Button>
                      </div>
                    )}
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
