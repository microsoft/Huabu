// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { MoreHorizontal, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { dismissPopoversWithin } from '@/components/Common/Popover';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import {
  getElectronBridge,
  type ElectronLocalAgentState,
} from '@/hooks/useElectron';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { resolveConnectedDevice } from '@/utils/agentletDevice';

import { ConnectedDeviceRow } from './ConnectedDeviceRow';

import type { AgentProfileView, AgentletDevice } from '@huabu/shared';
import type { ReactNode, Ref } from 'react';

const STATUS_KEYS = {
  disabled: 'settings.localAgentDisabled',
  connecting: 'settings.localAgentConnecting',
  connected: 'settings.localAgentConnected',
  reconnecting: 'settings.localAgentReconnecting',
  stopping: 'settings.localAgentStopping',
  'authorization-required': 'settings.localAgentAuthorizationRequired',
  error: 'settings.localAgentError',
} as const;

export function ConnectedDevicesSetting({
  profiles = [],
  renderProfile,
  onAdd,
  addRef,
}: {
  profiles?: AgentProfileView[];
  renderProfile?: (profile: AgentProfileView) => ReactNode;
  onAdd?: (agentletId: string) => void;
  addRef?: (agentletId: string) => Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const bridge = getElectronBridge();
  const api = bridge?.isRemoteServer ? bridge.localAgent : undefined;
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const connectedDevices = useAcpProfilesStore(
    (state) => state.connectedDevices,
  );
  const knownDevices = useAcpProfilesStore((state) => state.knownDevices);
  const [state, setState] = useState<ElectronLocalAgentState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderPickerAgentletId = useAcpProfilesStore(
    (state) => state.folderPickerAgentletId,
  );

  useEffect(() => {
    if (!api) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.onState((next) => {
      receivedEvent = true;
      setState(next);
      setError(null);
      if (next.status === 'connected') void refresh({ background: true });
    });
    void api.getState().then(
      (next) => {
        if (active && !receivedEvent) setState(next);
      },
      (reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, refresh]);

  const busy = pending || state?.status === 'stopping';
  const needsRetry =
    state?.status === 'error' || state?.status === 'authorization-required';
  const changeConnection = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    try {
      if (!api) throw new Error('Device connection requires the desktop app.');
      setState(await api.setEnabled(enabled));
      await refresh({ background: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const message = error ?? state?.error;
  const localId = api
    ? (state?.agentletId ?? state?.device?.agentletId)
    : bridge?.isElectron && !bridge.isRemoteServer
      ? folderPickerAgentletId
      : undefined;
  const devicesById = new Map<string, AgentletDevice>(
    [...knownDevices, ...connectedDevices].map((device) => [
      device.agentletId,
      device,
    ]),
  );
  if (localId && !devicesById.has(localId)) {
    devicesById.set(localId, {
      ...state?.device,
      agentletId: localId,
      displayName: state?.device?.displayName ?? t('settings.localAgentTitle'),
    });
  }
  const known = [...devicesById.values()];
  const profilesByDevice = new Map<string, AgentProfileView[]>();
  for (const profile of profiles) {
    const device =
      resolveConnectedDevice(profile.agentletId, connectedDevices) ??
      resolveConnectedDevice(profile.agentletId, known);
    const target = device?.agentletId ?? profile.agentletId;
    if (!devicesById.has(target))
      devicesById.set(target, { agentletId: target, displayName: target });
    const group = profilesByDevice.get(target) ?? [];
    group.push(profile);
    profilesByDevice.set(target, group);
  }
  const localDevice = localId ? devicesById.get(localId) : undefined;
  const orderedDevices = [
    ...(localDevice ? [localDevice] : []),
    ...connectedDevices.filter((device) => device.agentletId !== localId),
    ...[...devicesById.values()].filter(
      (device) =>
        device.agentletId !== localId &&
        !connectedDevices.some(
          (online) => online.agentletId === device.agentletId,
        ),
    ),
  ];
  const showStatus =
    !state || (state.status !== 'disabled' && state.status !== 'connected');

  const controls =
    api && (showStatus || !state?.enabled || needsRetry) ? (
      <>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {showStatus ? (
            <span role="status" className="text-fg-muted text-xs">
              {t(state ? STATUS_KEYS[state.status] : 'settings.loadingAgents')}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {state?.enabled && needsRetry ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void changeConnection(true)}
              >
                {t('settings.localAgentReconnect')}
              </Button>
            ) : null}
            {!state?.enabled && (
              <Button
                variant="outline"
                size="field"
                disabled={busy || (!state && !error)}
                onClick={() => {
                  if (state) {
                    void changeConnection(true);
                  } else {
                    setPending(true);
                    void api
                      .getState()
                      .then(
                        (next) => {
                          setState(next);
                          setError(null);
                        },
                        (reason: unknown) =>
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : String(reason),
                          ),
                      )
                      .finally(() => setPending(false));
                  }
                }}
              >
                {t(
                  !state && error
                    ? 'settings.retrySave'
                    : 'settings.localAgentConnect',
                )}
              </Button>
            )}
          </div>
        </div>
      </>
    ) : null;
  const disconnect =
    api && state?.enabled ? (
      <DropdownMenuItem
        icon={<Unplug />}
        disabled={busy}
        onClick={(event) => {
          const menu = event.currentTarget.closest('[role="menu"]');
          if (menu) dismissPopoversWithin(menu);
          void changeConnection(false);
        }}
      >
        {t('settings.localAgentDisconnect')}
      </DropdownMenuItem>
    ) : null;

  return (
    <>
      {api && !localDevice ? (
        <SettingRow
          title={t('settings.localAgentTitle')}
          className="border-edge-default mb-3 rounded-lg border"
        >
          <div className="flex items-center gap-2">
            {controls}
            {disconnect && (
              <DropdownMenu
                align="bottom-right"
                trigger={
                  <Button
                    variant="ghost"
                    size="field"
                    iconOnly
                    aria-label={t('settings.deviceActions', {
                      device: t('settings.localAgentTitle'),
                    })}
                  >
                    <MoreHorizontal />
                  </Button>
                }
              >
                {disconnect}
              </DropdownMenu>
            )}
          </div>
          {message && (
            <p
              role="alert"
              className="text-danger mt-2 text-xs [overflow-wrap:anywhere]"
            >
              {message}
            </p>
          )}
        </SettingRow>
      ) : null}
      {orderedDevices.map((device) => {
        const deviceProfiles = profilesByDevice.get(device.agentletId) ?? [];
        const isLocalDevice = device.agentletId === localId;
        const online =
          connectedDevices.some(
            (entry) => entry.agentletId === device.agentletId,
          ) &&
          (!isLocalDevice || !api || state?.status === 'connected');
        return (
          <ConnectedDeviceRow
            key={device.agentletId}
            device={device}
            isLocalDevice={isLocalDevice}
            online={online}
            connectionControls={isLocalDevice ? controls : null}
            connectionError={isLocalDevice ? message : null}
            menuItems={isLocalDevice ? disconnect : null}
            onAdd={onAdd ? () => onAdd(device.agentletId) : undefined}
            addRef={addRef?.(device.agentletId)}
            profileCount={deviceProfiles.length}
          >
            {deviceProfiles.map((profile) => renderProfile?.(profile))}
          </ConnectedDeviceRow>
        );
      })}
      {!api && orderedDevices.length === 0 ? (
        <SettingRow title={t('settings.noConnectedDevices')}>
          <span />
        </SettingRow>
      ) : null}
    </>
  );
}
