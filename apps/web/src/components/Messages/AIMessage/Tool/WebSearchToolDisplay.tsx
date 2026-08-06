// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * WebSearchToolDisplay — collapsible source-list rendering for the
 * `web_search` internal tool. Each search result becomes a draggable
 * SourceCard (drag-to-canvas creates a `web` node).
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SourceCard, type Source } from './SourceCard';
import { Button } from '../../../Common/Button';

import type { WebSearchToolPart } from '@huabu/shared';

export function WebSearchToolDisplay({ part }: { part: WebSearchToolPart }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const toolResponse = part.data ?? null;

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
        <div className="text-fg-muted border-edge-default bg-surface rounded-md border px-2 py-1 text-xs whitespace-pre-wrap">
          {t('messages.usedReferences', { count: 0 })}
        </div>
      </div>
    );
  }

  const count = sources.length;
  const label = t('messages.reference', { count });

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col items-start gap-2">
        <Button
          size="sm"
          variant="ghost"
          tone="neutral"
          className="w-full justify-start px-2 py-0.5"
          aria-expanded={isExpanded}
          aria-label={t('messages.toggleSources', { count, label })}
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? <ChevronDown /> : <ChevronRight />}
          <span className="mr-1 ml-2">
            {t('messages.usedReferences', { count })}
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
