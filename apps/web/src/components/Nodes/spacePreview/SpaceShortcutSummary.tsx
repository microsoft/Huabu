// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/Common/Tooltip';
import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const getNow = () => now;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function SpaceShortcutSummary({
  nodeCount,
  updatedAt,
}: {
  nodeCount?: number;
  updatedAt?: number;
}) {
  const { t, i18n } = useTranslation();
  const currentTime = useSyncExternalStore(subscribe, getNow, getNow);
  const count =
    nodeCount === undefined
      ? ''
      : t('spacePreview.nodeCount', { count: nodeCount });
  const date = updatedAt && updatedAt > 0 ? new Date(updatedAt) : null;
  const elapsed = date ? Math.max(0, currentTime - date.getTime()) : 0;
  const unit =
    elapsed < 3_600_000 ? 'minute' : elapsed < 86_400_000 ? 'hour' : 'day';
  const divisor =
    unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  const relative = date
    ? elapsed < 60_000
      ? t('spacePreview.updatedNow')
      : t('spacePreview.updatedRelative', {
          time: new Intl.RelativeTimeFormat(i18n.language, {
            numeric: 'always',
          }).format(-Math.floor(elapsed / divisor), unit),
        })
    : '';
  const text = [count, relative].filter(Boolean).join(' · ');
  const detail = [
    count,
    date
      ? t('spacePreview.updatedRelative', {
          time: date.toLocaleString(i18n.language),
        })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (!text) return null;
  return (
    <Tooltip content={detail} wrapperClassName="block min-w-0">
      <span
        className="text-fg-muted block truncate"
        data-space-shortcut-summary
        aria-label={detail}
        style={{
          fontSize: NODE_TYPOGRAPHY.metadata.size,
          lineHeight: NODE_TYPOGRAPHY.metadata.lineHeight,
          fontWeight: 400,
        }}
      >
        {text}
      </span>
    </Tooltip>
  );
}
