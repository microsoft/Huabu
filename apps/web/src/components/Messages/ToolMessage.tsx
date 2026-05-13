import {
  Blend,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  FolderOpen,
  LayoutList,
  ScanText,
  Search,
  SearchCode,
  Undo2,
  X as XIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { NodeRef } from '../Common/NodeRef';
import { SourceCard, type Source } from './Card/SourceCard';
import { useCanvasChangePreview } from '../../hooks/useCanvasChanges';
import { Button } from '../Common/Button';
import { Spinner } from '../Common/Spinner';

import type { CanvasChange } from '../../hooks/useCanvasChanges';
import type { CanvasCommand } from '@sediment/shared';
import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

// TODO: many status icons
// ==================== Helpers ====================

const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + '…' : s;

// ==================== Tool Icon Mapping ====================

const TOOL_ICON: Record<string, typeof ScanText> = {
  read: ScanText,
  grep: SearchCode,
  find: Search,
  ls: FolderOpen,
  inspect_nodes: LayoutList,
  get_canvas_outline: LayoutList,
  canvas_commands: Command,
};

// ==================== Merged Tool Row ====================

/** A single tool entry within a ToolMessageGroup, used for merging logic. */
export interface ToolEntry {
  messageId: string;
  toolResponse: ToolResponse<string, unknown>;
  isExecuting?: boolean;
}

/** Props for the unified tool message group component. */
interface ToolMessageGroupProps {
  entries: ToolEntry[];
}

/**
 * ToolMessageGroup — renders a group of consecutive same-tool messages
 * as a single merged row. For canvas_commands, shows inline change list.
 */
export function ToolMessageGroup({ entries }: ToolMessageGroupProps) {
  if (entries.length === 0) return null;

  const first = entries[0];
  const tool = first.toolResponse.tool;

  // Non-agent tools: render individually
  if (!isAgentTool(tool)) {
    if (tool === 'web_search') {
      return (
        <>
          {entries.map((e) => (
            <WebSearchToolDisplay
              key={e.messageId}
              toolResponse={e.toolResponse as WebSearchToolResponse}
            />
          ))}
        </>
      );
    }
    // Error display
    return (
      <>
        {entries.map((e) => {
          if (e.toolResponse.status === 'error') {
            const text = e.toolResponse.hint
              ? `Tool error (${e.toolResponse.tool}): ${e.toolResponse.error}\nHint: ${e.toolResponse.hint}`
              : `Tool error (${e.toolResponse.tool}): ${e.toolResponse.error}`;
            return (
              <div key={e.messageId} className="flex justify-start">
                <div className="bg-danger-bg text-danger border-edge-default rounded-md border px-4 py-3 text-sm whitespace-pre-wrap">
                  {text}
                </div>
              </div>
            );
          }
          return null;
        })}
      </>
    );
  }

  // canvas_commands: render each individually (each has its own change list)
  if (tool === 'canvas_commands') {
    return (
      <>
        {entries.map((e) => (
          <CanvasCommandCard
            key={e.messageId}
            messageId={e.messageId}
            toolResponse={e.toolResponse}
            isExecuting={e.isExecuting}
          />
        ))}
      </>
    );
  }

  // All other agent tools: merge into a single row
  const anyExecuting = entries.some((e) => e.isExecuting);
  const anyError = entries.some((e) => e.toolResponse.status === 'error');

  return (
    <MergedAgentToolRow
      tool={tool}
      entries={entries}
      isExecuting={anyExecuting}
      isError={anyError}
    />
  );
}

// ==================== Canvas Change Reconstruction ====================

/**
 * Reconstruct display-only CanvasChange entries from raw commands.
 * Used after refresh when canvasChanges weren't persisted.
 * All entries are non-revertible.
 */
function reconstructChangesFromCommands(
  commands: Array<Record<string, unknown>>,
): CanvasChange[] {
  const changes: CanvasChange[] = [];
  let counter = 0;

  for (const cmd of commands) {
    const type = cmd.type as string;
    switch (type) {
      case 'CREATE_NODES': {
        const nodes = (cmd.nodes ?? []) as Array<Record<string, unknown>>;
        for (const node of nodes) {
          const label = (node.data as Record<string, unknown> | undefined)
            ?.label as string | undefined;
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: `Created: ${truncate(label ?? 'untitled', 24)}`,
            nodeType: (node.nodeType as string) ?? 'note',
            nodeId: node.id as string,
            nodeLabel: truncate(label ?? 'untitled', 24),
            revertible: false,
          });
        }
        break;
      }
      case 'DELETE_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        for (const nodeId of nodeIds) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: `Deleted: ${truncate(nodeId, 24)}`,
            nodeId,
            revertible: false,
          });
        }
        break;
      }
      case 'MERGE_NODE_DATA': {
        const patches = (cmd.patches ?? []) as Array<Record<string, unknown>>;
        for (const patch of patches) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: `Updated: ${truncate((patch.nodeId as string) ?? '?', 24)}`,
            nodeId: patch.nodeId as string,
            revertible: false,
          });
        }
        break;
      }
      case 'CONNECT_NODES': {
        const edges = (cmd.edges ?? []) as Array<Record<string, unknown>>;
        for (const edge of edges) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: 'Connected',
            sourceNodeId: edge.source as string,
            targetNodeId: edge.target as string,
            revertible: false,
          });
        }
        break;
      }
      case 'DISCONNECT_EDGES': {
        const edges = (cmd.edges ?? []) as Array<
          string | Record<string, unknown>
        >;
        for (const edge of edges) {
          const source =
            typeof edge === 'string' ? undefined : (edge.source as string);
          const target =
            typeof edge === 'string' ? undefined : (edge.target as string);
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: 'Disconnected',
            sourceNodeId: source,
            targetNodeId: target,
            revertible: false,
          });
        }
        break;
      }
      case 'SET_NODE_PARENT': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        const parentId = cmd.parentId as string | null;
        const verb = parentId ? 'Moved into frame' : 'Moved out of frame';
        for (const nodeId of nodeIds) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: `${verb}: ${truncate(nodeId, 24)}`,
            nodeId,
            revertible: false,
          });
        }
        break;
      }
      case 'DISSOLVE_FRAME': {
        changes.push({
          id: `hist-${counter++}`,
          tool: 'canvas_commands',
          label: 'Dissolved frame',
          nodeType: 'frame',
          nodeId: cmd.frameId as string,
          revertible: false,
        });
        break;
      }
      case 'SET_NODE_GEOMETRY': {
        const items = (cmd.items ?? []) as Array<Record<string, unknown>>;
        for (const item of items) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'canvas_commands',
            label: `Repositioned: ${truncate((item.nodeId as string) ?? '?', 24)}`,
            nodeId: item.nodeId as string,
            revertible: false,
          });
        }
        break;
      }
      case 'ALIGN_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        changes.push({
          id: `hist-${counter++}`,
          tool: 'canvas_commands',
          label: `Aligned ${nodeIds.length} node(s)`,
          revertible: false,
        });
        break;
      }
      case 'DISTRIBUTE_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        changes.push({
          id: `hist-${counter++}`,
          tool: 'canvas_commands',
          label: `Distributed ${nodeIds.length} node(s)`,
          revertible: false,
        });
        break;
      }
      case 'AUTO_LAYOUT': {
        changes.push({
          id: `hist-${counter++}`,
          tool: 'canvas_commands',
          label: 'Auto layout',
          revertible: false,
        });
        break;
      }
      default:
        changes.push({
          id: `hist-${counter++}`,
          tool: 'canvas_commands',
          label: type || 'Unknown command',
          revertible: false,
        });
        break;
    }
  }

  return changes;
}

