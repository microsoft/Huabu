import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { setDragPayload } from '../../../../utils/dragDrop';
import { DragToCanvasHandleButton } from '../../../Common/DragToCanvasHandleButton';
import { GhostButton } from '../../../Common/GhostButton';

import type { ToolResponse, WebSearchToolResponse } from '@sediment/shared';

interface ToolMessageProps {
  toolResponse: ToolResponse<string, unknown>;
}

type Source = {
  title: string;
  url: string;
  favicon?: string;
};

const getHostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const SourceCard = ({ source }: { source: Source }) => {
  const title = (source.title ?? '').trim() || source.url;
  const hostname = getHostname(source.url);
  const cardRef = useRef<HTMLAnchorElement | null>(null);

  return (
    <div
      className="group relative px-4"
      data-source-url={source.url}
      data-source-title={title}
    >
      <DragToCanvasHandleButton
        className={[
          'absolute top-1 left-0',
          'opacity-0 transition-opacity',
          'group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100',
        ].join(' ')}
        onDragStart={(e) => {
          e.stopPropagation();

          setDragPayload(
            e,
            {
              kind: 'web',
              data: {
                src: source.url,
              },
            },
            {
              dragImageElement: cardRef.current,
            },
          );
        }}
      />
      <a
        ref={cardRef}
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className={[
          'border-border block rounded-lg border bg-white px-3 py-2',
          'hover:bg-background ml-1 transition-colors',
        ].join(' ')}
      >
        <div className="flex items-start gap-2">
          {source.favicon ? (
            <img
              src={source.favicon}
              alt=""
              className="mt-0.5 h-4 w-4 flex-none rounded-sm"
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="text-secondary flex min-w-0 items-center gap-2 text-sm font-medium">
              <span className="truncate">{title}</span>
              <ArrowUpRight
                className="text-icon flex-none"
                size={14}
                strokeWidth={2}
              />
            </div>
            {hostname ? (
              <div className="text-secondary mt-0.5 truncate text-xs">
                {hostname}
              </div>
            ) : null}
          </div>
        </div>
      </a>
    </div>
  );
};

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
        <div className="text-secondary border-border rounded-2xl border bg-white px-4 py-3 text-sm whitespace-pre-wrap">
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
