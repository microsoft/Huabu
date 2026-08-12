// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, Copy, ExternalLink } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { copyToClipboard } from '@/utils/io/clipboard';

interface OAuthDeviceCodePromptProps {
  userCode: string;
  verificationUri: string | null;
  onCancel: () => void;
}

export const OAuthDeviceCodePrompt: React.FC<OAuthDeviceCodePromptProps> = ({
  userCode,
  verificationUri,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [codeCopied, setCodeCopied] = useState(false);

  const handleCopyCode = useCallback(async () => {
    await copyToClipboard(userCode);
    setCodeCopied(true);
  }, [userCode]);

  useEffect(() => {
    if (!codeCopied) return;
    const timer = setTimeout(() => setCodeCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [codeCopied]);

  const openVerificationPage = useCallback(() => {
    if (!verificationUri) return;
    window.open(verificationUri, '_blank', 'noopener');
  }, [verificationUri]);

  return (
    <div className="bg-info-bg flex flex-col gap-2.5 px-3 py-3">
      <p className="text-fg-default text-xs font-medium">
        {t('settings.enterCodeAtGitHub')}
      </p>
      <div className="flex items-center gap-2">
        <code className="bg-surface border-edge-default text-fg-default rounded-md border px-3 py-1.5 font-mono text-base font-semibold tracking-[0.25em] tabular-nums">
          {userCode}
        </code>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          tone={codeCopied ? 'success' : 'info'}
          title={codeCopied ? t('settings.copied') : t('settings.copyCode')}
          tooltipPlacement="bottom"
          onClick={() => void handleCopyCode()}
        >
          {codeCopied ? <Check /> : <Copy />}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          tone="info"
          size="sm"
          onClick={openVerificationPage}
          disabled={!verificationUri}
        >
          <ExternalLink />
          {t('settings.openGitHub')}
        </Button>
        <Button variant="ghost" tone="neutral" size="sm" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
      </div>
    </div>
  );
};
