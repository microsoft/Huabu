// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { SpacePicker } from '@/components/Space/SpacePicker';

import type { ComponentProps } from 'react';

export type { SpacePickerOption as MoveDestinationOption } from '@/components/Space/SpacePicker';

type MoveSelectionPanelProps = Omit<
  ComponentProps<typeof SpacePicker>,
  | 'title'
  | 'searchLabel'
  | 'footer'
  | 'loadingLabel'
  | 'errorLabel'
  | 'emptyLabel'
> & {
  count: number;
  includesFrames: boolean;
  boundaryEdgeCount?: number;
};

export function MoveSelectionPanel({
  count,
  includesFrames,
  boundaryEdgeCount = 0,
  ...props
}: MoveSelectionPanelProps) {
  const { t } = useTranslation();
  return (
    <SpacePicker
      {...props}
      title={t('moveSelection.title')}
      searchLabel={t('moveSelection.search')}
      loadingLabel={t(
        props.submitting
          ? 'moveSelection.moving'
          : 'moveSelection.loadingTargets',
      )}
      errorLabel={t('moveSelection.targetsUnavailable')}
      emptyLabel={t('moveSelection.noTargets')}
      footer={
        <>
          {t('moveSelection.description', { count })}
          {includesFrames && ` · ${t('moveSelection.frameNotice')}`}
          {boundaryEdgeCount > 0 && (
            <p className="text-warning-fg mt-1">
              {t('moveSelection.boundaryNotice')}
            </p>
          )}
        </>
      }
    />
  );
}
