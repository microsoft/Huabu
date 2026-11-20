// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresenceActivity } from './presencePaint';
import type { RemotePresencePage } from '@/store/canvasPresence/canvasPresenceStore';

/**
 * Text shown beside another page's marker: the person's name once pages
 * carry one, otherwise the page's device label, otherwise a generic name.
 */
export function usePresenceLabel(): (
  page: Pick<RemotePresencePage, 'label' | 'displayName'>,
  activity?: PresenceActivity,
) => string {
  const { t } = useTranslation();
  return useCallback(
    (page, activity) => {
      const label =
        page.displayName?.trim() ||
        page.label.trim() ||
        t('canvasPresence.anotherDevice');
      if (activity === 'editing') return t('canvasPresence.editing', { label });
      if (activity === 'dragging') return t('canvasPresence.moving', { label });
      return label;
    },
    [t],
  );
}
