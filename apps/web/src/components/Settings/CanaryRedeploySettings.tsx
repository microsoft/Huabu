// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  checkCanaryRedeploy,
  getCanaryRedeployStatus,
  requestCanaryRedeploy,
} from '@/api/deployment';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

import type { CanaryRedeployStatusResponse } from '@huabu/shared';

function shortSha(sha: string | null): string {
  return sha?.slice(0, 7) ?? 'unknown';
}

export function CanaryRedeploySettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CanaryRedeployStatusResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const check = useCallback(
    async (showToast: boolean) => {
      setChecking(true);
      try {
        const next = await checkCanaryRedeploy();
        setStatus(next);
        if (showToast) {
          toast(
            next.updateAvailable
              ? t('settings.canaryUpdateAvailable')
              : t('settings.canaryUpToDate'),
            { tone: next.updateAvailable ? 'info' : 'success' },
          );
        }
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : t('settings.canaryCheckFailed'),
          { tone: 'danger' },
        );
      } finally {
        setChecking(false);
      }
    },
    [t],
  );

  useEffect(() => {
    let active = true;
    void getCanaryRedeployStatus()
      .then((initial) => {
        if (!active) return;
        setStatus(initial);
        if (initial.available) void check(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus(null);
        toast(
          error instanceof Error
            ? error.message
            : t('settings.canaryStatusFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [check, t]);

  const redeploy = useCallback(async () => {
    setRequesting(true);
    try {
      const next = await requestCanaryRedeploy();
      setStatus(next);
      setConfirming(false);
      toast(t('settings.canaryRedeployStarted'), {
        tone: 'info',
        duration: 10_000,
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.canaryRedeployFailed'),
        { tone: 'danger' },
      );
    } finally {
      setRequesting(false);
    }
  }, [t]);

  if (loading || !status?.available) return null;

  const outcome = status.redeploy
    ? t(`settings.canaryState_${status.redeploy.state}`)
    : t('settings.canaryNeverRedeployed');
  const redeployInProgress =
    status.redeploy?.state === 'requested' ||
    status.redeploy?.state === 'running';
  const description = t('settings.canaryDescription', {
    running: shortSha(status.runningSha),
    remote: shortSha(status.remoteSha),
    outcome,
  });

  return (
    <>
      <SettingRow
        title={t('settings.canaryRedeploy')}
        description={description}
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => void check(true)}
            disabled={checking || requesting}
          >
            {checking
              ? t('settings.canaryChecking')
              : t('settings.canaryCheck')}
          </Button>
          <Button
            variant="outline"
            tone="warning"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={checking || requesting || redeployInProgress}
          >
            {t('settings.canaryRedeployAction')}
          </Button>
        </div>
      </SettingRow>
      <Modal
        isOpen={confirming}
        onClose={() => {
          if (!requesting) setConfirming(false);
        }}
        title={t('settings.canaryConfirmTitle')}
        description={t('settings.canaryConfirmDescription')}
        initialFocusRef={confirmRef}
        closeOnBackdropClick={!requesting}
        closeOnEscape={!requesting}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={requesting}
            >
              {t('settings.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="solid"
              tone="warning"
              size="sm"
              onClick={() => void redeploy()}
              disabled={requesting}
            >
              {requesting
                ? t('settings.canaryStarting')
                : t('settings.canaryConfirmAction')}
            </Button>
          </>
        }
      />
    </>
  );
}
