import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SourceCard, type Source } from './SourceCard';
import { GhostButton } from '../Common/GhostButton';

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

  // Research thinking
  if (tool === 'research_thinking') {
    const { step } = data as { step: string; content: string };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border flex items-center gap-2 rounded-2xl border bg-white px-3 py-2 text-sm">
          <Sparkles size={14} className="text-primary animate-pulse" />
          <span>{step}</span>
        </div>
      </div>
    );
  }

  // Research searching
  if (tool === 'research_searching') {
    const { query, resultCount } = data as {
      query: string;
      resultCount: number;
    };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
          🔍 Searched: <span className="font-medium">{query}</span> (
          {resultCount} results)
        </div>
      </div>
    );
  }

  // Research node created
  if (tool === 'research_node_created') {
    const { nodeCount } = data as { nodeIds: string[]; nodeCount: number };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
          ✅ Created {nodeCount} node{nodeCount !== 1 ? 's' : ''}
        </div>
      </div>
    );
  }

  // Research synthesis
  if (tool === 'research_synthesis') {
    const { relatedNodeIds } = data as {
      content: string;
      nodeId: string;
      relatedNodeIds: string[];
    };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
          💡 Generated synthesis from {relatedNodeIds.length} source
          {relatedNodeIds.length !== 1 ? 's' : ''}
        </div>
      </div>
    );
  }

  // Research frame created
  if (tool === 'research_frame_created') {
    const { label } = data as { frameId: string; label: string };
    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-3 py-2 text-sm">
          📦 Organized into frame: <span className="font-medium">{label}</span>
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
        <GhostButton
          aria-expanded={isExpanded}
          aria-label={`Toggle sources (${count} ${label})`}
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="mr-1 ml-2">
            Used {count} {label}
          </span>
        </GhostButton>

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
