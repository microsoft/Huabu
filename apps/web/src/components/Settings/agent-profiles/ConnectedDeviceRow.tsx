// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { discoverAcpAgentlet } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type {
  AcpAgentletDiscoveryResponse,
  ConnectedAgentletDevice,
} from '@huabu/shared';
import type { ParseKeys } from 'i18next';
import type { ReactNode } from 'react';

const ERROR_KEYS = new Map<string, ParseKeys>([
  ['agentlet_unavailable', 'settings.deviceDetectionDisconnected'],
  ['harness_discovery_stale', 'settings.deviceDetectionStale'],
  ['harness_discovery_unsupported', 'settings.deviceDetectionUnsupported'],
  ['harness_discovery_unavailable', 'settings.deviceDetectionUnavailable'],
  [
    'profile_registry_unavailable',
    'settings.deviceDetectionRegistryUnavailable',
  ],
  [
    'harness_reconciliation_failed',
    'settings.deviceDetectionReconciliationFailed',
  ],
]);
const DIAGNOSTIC_KEYS = new Map<string, ParseKeys>([
  ['binary_missing', 'settings.deviceDetectionNotFound'],
  ['adapter_missing', 'settings.deviceDetectionAdapterMissing'],
  ['lookup_failed', 'settings.deviceDetectionLookupFailed'],
  ['workspace_failed', 'settings.deviceDetectionWorkspaceFailed'],
  ['version_unknown', 'settings.deviceDetectionVersionUnknown'],
  ['version_probe_failed', 'settings.deviceDetectionVersionUnknown'],
]);

export function ConnectedDeviceRow({
  device,
  isLocalDevice,
  connectionControls,
}: {
  device: ConnectedAgentletDevice;
  isLocalDevice: boolean;
  connectionControls?: ReactNode;
}) {
  const { t } = useTranslation();
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const requestRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AcpAgentletDiscoveryResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(
    () => () => {
      requestRef.current = null;
    },
    [],
  );

  const detect = async () => {
    if (requestRef.current) return;
    const request = Symbol();
    requestRef.current = request;
    setPending(true);
    setResult(null);
    setError(null);
    setRefreshFailed(false);
    setShowDetails(false);
    try {
      const response = await discoverAcpAgentlet(device.agentletId);
      if (requestRef.current === request) setResult(response);
    } catch (reason) {
      if (requestRef.current === request) {
        const key =
          reason instanceof ApiError
            ? ERROR_KEYS.get(reason.code ?? '')
            : undefined;
        let message = t(
          reason instanceof ApiError && reason.status === 403
            ? 'settings.deviceDetectionOwnerRequired'
            : (key ?? 'settings.deviceDetectionUnavailable'),
        );
        const details = reason instanceof ApiError ? reason.details : undefined;
        if (
          details &&
          typeof details === 'object' &&
          'createdProfileIds' in details &&
          Array.isArray(details.createdProfileIds) &&
          details.createdProfileIds.every((id) => typeof id === 'string')
        ) {
          message += ` ${t('settings.deviceDetectionPartialCount', { count: details.createdProfileIds.length })}`;
        }
        setError(message);
      }
    }
    // Even an interrupted reconciliation may have persisted some additions.
    try {
      await refresh({ afterMutation: true });
    } catch {
      if (requestRef.current === request) setRefreshFailed(true);
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setPending(false);
      }
    }
  };

  const entries = result?.harnesses ?? [];
  const ready = entries.filter((entry) => entry.status === 'ready').length;
  const existing = entries.filter(
    (entry) => entry.profileStatus === 'existing',
  ).length;
  const created = entries.filter(
    (entry) => entry.profileStatus === 'created',
  ).length;
  const adapterMissing = entries.filter(
    (entry) => entry.status === 'adapter-missing',
  ).length;
  const notFound = entries.filter(
    (entry) => entry.status === 'not-found',
  ).length;
  const workspaceFailed = entries.filter(
    (entry) => entry.status === 'ready' && entry.profileStatus === 'skipped',
  ).length;

  return (
    <div>
      <SettingRow
        title={
          <>
            {device.displayName}
            {isLocalDevice ? (
              <span className="text-fg-muted ml-1 font-normal">
                {t('settings.localAgentThisDevice')}
              </span>
            ) : null}
          </>
        }
        description={[
          t('settings.deviceProfileCount', { count: device.profileCount }),
          `v${device.version}`,
          device.agentletId,
        ].join(' · ')}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          {connectionControls}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('settings.detectInstalledAgents')}
            aria-label={t('settings.detectInstalledAgentsOnDevice', {
              device: device.displayName,
            })}
            aria-busy={pending}
            disabled={pending}
            onClick={() => void detect()}
          >
            <RefreshCw
              className={pending ? 'motion-safe:animate-spin' : undefined}
            />
          </Button>
        </div>
      </SettingRow>
      {pending || result || error || refreshFailed ? (
        <div className="px-3.5 pb-3 text-xs [overflow-wrap:anywhere]">
          {pending ? (
            <p role="status" className="text-fg-muted">
              {t('settings.deviceDetectionPending')}
            </p>
          ) : null}
          {result ? (
            <div role="status" className="text-fg-muted space-y-1">
              <p>
                {t('settings.deviceDetectionSummary', {
                  ready,
                  existing,
                  created,
                  adapterMissing,
                  notFound,
                })}
              </p>
              {workspaceFailed ? (
                <p className="text-warning">
                  {t('settings.deviceDetectionWorkspaceCount', {
                    count: workspaceFailed,
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
          {refreshFailed ? (
            <p role="alert" className="text-danger">
              {t('settings.deviceDetectionRefreshFailed')}
            </p>
          ) : null}
          {result && entries.length > 0 ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((shown) => !shown)}
                className="mt-1"
              >
                {t('settings.deviceDetectionDetails')}
              </Button>
              {showDetails ? (
                <ul className="text-fg-muted mt-2 space-y-2">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <p className="text-fg-default font-medium">
                        {entry.displayName}:{' '}
                        {t(
                          entry.status === 'adapter-missing'
                            ? 'settings.deviceDetectionAdapterMissing'
                            : entry.status === 'not-found'
                              ? entry.diagnostics?.some(
                                  (diagnostic) =>
                                    diagnostic.code === 'lookup_failed',
                                )
                                ? 'settings.deviceDetectionLookupFailed'
                                : 'settings.deviceDetectionNotFound'
                              : entry.profileStatus === 'created'
                                ? 'settings.deviceDetectionCreated'
                                : entry.profileStatus === 'existing'
                                  ? 'settings.deviceDetectionExisting'
                                  : 'settings.deviceDetectionWorkspaceFailed',
                        )}
                      </p>
                      {entry.status !== 'ready' && entry.installHint ? (
                        <p>
                          {t('settings.deviceDetectionInstallHint')}{' '}
                          <code>{entry.installHint}</code>
                        </p>
                      ) : null}
                      {entry.diagnostics?.map((diagnostic, index) => (
                        <p key={`${diagnostic.code}-${index}`}>
                          {t(
                            DIAGNOSTIC_KEYS.get(diagnostic.code) ??
                              'settings.deviceDetectionDiagnostic',
                          )}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
