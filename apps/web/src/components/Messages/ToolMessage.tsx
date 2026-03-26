import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  X as XIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { NodeRef } from './NodeRef';
import { SourceCard, type Source } from './SourceCard';
import { NODE_ICON } from '../../config/nodeIcons';
import { Button } from '../Common/Button';

import type { CanvasNodeType } from '@sediment/shared';
import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

// ==================== Helpers ====================

/** Extract a human-readable title from tool response data. */
function getToolTitle(
  tool: string,
  data: Record<string, unknown>,
): { icon: React.ReactNode; title: string } {
  const nodeType = ((data.type ?? data.nodeType) as string) ?? 'note';
  const NodeIcon = NODE_ICON[nodeType as CanvasNodeType] ?? NODE_ICON.note;
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + '…' : s;

  switch (tool) {
    case 'get_node_detail':
      return {
        icon: <NodeIcon size={12} />,
        title: `Read node ${truncate((data.label as string) ?? (data.id as string) ?? '', 20)}`,
      };
    case 'get_canvas_state':
      return { icon: null, title: 'Read canvas state' };
    case 'canvas_commands': {
      const commands = (data.commands ?? []) as Array<Record<string, unknown>>;
      const count = commands.length;
      if (count === 0) return { icon: null, title: 'Canvas commands (empty)' };
      const first = commands[0].type as string;
      return {
        icon: null,
        title:
          count === 1
            ? `Canvas: ${first}`
            : `Canvas: ${first} + ${count - 1} more`,
      };
    }
    case 'web_search':
      return { icon: null, title: `Web search` };
    case 'read_source':
      return {
        icon: <NodeIcon size={12} />,
        title: `Read source ${truncate((data.title as string) ?? '', 20)}`,
      };
    case 'search_knowledge':
      return { icon: null, title: `Search knowledge` };
    case 'ingest_content':
      return { icon: null, title: `Ingest content` };
    default:
      return { icon: null, title: tool };
  }
}

// ==================== Agent Tool Card ====================

interface AgentToolCardProps {
  toolResponse: ToolResponse<string, unknown>;
  isExecuting?: boolean;
}

function AgentToolCard({ toolResponse, isExecuting }: AgentToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const data =
    toolResponse.status === 'success'
      ? ((toolResponse.data ?? {}) as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const { icon, title } = getToolTitle(toolResponse.tool, data);
  const isError = toolResponse.status === 'error';

  // Expandable tools: none of the new tools need content expansion
  const isExpandable = false;
  const contentText = null;

  // Render title with clickable NodeRef for tools that reference nodes
  const renderTitle = (): React.ReactNode => {
    const tool = toolResponse.tool;

    if (tool === 'get_node_detail') {
      const nodeId = ((data.id ?? data.nodeId) as string) || undefined;
      if (nodeId) {
        return (
          <>
            Read node{' '}
            <NodeRef nodeId={nodeId} fallbackLabel={data.label as string} />
          </>
        );
      }
    }

    return title;
  };

  // Auto-expand while executing (only for expandable tools)
  const canExpand = isExpandable && contentText !== null;
  const showContent = canExpand && (isExecuting || isExpanded);

  const statusIcon = isExecuting ? (
    <Loader2 size={12} className="text-info animate-spin" />
  ) : isError ? (
    <XIcon size={12} className="text-danger" />
  ) : (
    <Check size={12} className="text-success" />
  );

  return (
    <div className="flex justify-start">
      <div className="w-full">
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors"
          onClick={() => canExpand && setIsExpanded(!isExpanded)}
        >
          {statusIcon}
          {icon && <span className="text-muted-foreground/60">{icon}</span>}
          <span className="flex-1 truncate">{renderTitle()}</span>
          {!isExecuting && canExpand && (
            <ChevronRight
              size={10}
              className={`text-muted-foreground/50 flex-shrink-0 transition-transform ${showContent ? 'rotate-90' : ''}`}
            />
          )}
        </button>
        {showContent && contentText && (
          <div className="border-border text-muted-foreground/60 mt-1 max-h-40 overflow-y-auto rounded border p-2 text-[11px] leading-relaxed">
            <div className="break-all whitespace-pre-wrap">{contentText}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== Main ToolMessage ====================

interface ToolMessageProps {
  toolResponse: ToolResponse<string, unknown>;
  isExecuting?: boolean;
}

/**
 * ToolMessage - Unified display for all agent tool calls
 * Agent tools show as collapsible icon+title cards.
 * Research and web_search tools keep their existing display.
 */
export const ToolMessage = ({
  toolResponse,
  isExecuting,
}: ToolMessageProps) => {
  // Error handling for non-agent tools
  if (toolResponse.status === 'error' && !isAgentTool(toolResponse.tool)) {
    const text = toolResponse.hint
      ? `Tool error (${toolResponse.tool}): ${toolResponse.error}\nHint: ${toolResponse.hint}`
      : `Tool error (${toolResponse.tool}): ${toolResponse.error}`;

    return (
      <div className="flex justify-start">
        <div className="bg-danger-bg text-danger border-border rounded-2xl border px-4 py-3 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  // Agent tools — collapsible card style
  if (isAgentTool(toolResponse.tool)) {
    return (
      <AgentToolCard toolResponse={toolResponse} isExecuting={isExecuting} />
    );
  }

  // Research tool types
  if (toolResponse.tool.startsWith('research_')) {
    return <ResearchToolDisplay toolResponse={toolResponse} />;
  }

  // Web search (from ask mode)
  if (toolResponse.tool === 'web_search') {
    return (
      <WebSearchToolDisplay
        toolResponse={toolResponse as WebSearchToolResponse}
      />
    );
  }

  // Fallback
  return (
    <AgentToolCard toolResponse={toolResponse} isExecuting={isExecuting} />
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
        <div className="text-muted-foreground border-border bg-card flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border bg-card rounded-2xl border px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border bg-card rounded-2xl border px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border bg-card rounded-2xl border px-3 py-2 text-sm">
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
      <div className="text-muted-foreground border-border bg-card rounded-2xl border px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border bg-card rounded-2xl border px-4 py-3 text-sm whitespace-pre-wrap">
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
