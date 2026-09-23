// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDebouncedSave } from '@/components/Settings/utils';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';

export function AgentDefaultsSettings() {
  const { t } = useTranslation();
  const profiles = useAcpProfilesStore((state) => state.profiles);
  const profilesLoaded = useAcpProfilesStore((state) => state.loaded);
  const profilesError = useAcpProfilesStore((state) => state.error);
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const loadDefaults = useAcpProfilesStore((state) => state.loadDefaults);
  const saveDefaults = useAcpProfilesStore((state) => state.saveDefaults);
  const [snapshot, setSnapshot] = useState<AgentDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<AgentDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const modelId = useId();
  const active = useRef(false);
  const editRevision = useRef(0);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void refresh();
    void loadDefaults().then(
      (response) => {
        if (cancelled) return;
        setSnapshot(response);
        setDraft(response.defaults);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [refresh, loadDefaults]);

  const debouncedSave = useDebouncedSave(
    async ({
      config,
      revision,
    }: {
      config: AgentDefaults;
      revision: number;
    }) => {
      if (active.current) {
        setSaving(true);
        setError(null);
      }
      try {
        const response = await saveDefaults(config);
        if (active.current && revision === editRevision.current) {
          setSnapshot(response);
          setDraft(response.defaults);
          setSaved(true);
        }
      } catch (cause) {
        if (active.current && revision === editRevision.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : t('settings.agentDefaultsSaveFailed'),
          );
        }
      } finally {
        if (active.current && revision === editRevision.current) {
          setSaving(false);
        }
      }
    },
  );

  function edit(config: AgentDefaults, immediate = false) {
    setDraft(config);
    setSaved(false);
    setError(null);
    debouncedSave({ config, revision: ++editRevision.current });
    if (immediate) debouncedSave.flush();
  }

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
  const modelCapability =
    snapshot?.defaults.profileId === draft?.profileId
      ? (snapshot?.modelCapability ?? 'unknown')
      : externalProfiles.find((profile) => profile.id === draft?.profileId)
            ?.launch.kind === 'acp-command'
        ? 'unsupported'
        : 'unknown';

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
              disabled={!profilesLoaded}
              onOpen={() => void refresh()}
              onChange={(profileId) => {
                edit({ ...draft, profileId }, true);
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
              disabled={missing || !profilesLoaded}
              onChange={(event) => {
                edit({ ...draft, functionalModel: event.target.value });
              }}
              onBlur={() => {
                if (error) edit(draft, true);
                else debouncedSave.flush();
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
            {(saving || saved) && (
              <p className="text-success" role="status">
                {saving
                  ? t('settings.saving')
                  : t('settings.agentDefaultsSaved')}
              </p>
            )}
          </div>
        </>
      )}
    </SettingSection>
  );
}
