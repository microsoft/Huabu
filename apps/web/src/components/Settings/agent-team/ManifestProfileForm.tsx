/**
 * Manifest-backed (Agent Team template) Profile form — one component that
 * handles both creating a Profile from a bundled template and editing an
 * existing one.
 *
 * The two modes share the member-level Config/Token block (shared by every
 * Profile of the same template) and the alias + working-directory layout.
 * They differ in what is editable:
 *
 *  - **create**: pick a trusted harness Agent, choose a working directory,
 *    optionally name it, then create the Profile *without* starting Setup.
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
import { SettingControl } from '@/components/Common/SettingControl';
import { SettingLabel } from '@/components/Common/SettingLabel';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSubGroup } from '@/components/Common/SettingSubGroup';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';

import { AgentTeamConfigs } from './AgentTeamConfigs';
import { ReadOnlyField } from './ReadOnlyField';

import type {
  ManifestMemberGroup,
  ManifestProfileRow,
} from './useUnifiedAgents';
import type {
  AcpAgentCliInfo,
  AgentTeamMemberDetailView,
} from '@sediment/shared';

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
  const [workingDirPath, setWorkingDirPath] = useState('');
  const [alias, setAlias] = useState('');
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
    const flatPath = workingDirPath
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    const folder = flatPath.slice(flatPath.lastIndexOf('/') + 1);
    return folder ? `${presetName} (${folder})` : presetName;
  }, [group.member.name, workingDirPath]);
  const agentOptions = useMemo(
    () =>
      supportedAgents.map((agent) => ({
        value: agent.id,
        label: agent.displayName,
        description: agent.installed
          ? undefined
          : t('settings.agentNotInstalled', { hint: agent.installHint }),
        disabled: !agent.installed,
      })),
    [supportedAgents, t],
  );

  const create = useCallback(async () => {
    const cwd = workingDirPath.trim();
    if (!agentId || !cwd) return;
    setCreating(true);
    try {
      const latest = await listAcpAgentClis();
      if (
        !latest.agents.some((agent) => agent.id === agentId && agent.installed)
      ) {
        toast(t('settings.selectedAgentUnavailable'), { tone: 'danger' });
        return;
      }
      const created = await createAgentTeamProfile({
        alias: alias.trim() || defaultAlias,
        agentletId: group.member.machine,
        workingDirPath: cwd,
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: group.member.manifestPath,
          harness: agentId,
        },
      });
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
    onClose,
    onCreated,
    t,
    tAgent,
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
        <SettingSubGroup>
          <p className="text-fg-subtle px-3 py-2 text-[11px] leading-snug">
            {tAgent('tokenSharedHint')}
          </p>
          <AgentTeamConfigs
            config={group.config}
            onDetailChange={applyMemberDetail}
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

      <div className="flex justify-end gap-2 px-3 py-2.5">
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
            !workingDirPath.trim() ||
            unsupported ||
            !group.config.ready
          }
          onClick={() => void create()}
        >
          {creating ? t('settings.saving') : t('settings.createAndSetup')}
        </Button>
      </div>
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
  const { profile, config } = row;
  const [alias, setAlias] = useState(profile.alias);
  const [saving, setSaving] = useState(false);
  // Resolve the harness id to the same display name the list uses (e.g.
  // "GitHub Copilot") so both views read consistently; fall back to the raw
  // id when detection hasn't surfaced the CLI.
  const harnessLabel =
    detectedClis.find((cli) => cli.id === profile.launch.harness)
      ?.displayName ?? profile.launch.harness;

  const saveAlias = async () => {
    const next = alias.trim();
    if (!next || next === profile.alias) return;
    setSaving(true);
    try {
      await patchAgentTeamProfile(profile.id, { alias: next });
      await onAliasSaved();
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
      <SettingRow title={tAgent('alias')} labelFor={aliasId}>
        <SettingControl>
          <TextInput
            id={aliasId}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            onBlur={() => void saveAlias()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            disabled={saving}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>

      <SettingRow title={tAgent('harness')}>
        <SettingControl>
          <ReadOnlyField value={harnessLabel} />
        </SettingControl>
      </SettingRow>
      <SettingRow title={tAgent('workingDirectory')}>
        <SettingControl>
          <ReadOnlyField value={profile.workingDirPath} mono />
        </SettingControl>
      </SettingRow>

      {config.fields.length > 0 ? (
        <div>
          <p className="text-fg-subtle px-3 py-2 text-[11px] leading-snug">
            {tAgent('tokenSharedHint')}
          </p>
          <AgentTeamConfigs
            config={config}
            onDetailChange={applyMemberDetail}
          />
        </div>
      ) : null}
      <div className="flex justify-end px-3 py-2.5">
        <Button variant="outline" tone="neutral" size="sm" onClick={onClose}>
          {t('actions.close')}
        </Button>
      </div>
    </div>
  );
}
