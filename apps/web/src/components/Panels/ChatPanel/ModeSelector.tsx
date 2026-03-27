import { MessageSquare, Sprout } from 'lucide-react';

import { Select, type SelectOption } from '../../Common/Select';

import type { AgentMode } from '@sediment/shared';

const modes: SelectOption<AgentMode>[] = [
  { value: 'ask', label: 'Ask', icon: <MessageSquare size={14} /> },
  { value: 'operate', label: 'Agent', icon: <Sprout size={14} /> },
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
  return (
    <Select
      options={modes}
      value={value}
      onChange={onChange}
      disabled={disabled}
      variant="outline"
      shape="pill"
      tone="neutral"
      size="sm"
      direction="up"
    />
  );
};
