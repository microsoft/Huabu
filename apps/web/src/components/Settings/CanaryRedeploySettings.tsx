// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  checkCanaryRedeploy,
  getCanaryRedeployStatus,
  requestCanaryRedeploy,
  updateCanaryRedeployConfig,
} from '@/api/deployment';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

import type { CanaryRedeployStatusResponse } from '@huabu/shared';

function shortSha(sha: string | null): string {
  return sha?.slice(0, 7) ?? 'unknown';
}

export function CanaryRedeploySettings() {
  const { t } = useTranslation();
  const branchInputId = useId();
  const [status, setStatus] = useState<CanaryRedeployStatusResponse | null>(
    null,
  );
  const [branchDraft, setBranchDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
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
              ? t('settings.canaryUpdateAvailable', { branch: next.branch })
              : t('settings.canaryUpToDate', { branch: next.branch }),
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
        setBranchDraft(initial.configuredBranch ?? '');
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

  const saveBranch = useCallback(async () => {
    setSaving(true);
    try {
      const next = await updateCanaryRedeployConfig({
        branch: branchDraft.trim() || null,
      });
      setStatus(next);
      setBranchDraft(next.configuredBranch ?? '');
      toast(t('settings.canaryBranchSaved', { branch: next.branch }), {
        tone: 'success',
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.canaryBranchSaveFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  }, [branchDraft, t]);

  const redeploy = useCallback(async () => {
    if (!status) return;
    setRequesting(true);
    try {
      const next = await requestCanaryRedeploy(status.branch);
      setStatus(next);
      setConfirming(false);
      toast(t('settings.canaryRedeployStarted', { branch: next.branch }), {
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
  }, [status, t]);

  if (loading || !status?.available) return null;

  const outcome = status.redeploy
    ? t(`settings.canaryState_${status.redeploy.state}`)
    : t('settings.canaryNeverRedeployed');
  const redeployInProgress =
    status.redeploy?.state === 'requested' ||
    status.redeploy?.state === 'running';
  const busy = checking || saving || requesting || redeployInProgress;
  const description = t('settings.canaryDescription', {
    branch: status.branch,
    running: shortSha(status.runningSha),
    remote: shortSha(status.remoteSha),
    redeployBranch: status.redeploy?.branch ?? status.branch,
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
            disabled={busy}
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
            disabled={busy}
          >
            {t('settings.canaryRedeployAction', { branch: status.branch })}
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        title={t('settings.canaryBranch')}
        description={t('settings.canaryBranchDescription')}
        labelFor={branchInputId}
        density="compact"
      >
        <div className="flex items-center gap-2">
          <TextInput
            id={branchInputId}
            mono
            className="w-40"
            value={branchDraft}
            placeholder="alpha"
            disabled={busy}
            onChange={(event) => setBranchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void saveBranch();
            }}
          />
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => void saveBranch()}
            disabled={busy}
          >
            {saving
              ? t('settings.canaryBranchSaving')
              : t('settings.canaryBranchSave')}
          </Button>
        </div>
      </SettingRow>
      <Modal
        isOpen={confirming}
        onClose={() => {
          if (!requesting) setConfirming(false);
        }}
        title={t('settings.canaryConfirmTitle', { branch: status.branch })}
        description={t('settings.canaryConfirmDescription', {
          branch: status.branch,
        })}
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
                : t('settings.canaryConfirmAction', {
                    branch: status.branch,
                  })}
            </Button>
          </>
        }
      />
    </>
  );
}
