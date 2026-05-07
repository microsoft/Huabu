import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

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
  const [collapsed, setCollapsed] = useState(false);

  const hasSummary = typeof summary === 'string' && summary.trim().length > 0;
  const hasKeywords = Array.isArray(keywords) && keywords.length > 0;
  if (!hasSummary && !hasKeywords) return null;

  return (
    <div className="relative z-10 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
      <Button
        variant="ghost"
        size="sm"
        className="hover:text-fg-default w-full justify-start gap-1 px-3 hover:bg-transparent!"
        onClick={() => setCollapsed((prev) => !prev)}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span>AI Summary</span>
      </Button>
      {!collapsed && (
        <div className="animate-in fade-in flex flex-col gap-1.5 px-3 pb-2 duration-150">
          {hasSummary && (
            <p className="text-fg-default text-sm leading-relaxed">{summary}</p>
          )}
          {hasKeywords && (
            <div className="flex flex-wrap gap-1.5">
              {keywords!.map((kw) => (
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
