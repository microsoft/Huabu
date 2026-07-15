/**
 * Inline editor for a manifest-backed (Agent Team template) Profile in the
 * unified External Agents tab.
 *
 * Runtime fields (harness, working directory) are immutable after
 * creation and shown read-only. The alias is editable. The Config/Token
 * fields are **member-level**: they are shared by every Profile created
 * from the same template, so the dialog states that explicitly and edits
 * flow back through {@link applyMemberDetail} so sibling Profiles reflect
 * the change immediately.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { patchAgentTeamProfile } from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { SettingControl } from '@/components/Common/SettingControl';
import { SettingRow } from '@/components/Common/SettingRow';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';

import { AgentTeamConfigs } from './AgentTeamConfigs';

import type { ManifestProfileRow } from './useUnifiedAgents';
import type { AgentTeamMemberDetailView } from '@sediment/shared';

interface ManifestProfileEditorProps {
  row: ManifestProfileRow;
  onClose: () => void;
  applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
  onAliasSaved: () => Promise<void> | void;
}

export function ManifestProfileEditor({
  row,
  onClose,
  applyMemberDetail,
  onAliasSaved,
}: ManifestProfileEditorProps) {
  const { t } = useTranslation();
  const { t: tAgent } = useTranslation('agentTeam');
  const aliasId = useId();
  const { profile, config } = row;
  const [alias, setAlias] = useState(profile.alias);
  const [saving, setSaving] = useState(false);

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

      <SettingRow
        title={tAgent('harness')}
        description={profile.launch.harness}
      >
        <span />
      </SettingRow>
      <SettingRow
        title={tAgent('workingDirectory')}
        description={profile.workingDirPath}
      >
        <span />
      </SettingRow>

      <div>
        <p className="text-fg-subtle px-3 py-2 text-[11px] leading-snug">
          {tAgent('tokenSharedHint')}
        </p>
        <AgentTeamConfigs config={config} onDetailChange={applyMemberDetail} />
      </div>
      <div className="flex justify-end px-3 py-2.5">
        <Button variant="outline" tone="neutral" size="sm" onClick={onClose}>
          {t('actions.close')}
        </Button>
      </div>
    </div>
  );
}
