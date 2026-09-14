// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { BookOpen, MessageSquareQuote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SpaceInstructionFrameKind } from '@huabu/shared';

export function InstructionFrameBadge({
  kind,
  directAgentCount = 0,
}: {
  kind: SpaceInstructionFrameKind;
  directAgentCount?: number;
}) {
  const { t } = useTranslation();
  const isPrompt = kind === 'prompt';
  const label = isPrompt
    ? directAgentCount > 0
      ? t('node.promptFrameBadgeConnected', { count: directAgentCount })
      : t('node.promptFrameBadgeGlobal')
    : t('node.skillFrameBadge');
  const title = isPrompt
    ? directAgentCount > 0
      ? t('node.promptFrameBadgeConnectedDescription', {
          count: directAgentCount,
        })
      : t('node.promptFrameBadgeGlobalDescription')
    : t('node.skillFrameBadgeDescription');

  return (
    <span
      className={clsx(
        'text-fg-inverse inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] leading-none font-semibold shadow-sm',
        isPrompt ? 'bg-info' : 'bg-success',
      )}
      title={title}
    >
      {isPrompt ? (
        <MessageSquareQuote aria-hidden="true" className="size-2.5" />
      ) : (
        <BookOpen aria-hidden="true" className="size-2.5" />
      )}
      {label}
    </span>
  );
}
