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
import { useSettingsUiStore } from '@/store/settingsUiStore';
import { readAgentIcon } from '@/utils/agentIcon';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';

import type {
  AgentBinding,
  AgentMode,
  AgentProfileView,
  AgentTeamManifestProfileView,
} from '@huabu/shared';
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

function isManifestProfile(
  profile: AgentProfileView,
): profile is AgentTeamManifestProfileView {
  return 'preparation' in profile;
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
      className={cn(
        'w-full justify-start gap-2 rounded-none px-3 py-1.5 text-left',
        current ? 'text-info' : 'text-fg-default',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="shrink-0">{label}</span>
      {hint && (
        <span className="text-fg-muted ml-auto block min-w-0 truncate pl-2 text-xs">
          {hint}
        </span>
      )}
    </Button>
  );
}

interface AgentMenuOptionsProps {
  /** Small uppercase heading shown above the rows. */
  heading: string;
  currentBinding: AgentBinding;
  currentMode: AgentMode;
  profiles: AgentProfileView[];
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
      <div
        role="presentation"
        className="text-fg-muted px-3 pt-1.5 pb-1 text-[10px] tracking-wider uppercase select-none"
      >
        {heading}
      </div>
      {modeItems.map((m) => {
        const isCurrent =
          currentBinding.kind === 'internal' && currentMode === m.mode;
        return (
          <AgentMenuRow
            key={`mode:${m.mode}`}
            icon={m.icon}
            label={m.label}
            hint="Huabu"
            current={isCurrent}
            disabled={busy}
            title={isCurrent ? currentRowTitle : undefined}
            onClick={() =>
              onSelect({ mode: m.mode, binding: INTERNAL_BINDING })
            }
          />
        );
      })}
      {(() => {
        // Both Profile kinds share one "External Agents" group now. Only
        // ready manifest Profiles are selectable; command Profiles are
        // always selectable. Preserve order: manifest first, then command.
        const external = profiles.filter(
          (profile) =>
            (isManifestProfile(profile) &&
              profile.preparation.status === 'ready') ||
            profile.launch.kind === 'acp-command',
        );
        if (external.length === 0) return null;
        return (
          <>
            <div
              role="presentation"
              className="text-fg-muted mt-1 flex items-center gap-2 px-3 pt-1 pb-0.5 text-[10px] tracking-wider uppercase select-none"
            >
              <span className="bg-edge-default h-px flex-1" />
              <span>{t('chat.externalAgents')}</span>
              <span className="bg-edge-default h-px flex-1" />
            </div>
            {external.map((profile) => {
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
          </>
        );
      })()}
      {onAddAgent && (
        <>
          <div
            role="presentation"
            className="bg-edge-default mt-1 h-px w-full"
          />
          <div className="px-1 py-1">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={onAddAgent}
              className="w-full justify-start gap-1.5 rounded px-2 py-1.5 text-left"
            >
              <Plus size={14} />
              <span className="text-xs">{t('chat.addAgent')}</span>
            </Button>
          </div>
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
  return { openEditor: () => openSettings('agents'), editor: null };
}
