/**
 * WebSearchToolDisplay — collapsible source-list rendering for the
 * `web_search` internal tool. Each search result becomes a draggable
 * SourceCard (drag-to-canvas creates a `web` node).
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { partToToolResponse } from './helpers';
import { SourceCard, type Source } from './SourceCard';
import { Button } from '../../../Common/Button';

import type {
  AssistantToolPart,
  WebSearchToolResponse,
} from '@sediment/shared';

export function WebSearchToolDisplay({ part }: { part: AssistantToolPart }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolResponse = partToToolResponse(part) as WebSearchToolResponse | null;

  const sources = useMemo<Source[]>(() => {
    if (!toolResponse || toolResponse.status !== 'success') return [];
    const results = toolResponse.data.results ?? [];
    return results
      .map((r) => ({ title: r.title, url: r.url, favicon: r.favicon }))
      .filter((s) => typeof s.url === 'string' && s.url.trim().length > 0);
  }, [toolResponse]);

  if (!toolResponse || toolResponse.status !== 'success') return null;

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
