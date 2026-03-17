import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SourceCard, type Source } from './SourceCard';
import { Button } from '../Common/Button';

import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

interface ToolMessageProps {
  toolResponse: ToolResponse<string, unknown>;
}

/**
 * ToolMessage - Unified display for all agent tool calls
 * Supports: web_search, research_thinking, research_searching, research_node_created, etc.
 */
export const ToolMessage = ({ toolResponse }: ToolMessageProps) => {
  // Error handling
  if (toolResponse.status === 'error') {
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

  // Research tool types
  if (toolResponse.tool.startsWith('research_')) {
    return <ResearchToolDisplay toolResponse={toolResponse} />;
  }

  // Web search
  if (toolResponse.tool === 'web_search') {
    return (
      <WebSearchToolDisplay
        toolResponse={toolResponse as WebSearchToolResponse}
      />
    );
  }

  // Fallback for unknown tools
  return (
    <div className="flex justify-start">
      <div className="text-muted-foreground border-border rounded-2xl border bg-white px-4 py-3 text-sm whitespace-pre-wrap">
        {JSON.stringify(toolResponse)}
      </div>
    </div>
  );
};

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
        <div className="text-muted-foreground border-border flex items-center gap-2 rounded-2xl border bg-white px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
          馃攳 Found{' '}
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
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
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
      <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
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
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-4 py-3 text-sm whitespace-pre-wrap">
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
