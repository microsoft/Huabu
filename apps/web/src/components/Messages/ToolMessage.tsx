import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SourceCard, type Source } from './SourceCard';
import { GhostButton } from '../Common/GhostButton';

import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

interface ToolMessageProps {
  toolResponse: ToolResponse<string, unknown>;
}

export const ToolMessage = ({ toolResponse }: ToolMessageProps) => {
  const sources = useMemo<Source[]>(() => {
    if (toolResponse.tool !== 'web_search') return [];
    if (toolResponse.status !== 'success') return [];

    const response = toolResponse as Extract<
      WebSearchToolResponse,
      { status: 'success' }
    >;
    const results = response.data.results ?? [];

    return results
      .map((r) => ({ title: r.title, url: r.url, favicon: r.favicon }))
      .filter((s) => typeof s.url === 'string' && s.url.trim().length > 0);
  }, [toolResponse]);

  const [isExpanded, setIsExpanded] = useState(false);

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

  if (sources.length === 0) {
    const fallbackText =
      toolResponse.tool === 'web_search' && toolResponse.status === 'success'
        ? 'Used 0 references'
        : JSON.stringify(toolResponse);

    return (
      <div className="flex justify-start">
        <div className="text-muted-foreground border-border rounded-2xl border bg-white px-4 py-3 text-sm whitespace-pre-wrap">
          {fallbackText}
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
};
