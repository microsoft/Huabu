import { ChevronDown, Sprout } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { IntentCandidate } from '@sediment/shared';

interface IntentSelectMessageProps {
  candidates: IntentCandidate[];
  selectedIntent: string;
  onReselect: (intent: string) => void;
}

export const IntentSelectMessage = ({
  candidates,
  selectedIntent,
  onReselect,
}: IntentSelectMessageProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = useCallback(
    (label: string) => {
      setIsOpen(false);
      if (label !== selectedIntent) {
        onReselect(label);
      }
    },
    [selectedIntent, onReselect],
  );

  return (
    <div className="flex justify-end">
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="bg-info-bg text-theme-700 border-theme-200 hover:bg-info-bg-hover inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
        >
          <Sprout size={14} />
          <span className="max-w-[200px] truncate">{selectedIntent}</span>
          <ChevronDown
            size={12}
            className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isOpen && (
          <div className="border-border bg-card absolute right-0 bottom-full z-50 mb-2 w-64 overflow-hidden rounded-lg border shadow-lg">
            {candidates.map((c, idx) => (
              <button
                key={idx}
                type="button"
                className={`hover:bg-hover-subtle flex w-full flex-col px-3 py-2 text-left transition-colors ${
                  c.label === selectedIntent ? 'bg-info-bg' : ''
                }`}
                onClick={() => handleSelect(c.label)}
              >
                <span className="text-foreground text-sm">{c.label}</span>
                {c.description && (
                  <span className="text-muted-foreground text-xs">
                    {c.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
