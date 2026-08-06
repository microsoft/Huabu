// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Inline amber banner shown only when the embedded agentlet daemon is in
 * a known-failed state. Extracted from the old `AcpSettings` so the
 * unified External Agents tab can reuse it. The happy path (`online:
 * true`, no error) renders nothing so the section stays compact.
 */

import { AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { AcpAgentletStatus } from '@huabu/shared';

interface AgentletHealthBannerProps {
  agentlet: AcpAgentletStatus | null;
  onRestart: () => Promise<void>;
  restarting: boolean;
}

export const AgentletHealthBanner: React.FC<AgentletHealthBannerProps> = ({
  agentlet,
  onRestart,
  restarting,
}) => {
  const { t } = useTranslation();
  if (!agentlet) return null;
  if (agentlet.online && !agentlet.lastError) return null;

  const nextRestartInSec = agentlet.nextRestartAt
    ? Math.max(0, Math.ceil((agentlet.nextRestartAt - Date.now()) / 1000))
    : null;

  const copyErrorMessage = () => {
    if (!agentlet.lastError) return;
    void copyToClipboard(agentlet.lastError).then(() => {
      toast(t('settings.errorMessageCopied'), { tone: 'success' });
    });
  };

  return (
    <div className="border-warning-light/60 bg-warning-light/15 mb-3 flex items-start gap-2 rounded-md border px-3 py-2">
      <AlertTriangle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-xs font-medium">
          {t('settings.workerOffline')}
        </p>
        {agentlet.lastError && (
          <Tooltip
            content={agentlet.lastError}
            wrapperClassName="mt-0.5 flex min-w-0 max-w-full"
            contentClassName="max-w-lg whitespace-pre-wrap wrap-break-word"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={copyErrorMessage}
              aria-label={t('settings.copyErrorMessage')}
              className="text-fg-muted max-w-full min-w-0 justify-start gap-1 px-0 py-0 text-left text-[11px] leading-snug"
            >
              <span className="truncate">{agentlet.lastError}</span>
              <Copy className="shrink-0" aria-hidden />
            </Button>
          </Tooltip>
        )}
        {nextRestartInSec !== null && nextRestartInSec > 0 && (
          <p className="text-fg-subtle mt-0.5 text-[11px] leading-snug">
            {t('settings.nextAutoRetry', { seconds: nextRestartInSec })}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        tone="info"
        size="sm"
        onClick={() => void onRestart()}
        disabled={restarting}
        title={t('settings.forceRestartWorker')}
        className="shrink-0"
      >
        <RefreshCw
          size={12}
          className={restarting ? 'animate-spin' : undefined}
        />
        <span>
          {restarting ? t('settings.restarting') : t('settings.restartWorker')}
        </span>
      </Button>
    </div>
  );
};
