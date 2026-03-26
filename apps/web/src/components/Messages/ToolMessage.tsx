import {
  Blend,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  Undo2,
  X as XIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { IconButton } from '@/components/Common/IconButton';
import { NODE_ICON } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { NodeRef } from './NodeRef';
import { SourceCard, type Source } from './SourceCard';
import { useCanvasChangePreview } from '../../hooks/useCanvasChanges';
import { Button } from '../Common/Button';

import type { CanvasChange } from '../../hooks/useCanvasChanges';
import type { CanvasCommand, CanvasNodeType } from '@sediment/shared';
import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

// ==================== Helpers ====================

const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + '…' : s;

/** Extract icon for a node-referencing tool. */
function getNodeIcon(data: Record<string, unknown>) {
  const nodeType = ((data.type ?? data.nodeType) as string) ?? 'note';
  return NODE_ICON[nodeType as CanvasNodeType] ?? NODE_ICON.note;
}

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

  const first = entries[0]!;
  const tool = first.toolResponse.tool;

  // Non-agent tools: render individually
  if (!isAgentTool(tool)) {
    if (tool.startsWith('research_')) {
      return (
        <>
          {entries.map((e) => (
            <ResearchToolDisplay
              key={e.messageId}
              toolResponse={e.toolResponse}
            />
          ))}
        </>
      );
    }
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
                <div className="bg-danger-bg text-danger border-border rounded-md border px-4 py-3 text-sm whitespace-pre-wrap">
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
  const hasChanges = canvasChanges.length > 0;

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

  // Has canvas changes → render inline change list
  if (hasChanges) {
    return (
      <div className="flex justify-start">
        <div className="w-full px-2">
          <div className="border-border bg-background/40 flex flex-col gap-2 rounded-md border p-2.5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setIsCollapsed((prev) => !prev)}
                className="text-foreground/70 flex items-center gap-1 text-xs font-medium"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                Canvas changes ({canvasChanges.length})
              </button>
              <div className="flex items-center gap-1">
                <Button
                  onPointerDown={handlePreviewAllDown}
                  onPointerUp={handlePreviewUp}
                  onPointerLeave={handlePreviewUp}
                  variant="secondary"
                  size="sm"
                  className="gap-1 px-1.5 py-0.5 text-[10px]"
                >
                  <Blend size={10} />
                  View before
                </Button>
                <Button
                  onClick={clearAllChanges}
                  variant="secondary"
                  size="sm"
                  className="gap-1 px-1.5 py-0.5 text-[10px]"
                >
                  Keep all
                </Button>
                <Button
                  onClick={revertAllChanges}
                  variant="secondary"
                  size="sm"
                  className="gap-1 px-1.5 py-0.5 text-[10px]"
                >
                  Revert all
                </Button>
              </div>
            </div>

            {/* Change rows */}
            {!isCollapsed && (
              <div className="flex max-h-[24vh] flex-col gap-0.5 overflow-y-auto">
                {canvasChanges.map((change) => {
                  const Icon =
                    NODE_ICON[(change.nodeType as CanvasNodeType) ?? 'note'] ??
                    NODE_ICON.note;

                  const allMissing =
                    (change.nodeId && isNodeMissing(change.nodeId)) ||
                    (change.sourceNodeId &&
                      isNodeMissing(change.sourceNodeId)) ||
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
                      className="text-muted-foreground flex items-center gap-2 pl-0.5 text-xs"
                    >
                      <Icon size={11} className="flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {renderLabel()}
                      </span>
                      <div className="flex flex-shrink-0 items-center gap-0.5">
                        <IconButton
                          onPointerDown={() => handlePreviewDown(change)}
                          onPointerUp={handlePreviewUp}
                          onPointerLeave={handlePreviewUp}
                          disabled={!change.revertible}
                          title="Hold to preview before"
                          className="text-muted-foreground/40 hover:text-blue-500"
                        >
                          <Blend size={12} />
                        </IconButton>
                        <IconButton
                          onClick={() => removeChange(change.id)}
                          title="Keep this change"
                          className="text-muted-foreground/40 hover:text-green-600"
                        >
                          <Check size={12} />
                        </IconButton>
                        <IconButton
                          onClick={() => revertChange(change.id)}
                          disabled={!change.revertible || !!allMissing}
                          title={
                            change.revertible
                              ? 'Revert this change'
                              : 'Cannot revert this change'
                          }
                          className="text-muted-foreground/40 hover:text-red-600"
                        >
                          <Undo2 size={12} />
                        </IconButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // No changes → compact title
  const commands = (data.commands ?? []) as Array<Record<string, unknown>>;
  const count = commands.length;
  const title =
    count === 0
      ? 'Canvas commands'
      : count === 1
        ? `Canvas: ${commands[0]?.type as string}`
        : `Canvas: ${count} commands`;

  const statusIcon = isExecuting ? (
    <Loader2 size={12} className="text-theme-500 animate-spin" />
  ) : (
    <Check size={12} className="text-green-600" />
  );

  return (
    <div className="flex justify-start">
      <div className="w-full">
        <div className="text-muted-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
          {statusIcon}
          <span className="flex-1 truncate">{title}</span>
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
    if (tool === 'get_node_detail') {
      const refs = entries.map((e) => {
        const d =
          e.toolResponse.status === 'success'
            ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
            : {};
        return {
          nodeId: ((d.id ?? d.nodeId) as string) || undefined,
          label: (d.label as string) || undefined,
        };
      });
      return {
        title: count === 1 ? 'Read node' : `Read ${count} nodes`,
        nodeRefs: refs,
      };
    }

    if (tool === 'read_source') {
      const refs = entries.map((e) => {
        const d =
          e.toolResponse.status === 'success'
            ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
            : {};
        return {
          nodeId: undefined as string | undefined,
          label: (d.title as string) || undefined,
        };
      });
      return {
        title: count === 1 ? 'Read source' : `Read ${count} sources`,
        nodeRefs: refs,
      };
    }

    const emptyRefs: { nodeId?: string; label?: string }[] = [];

    if (tool === 'get_canvas_state') {
      return { title: 'Read canvas state', nodeRefs: emptyRefs };
    }
    if (tool === 'search_knowledge') {
      return {
        title:
          count === 1 ? 'Search knowledge' : `Search knowledge (×${count})`,
        nodeRefs: emptyRefs,
      };
    }
    if (tool === 'ingest_content') {
      return {
        title: count === 1 ? 'Ingest content' : `Ingest content (×${count})`,
        nodeRefs: emptyRefs,
      };
    }

    return { title: tool, nodeRefs: emptyRefs };
  }, [tool, entries, count]);

  const statusIcon = isExecuting ? (
    <Loader2 size={12} className="text-theme-500 animate-spin" />
  ) : isError ? (
    <XIcon size={12} className="text-red-500" />
  ) : (
    <Check size={12} className="text-green-600" />
  );

  // get_node_detail with icon
  const icon = useMemo(() => {
    if (tool === 'get_node_detail' || tool === 'read_source') {
      const firstData =
        entries[0]?.toolResponse.status === 'success'
          ? ((entries[0].toolResponse.data ?? {}) as Record<string, unknown>)
          : {};
      const Icon = getNodeIcon(firstData);
      return <Icon size={12} />;
    }
    return null;
  }, [tool, entries]);

  // Single entry with node ref → inline badge
  if (count === 1 && tool === 'get_node_detail' && nodeRefs[0]?.nodeId) {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-muted-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {icon && <span className="text-muted-foreground/60">{icon}</span>}
            <span className="flex-1 truncate">
              Read node{' '}
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

  // Single entry with read_source
  if (count === 1 && tool === 'read_source') {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-muted-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {icon && <span className="text-muted-foreground/60">{icon}</span>}
            <span className="flex-1 truncate">
              Read source{' '}
              {nodeRefs[0]?.label ? truncate(nodeRefs[0].label, 20) : ''}
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
          <div className="text-muted-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {icon && <span className="text-muted-foreground/60">{icon}</span>}
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
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {statusIcon}
          {icon && <span className="text-muted-foreground/60">{icon}</span>}
          <span className="flex-1 truncate">{title}</span>
          <ChevronRight
            size={10}
            className={`text-muted-foreground/50 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>
        {isExpanded && (
          <div className="flex flex-col gap-0.5 py-0.5 pl-6">
            {entries.map((e, i) => {
              const d =
                e.toolResponse.status === 'success'
                  ? ((e.toolResponse.data ?? {}) as Record<string, unknown>)
                  : {};
              if (tool === 'get_node_detail') {
                const nodeId = ((d.id ?? d.nodeId) as string) || undefined;
                return (
                  <div
                    key={e.messageId}
                    className="text-muted-foreground flex items-center gap-1.5 text-xs"
                  >
                    {nodeId ? (
                      <NodeRef
                        nodeId={nodeId}
                        fallbackLabel={d.label as string}
                      />
                    ) : (
                      <span>{nodeRefs[i]?.label ?? '?'}</span>
                    )}
                  </div>
                );
              }
              if (tool === 'read_source') {
                return (
                  <div
                    key={e.messageId}
                    className="text-muted-foreground truncate text-xs"
                  >
                    {truncate((d.title as string) ?? '?', 30)}
                  </div>
                );
              }
              return null;
            })}
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
    'get_node_detail',
    'get_canvas_state',
    'canvas_commands',
    'read_source',
    'search_knowledge',
    'ingest_content',
  ].includes(tool);
}

/**
 * Display for research tool responses
 */
function ResearchToolDisplay({
  toolResponse,
}: {
  toolResponse: ToolResponse<string, unknown>;
}) {
  if (toolResponse.status !== 'success') return null;

  const { tool, data } = toolResponse;

  // Research query analysis
  if (tool === 'research_query_analysis') {
    const { subQueries } = data as { query: string; subQueries: string[] };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm">
          <Sparkles size={14} className="text-primary animate-pulse" />
          <span>
            Searching for:{' '}
            <span className="font-medium">{subQueries.join(' · ')}</span>
          </span>
        </div>
      </div>
    );
  }

  // Research multi-search
  if (tool === 'research_multi_search') {
    const { nodeCount, resultCount } = data as {
      nodeCount: number;
      resultCount: number;
      queries: string[];
    };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-md border bg-white px-3 py-2 text-sm">
          🔍 Found{' '}
          <span className="font-medium">
            {nodeCount} source{nodeCount !== 1 ? 's' : ''}
          </span>{' '}
          across {resultCount} result{resultCount !== 1 ? 's' : ''}
        </div>
      </div>
    );
  }

  // Research ingestion
  if (tool === 'research_ingestion') {
    const { succeeded, failed } = data as { succeeded: number; failed: number };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-md border bg-white px-3 py-2 text-sm">
          {failed > 0
            ? `⚠️ Ingested ${succeeded} source${
                succeeded !== 1 ? 's' : ''
              } (${failed} failed)`
            : `✅ Ingested ${succeeded} source${succeeded !== 1 ? 's' : ''}`}
        </div>
      </div>
    );
  }

  // Research canvas organization
  if (tool === 'research_canvas_organization') {
    const { nodeCount, grouped } = data as {
      frameId?: string;
      nodeCount: number;
      grouped: boolean;
    };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-md border bg-white px-3 py-2 text-sm">
          {grouped
            ? `📦 Organized ${nodeCount} node${
                nodeCount !== 1 ? 's' : ''
              } into a frame`
            : `✅ Research complete (${nodeCount} node${
                nodeCount !== 1 ? 's' : ''
              })`}
        </div>
      </div>
    );
  }

  // Unknown research tool
  return (
    <div className="flex justify-start">
      <div className="text-muted-foreground border-border rounded-md border bg-white px-3 py-2 text-sm">
        {tool}: {JSON.stringify(data)}
      </div>
    </div>
  );
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
        <div className="text-muted-foreground border-border rounded-md border bg-white px-4 py-3 text-sm whitespace-pre-wrap">
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
          aria-expanded={isExpanded}
          aria-label={`Toggle sources (${count} ${label})`}
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
