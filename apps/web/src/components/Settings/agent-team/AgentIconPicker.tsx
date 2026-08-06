// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentIconPicker` — a compact popover that lets the user choose the avatar
 * (shape + color) for a single external agent. The trigger shows the current
 * icon; opening it reveals a shape row and a color row that preview the choice
 * live. It is fully controlled: the parent owns the value and persists changes.
 */

import { useTranslation } from 'react-i18next';

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SELECTABLE_SHAPES,
  AgentIcon,
  type AgentIconColor,
  type AgentIconShape,
  type AgentIconValue,
} from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { DropdownMenu } from '@/components/Common/DropdownMenu';

type AgentIconPickerProps = {
  /** Current icon. */
  value: AgentIconValue;
  /** Called with the next icon when the user changes shape or color. */
  onChange: (next: AgentIconValue) => void;
  /** Agent alias, used to build accessible labels. */
  alias: string;
  /** Disables the trigger (e.g. while a save is in flight). */
  disabled?: boolean;
};

export function AgentIconPicker({
  value,
  onChange,
  alias,
  disabled,
}: AgentIconPickerProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu
      align="bottom-left"
      className="w-auto p-2"
      trigger={
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          iconOnly
          disabled={disabled}
          // Override the Button's default lucide-sized icon (~13px) and tighten
          // the icon-only padding so the avatar fills the trigger.
          className="rounded-full p-0.5 [&_svg]:h-5 [&_svg]:w-5"
          aria-label={t('settings.agentIcon.change', { alias })}
          title={t('settings.agentIcon.change', { alias })}
        >
          <AgentIcon
            shape={value.shape}
            color={value.color}
            size={20}
            withFace
          />
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <IconOptionRow
          label={t('settings.agentIcon.shape')}
          options={AGENT_ICON_SELECTABLE_SHAPES}
          isSelected={(shape) => shape === value.shape}
          optionLabel={(shape) => t(`settings.agentIcon.shapes.${shape}`)}
          onSelect={(shape) => onChange({ ...value, shape })}
          renderIcon={(shape: AgentIconShape) => (
            <AgentIcon shape={shape} color={value.color} size={20} withFace />
          )}
        />
        <IconOptionRow
          label={t('settings.agentIcon.color')}
          options={AGENT_ICON_COLORS}
          isSelected={(color) => color === value.color}
          optionLabel={(color) => t(`settings.agentIcon.colors.${color}`)}
          onSelect={(color) => onChange({ ...value, color })}
          renderIcon={(color: AgentIconColor) => (
            <AgentIcon shape={value.shape} color={color} size={20} withFace />
          )}
        />
      </div>
    </DropdownMenu>
  );
}

type IconOptionRowProps<T extends string> = {
  label: string;
  options: readonly T[];
  isSelected: (option: T) => boolean;
  optionLabel: (option: T) => string;
  onSelect: (option: T) => void;
  renderIcon: (option: T) => React.ReactNode;
};

function IconOptionRow<T extends string>({
  label,
  options,
  isSelected,
  optionLabel,
  onSelect,
  renderIcon,
}: IconOptionRowProps<T>) {
  return (
    <div>
      <p className="text-fg-subtle mb-1 px-0.5 text-[10px] tracking-wider uppercase">
        {label}
      </p>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={isSelected(option)}
            aria-label={optionLabel(option)}
            title={optionLabel(option)}
            onClick={() => onSelect(option)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
              isSelected(option)
                ? 'border-info bg-hover'
                : 'hover:bg-hover border-transparent',
            )}
          >
            {renderIcon(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
