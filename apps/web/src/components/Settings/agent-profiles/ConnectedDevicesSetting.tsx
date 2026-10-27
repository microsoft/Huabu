// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import {
  getElectronBridge,
  type ElectronLocalAgentState,
} from '@/hooks/useElectron';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type { ConnectedAgentletDevice } from '@/api/acp';

function ConnectedDeviceRow({
  device,
  isLocal,
  children,
}: {
  device: ConnectedAgentletDevice;
  isLocal: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const renameDevice = useAcpProfilesStore((store) => store.renameDevice);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasEditing.current) {
      renameRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const save = async () => {
    if (inFlight.current) return;
    const name = draft.trim();
    if (!name || name.length > 120) {
      setError(t('settings.deviceNameInvalid'));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (name !== device.displayName)
        await renameDevice(device.agentletId, name);
      setEditing(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('settings.deviceRenameFailed'),
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={
        editing ? (
          <TextInput
            ref={inputRef}
            aria-label={t('settings.deviceName')}
            aria-invalid={!!error}
            className="w-full"
            value={draft}
            maxLength={120}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || saving) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setError(null);
              }
            }}
          />
        ) : (
          <>
            <span className="[overflow-wrap:anywhere]">
              {device.displayName}
            </span>
            {isLocal ? (
              <span className="text-fg-muted ml-1 font-normal">
                {t('settings.localAgentThisDevice')}
              </span>
            ) : null}
          </>
        )
      }
      description={[
        t('settings.deviceProfileCount', { count: device.profileCount }),
        `v${device.version}`,
        device.agentletId,
      ].join(' · ')}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {children}
        {editing ? (
          <>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {t('actions.save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              {t('actions.cancel')}
            </Button>
          </>
        ) : (
          <Button
            ref={renameRef}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('settings.renameDevice')}
            title={t('settings.renameDevice')}
            onClick={() => {
              setDraft(device.displayName);
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {error ? (
        <p
          role="alert"
          className="text-danger-fg mt-2 max-w-sm text-xs [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      ) : null}
    </SettingRow>
  );
}

const STATUS_KEYS = {
  disabled: 'settings.localAgentDisabled',
  connecting: 'settings.localAgentConnecting',
  connected: 'settings.localAgentConnected',
  reconnecting: 'settings.localAgentReconnecting',
  stopping: 'settings.localAgentStopping',
  'authorization-required': 'settings.localAgentAuthorizationRequired',
  error: 'settings.localAgentError',
} as const;

export function ConnectedDevicesSetting() {
  const { t } = useTranslation();
  const bridge = getElectronBridge();
  const api = bridge?.isRemoteServer ? bridge.localAgent : undefined;
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const connectedDevices = useAcpProfilesStore(
    (state) => state.connectedDevices,
  );
  const [state, setState] = useState<ElectronLocalAgentState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const localDevice = connectedDevices.find(
    (device) => device.agentletId === state?.agentletId,
  );
  const orderedDevices = localDevice
    ? [
        localDevice,
        ...connectedDevices.filter((device) => device !== localDevice),
      ]
    : connectedDevices;
  const showStatus =
    !state || (state.status !== 'disabled' && state.status !== 'connected');

  const controls = api ? (
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
          <Button
            variant="outline"
            size="sm"
            disabled={busy || (!state && !error)}
            onClick={() => {
              if (state) {
                void changeConnection(!state.enabled);
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
                : state?.enabled
                  ? 'settings.localAgentDisconnect'
                  : 'settings.localAgentConnect',
            )}
          </Button>
        </div>
      </div>
      {message ? (
        <p
          role="alert"
          className="text-danger mt-2 max-w-sm text-xs [overflow-wrap:anywhere]"
        >
          {message}
        </p>
      ) : null}
    </>
  ) : null;

  return (
    <>
      {api && !localDevice ? (
        <SettingRow
          title={
            state?.device ? (
              <>
                {state.device.displayName}
                <span className="text-fg-muted ml-1 font-normal">
                  {t('settings.localAgentThisDevice')}
                </span>
              </>
            ) : (
              t('settings.localAgentTitle')
            )
          }
          description={
            state?.device
              ? `v${state.device.version} · ${state.device.agentletId}`
              : undefined
          }
        >
          {controls}
        </SettingRow>
      ) : null}
      {orderedDevices.map((device) => (
        <ConnectedDeviceRow
          key={device.agentletId}
          device={device}
          isLocal={device === localDevice}
        >
          {device === localDevice ? controls : null}
        </ConnectedDeviceRow>
      ))}
      {!api && connectedDevices.length === 0 ? (
        <SettingRow title={t('settings.noConnectedDevices')}>
          <span />
        </SettingRow>
      ) : null}
    </>
  );
}
