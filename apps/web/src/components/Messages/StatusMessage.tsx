import { BadgeInfo, RefreshCw, XCircle } from 'lucide-react';

import { IconButton } from '../Common/IconButton';

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
    label: string;
    bg: string;
    iconColor: string;
    textColor: string;
    retryHoverBg: string;
  }
> = {
  interrupted: {
    icon: BadgeInfo,
    label: 'Generation interrupted',
    bg: 'bg-info-bg',
    iconColor: 'text-info-light',
    textColor: 'text-info',
    retryHoverBg: 'enabled:hover:bg-info-bg-hover',
  },
  error: {
    icon: XCircle,
    label: 'Something went wrong',
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
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <div className="flex justify-start">
      <div
        className={`my-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs ${config.bg}`}
      >
        <Icon size={12} className={config.iconColor} />
        <span className={`min-w-0 flex-1 break-words ${config.textColor}`}>
          {detail || config.label}
        </span>
        {onRetry && (
          <IconButton
            onClick={onRetry}
            className={`${config.textColor} ${config.retryHoverBg}`}
            title="Retry"
            variant="ghost"
          >
            <RefreshCw size={12} />
          </IconButton>
        )}
      </div>
    </div>
  );
};