// ==================== Canvas Command Card ====================

function CanvasCommandCard({
  messageId,
  toolResponse,
  isExecuting,
}: {
  messageId: string;
  toolResponse: ToolResponse<string, unknown>;
  isExecuting?: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const data =
    toolResponse.status === 'success'
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

  const updateMessage = useChatStore((s) => s.updateMessage);

  const {
    isNodeMissing,
    isNodePreviewing,
    handlePreviewDown,
    handlePreviewAllDown,
    handlePreviewUp,
  } = useCanvasChangePreview(canvasChanges);

  const removeChange = useCallback(
    (changeId: string) => {
      updateMessage(messageId, (m) => {
        if (m.role !== 'tool' || m.toolResponse.status !== 'success') return m;
        const d = m.toolResponse.data as Record<string, unknown>;
        const changes = (d.canvasChanges ?? []) as CanvasChange[];
        return {
          ...m,
          toolResponse: {
            ...m.toolResponse,
            data: {
              ...d,
              canvasChanges: changes.filter((c) => c.id !== changeId),
            },
          },
        };
      });
    },
    [messageId, updateMessage],
  );

  const clearAllChanges = useCallback(() => {
    updateMessage(messageId, (m) => {
      if (m.role !== 'tool' || m.toolResponse.status !== 'success') return m;
      const d = m.toolResponse.data as Record<string, unknown>;
      return {
        ...m,
        toolResponse: {
          ...m.toolResponse,
          data: { ...d, canvasChanges: [] },
        },
      };
    });
  }, [messageId, updateMessage]);

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

// ==================== Merged Agent Tool Row ====================

function MergedAgentToolRow({
  tool,
  entries,
  isExecuting,
  isError,
}: {
  tool: string;
  entries: ToolEntry[];
  isExecuting?: boolean;
  isError?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const count = entries.length;

  // Build merged title and content
  const { title, nodeRefs } = useMemo(() => {
    const emptyRefs: { nodeId?: string; label?: string }[] = [];

    if (tool === 'inspect_nodes') {
      // inspect_nodes returns `{ count, nodes: [{ id, label, ... }] }`.
      // One call may match many nodes; flatten across all calls so the
      // expanded view lists every matched node.
      const refs: { nodeId?: string; label?: string }[] = [];
      let totalMatched = 0;
      for (const e of entries) {
        const d =
          e.toolResponse.status === 'success'
            ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
            : {};
        const nodes = Array.isArray(d.nodes)
          ? (d.nodes as Array<Record<string, unknown>>)
          : [];
        totalMatched += nodes.length;
        for (const n of nodes) {
          refs.push({
            nodeId: typeof n.id === 'string' ? n.id : undefined,
            label: typeof n.label === 'string' ? n.label : undefined,
          });
        }
      }
      return {
        title:
          count === 1
            ? totalMatched === 1
              ? 'Inspected 1 node'
              : `Inspected ${totalMatched} nodes`
            : `Inspected nodes (×${count})`,
        nodeRefs: refs,
      };
    }

    if (tool === 'read') {
      const first =
        entries[0]?.toolResponse.status === 'success'
          ? ((entries[0].toolResponse.data ?? {}) as Record<string, unknown>)
          : {};
      const firstPath = (first.path as string) || '';
      return {
        title:
          count === 1
            ? firstPath
              ? `Read ${truncate(firstPath, 60)}`
              : 'Read file'
            : `Read ${count} files`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'grep') {
      // grep returns `{ matches, count, limitReached }`. Sum match counts
      // across calls for a self-describing title.
      const totalMatches = entries.reduce((sum, e) => {
        const d =
          e.toolResponse.status === 'success'
            ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const matchLabel = totalMatches === 1 ? 'match' : 'matches';
      return {
        title:
          count === 1
            ? `Grep — ${totalMatches} ${matchLabel}`
            : `Grep (×${count}) — ${totalMatches} ${matchLabel}`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'find') {
      // find returns `{ paths, count, limitReached }`.
      const totalPaths = entries.reduce((sum, e) => {
        const d =
          e.toolResponse.status === 'success'
            ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const fileLabel = totalPaths === 1 ? 'file' : 'files';
      return {
        title:
          count === 1
            ? `Find — ${totalPaths} ${fileLabel}`
            : `Find (×${count}) — ${totalPaths} ${fileLabel}`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'ls') {
      // ls returns `{ path, entries, count, limitReached }`.
      const first =
        entries[0]?.toolResponse.status === 'success'
          ? ((entries[0].toolResponse.data ?? {}) as Record<string, unknown>)
          : {};
      const firstPath = (first.path as string) || '';
      const firstCount = typeof first.count === 'number' ? first.count : 0;
      const entryLabel = firstCount === 1 ? 'entry' : 'entries';
      return {
        title:
          count === 1
            ? firstPath
              ? `Ls ${truncate(firstPath, 40)} — ${firstCount} ${entryLabel}`
              : `Ls — ${firstCount} ${entryLabel}`
            : `Ls (×${count})`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'get_canvas_outline') {
      return {
        title:
          count === 1
            ? 'Read canvas outline'
            : `Read canvas outline (×${count})`,
        nodeRefs: emptyRefs,
      };
    }

    return { title: tool, nodeRefs: emptyRefs };
  }, [tool, entries, count]);

  const statusIcon = isExecuting ? (
    <Spinner size="xs" className="text-info" />
  ) : isError ? (
    <XIcon size={12} className="text-danger" />
  ) : (
    <Check size={12} className="text-fg-muted" />
  );

  const icon = useMemo(() => {
    const Icon = TOOL_ICON[tool];
    if (Icon) return <Icon size={12} />;
    return null;
  }, [tool]);

  // Single inspect_nodes call that matched a single node → inline badge
  if (
    count === 1 &&
    tool === 'inspect_nodes' &&
    nodeRefs.length === 1 &&
    nodeRefs[0]?.nodeId
  ) {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {icon && <span className="text-fg-muted/60">{icon}</span>}
            <span className="flex-1 truncate">
              Inspected{' '}
              <NodeRef
                nodeId={nodeRefs[0].nodeId}
                fallbackLabel={nodeRefs[0].label}
              />
            </span>
          </div>
        </div>
      </div>
    );
  }

  // No expandable content → simple row
  if (nodeRefs.length === 0 || count === 1) {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {icon && <span className="text-fg-muted/60">{icon}</span>}
            <span className="flex-1 truncate">{title}</span>
          </div>
        </div>
      </div>
    );
  }

  // Multiple entries with refs → expandable row
  return (
    <div className="flex justify-start">
      <div className="w-full">
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors">
          {statusIcon}
          {icon && <span className="text-fg-muted/60">{icon}</span>}
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex flex-1 items-center gap-1 truncate text-left"
          >
            <span>{title}</span>
            <ChevronRight
              size={10}
              className={`text-fg-muted/50 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        </div>
        {isExpanded && (
          <div className="border-edge-default/40 ml-4 flex flex-col gap-1 border-l py-1 pl-3">
            {tool === 'inspect_nodes'
              ? // inspect_nodes flattens nodes across calls into nodeRefs;
                // render each matched node as its own row.
                nodeRefs.map((ref, i) =>
                  ref.nodeId ? (
                    <div
                      key={`${ref.nodeId}-${i}`}
                      className="text-fg-muted flex items-center gap-1.5 text-xs"
                    >
                      <span className="truncate">
                        <NodeRef
                          nodeId={ref.nodeId}
                          fallbackLabel={ref.label}
                        />
                      </span>
                    </div>
                  ) : (
                    <div
                      key={`unknown-${i}`}
                      className="text-fg-muted flex items-center gap-1.5 text-xs"
                    >
                      <span className="truncate">{ref.label ?? '?'}</span>
                    </div>
                  ),
                )
              : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== Legacy Single ToolMessage (for non-grouped rendering) ====================

interface ToolMessageProps {
  messageId: string;
  toolResponse: ToolResponse<string, unknown>;
  isExecuting?: boolean;
}

/**
 * ToolMessage — single tool message renderer.
 * Delegates to ToolMessageGroup with a single entry.
 */
export const ToolMessage = ({
  messageId,
  toolResponse,
  isExecuting,
}: ToolMessageProps) => {
  return (
    <ToolMessageGroup entries={[{ messageId, toolResponse, isExecuting }]} />
  );
};

/** Tools used by the operate mode that should show as collapsible cards. */
function isAgentTool(tool: string): boolean {
  return [
    'read',
    'grep',
    'find',
    'ls',
    'inspect_nodes',
    'get_canvas_outline',
    'canvas_commands',
  ].includes(tool);
}

/**
 * Display for web search tool responses
 */
function WebSearchToolDisplay({
  toolResponse,
}: {
  toolResponse: WebSearchToolResponse;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const sources = useMemo<Source[]>(() => {
    if (toolResponse.status !== 'success') return [];
    const results = toolResponse.data.results ?? [];
    return results
      .map((r) => ({ title: r.title, url: r.url, favicon: r.favicon }))
      .filter((s) => typeof s.url === 'string' && s.url.trim().length > 0);
  }, [toolResponse]);

  if (toolResponse.status !== 'success') return null;

  if (sources.length === 0) {
    return (
      <div className="flex justify-start">
        <div className="text-fg-muted border-edge-default bg-surface rounded-2xl border px-4 py-3 text-sm whitespace-pre-wrap">
          Used 0 references
        </div>
      </div>
    );
  }

  const count = sources.length;
  const label = count === 1 ? 'reference' : 'references';

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col items-start gap-2">
        <Button
          variant="ghost"
          tone="neutral"
          aria-expanded={isExpanded}
          aria-label={`Toggle sources (${count} ${label})`}
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? <ChevronDown /> : <ChevronRight />}
          <span className="mr-1 ml-2">
            Used {count} {label}
          </span>
        </Button>

        {isExpanded && (
          <div className="w-full">
            <ul className="space-y-2">
              {sources.map((s) => {
                return (
                  <li key={s.url} className="min-w-0">
                    <SourceCard source={s} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
