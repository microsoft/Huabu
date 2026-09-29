// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { createAcpProfile, updateAcpProfile } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import {
  readAgentIcon,
  randomAgentIcon,
  withAgentIcon,
} from '@/utils/agentIcon';

import { AgentIconField } from './AgentIconField';
import { ProfileEditActions } from './ProfileEditActions';
import { ReadOnlyField } from './ReadOnlyField';
import { useProfileLaunchPreview } from './useProfileLaunchPreview';

import type { AcpAgentCliInfo, AgentProfileView } from '@huabu/shared';

interface CommandProfileFormProps {
  editing: AgentProfileView | null;
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

const CUSTOM_CAPABILITIES = {
  customLaunchCommand: 'supported',
  autoApprove: 'unsupported',
  modelOverride: 'unsupported',
  sessionPersistence: 'unsupported',
} as const;

function supportsStructuredEditing(cli: AcpAgentCliInfo | undefined) {
  return (
    cli?.installed === true &&
    cli.launchVersion === 1 &&
    cli.launchPreviewVersion === 1 &&
    cli.capabilities !== undefined
  );
}

function defaultWrapper(clis: AcpAgentCliInfo[]) {
  return (
    clis.find((cli) => cli.id !== 'custom' && supportsStructuredEditing(cli))
      ?.id ?? 'custom'
  );
}

function displayNameFor(agent: string, cwd: string) {
  const folder = cwd
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .at(-1);
  return folder ? `${agent} (${folder})` : agent;
}

/** One capability-driven form for both structured and raw-command Profiles. */
export function CommandProfileForm({
  editing,
  detectedClis,
  detectionLoaded,
  onClose,
  onSaved,
}: CommandProfileFormProps) {
  const { t } = useTranslation();
  const commandId = useId();
  const cwdId = useId();
  const displayNameId = useId();
  const [cliId, setCliId] = useState(() =>
    editing
      ? editing.launch.kind === 'acp-harness'
        ? editing.launch.harnessId
        : 'custom'
      : detectionLoaded
        ? defaultWrapper(detectedClis)
        : '',
  );
  const [displayName, setDisplayName] = useState(editing?.alias ?? '');
  const [cwd, setCwd] = useState(editing?.workingDirPath ?? '');
  const [command, setCommand] = useState(
    editing?.launch.kind === 'acp-command' ? editing.launch.command : '',
  );
  const initialApproval =
    editing?.launch.kind === 'acp-harness'
      ? (editing.launch.options?.autoApprove ?? false)
      : false;
  const [allowAll, setAllowAll] = useState(initialApproval);
  const [icon, setIcon] = useState(() =>
    editing ? readAgentIcon(editing) : randomAgentIcon(),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing && !cliId && detectionLoaded) {
      setCliId(defaultWrapper(detectedClis));
    }
  }, [editing, cliId, detectedClis, detectionLoaded]);

  const custom = cliId === 'custom';
  const descriptor = detectedClis.find((cli) => cli.id === cliId);
  // Manual setup remains available when discovery fails or an old daemon has no custom descriptor.
  const capabilities =
    descriptor?.capabilities ??
    (custom && !descriptor ? CUSTOM_CAPABILITIES : undefined);
  const structuredSupported = supportsStructuredEditing(descriptor);
  const commandSupported =
    custom && capabilities?.customLaunchCommand === 'supported';
  const approvalSupported =
    !custom && structuredSupported && capabilities?.autoApprove === 'supported';
  const agentName = custom
    ? t('settings.customCommand')
    : (descriptor?.displayName ?? cliId);
  const defaultName = displayNameFor(
    custom ? t('settings.customAgent') : agentName,
    cwd,
  );
  const launchChanged = editing
    ? custom
      ? editing.launch.kind === 'acp-command' &&
        command.trim() !== editing.launch.command
      : allowAll !== initialApproval
    : true;
  const cwdChanged = editing ? cwd.trim() !== editing.workingDirPath : true;
  const launch: AgentProfileView['launch'] =
    editing && !launchChanged
      ? editing.launch
      : custom
        ? { kind: 'acp-command', command: command.trim() }
        : {
            kind: 'acp-harness',
            harnessId: cliId,
            ...(editing?.launch.kind === 'acp-harness' || approvalSupported
              ? {
                  options: {
                    ...(editing?.launch.kind === 'acp-harness'
                      ? editing.launch.options
                      : {}),
                    ...(approvalSupported ? { autoApprove: allowAll } : {}),
                  },
                }
              : {}),
          };
  const preview = useProfileLaunchPreview(
    !custom && structuredSupported
      ? { launch, ...(editing ? { profileId: editing.id } : {}) }
      : null,
  );
  const executionChanged = launchChanged || cwdChanged;
  const invalidExecution =
    executionChanged &&
    (!cwd.trim() ||
      (custom
        ? launchChanged && (!commandSupported || !command.trim())
        : !structuredSupported ||
          !preview.plan ||
          !!preview.error ||
          (launchChanged && !approvalSupported && !!editing)));
  const saveDisabled = saving || !cliId || invalidExecution;
  const knownControlsDisabled =
    saving || !structuredSupported || !!preview.error;
  const options = [
    ...detectedClis
      .filter((cli) => cli.id !== 'custom')
      .map((cli) => ({
        value: cli.id,
        label: cli.displayName,
        disabled: !supportsStructuredEditing(cli),
      })),
    { value: 'custom', label: t('settings.customCommand') },
  ];

  async function save() {
    if (saveDisabled) return;
    setSaving(true);
    try {
      if (editing) {
        await updateAcpProfile(editing.id, {
          expectedRevision: editing.revision ?? 0,
          alias: displayName.trim() || editing.alias,
          customData: withAgentIcon(editing.customData, icon),
          ...(cwdChanged ? { workingDirPath: cwd.trim() } : {}),
          ...(launchChanged ? { launch } : {}),
        });
      } else {
        await createAcpProfile({
          alias: displayName.trim() || defaultName,
          workingDirPath: cwd.trim(),
          launch,
          metadata: { cliId },
          customData: withAgentIcon(undefined, icon),
        });
      }
      toast(
        t(editing ? 'settings.profileUpdated' : 'settings.profileCreated'),
        { tone: 'success' },
      );
      await onSaved();
      onClose();
    } catch (error) {
      toast(
        error instanceof ApiError && error.status === 409
          ? t('settings.profileEditConflict')
          : error instanceof Error
            ? error.message
            : t('settings.profileSaveFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="divide-edge-default flex flex-col divide-y">
      <SettingRow title={t('settings.agent')}>
        <SettingControl>
          {editing ? (
            <ReadOnlyField value={agentName} />
          ) : (
            <Select
              value={cliId}
              onChange={(value) => {
                setCliId(value);
                setAllowAll(false);
              }}
              options={options}
              placeholder={t('settings.detectingClis')}
              ariaLabel={t('settings.agent')}
              disabled={saving}
              className="w-full"
            />
          )}
        </SettingControl>
      </SettingRow>
      {editing ? (
        <SettingRow title={t('settings.profileMachine')}>
          <SettingControl>
            <ReadOnlyField value={editing.agentletId} mono />
          </SettingControl>
        </SettingRow>
      ) : null}
      {custom ? (
        <SettingRow
          labelFor={commandId}
          title={t('settings.launchCommand')}
          description={t('settings.launchCommandHint')}
        >
          <SettingControl>
            <TextInput
              id={commandId}
              aria-label={t('settings.launchCommand')}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="/usr/local/bin/copilot --acp"
              disabled={saving || !commandSupported}
              mono
              className="w-full"
            />
          </SettingControl>
        </SettingRow>
      ) : cliId ? (
        <>
          <SettingRow
            title={t('settings.launchCommand')}
            description={t('settings.profileLaunchPreviewHint')}
          >
            <SettingControl>
              {preview.plan ? (
                <ReadOnlyField
                  value={
                    preview.plan.kind === 'shell'
                      ? preview.plan.command
                      : JSON.stringify([
                          preview.plan.executable,
                          ...preview.plan.argv,
                        ])
                  }
                  mono
                />
              ) : (
                <span className="text-fg-muted text-xs">
                  {t(
                    preview.pending
                      ? 'settings.profilePreviewLoading'
                      : 'settings.profilePreviewUnavailable',
                  )}
                </span>
              )}
              {preview.error ? (
                <>
                  <p className="text-danger text-xs" role="alert">
                    {preview.error}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={preview.retry}
                    disabled={saving}
                  >
                    {t('settings.profilePreviewRetry')}
                  </Button>
                </>
              ) : null}
            </SettingControl>
          </SettingRow>
          <SettingRow
            title={t('settings.autoApproveAllToolCalls')}
            description={t('settings.autoApproveAllToolCallsHint')}
          >
            <input
              type="checkbox"
              aria-label={t('settings.autoApproveAllToolCalls')}
              className="accent-info h-3.5 w-3.5"
              checked={allowAll}
              disabled={knownControlsDisabled || !approvalSupported}
              onChange={(event) => setAllowAll(event.target.checked)}
            />
          </SettingRow>
          {!approvalSupported ? (
            <p className="text-fg-muted px-3 py-2 text-xs">
              {t('settings.profileApprovalUnsupported')}
            </p>
          ) : null}
          {allowAll && !initialApproval ? (
            <p className="text-warning px-3 py-2 text-xs" role="alert">
              {t('settings.profilePermissionIncrease')}
            </p>
          ) : null}
        </>
      ) : null}
      {(custom && !commandSupported) ||
      (!custom && cliId && !structuredSupported) ? (
        <p className="text-warning px-3 py-2 text-xs">
          {t('settings.profileExecutionEditingUnavailable')}
        </p>
      ) : null}
      {!editing &&
      detectionLoaded &&
      detectedClis.some(
        (cli) =>
          cli.id !== 'custom' &&
          cli.installed &&
          !supportsStructuredEditing(cli),
      ) ? (
        <p className="text-warning px-3 py-2 text-xs">
          {t('settings.structuredLaunchUnavailable')}
        </p>
      ) : null}
      <SettingRow
        labelFor={cwdId}
        title={t('settings.workingDirectory')}
        description={t('settings.workingDirectoryHint')}
      >
        <SettingControl>
          <PathInput
            id={cwdId}
            value={cwd}
            onChange={setCwd}
            ariaLabel={t('settings.workingDirectory')}
            placeholder="/Users/me/project-x"
            disabled={custom ? saving : knownControlsDisabled}
            pickerEnabled={!editing}
            size="sm"
            mono
            pickTitle={t('settings.pickFolder')}
            inputClassName="rounded"
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
            aria-label={t('settings.displayName')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={defaultName}
            disabled={saving}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>
      <AgentIconField
        value={icon}
        onChange={setIcon}
        alias={displayName || defaultName}
        disabled={saving}
      />
      {editing ? (
        <p className="text-fg-muted px-3 py-2 text-xs">
          {t('settings.profileChangesNewExecutions')}
        </p>
      ) : null}
      <ProfileEditActions
        saving={saving}
        saveDisabled={saveDisabled}
        saveLabel={editing ? undefined : t('settings.createProfile')}
        onCancel={onClose}
        onSave={() => void save()}
      />
    </div>
  );
}
