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
    iconColor: 'text-info-light',
    textColor: 'text-info',
    retryHoverBg: 'enabled:hover:bg-info-bg-hover',
  },
  error: {
    icon: XCircle,
    labelKey: 'messages.somethingWentWrong',
    bg: 'bg-danger-bg',
    iconColor: 'text-danger-light',
    textColor: 'text-danger',
    retryHoverBg: 'enabled:hover:bg-danger-bg-hover',
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
        className={`my-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs ${config.bg}`}
      >
        <Icon size={12} className={config.iconColor} />
        <span className={`min-w-0 flex-1 break-words ${config.textColor}`}>
          {detail || t(config.labelKey)}
        </span>
        {onRetry && (
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onRetry}
            className={`${config.textColor} ${config.retryHoverBg}`}
            title={t('messages.retry')}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
    </div>
  );
};
