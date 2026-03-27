import clsx from 'clsx';
import { Check, ChevronDown, MessageSquare, Sprout } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../Common/Button';

import type { AgentMode } from '@sediment/shared';
import type { LucideIcon } from 'lucide-react';

interface ModeOption {
  value: AgentMode;
  label: string;
  icon: LucideIcon;
  description: string;
}

const modes: ModeOption[] = [
  {
    value: 'ask',
    label: 'Ask',
    icon: MessageSquare,
    description: 'Quick conversation',
  },
  {
    value: 'operate',
    label: 'Agent',
    icon: Sprout,
    description: 'Directly modify the Canvas based on your instructions',
  },
];

interface ModeSelectorProps {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
}

export const ModeSelector = ({
  value,
  onChange,
  disabled = false,
}: ModeSelectorProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentMode = modes.find((m) => m.value === value) || modes[0];
  const CurrentModeIcon = currentMode.icon;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleModeSelect = (mode: AgentMode) => {
    onChange(mode);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="outline"
        shape="pill"
        tone="neutral"
        size="sm"
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={clsx(isOpen && 'bg-bg-default')}
      >
        <CurrentModeIcon />
        <span>{currentMode.label}</span>
        <ChevronDown
          className={clsx('transition-transform', isOpen && 'rotate-180')}
        />
      </Button>

      {isOpen && (
        <div className="border-border bg-surface absolute bottom-full left-0 mb-2 flex w-auto flex-col gap-1 overflow-hidden rounded-md border py-1 shadow-lg">
          {modes.map((mode) => {
            const ModeIcon = mode.icon;

            return (
              <Button
                variant="ghost"
                tone="neutral"
                key={mode.value}
                size="sm"
                onClick={() => handleModeSelect(mode.value)}
                title={mode.description}
                tooltipWrapperClassName="flex w-full"
                className={clsx(
                  'w-full rounded-none px-3 text-left',
                  mode.value === value ? 'text-info' : 'text-fg-default',
                )}
              >
                <ModeIcon />
                <div className="flex-1">{mode.label}</div>
                {mode.value === value && <Check />}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
};
