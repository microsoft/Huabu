import { ChevronDown, Sprout } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '../Common/Button';
import { DropdownMenu, DropdownMenuItem } from '../Common/DropdownMenu';

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
      <DropdownMenu
        open={isOpen}
        onOpenChange={setIsOpen}
        trigger={
          <Button variant="outline" tone="info" shape="pill" size="sm">
            <Sprout size={14} />
            <span className="max-w-[200px] truncate">{selectedIntent}</span>
            <ChevronDown
              size={12}
              className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </Button>
        }
        align="bottom-right"
      >
        {candidates.map((c, idx) => (
          <DropdownMenuItem
            key={idx}
            onClick={() => handleSelect(c.label)}
            className={c.label === selectedIntent ? 'bg-info-bg' : ''}
          >
            <div className="flex flex-col">
              <span className="text-fg-default text-sm">{c.label}</span>
              {c.description && (
                <span className="text-fg-muted text-xs">{c.description}</span>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </div>
  );
};
