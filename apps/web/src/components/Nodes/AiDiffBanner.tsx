import { diffLines } from 'diff';
import { ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { IconButton } from '@/components/Common/IconButton';

interface AiDiffBannerProps {
  contentBeforeAI: string;
  currentContent: string;
  onDismiss: () => void;
}

export const AiDiffBanner = ({
  contentBeforeAI,
  currentContent,
  onDismiss,
}: AiDiffBannerProps) => {
  const [showDiff, setShowDiff] = useState(false);

  const diffParts = useMemo(
    () => diffLines(contentBeforeAI, currentContent),
    [contentBeforeAI, currentContent],
  );

  // Count additions and removals for summary
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const part of diffParts) {
      const lines = part.count ?? 0;
      if (part.added) added += lines;
      if (part.removed) removed += lines;
    }
    return { added, removed };
  }, [diffParts]);

  return (
    <div className="border-border border-b">
      {/* Banner bar */}
      <div className="bg-ai-bg flex items-center justify-between px-3 py-1.5">
        <div className="text-ai flex items-center gap-1.5 text-xs font-medium">
          <Sparkles size={12} />
          <span>AI modified this note</span>
          {(stats.added > 0 || stats.removed > 0) && (
            <span className="text-muted-foreground font-normal">
              {stats.added > 0 && `+${stats.added}`}
              {stats.added > 0 && stats.removed > 0 && ' '}
              {stats.removed > 0 && `-${stats.removed}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="text-ai hover:bg-ai-light/30 cursor-pointer rounded px-2 py-0.5 text-xs transition-colors"
            onClick={() => setShowDiff((v) => !v)}
          >
            <span className="flex items-center gap-1">
              {showDiff ? 'Hide changes' : 'View changes'}
              {showDiff ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </span>
          </button>
          <IconButton
            title="Dismiss"
            size="sm"
            className="text-muted-foreground"
            onClick={onDismiss}
          >
            <X size={12} />
          </IconButton>
        </div>
      </div>

      {/* Collapsible diff view */}
      {showDiff && (
        <div className="border-border max-h-60 overflow-auto border-t bg-gray-50 px-3 py-2 font-mono text-xs leading-relaxed">
          {diffParts.map((part, i) => {
            const lines = part.value.replace(/\n$/, '').split('\n');
            return lines.map((line, j) => (
              <div
                key={`${i}-${j}`}
                className={
                  part.added
                    ? 'bg-green-50 text-green-800'
                    : part.removed
                      ? 'bg-red-50 text-red-800 line-through'
                      : 'text-muted-foreground'
                }
              >
                <span className="mr-2 inline-block w-3 opacity-50 select-none">
                  {part.added ? '+' : part.removed ? '-' : ' '}
                </span>
                {line || ' '}
              </div>
            ));
          })}
        </div>
      )}
    </div>
  );
};
