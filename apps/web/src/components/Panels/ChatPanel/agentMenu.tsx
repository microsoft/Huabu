// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared building blocks for the agent picker dropdown used by
 * `AgentSelector`.
 *
 * This module owns the built-in Chat / Agent modes, one row per configured
 * external ACP profile, the inline "Add agent" entry, and the
 * `bindingsEqual` / `INTERNAL` helpers.
 */

import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AgentIcon } from '@/components/Common/AgentIcon';
import { BuiltInAgentAvatar } from '@/components/Common/BuiltInAgentAvatar';
import {
  MENU_HINT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_GROUP_CLASS,
  MENU_SEPARATOR_CLASS,
} from '@/components/Common/menuStyles';
import { useSettingsUiStore } from '@/store/settingsUiStore';
import { readAgentIcon } from '@/utils/agentIcon';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';

import type { AgentBinding, AgentMode, AgentProfileView } from '@huabu/shared';
import type { ReactNode } from 'react';

/** A picked (mode, binding) pair emitted by either agent menu. */
export interface AgentChoice {
  mode: AgentMode;
  binding: AgentBinding;
}

/** The built-in (Huabu) agent binding. */
export const INTERNAL_BINDING: AgentBinding = { kind: 'internal' };

export function bindingsEqual(a: AgentBinding, b: AgentBinding): boolean {
  if (a.kind === 'internal' && b.kind === 'internal') return true;
  if (a.kind === 'external' && b.kind === 'external') {
    return a.profileId === b.profileId;
  }
  return false;
}

interface AgentMenuRowProps {
  icon: ReactNode;
  label: string;
  hint?: string;
  current?: boolean;
  disabled?: boolean;
  /** Tooltip on the row — typically only set for the current row. */
  title?: string;
  onClick: () => void;
}

/** One option row in the agent dropdown. */
export function AgentMenuRow({
  icon,
  label,
  hint,
  current,
  disabled,
  title,
  onClick,
}: AgentMenuRowProps) {
  return (
    <Button
      variant="ghost"
      tone="neutral"
      size="sm"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      tooltipWrapperClassName="block w-full"
      className={cn(MENU_ITEM_CLASS, current && 'text-info-fg')}
    >
      <span className="shrink-0">{icon}</span>
      <span className={MENU_LABEL_CLASS}>{label}</span>
      {hint && <span className={MENU_HINT_CLASS}>{hint}</span>}
    </Button>
  );
}

interface AgentMenuOptionsProps {
  /** Subordinate section label shown above the rows. */
  heading: string;
  currentBinding: AgentBinding;
  currentMode: AgentMode;
  profiles: AgentProfileView[];
  builtInModes?: readonly AgentMode[];
  /** External choices can be peers of the heading or nested within it. */
  externalGroup?: 'peer' | 'nested';
  /** Grey out every row (e.g. mid-stream) without closing the menu. */
  busy?: boolean;
  /** Tooltip applied to whichever row matches the current binding. */
  currentRowTitle?: string;
  onSelect: (choice: AgentChoice) => void;
  /** When provided, renders the inline "Add agent" row that calls this. */
  onAddAgent?: () => void;
}

/**
 * The dropdown body shared by both menus: heading, the two built-in
 * modes, the configured external profiles, and an optional "Add agent"
 * row. Pure presentation — the caller owns the surrounding `Popover`.
 */
export function AgentMenuOptions({
  heading,
  currentBinding,
  currentMode,
  profiles,
  builtInModes,
  externalGroup = 'peer',
  busy,
  currentRowTitle,
  onSelect,
  onAddAgent,
}: AgentMenuOptionsProps) {
  const { t } = useTranslation();
  const modeItems: { mode: AgentMode; label: string; icon: ReactNode }[] = [
    {
      mode: 'ask',
      label: t('chat.modeChat'),
      icon: <BuiltInAgentAvatar mode="ask" size={16} />,
    },
    {
      mode: 'operate',
      label: t('chat.modeAgent'),
      icon: <BuiltInAgentAvatar mode="operate" size={16} />,
    },
  ];

  return (
    <>
      <div role="presentation" className={MENU_SECTION_LABEL_CLASS}>
        {heading}
      </div>
      {modeItems
        .filter((m) => !builtInModes || builtInModes.includes(m.mode))
        .map((m) => {
          const isCurrent =
            currentBinding.kind === 'internal' && currentMode === m.mode;
          return (
            <AgentMenuRow
              key={`mode:${m.mode}`}
              icon={m.icon}
              label={m.label}
              hint={t('settings.builtInPi')}
              current={isCurrent}
              disabled={busy}
              title={isCurrent ? currentRowTitle : undefined}
              onClick={() =>
                onSelect({ mode: m.mode, binding: INTERNAL_BINDING })
              }
            />
          );
        })}
      {profiles.length > 0 && (
        <div className={externalGroup === 'nested' ? 'mt-2' : MENU_GROUP_CLASS}>
          <div role="presentation" className={MENU_SECTION_LABEL_CLASS}>
            {t('chat.externalAgents')}
          </div>
          {profiles.map((profile) => {
            const binding: AgentBinding = {
              kind: 'external',
              alias: profile.alias,
              profileId: profile.id,
            };
            const isCurrent = bindingsEqual(currentBinding, binding);
            const icon = readAgentIcon(profile);
            return (
              <AgentMenuRow
                key={`profile:${profile.id}`}
                icon={
                  <AgentIcon
                    shape={icon.shape}
                    color={icon.color}
                    size={16}
                    withFace
                  />
                }
                label={profile.alias}
                current={isCurrent}
                disabled={busy}
                title={isCurrent ? currentRowTitle : undefined}
                onClick={() => onSelect({ mode: currentMode, binding })}
              />
            );
          })}
        </div>
      )}
      {onAddAgent && (
        <>
          <div role="separator" className={MENU_SEPARATOR_CLASS} />
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={onAddAgent}
            className={MENU_ITEM_CLASS}
          >
            <Plus size={14} />
            <span className={MENU_LABEL_CLASS}>{t('chat.addAgent')}</span>
          </Button>
        </>
      )}
    </>
  );
}

/**
 * "Add agent" now deep-links into the unified External Agents Settings
 * tab instead of opening an inline editor, so template and custom
 * Profiles are created in one place. The `editor` slot is kept in the
 * return shape (always `null`) so existing call sites can render it
 * without any changes.
 */
export function useAddAgentEditor(
  _onRefreshProfiles?: () => void | Promise<void>,
): { openEditor: () => void; editor: ReactNode } {
  const openSettings = useSettingsUiStore((s) => s.open);
  return { openEditor: () => openSettings('agent'), editor: null };
}
