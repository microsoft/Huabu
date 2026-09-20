// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getAgentDefaults, updateAgentDefaults } from '@/api/agentDefaults';
import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';

export function AgentDefaultsSettings() {
  const { t } = useTranslation();
  const profiles = useAcpProfilesStore((state) => state.profiles);
  const profilesLoaded = useAcpProfilesStore((state) => state.loaded);
  const profilesError = useAcpProfilesStore((state) => state.error);
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const [snapshot, setSnapshot] = useState<AgentDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<AgentDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const modelId = useId();

  useEffect(() => {
    let active = true;
    void refresh();
    void getAgentDefaults().then(
      (response) => {
        if (!active) return;
        setSnapshot(response);
        setDraft(response.defaults);
      },
      (cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [refresh]);

  const externalProfiles = profiles.filter((profile) => profile.id !== 'huabu');
  const missing =
    profilesLoaded &&
    draft !== null &&
    draft.profileId !== null &&
    !externalProfiles.some((profile) => profile.id === draft.profileId);
  const options = externalProfiles.map((profile) => ({
    value: profile.id,
    label: profile.alias,
  }));
  if (missing && draft?.profileId) {
    options.unshift({
      value: draft.profileId,
      label: t('settings.agentDefaultsMissing', { id: draft.profileId }),
    });
  }
  const changed =
    draft !== null &&
    snapshot !== null &&
    (draft.profileId !== snapshot.defaults.profileId ||
      draft.functionalModel.trim() !== snapshot.defaults.functionalModel);
  const modelCapability =
    snapshot?.defaults.profileId === draft?.profileId
      ? (snapshot?.modelCapability ?? 'unknown')
      : 'unknown';

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await updateAgentDefaults(draft);
      setSnapshot(response);
      setDraft(response.defaults);
      setSaved(true);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('settings.agentDefaultsSaveFailed'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingSection title={t('settings.agentDefaultsTitle')}>
      {!draft ? (
        <p
          className="text-fg-muted px-3 py-2 text-xs"
          role={error ? 'alert' : undefined}
        >
          {error ?? t('settings.loadingAgents')}
        </p>
      ) : (
        <>
          <SettingRow
            title={t('settings.agentDefaultsProfile')}
            description={t('settings.agentDefaultsDescription')}
          >
            <Select
              ariaLabel={t('settings.agentDefaultsProfile')}
              options={options}
              value={draft.profileId ?? ''}
              placeholder={t('settings.agentDefaultsUnconfigured')}
              disabled={saving || !profilesLoaded}
              onOpen={() => void refresh()}
              onChange={(profileId) => {
                setDraft({ ...draft, profileId });
                setSaved(false);
              }}
            />
          </SettingRow>
          <SettingRow
            title={t('settings.agentDefaultsModel')}
            description={t('settings.agentDefaultsModelDescription')}
            labelFor={modelId}
          >
            <TextInput
              id={modelId}
              value={draft.functionalModel}
              placeholder={t('settings.agentDefaultsInherit')}
              maxLength={500}
              disabled={saving}
              onChange={(event) => {
                setDraft({ ...draft, functionalModel: event.target.value });
                setSaved(false);
              }}
            />
          </SettingRow>
          <div className="space-y-2 px-3 py-2 text-xs">
            {missing ? (
              <p className="text-warning" role="status">
                {t('settings.agentDefaultsDeleted')}
              </p>
            ) : draft.profileId === null ? (
              <p className="text-fg-muted">
                {t('settings.agentDefaultsUnconfigured')}
              </p>
            ) : snapshot?.defaults.profileId === draft.profileId &&
              snapshot.selectionState === 'offline' ? (
              <p className="text-warning">
                {t('settings.agentDefaultsOffline')}
              </p>
            ) : null}
            {draft.functionalModel.trim() &&
              modelCapability !== 'supported' && (
                <p className="text-warning">
                  {modelCapability === 'unsupported'
                    ? t('settings.agentDefaultsModelUnsupported')
                    : t('settings.agentDefaultsModelUnknown')}
                </p>
              )}
            {(error || profilesError) && (
              <p className="text-danger" role="alert">
                {error ?? profilesError?.message}
              </p>
            )}
            {saved && (
              <p className="text-success" role="status">
                {t('settings.agentDefaultsSaved')}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                variant="solid"
                tone="info"
                size="sm"
                disabled={saving || !changed || missing || !profilesLoaded}
                onClick={() => void save()}
              >
                {saving ? t('settings.saving') : t('actions.save')}
              </Button>
            </div>
          </div>
        </>
      )}
    </SettingSection>
  );
}
