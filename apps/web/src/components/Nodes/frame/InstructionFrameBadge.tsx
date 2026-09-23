// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { FRAME_DESIGN_CONFIG } from './frameDesign';

import type { SpaceInstructionFrameKind } from '@huabu/shared';

export function InstructionFrameBadge({
  kind,
  directAgentCount = 0,
  titleFontSize,
}: {
  kind: SpaceInstructionFrameKind;
  directAgentCount?: number;
  titleFontSize: number;
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
  const config = FRAME_DESIGN_CONFIG.instructionBadge;
  const fontSize = Math.round(
    Math.min(
      config.maxFontSize,
      Math.max(config.minFontSize, titleFontSize * config.fontRatio),
    ),
  );
  const height = Math.round(fontSize * config.heightRatio);

  return (
    <span
      className={clsx(
        'text-fg-inverse pointer-events-auto inline-flex shrink-0 items-center rounded-full leading-none font-semibold shadow-sm',
        isPrompt ? 'bg-info' : 'bg-success',
      )}
      style={{
        height,
        paddingInline: Math.round(fontSize * config.paddingInlineRatio),
        fontSize,
      }}
      title={title}
    >
      {label}
    </span>
  );
}
