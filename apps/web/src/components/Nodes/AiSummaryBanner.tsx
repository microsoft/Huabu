import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getSource } from '@/api/knowledge';
import { Button } from '@/components/Common/Button';

import type { SourceMetadata } from '@sediment/shared';

interface AiSummaryBannerProps {
  sourceId: string;
}

/** Collapsible banner showing AI-generated summary and keywords above the preview. */
export const AiSummaryBanner = ({ sourceId }: AiSummaryBannerProps) => {
  const [summary, setSummary] = useState<string | null>(null);
  const [keywords, setKeywords] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const source = await getSource(sourceId);
        if (cancelled || !source.metaJson) return;
        const meta = JSON.parse(source.metaJson) as SourceMetadata;
        setSummary(
          typeof meta.summary === 'string' && meta.summary.trim()
            ? meta.summary.trim()
            : null,
        );
        setKeywords(
          Array.isArray(meta.keywords) && meta.keywords.length > 0
            ? meta.keywords
            : null,
        );
      } catch {
        /* ignore fetch errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  if (!summary && !keywords) return null;

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
          {summary && (
            <p className="text-fg-default text-sm leading-relaxed">{summary}</p>
          )}
          {keywords && (
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
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
