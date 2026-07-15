/**
 * "Add agent" flow for the unified External Agents tab.
 *
 * Step 1 picks a source:
 *   - **Template** — a bundled Agent Team. The user fills the member's
 *     Config/Token (member-level, shared by every Profile of that
 *     template), picks a harness and a working directory, then creates a
 *     Profile. Setup is intentionally NOT auto-run — the new Profile
 *     lands in `not_prepared` and the list row exposes an explicit
 *     "Set up" button, because preparation (npm installs, skills) is a
 *     heavy operation the user should trigger deliberately.
 *   - **Custom command** — reuses {@link ProfileEditorForm}, the same
 *     detected-CLI / raw-command editor used for command-backed ACP
 *     Profiles.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createAgentTeamProfile } from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { ProfileEditorForm } from '@/components/Settings/sections/ProfileEditor';

import { AgentTeamConfigs } from './AgentTeamConfigs';

import type { ManifestMemberGroup } from './useUnifiedAgents';
import type {
  AgentTeamMemberDetailView,
  AcpAgentCliInfo,
} from '@sediment/shared';

type Source = 'choose' | 'template' | 'custom';

interface AddAgentFlowProps {
  members: ManifestMemberGroup[];
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
  detectedClis,
  detectionLoaded,
  onClose,
  onCommandCreated,
  onManifestCreated,
  applyMemberDetail,
}: AddAgentFlowProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>('choose');

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('settings.addAgent')}
      className="w-108"
    >
      {source === 'choose' && (
        <SourcePicker hasTemplates={members.length > 0} onPick={setSource} />
      )}
      {source === 'custom' && (
        <ProfileEditorForm
          editing={null}
          detectedClis={detectedClis}
          detectionLoaded={detectionLoaded}
          onClose={onClose}
          onSaved={onCommandCreated}
        />
      )}
      {source === 'template' && (
        <TemplateForm
          members={members}
          onClose={onClose}
          onManifestCreated={onManifestCreated}
          applyMemberDetail={applyMemberDetail}
        />
      )}
    </Modal>
  );
}

function SourcePicker({
  hasTemplates,
  onPick,
}: {
  hasTemplates: boolean;
  onPick: (source: Source) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={!hasTemplates}
        onClick={() => onPick('template')}
        className="border-edge-default hover:bg-hover flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50"
      >
        <span className="text-fg-default text-sm font-medium">
          {t('settings.addFromTemplate')}
        </span>
        <span className="text-fg-muted text-xs">
          {t('settings.addFromTemplateHint')}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onPick('custom')}
        className="border-edge-default hover:bg-hover flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors"
      >
        <span className="text-fg-default text-sm font-medium">
          {t('settings.addCustomCommand')}
        </span>
        <span className="text-fg-muted text-xs">
          {t('settings.addCustomCommandHint')}
        </span>
      </button>
    </div>
  );
}

function TemplateForm({
  members,
  onClose,
  onManifestCreated,
  applyMemberDetail,
}: {
  members: ManifestMemberGroup[];
  onClose: () => void;
  onManifestCreated: (ref: {
    machine: string;
    manifestPath: string;
  }) => Promise<void>;
  applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
}) {
  const { t } = useTranslation();
  const { t: tt } = useTranslation('agentTeam');
  const [selectedKey, setSelectedKey] = useState(
    members[0] ? memberValue(members[0]) : '',
  );
  const selected = useMemo(
    () => members.find((group) => memberValue(group) === selectedKey) ?? null,
    [members, selectedKey],
  );
  const firstHarness = selected?.member.harnesses[0] ?? '';
  const [harness, setHarness] = useState(firstHarness);
  const [workingDirPath, setWorkingDirPath] = useState('');
  const [alias, setAlias] = useState(selected?.member.name ?? '');
  const [creating, setCreating] = useState(false);

  const memberOptions = useMemo(
    () =>
      members.map((group) => ({
        value: memberValue(group),
        label: group.member.name,
        description: group.member.description || undefined,
      })),
    [members],
  );
  const harnessOptions = useMemo(
    () =>
      (selected?.member.harnesses ?? []).map((value) => ({
        value,
        label: value,
      })),
    [selected],
  );

  const onSelectMember = (key: string) => {
    setSelectedKey(key);
    const group = members.find((candidate) => memberValue(candidate) === key);
    setHarness(group?.member.harnesses[0] ?? '');
    setAlias(group?.member.name ?? '');
  };

  const create = async () => {
    if (!selected || !harness || !alias.trim() || !workingDirPath.trim()) {
      return;
    }
    setCreating(true);
    try {
      await createAgentTeamProfile({
        alias: alias.trim(),
        agentletId: selected.member.machine,
        workingDirPath: workingDirPath.trim(),
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: selected.member.manifestPath,
          harness,
        },
      });
      toast(tt('profileCreated'), { tone: 'success' });
      await onManifestCreated({
        machine: selected.member.machine,
        manifestPath: selected.member.manifestPath,
      });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : tt('operationFailed'), {
        tone: 'danger',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <SettingRow title={t('settings.template')}>
        <Select
          value={selectedKey}
          options={memberOptions}
          onChange={onSelectMember}
          className="min-w-64"
        />
      </SettingRow>

      {selected && (
        <>
          {selected.member.description && (
            <p className="text-fg-muted text-xs leading-snug">
              {selected.member.description}
            </p>
          )}

          <div className="border-edge-default border-t pt-3">
            <p className="text-fg-subtle mb-2 text-[11px] leading-snug">
              {tt('tokenSharedHint')}
            </p>
            <AgentTeamConfigs
              config={selected.config}
              onDetailChange={applyMemberDetail}
            />
          </div>

          <SettingRow title={tt('harness')}>
            <Select
              value={harness}
              options={harnessOptions}
              onChange={setHarness}
              className="min-w-64"
            />
          </SettingRow>
          <SettingRow title={tt('alias')}>
            <TextInput
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              className="min-w-64"
            />
          </SettingRow>
          <SettingRow
            title={tt('workingDirectory')}
            description={t('settings.templateWorkingDirHint')}
          >
            <PathInput
              value={workingDirPath}
              onChange={setWorkingDirPath}
              placeholder="/Users/me/project-x"
              pickTitle={tt('pickFolder')}
              size="sm"
              mono
              className="min-w-64"
            />
          </SettingRow>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={onClose}
            >
              {tt('cancel')}
            </Button>
            <Button
              variant="solid"
              tone="info"
              size="sm"
              disabled={
                creating || !harness || !alias.trim() || !workingDirPath.trim()
              }
              onClick={() => void create()}
            >
              {creating ? tt('save') : t('settings.createProfile')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
