// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Manifest-backed (Agent Team template) Profile form — one component that
 * handles both creating a Profile from a bundled template and editing an
 * existing one.
 *
 * The two modes share the member-level Config/Token block (shared by every
 * Profile of the same template) and the alias + working-directory layout.
 * They differ in what is editable:
 *
 *  - **create**: pick a trusted harness Agent, use a Huabu-managed workspace
 *    or choose a custom directory, optionally name it, then create + Setup.
 *  - **edit**: harness and working directory are immutable and shown
 *    read-only; only the alias (and the shared Configs) can change.
 *
 * Config edits flow back through {@link applyMemberDetail} so sibling
 * Profiles reflect the change immediately.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import {
  createAgentTeamProfile,
  patchAgentTeamProfile,
  setupAgentTeamProfile,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSubGroup } from '@/components/Settings/Common/SettingSubGroup';
import {
  readAgentIcon,
  randomAgentIcon,
  withAgentIcon,
} from '@/utils/agentIcon';

import { AgentIconField } from './AgentIconField';
import { AgentTeamConfigs } from './AgentTeamConfigs';
import { ProfileEditActions } from './ProfileEditActions';
import { ProfileEditFields } from './ProfileEditFields';
import { ProfileFormFooter } from './ProfileFormFooter';

import type {
  ManifestMemberGroup,
  ManifestProfileRow,
} from './useUnifiedAgents';
import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type {
  AcpAgentCliInfo,
  AgentTeamMemberDetailView,
  CreateAgentTeamProfileBody,
} from '@huabu/shared';

type ManifestProfileFormProps =
  | {
      mode: 'create';
      group: ManifestMemberGroup;
      detectedClis: AcpAgentCliInfo[];
      detectionLoaded: boolean;
      onClose: () => void;
      onCreated: (ref: {
        machine: string;
        manifestPath: string;
      }) => Promise<void>;
      applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
    }
  | {
      mode: 'edit';
      row: ManifestProfileRow;
      detectedClis: AcpAgentCliInfo[];
      onClose: () => void;
      applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
      onAliasSaved: () => Promise<void> | void;
    };

export function ManifestProfileForm(props: ManifestProfileFormProps) {
  return props.mode === 'create' ? (
    <CreateManifestProfileForm {...props} />
  ) : (
    <EditManifestProfileForm {...props} />
  );
}

// ── Create ────────────────────────────────────────────────────────────

