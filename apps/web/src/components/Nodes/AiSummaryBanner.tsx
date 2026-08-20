// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';

interface AiSummaryBannerProps {
  summary?: string | null;
  keywords?: string[] | null;
}

/** Collapsible banner showing AI-generated summary and keywords above the preview. */
export const AiSummaryBanner = ({
  summary,
  keywords,
}: AiSummaryBannerProps) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const hasSummary = typeof summary === 'string' && summary.trim().length > 0;
  const visibleKeywords = Array.isArray(keywords) ? keywords : [];
  const hasKeywords = visibleKeywords.length > 0;
  if (dismissed || (!hasSummary && !hasKeywords)) return null;

  return (
    <div className="relative z-10 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-fg-default min-w-0 flex-1 justify-start gap-1 px-3 hover:bg-transparent!"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>{t('node.aiSummary')}</span>
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={t('node.closeAiSummary')}
          className="mr-1 shrink-0"
          onClick={() => setDismissed(true)}
        >
          <X size={13} />
        </Button>
      </div>
      {!collapsed && (
        <div className="animate-in fade-in flex flex-col gap-1.5 px-3 pb-2 duration-150">
          {hasSummary && (
            <p className="text-fg-default text-sm leading-relaxed">{summary}</p>
          )}
          {hasKeywords && (
            <div className="flex flex-wrap gap-1.5">
              {visibleKeywords.map((kw) => (
                <span
                  key={kw}
                  className="bg-hover text-fg-muted rounded-full px-2 py-0.5 text-xs"
                >
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
