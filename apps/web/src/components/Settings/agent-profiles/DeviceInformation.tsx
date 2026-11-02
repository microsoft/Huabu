// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';

export function DeviceInformation({
  device,
}: {
  device: { displayName: string; agentletId: string; version?: string };
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('settings.deviceInformation')}
      className="border-edge-default text-fg-muted mt-1 w-56 max-w-[calc(100vw-40px)] border-t px-2.5 py-2 first:mt-0 first:border-t-0"
    >
      <dl className="text-xs">
        <div className="group/copy-id flex items-center justify-between gap-3">
          <dt>{t('settings.deviceId')}</dt>
          <dd className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              title={device.agentletId}
              role="menuitem"
              tabIndex={-1}
              className="focus-visible:outline-info relative max-w-full px-0 focus-visible:outline-2"
              aria-label={t('settings.copyDeviceId')}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(device.agentletId);
                  toast(t('settings.deviceIdCopied'), { tone: 'success' });
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
              <code className="truncate">
                {device.agentletId.length > 20
                  ? `${device.agentletId.slice(0, 8)}…${device.agentletId.slice(-4)}`
                  : device.agentletId}
              </code>
              <Copy className="bg-surface absolute right-0 box-content rounded-sm p-1 opacity-100 group-focus-within/copy-id:opacity-100 group-hover/copy-id:opacity-100 [@media(hover:hover)]:opacity-0" />
            </Button>
          </dd>
        </div>
        {device.version && (
          <div className="mt-1 flex justify-between gap-3">
            <dt className="text-fg-muted">
              {t('settings.connectionProgramVersion')}
            </dt>
            <dd className="select-text">{device.version}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
