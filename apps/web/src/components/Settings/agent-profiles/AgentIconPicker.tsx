// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentIconPicker` — a compact popover that lets the user choose the avatar
 * for a single external agent. The trigger shows the current icon; opening it
 * reveals a shape row and a color row that preview the choice live. When the
 * agent's harness has a bundled logo, a style row switches between that logo
 * and the shape avatar; the shape and color rows apply to the shape avatar, so
 * they are hidden while the logo is selected. It is fully controlled: the
 * parent owns the value and persists changes.
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
import { MENU_SECTION_LABEL_CLASS } from '@/components/Common/menuStyles';
import { getHarnessAgentIconBrand } from '@/utils/agentIcon';

const AGENT_ICON_STYLES = ['logo', 'shape'] as const;
type AgentIconStyle = (typeof AGENT_ICON_STYLES)[number];

type AgentIconPickerProps = {
  /** Current icon. */
  value: AgentIconValue;
  /** Called with the next icon when the user changes style, shape or color. */
  onChange: (next: AgentIconValue) => void;
  /** Harness the Profile launches; offers its logo when one is bundled. */
  harnessId?: string;
  /** Agent alias, used to build accessible labels. */
  alias: string;
  /** Disables the trigger (e.g. while a save is in flight). */
  disabled?: boolean;
};

export function AgentIconPicker({
  value,
  onChange,
  harnessId,
  alias,
  disabled,
}: AgentIconPickerProps) {
  const { t } = useTranslation();
  // A saved logo stays selectable even if the harness can no longer be
  // resolved, so opening the picker never silently drops it.
  const logo = getHarnessAgentIconBrand(harnessId) ?? value.brand;
  const style: AgentIconStyle = value.brand ? 'logo' : 'shape';
  const shapeValue = { shape: value.shape, color: value.color };

  return (
    <DropdownMenu
      align="bottom-left"
      contentRole="dialog"
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
          tooltipWrapperClassName="flex"
          aria-label={t('settings.agentIcon.change', { alias })}
          title={t('settings.agentIcon.change', { alias })}
        >
          <AgentIcon
            shape={value.shape}
            color={value.color}
            brand={value.brand}
            size={20}
            withFace
          />
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {logo ? (
          <IconOptionRow
            label={t('settings.agentIcon.style')}
            options={AGENT_ICON_STYLES}
            isSelected={(option) => option === style}
            optionLabel={(option) => t(`settings.agentIcon.styles.${option}`)}
            onSelect={(option) =>
              onChange(
                option === 'logo' ? { ...shapeValue, brand: logo } : shapeValue,
              )
            }
            renderIcon={(option: AgentIconStyle) => (
              <AgentIcon
                {...shapeValue}
                brand={option === 'logo' ? logo : undefined}
                size={20}
                withFace
              />
            )}
          />
        ) : null}
        {style === 'shape' ? (
          <>
            <IconOptionRow
              label={t('settings.agentIcon.shape')}
              options={AGENT_ICON_SELECTABLE_SHAPES}
              isSelected={(shape) => shape === value.shape}
              optionLabel={(shape) => t(`settings.agentIcon.shapes.${shape}`)}
              onSelect={(shape) => onChange({ ...value, shape })}
              renderIcon={(shape: AgentIconShape) => (
                <AgentIcon
                  shape={shape}
                  color={value.color}
                  size={20}
                  withFace
                />
              )}
            />
            <IconOptionRow
              label={t('settings.agentIcon.color')}
              options={AGENT_ICON_COLORS}
              isSelected={(color) => color === value.color}
              optionLabel={(color) => t(`settings.agentIcon.colors.${color}`)}
              onSelect={(color) => onChange({ ...value, color })}
              renderIcon={(color: AgentIconColor) => (
                <AgentIcon
                  shape={value.shape}
                  color={color}
                  size={20}
                  withFace
                />
              )}
            />
          </>
        ) : null}
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
      <p className={cn(MENU_SECTION_LABEL_CLASS, 'mb-1 px-0.5')}>{label}</p>
      <div className="flex gap-1">
        {options.map((option) => (
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            key={option}
            type="button"
            aria-pressed={isSelected(option)}
            aria-label={optionLabel(option)}
            title={optionLabel(option)}
            onClick={() => onSelect(option)}
            className={cn(
              'focus-visible:outline-info size-8 rounded-md border border-solid p-0 focus-visible:outline-2 focus-visible:outline-offset-2 [&_svg]:size-5',
              isSelected(option)
                ? 'border-info bg-hover'
                : 'border-transparent',
            )}
          >
            {renderIcon(option)}
          </Button>
        ))}
      </div>
    </div>
  );
}
