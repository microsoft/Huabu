// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

export function DeploymentReadinessNotice() {
  const { t } = useTranslation();
  const readiness = useDeploymentReadinessStore((state) => state.readiness);
  const error = useDeploymentReadinessStore((state) => state.error);

  const credentialStoreReadOnly = readiness?.credentials.writable === false;
  const remoteTransportUnverified =
    readiness?.bind.scope === 'network' &&
    readiness.transport.status === 'operator-unverified';

  if (!error && !credentialStoreReadOnly && !remoteTransportUnverified) {
    return null;
  }

  return (
    <div className="border-warning bg-warning-bg text-warning mb-4 rounded-lg border px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          {error ? <p>{t('settings.readinessUnavailable')}</p> : null}
          {credentialStoreReadOnly ? (
            <p>{t('settings.credentialStoreReadOnly')}</p>
          ) : null}
          {remoteTransportUnverified ? (
            <p>{t('settings.remoteTransportUnverified')}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
