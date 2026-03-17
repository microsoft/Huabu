import clsx from 'clsx';
import {
  Check,
  ChevronDown,
  MessageSquare,
  Search,
  Sprout,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../Common/Button';

export type ChatMode = 'chat' | 'deep-research' | 'agent';

interface ModeOption {
  value: ChatMode;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const modes: ModeOption[] = [
  {
    value: 'chat',
    label: 'Chat',
    icon: <MessageSquare size={14} />,
    description: 'Quick conversation',
  },
  {
    value: 'deep-research',
    label: 'Deep Research',
    icon: <Search size={14} />,
    description: 'Search multiple sources and add to Canvas',
  },
  {
    value: 'agent',
    label: 'Agent',
    icon: <Sprout size={14} />,
    description: 'Turn intent into canvas actions and apply them',
  },
];

interface ModeSelectorProps {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
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

  const handleModeSelect = (mode: ChatMode) => {
    onChange(mode);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="pill"
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={clsx('gap-1.5', isOpen && 'bg-secondary')}
      >
        {currentMode.icon}
        <span>{currentMode.label}</span>
        <ChevronDown
          size={14}
          className={clsx('transition-transform', isOpen && 'rotate-180')}
        />
      </Button>

      {isOpen && (
        <div className="border-border bg-card absolute bottom-full left-0 mb-2 w-auto overflow-hidden rounded-lg border shadow-lg">
          {modes.map((mode) => (
            <Button
              variant="ghost"
              key={mode.value}
              onClick={() => handleModeSelect(mode.value)}
              title={mode.description}
              tooltipWrapperClassName="flex w-full"
              className={clsx(
                'flex w-full gap-1.5 rounded-none px-3 py-1.5 text-left whitespace-nowrap transition-colors',
                mode.value === value ? 'text-theme-500' : 'text-foreground',
              )}
            >
              <div className="shrink-0">{mode.icon}</div>
              <div className="flex-1 text-sm font-medium">{mode.label}</div>
              {mode.value === value && <Check size={16} />}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
};