function CreateManifestProfileForm({
  group,
  detectedClis,
  detectionLoaded,
  onClose,
  onCreated,
  applyMemberDetail,
}: Extract<ManifestProfileFormProps, { mode: 'create' }>) {
  const { t } = useTranslation();
  const { t: tAgent } = useTranslation('agentTeam');
  const cwdId = useId();
  const displayNameId = useId();
  const supportedAgents = useMemo(() => {
    const harnesses = new Set(group.member.harnesses);
    return detectedClis.filter((agent) => harnesses.has(agent.id));
  }, [detectedClis, group.member.harnesses]);
  const unknownHarnesses = useMemo(() => {
    const known = new Set(detectedClis.map((agent) => agent.id));
    return group.member.harnesses.filter((harness) => !known.has(harness));
  }, [detectedClis, group.member.harnesses]);
  const selectableAgents = useMemo(
    () => supportedAgents.filter((agent) => agent.installed),
    [supportedAgents],
  );
  const [agentId, setAgentId] = useState('');
  const [useDefaultWorkingDir, setUseDefaultWorkingDir] = useState(true);
  const [workingDirPath, setWorkingDirPath] = useState('');
  const [alias, setAlias] = useState('');
  const [icon, setIcon] = useState<AgentIconValue>(() => randomAgentIcon());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!detectionLoaded) return;
    setAgentId((current) =>
      selectableAgents.some((agent) => agent.id === current)
        ? current
        : (selectableAgents[0]?.id ?? ''),
    );
  }, [detectionLoaded, selectableAgents]);

  const defaultAlias = useMemo(() => {
    // Default to the preset name + working folder (e.g.
    // "deepv-slides-maker (project-x)"). Using the preset name rather than
    // the agent's display name keeps it distinct from the no-preset default,
    // which is derived from the agent name.
    const presetName = group.member.name;
    const flatPath = (useDefaultWorkingDir ? '' : workingDirPath)
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    const folder = flatPath.slice(flatPath.lastIndexOf('/') + 1);
    return folder ? `${presetName} (${folder})` : presetName;
  }, [group.member.name, useDefaultWorkingDir, workingDirPath]);
  const agentOptions = useMemo(() => {
    const installed = supportedAgents
      .filter((agent) => agent.installed)
      .map((agent) => ({
        value: agent.id,
        label: agent.displayName,
      }));
    const missing = supportedAgents
      .filter((agent) => !agent.installed)
      .map((agent, index) => ({
        value: agent.id,
        label: agent.displayName,
        disabled: true,
        sectionLabel:
          index === 0 ? t('settings.notInstalledAgents') : undefined,
      }));
    return [...installed, ...missing];
  }, [supportedAgents, t]);

  const create = useCallback(async () => {
    const cwd = workingDirPath.trim();
    if (!agentId || (!useDefaultWorkingDir && !cwd)) return;
    setCreating(true);
    try {
      const latest = await listAcpAgentClis();
      if (
        !latest.agents.some((agent) => agent.id === agentId && agent.installed)
      ) {
        toast(t('settings.selectedAgentUnavailable'), { tone: 'danger' });
        return;
      }
      const commonProfile = {
        alias: alias.trim() || defaultAlias,
        agentletId: group.member.machine,
        launch: {
          kind: 'agent-team-manifest' as const,
          manifestPath: group.member.manifestPath,
          harness: agentId,
        },
        customData: withAgentIcon(undefined, icon),
      };
      const profile: CreateAgentTeamProfileBody = useDefaultWorkingDir
        ? {
            ...commonProfile,
            workingDirectory: { kind: 'default' },
          }
        : {
            ...commonProfile,
            workingDirectory: { kind: 'custom', path: cwd },
          };
      const created = await createAgentTeamProfile(profile);
      // Create is only enabled once every required field (including the
      // preset's required credentials) is complete, so setup can always run
      // immediately. Kick it off; progress is then monitored in the list.
      try {
        await setupAgentTeamProfile(created.id);
        toast(tAgent('profileCreated'), { tone: 'success' });
      } catch (setupError) {
        // The Profile exists regardless — surface the setup failure but keep
        // it; the user can retry setup from the list.
        toast(
          setupError instanceof Error
            ? setupError.message
            : tAgent('operationFailed'),
          { tone: 'danger' },
        );
      }
      await onCreated({
        machine: group.member.machine,
        manifestPath: group.member.manifestPath,
      });
      onClose();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : tAgent('operationFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setCreating(false);
    }
  }, [
    agentId,
    alias,
    defaultAlias,
    group.member,
    icon,
    onClose,
    onCreated,
    t,
    tAgent,
    useDefaultWorkingDir,
    workingDirPath,
  ]);

  const unsupported =
    detectionLoaded &&
    (unknownHarnesses.length > 0 || supportedAgents.length === 0);

  return (
    <div className="divide-edge-default flex flex-col divide-y">
      {/*
       * Token/Config sits directly under the Template selector (rendered by
       * the parent) because it is member-level: it belongs to the template
       * and is shared by every Profile created from it — not to the agent
       * client picked below. Nested via SettingSubGroup so it reads as the
       * preset's own configuration. Hidden entirely when the preset
       * declares no configurable fields — an empty "no credentials" panel is
       * just noise.
       */}
      {group.config.fields.length > 0 ? (
        <SettingSubGroup density="compact">
          <p className="text-fg-subtle px-3 pt-1 pb-0.5 text-[11px] leading-snug">
            {tAgent('tokenSharedHint')}
          </p>
          <AgentTeamConfigs
            config={group.config}
            onDetailChange={applyMemberDetail}
            density="compact"
          />
        </SettingSubGroup>
      ) : null}

      <SettingRow title={t('settings.agent')}>
        <SettingControl>
          {!detectionLoaded ? (
            <div className="border-edge-default bg-surface text-fg-subtle rounded border px-2 py-1 text-xs">
              {t('settings.detectingClis')}
            </div>
          ) : (
            <Select
              value={agentId}
              options={agentOptions}
              onChange={setAgentId}
              placeholder={t('settings.noSupportedAgent')}
              disabled={agentOptions.length === 0}
              ariaLabel={t('settings.agent')}
              className="w-full"
            />
          )}
        </SettingControl>
      </SettingRow>
      {unsupported ? (
        <p className="text-danger px-3 py-2.5 text-xs" role="alert">
          {t('settings.unsupportedTemplateAgents', {
            agents:
              unknownHarnesses.join(', ') || group.member.harnesses.join(', '),
          })}
        </p>
      ) : null}
      {detectionLoaded &&
      supportedAgents.length > 0 &&
      selectableAgents.length === 0 ? (
        <p className="text-warning px-3 py-2.5 text-xs" role="status">
          {t('settings.installSupportedAgent')}
        </p>
      ) : null}

      <SettingRow
        title={tAgent('useDefaultWorkingDirectory')}
        description={tAgent('useDefaultWorkingDirectoryHint')}
      >
        <SettingControl>
          <Toggle
            checked={useDefaultWorkingDir}
            onChange={setUseDefaultWorkingDir}
            disabled={creating}
            label={tAgent('useDefaultWorkingDirectory')}
          />
        </SettingControl>
      </SettingRow>
      {!useDefaultWorkingDir ? (
        <SettingRow
          labelFor={cwdId}
          title={tAgent('workingDirectory')}
          description={t('settings.templateWorkingDirHint')}
        >
          <SettingControl>
            <PathInput
              id={cwdId}
              value={workingDirPath}
              onChange={setWorkingDirPath}
              placeholder="/Users/me/project-x"
              pickTitle={tAgent('pickFolder')}
              size="sm"
              mono
            />
          </SettingControl>
        </SettingRow>
      ) : null}
      <SettingRow
        labelFor={displayNameId}
        title={
          <SettingLabel optional>{t('settings.displayName')}</SettingLabel>
        }
      >
        <SettingControl>
          <TextInput
            id={displayNameId}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder={defaultAlias}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>

      <AgentIconField
        value={icon}
        onChange={setIcon}
        alias={alias || defaultAlias}
        disabled={creating}
      />

      <ProfileFormFooter>
        <Button
          variant="outline"
          tone="neutral"
          size="sm"
          onClick={onClose}
          disabled={creating}
        >
          {tAgent('cancel')}
        </Button>
        <Button
          variant="solid"
          tone="info"
          size="sm"
          disabled={
            creating ||
            !agentId ||
            (!useDefaultWorkingDir && !workingDirPath.trim()) ||
            unsupported ||
            !group.config.ready
          }
          onClick={() => void create()}
        >
          {creating ? t('settings.saving') : t('settings.createAndSetup')}
        </Button>
      </ProfileFormFooter>
    </div>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────

function EditManifestProfileForm({
  row,
  detectedClis,
  onClose,
  applyMemberDetail,
  onAliasSaved,
}: Extract<ManifestProfileFormProps, { mode: 'edit' }>) {
  const { t } = useTranslation();
  const { t: tAgent } = useTranslation('agentTeam');
  const aliasId = useId();
  const { profile, config, member } = row;
  const [alias, setAlias] = useState(profile.alias);
  const [icon, setIcon] = useState<AgentIconValue>(() =>
    readAgentIcon(profile),
  );
  const [saving, setSaving] = useState(false);
  // Resolve the harness id to the same display name the list uses (e.g.
  // "GitHub Copilot") so both views read consistently; fall back to the raw
  // id when detection hasn't surfaced the CLI.
  const harnessLabel =
    detectedClis.find((cli) => cli.id === profile.launch.harness)
      ?.displayName ?? profile.launch.harness;

  const saveAlias = async () => {
    const next = alias.trim();
    if (!next) return;
    const aliasChanged = next !== profile.alias;
    const current = readAgentIcon(profile);
    const iconChanged =
      icon.shape !== current.shape || icon.color !== current.color;
    if (!aliasChanged && !iconChanged) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await patchAgentTeamProfile(profile.id, {
        ...(aliasChanged ? { alias: next } : {}),
        ...(iconChanged
          ? { customData: withAgentIcon(profile.customData, icon) }
          : {}),
      });
      await onAliasSaved();
      toast(t('settings.profileUpdated'), { tone: 'success' });
      onClose();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : tAgent('operationFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="divide-edge-default flex flex-col divide-y">
      <ProfileEditFields
        preset={{
          name: member.name,
          description: member.description || undefined,
          configuration:
            config.fields.length > 0 ? (
              <SettingSubGroup density="compact">
                <p className="text-fg-subtle px-3 pt-1 pb-0.5 text-[11px] leading-snug">
                  {tAgent('tokenSharedHint')}
                </p>
                <AgentTeamConfigs
                  config={config}
                  onDetailChange={applyMemberDetail}
                  density="compact"
                />
              </SettingSubGroup>
            ) : undefined,
        }}
        agentName={harnessLabel}
        workingDirPath={profile.workingDirPath}
        displayNameId={aliasId}
        displayNameControl={
          <TextInput
            id={aliasId}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            disabled={saving}
            className="w-full"
          />
        }
      />
      <AgentIconField
        value={icon}
        onChange={setIcon}
        alias={alias || profile.alias}
        disabled={saving}
      />
      <ProfileEditActions
        saving={saving}
        saveDisabled={!alias.trim()}
        onCancel={onClose}
        onSave={() => void saveAlias()}
      />
    </div>
  );
}
