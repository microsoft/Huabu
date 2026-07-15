/**
 * Edit dialog for a manifest-backed (Agent Team template) Profile in the
 * unified External Agents tab.
 *
 * Runtime fields (harness, working directory) are immutable after
 * creation and shown read-only. The alias is editable. The Config/Token
 * fields are **member-level**: they are shared by every Profile created
 * from the same template, so the dialog states that explicitly and edits
 * flow back through {@link applyMemberDetail} so sibling Profiles reflect
 * the change immediately.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { patchAgentTeamProfile } from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
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
  const { t } = useTranslation('agentTeam');
  const { profile, config } = row;
  const [alias, setAlias] = useState(profile.alias);
  const [saving, setSaving] = useState(false);

  const saveAlias = async () => {
    const next = alias.trim();
    if (!next || next === profile.alias) return;
    setSaving(true);
    try {
      await patchAgentTeamProfile(profile.id, { alias: next });
      toast(t('profileUpdated'), { tone: 'success' });
      await onAliasSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={profile.alias} className="w-108">
      <div className="flex flex-col gap-4">
        <SettingRow title={t('alias')}>
          <div className="flex min-w-64 items-center gap-1.5">
            <TextInput
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              disabled={saving}
              className="min-w-0 flex-1"
            />
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              disabled={
                saving || !alias.trim() || alias.trim() === profile.alias
              }
              onClick={() => void saveAlias()}
            >
              {t('save')}
            </Button>
          </div>
        </SettingRow>

        <SettingRow title={t('harness')} description={profile.launch.harness}>
          <span />
        </SettingRow>
        <SettingRow
          title={t('workingDirectory')}
          description={profile.workingDirPath}
        >
          <span />
        </SettingRow>

        <div className="border-edge-default border-t pt-3">
          <p className="text-fg-subtle mb-2 text-[11px] leading-snug">
            {t('tokenSharedHint')}
          </p>
          <AgentTeamConfigs
            config={config}
            onDetailChange={applyMemberDetail}
          />
        </div>

        <div className="flex justify-end">
          <Button variant="outline" tone="neutral" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
