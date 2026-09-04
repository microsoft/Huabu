// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { BookOpen, MessageSquareQuote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SpaceInstructionFrameKind } from '@huabu/shared';

export function InstructionFrameBadge({
  kind,
}: {
  kind: SpaceInstructionFrameKind;
}) {
  const { t } = useTranslation();
  const isPrompt = kind === 'prompt';

  return (
    <span
      className={clsx(
        'text-fg-inverse inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] leading-none font-semibold shadow-sm',
        isPrompt ? 'bg-info' : 'bg-success',
      )}
      title={t(
        isPrompt
          ? 'node.promptFrameBadgeDescription'
          : 'node.skillFrameBadgeDescription',
      )}
    >
      {isPrompt ? (
        <MessageSquareQuote aria-hidden="true" className="size-2.5" />
      ) : (
        <BookOpen aria-hidden="true" className="size-2.5" />
      )}
      {t(isPrompt ? 'node.promptFrameBadge' : 'node.skillFrameBadge')}
    </span>
  );
}
