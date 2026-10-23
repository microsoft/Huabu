// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/Common/Tooltip';
import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';

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

export function NodeActivityTime({
  updatedAt,
  kind = 'space',
  scale = 1,
}: {
  updatedAt?: number;
  kind?: 'space' | 'conversation';
  scale?: number;
}) {
  const { t, i18n } = useTranslation();
  const currentTime = useSyncExternalStore(subscribe, getNow, getNow);
  const date =
    updatedAt && updatedAt > 0 && Number.isFinite(new Date(updatedAt).getTime())
      ? new Date(updatedAt)
      : null;
  const elapsed = date ? Math.max(0, currentTime - date.getTime()) : 0;
  const unit =
    elapsed < 3_600_000 ? 'minute' : elapsed < 86_400_000 ? 'hour' : 'day';
  const divisor =
    unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  const relative = date
    ? elapsed < 60_000
      ? t('spacePreview.timeNow')
      : new Intl.RelativeTimeFormat(i18n.language, {
          numeric: 'always',
          style: 'narrow',
        }).format(-Math.floor(elapsed / divisor), unit)
    : '';
  const text = relative;
  const detail = [
    date
      ? t(
          kind === 'space'
            ? 'spacePreview.updatedRelative'
            : 'node.questionCard.lastActivity',
          {
            time: date.toLocaleString(i18n.language),
          },
        )
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (!text) return null;
  return (
    <Tooltip
      content={detail}
      wrapperClassName="ml-auto block min-w-0 max-w-[50%] shrink-0 self-center"
    >
      <span
        className="text-fg-muted block truncate text-right font-normal"
        data-space-shortcut-summary={kind === 'space' ? '' : undefined}
        data-conversation-activity-time={
          kind === 'conversation' ? '' : undefined
        }
        aria-label={detail}
        style={{
          fontSize: SPACE_CARD_TYPOGRAPHY.metadata.size * scale,
          lineHeight: SPACE_CARD_TYPOGRAPHY.metadata.lineHeight,
        }}
      >
        {text}
      </span>
    </Tooltip>
  );
}
