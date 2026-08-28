// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { FileWarning, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../Common/Button';

interface MissingNodesSummaryProps {
  count: number;
  isActive: boolean;
  isDisabled: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export const MissingNodesSummary = ({
  count,
  isActive,
  isDisabled,
  onToggle,
  onClear,
}: MissingNodesSummaryProps) => {
  const { t } = useTranslation();
  const toggleTitle = isDisabled
    ? t('layers.clearSearchBeforeMissingFilter')
    : isActive
      ? t('layers.showAllNodes')
      : t('layers.showMissingNodesOnly');

  return (
    <div
      className={clsx(
        'border-warning-light bg-surface flex shrink-0 items-center border-b px-1.5 py-1',
        isActive && 'bg-warning-bg',
      )}
    >
      <Button
        variant="ghost"
        tone="warning"
        size="sm"
        onClick={onToggle}
        disabled={isDisabled}
        title={toggleTitle}
        aria-pressed={isActive}
        tooltipWrapperClassName="min-w-0 flex-1"
        className="w-full min-w-0 justify-start px-1.5!"
      >
        <FileWarning />
        <span className="truncate">
          {t('layers.missingNodesCount', { count })}
        </span>
      </Button>
      {isActive && (
        <Button
          variant="ghost"
          tone="warning"
          iconOnly
          size="sm"
          onClick={onClear}
          title={t('layers.clearMissingFilter')}
          className="p-1!"
        >
          <X />
        </Button>
      )}
    </div>
  );
};
