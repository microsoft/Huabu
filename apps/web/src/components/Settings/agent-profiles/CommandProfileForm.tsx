// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CircleAlert, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { createAcpProfile, updateAcpProfile } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import {
  readAgentIcon,
  randomAgentIcon,
  withAgentIcon,
} from '@/utils/agentIcon';
import { resolveConnectedDevice } from '@/utils/agentletDevice';

import { AgentIconField } from './AgentIconField';
import { ProfileEditActions } from './ProfileEditActions';
import { ReadOnlyField } from './ReadOnlyField';

import type {
  AcpAgentCliInfo,
  AgentProfileView,
  ConnectedAgentletDevice,
} from '@huabu/shared';

interface CommandProfileFormProps {
  editing: AgentProfileView | null;
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  connectedDevices: ConnectedAgentletDevice[];
  agentletId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  initialCliId?: string;
  embedded?: boolean;
  active?: boolean;
  detectionError?: string | null;
  onRecheck?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

const CUSTOM_CAPABILITIES = {
  customLaunchCommand: true,
  autoApprove: false,
} as const;

function supportsStructuredEditing(cli: AcpAgentCliInfo | undefined) {
  return cli?.status === 'ready';
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
  connectedDevices,
  agentletId,
  onClose,
  onSaved,
  initialCliId,
  embedded = false,
  active = true,
  detectionError,
  onRecheck,
  onBusyChange,
}: CommandProfileFormProps) {
  const { t } = useTranslation();
  const commandId = useId();
  const cwdId = useId();
  const displayNameId = useId();
  const cliId = editing
    ? editing.launch.kind === 'acp-harness'
      ? editing.launch.harnessId
      : 'custom'
    : (initialCliId ?? '');
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
  const [persisted, setPersisted] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (active) onBusyChange?.(saving || persisted);
  }, [active, saving, persisted, onBusyChange]);

  const custom = cliId === 'custom';
  const descriptor = detectedClis.find((cli) => cli.id === cliId);
  // Manual setup remains available when discovery fails or an old daemon has no custom descriptor.
  const capabilities =
    descriptor?.capabilities ??
    (custom && !descriptor ? CUSTOM_CAPABILITIES : undefined);
  const structuredSupported = supportsStructuredEditing(descriptor);
  const commandSupported = custom && capabilities?.customLaunchCommand === true;
  const approvalSupported =
    !custom && structuredSupported && capabilities?.autoApprove === true;
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
  const executionChanged = launchChanged || cwdChanged;
  const invalidExecution =
    executionChanged &&
    (!cwd.trim() ||
      (custom
        ? launchChanged && (!commandSupported || !command.trim())
        : !structuredSupported ||
          (launchChanged && !approvalSupported && !!editing)));
  const saveDisabled =
    saving ||
    persisted ||
    !cliId ||
    !agentletId ||
    (!editing &&
      !connectedDevices.some((device) => device.agentletId === agentletId)) ||
    invalidExecution;
  const fieldsDisabled = saving || persisted;
  const knownControlsDisabled = fieldsDisabled || !structuredSupported;
  const editingDevice = editing
    ? resolveConnectedDevice(editing.agentletId, connectedDevices)
    : undefined;
  const editingDeviceLabel = editingDevice
    ? editingDevice.displayName
    : `${t('settings.agentUnavailable')} (${editing?.agentletId ?? ''})`;

  async function save() {
    if (submitting.current || (!persisted && saveDisabled)) return;
    submitting.current = true;
    setSaving(true);
    setRefreshFailed(false);
    if (persisted) {
      try {
        await onSaved();
        onClose();
      } catch (error) {
        setRefreshFailed(true);
        toast(
          error instanceof Error
            ? error.message
            : t('settings.profileSavedRefreshFailed'),
          { tone: 'danger' },
        );
      } finally {
        submitting.current = false;
        setSaving(false);
      }
      return;
    }
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
          agentletId,
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
      setPersisted(true);
      try {
        await onSaved();
        onClose();
      } catch {
        setRefreshFailed(true);
        toast(t('settings.profileSavedRefreshFailed'), { tone: 'danger' });
      }
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
      submitting.current = false;
    }
  }

  return (
    <div
      className={`divide-edge-default flex flex-col divide-y ${embedded ? 'border-edge-default border-t' : 'border-edge-default rounded-lg border'}`}
    >
      {!embedded && (
        <SettingRow
          title={t(
            editing
              ? 'settings.profileMachineFixed'
              : 'settings.profileMachine',
          )}
        >
          <SettingControl>
            <ReadOnlyField value={editingDeviceLabel} />
          </SettingControl>
        </SettingRow>
      )}
      {embedded &&
      !custom &&
      (!detectionLoaded || detectionError || !structuredSupported) ? (
        <div className="space-y-3 px-3.5 py-4">
          {!detectionLoaded ? (
            <p role="status" className="text-fg-muted text-xs">
              {t('settings.detectingClis')}
            </p>
          ) : detectionError ? (
            <p role="alert" className="text-danger-fg text-xs">
              {detectionError}
            </p>
          ) : (
            <>
              <h4 className="flex items-center gap-2 text-[13px] font-medium">
                <CircleAlert size={16} />
                {t(
                  !descriptor
                    ? 'settings.structuredLaunchUnavailable'
                    : descriptor.diagnostics?.some(
                          (diagnostic) => diagnostic.code === 'lookup_failed',
                        )
                      ? 'settings.deviceDetectionLookupFailed'
                      : descriptor.status === 'adapter-missing'
                        ? 'settings.agentInstallAdapter'
                        : 'settings.agentInstallRequired',
                  { name: agentName },
                )}
              </h4>
              <p className="text-fg-muted text-xs">
                {t('settings.installOnDevice', {
                  device:
                    connectedDevices.find(
                      (device) => device.agentletId === agentletId,
                    )?.displayName ?? agentletId,
                })}
              </p>
              {descriptor?.installHint && (
                <div className="border-edge-default bg-bg-default flex items-start gap-2 rounded-md border p-3">
                  <code className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere] select-text">
                    {descriptor.installHint}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={t('settings.copyInstallHint')}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          descriptor.installHint,
                        );
                        toast(t('settings.installHintCopied'), {
                          tone: 'success',
                        });
                      } catch (error) {
                        toast(
                          error instanceof Error
                            ? error.message
                            : t('settings.deviceIdCopyFailed'),
                          { tone: 'danger' },
                        );
                      }
                    }}
                  >
                    <Copy />
                  </Button>
                </div>
              )}
              {descriptor?.diagnostics?.map((diagnostic, index) => (
                <p
                  key={`${diagnostic.code}:${index}`}
                  className="text-warning-fg text-xs"
                >
                  {diagnostic.message}
                </p>
              ))}
            </>
          )}
          <Button
            variant="outline"
            size="field"
            disabled={!detectionLoaded}
            onClick={onRecheck}
          >
            {t('settings.recheckAgent')}
          </Button>
        </div>
      ) : (
        <>
          {!embedded && (
            <SettingRow title={t('settings.agent')}>
              <SettingControl>
                <ReadOnlyField value={agentName} />
              </SettingControl>
            </SettingRow>
          )}
          <SettingRow
            labelFor={displayNameId}
            title={
              <SettingLabel optional>{t('settings.displayName')}</SettingLabel>
            }
          >
            <SettingControl>
              <TextInput
                size="field"
                id={displayNameId}
                aria-label={t('settings.displayName')}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={defaultName}
                disabled={fieldsDisabled}
                className="w-full"
              />
            </SettingControl>
          </SettingRow>
          <SettingRow
            labelFor={cwdId}
            title={t('settings.workingDirectory')}
            description={
              editing ? t('settings.workingDirectoryHint') : undefined
            }
          >
            <SettingControl>
              <PathInput
                id={cwdId}
                value={cwd}
                onChange={setCwd}
                ariaLabel={t('settings.workingDirectory')}
                placeholder="/Users/me/project-x"
                disabled={custom ? fieldsDisabled : knownControlsDisabled}
                targetAgentletId={editing?.agentletId ?? agentletId}
                size="sm"
                mono
                pickTitle={t('settings.pickFolder')}
                inputClassName="rounded"
              />
            </SettingControl>
          </SettingRow>
          <AgentIconField
            value={icon}
            onChange={setIcon}
            alias={displayName || defaultName}
            disabled={fieldsDisabled}
          />
          {custom ? (
            <SettingRow
              labelFor={commandId}
              title={t('settings.launchCommand')}
              description={t('settings.launchCommandHint')}
            >
              <SettingControl>
                <TextInput
                  size="field"
                  id={commandId}
                  aria-label={t('settings.launchCommand')}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="/usr/local/bin/copilot --acp"
                  disabled={fieldsDisabled || !commandSupported}
                  mono
                  className="w-full"
                />
              </SettingControl>
            </SettingRow>
          ) : cliId ? (
            <>
              <SettingRow
                title={t('settings.autoApproveAllToolCalls')}
                description={t('settings.autoApproveAllToolCallsHint')}
              >
                <Toggle
                  label={t('settings.autoApproveAllToolCalls')}
                  checked={allowAll}
                  disabled={knownControlsDisabled || !approvalSupported}
                  onChange={setAllowAll}
                />
              </SettingRow>
              {detectionLoaded && !approvalSupported ? (
                <p className="text-fg-muted px-3 py-2 text-xs">
                  {t('settings.profileApprovalUnsupported')}
                </p>
              ) : null}
              {allowAll && !initialApproval ? (
                <p className="text-warning-fg px-3 py-2 text-xs" role="alert">
                  {t('settings.profilePermissionIncrease')}
                </p>
              ) : null}
            </>
          ) : null}
          {detectionLoaded &&
          ((custom && !commandSupported) ||
            (!custom && cliId && !structuredSupported)) ? (
            <p className="text-warning-fg px-3 py-2 text-xs">
              {t('settings.profileExecutionEditingUnavailable')}
            </p>
          ) : null}
          {editing ? (
            <p className="text-fg-muted px-3 py-2 text-xs">
              {t('settings.profileChangesNewExecutions')}
            </p>
          ) : null}
        </>
      )}
      {!embedded && detectionError && (
        <p role="alert" className="text-danger-fg px-3.5 py-2 text-xs">
          {detectionError}
          <Button variant="ghost" size="sm" onClick={onRecheck}>
            {t('settings.recheckAgent')}
          </Button>
        </p>
      )}
      {refreshFailed && (
        <p role="status" className="text-warning-fg px-3.5 py-2 text-xs">
          {t('settings.profileSavedRefreshFailed')}
        </p>
      )}
      {active && (
        <ProfileEditActions
          saving={saving}
          saveDisabled={persisted ? saving : saveDisabled}
          saveLabel={
            persisted
              ? t('settings.retryRefresh')
              : editing
                ? undefined
                : t('settings.createProfile')
          }
          onCancel={onClose}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}
