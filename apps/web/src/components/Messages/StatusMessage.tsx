// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { BadgeInfo, RefreshCw, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../Common/Button';

type StatusType = 'interrupted' | 'error';

interface StatusMessageProps {
  status: StatusType;
  detail?: string;
  onRetry?: () => void;
}

const STATUS_CONFIG: Record<
  StatusType,
  {
    icon: typeof XCircle;
    labelKey: 'messages.generationInterrupted' | 'messages.somethingWentWrong';
    bg: string;
    iconColor: string;
    textColor: string;
    retryHoverBg: string;
  }
> = {
  interrupted: {
    icon: BadgeInfo,
    labelKey: 'messages.generationInterrupted',
    bg: 'bg-info-bg',
    iconColor: 'text-info-fg',
    textColor: 'text-fg-default',
    retryHoverBg: 'enabled:hover:bg-info-bg-hover',
  },
  error: {
    icon: XCircle,
    labelKey: 'messages.somethingWentWrong',
    bg: 'bg-danger-bg',
    iconColor: 'text-danger-fg',
    textColor: 'text-danger-fg',
    retryHoverBg: 'enabled:hover:bg-hover',
  },
};

export const StatusMessage = ({
  status,
  detail,
  onRetry,
}: StatusMessageProps) => {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <div className="flex justify-start">
      <div
        className={`my-2 flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-xs leading-5 ${config.bg}`}
      >
        <Icon size={16} className={`mt-0.5 shrink-0 ${config.iconColor}`} />
        <span className={`min-w-0 flex-1 wrap-anywhere ${config.textColor}`}>
          {detail || t(config.labelKey)}
        </span>
        {onRetry && (
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onRetry}
            className={`shrink-0 ${config.textColor} ${config.retryHoverBg}`}
            title={t('messages.retry')}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
    </div>
  );
};
