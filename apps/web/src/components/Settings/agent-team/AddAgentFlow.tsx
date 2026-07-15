/**
 * Unified external-agent Profile creation editor.
 *
 * A Template is optional. Without one, the shared command Profile editor
 * creates an `acp-command` Profile. With one, the same form filters the Agent
 * field to the member's trusted harness ids, exposes member-scoped Configs,
 * and creates an `agent-team-manifest` Profile without starting Setup.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import { createAgentTeamProfile } from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingControl } from '@/components/Common/SettingControl';
import { SettingLabel } from '@/components/Common/SettingLabel';
import { SettingRow } from '@/components/Common/SettingRow';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { ProfileEditorForm } from '@/components/Settings/sections/ProfileEditor';

import { AgentTeamConfigs } from './AgentTeamConfigs';

import type { ManifestMemberGroup } from './useUnifiedAgents';
import type {
  AcpAgentCliInfo,
  AgentTeamMemberDetailView,
} from '@sediment/shared';

interface AddAgentFlowProps {
  members: ManifestMemberGroup[];
  manifestError: string | null;
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  onClose: () => void;
  onCommandCreated: () => Promise<void>;
  onManifestCreated: (ref: {
    machine: string;
    manifestPath: string;
  }) => Promise<void>;
  applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
}

function memberValue(group: ManifestMemberGroup): string {
  return `${group.member.machine}\u0000${group.member.manifestPath}`;
}

export function AddAgentFlow({
  members,
  manifestError,
  detectedClis,
  detectionLoaded,
  onClose,
  onCommandCreated,
  onManifestCreated,
  applyMemberDetail,
}: AddAgentFlowProps) {
  const { t } = useTranslation();
  const templateLabel = t('settings.template');
  const templateOptions = useMemo(
    () => [
      {
        value: '',
        label: t('settings.noTemplate'),
        description: t('settings.noTemplateDescription'),
      },
      ...members.map((group) => ({
        value: memberValue(group),
        label: group.member.name,
        description: group.member.description || undefined,
      })),
    ],
    [members, t],
  );
  const [selectedKey, setSelectedKey] = useState('');
  const selected = useMemo(
    () => members.find((group) => memberValue(group) === selectedKey) ?? null,
    [members, selectedKey],
  );

  return (
    <div className="divide-edge-default flex flex-col divide-y">
      <SettingRow title={t('settings.template')}>
        <SettingControl>
          <Select
            value={selectedKey}
            options={templateOptions}
            onChange={setSelectedKey}
            ariaLabel={templateLabel}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>
      {manifestError ? (
        <p className="text-warning px-3 py-2.5 text-xs" role="status">
          {t('settings.templatesUnavailable', { error: manifestError })}
        </p>
      ) : null}
      {selected ? (
        <TemplateProfileForm
          key={selectedKey}
          group={selected}
          detectedClis={detectedClis}
          detectionLoaded={detectionLoaded}
          onClose={onClose}
          onCreated={onManifestCreated}
          applyMemberDetail={applyMemberDetail}
        />
      ) : (
        <ProfileEditorForm
          editing={null}
          detectedClis={detectedClis}
          detectionLoaded={detectionLoaded}
          onClose={onClose}
          onSaved={onCommandCreated}
        />
      )}
    </div>
  );
}

function TemplateProfileForm({
  group,
  detectedClis,
  detectionLoaded,
  onClose,
  onCreated,
  applyMemberDetail,
}: {
  group: ManifestMemberGroup;
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  onClose: () => void;
  onCreated: (ref: { machine: string; manifestPath: string }) => Promise<void>;
  applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
}) {
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

  const selectedAgent = useMemo(
    () => supportedAgents.find((agent) => agent.id === agentId) ?? null,
    [agentId, supportedAgents],
  );
  const defaultAlias = useMemo(() => {
    const agentName = selectedAgent?.displayName ?? t('settings.customAgent');
    const flatPath = workingDirPath
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    const folder = flatPath.slice(flatPath.lastIndexOf('/') + 1);
    return folder ? `${agentName} (${folder})` : agentName;
  }, [selectedAgent, t, workingDirPath]);
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
      await createAgentTeamProfile({
        alias: alias.trim() || defaultAlias,
        agentletId: group.member.machine,
        workingDirPath: cwd,
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: group.member.manifestPath,
          harness: agentId,
        },
      });
      toast(tAgent('profileCreated'), { tone: 'success' });
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
      {group.member.description ? (
        <p className="text-fg-muted px-3 py-2.5 text-xs leading-snug">
          {group.member.description}
        </p>
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

      <div>
        <p className="text-fg-subtle px-3 py-2 text-[11px] leading-snug">
          {tAgent('tokenSharedHint')}
        </p>
        <AgentTeamConfigs
          config={group.config}
          onDetailChange={applyMemberDetail}
        />
      </div>

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
            creating || !agentId || !workingDirPath.trim() || unsupported
          }
          onClick={() => void create()}
        >
          {creating ? t('settings.saving') : t('settings.createProfile')}
        </Button>
      </div>
    </div>
  );
}
