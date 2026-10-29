// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

import { SpacePicker } from './SpacePicker';
import { useSpaceParentMove } from './useSpaceParentMove';

export function SpaceOrganizationPopover({
  canvasId,
  reference,
  onClose,
}: {
  canvasId: string;
  reference: HTMLElement | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { move, busy, error, canMove } = useSpaceParentMove();
  const liveWorkspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [workspaceId] = useState(liveWorkspaceId);
  const titles = useWorkspaceStore((state) => state.spaceTitles);
  const summaries = useWorkspaceStore((state) => state.spaceSummaries);
  const metadataStatus = useWorkspaceStore((state) => state.spaceTitlesStatus);
  const metadataError = useWorkspaceStore((state) => state.spaceTitlesError);
  const refresh = useWorkspaceStore((state) => state.refreshSpaceTitles);
  const summary = summaries[canvasId];
  const expectedParent = summary?.parentSpaceId ?? null;
  const missingMetadata = metadataStatus === 'ready' && !canMove(canvasId);
  const feedback =
    error ||
    metadataError ||
    (missingMetadata ? t('spacePreview.missingTarget') : null);
  const name = titles[canvasId] || t('canvasList.untitled');
  const options = Object.keys(titles)
    .filter(
      (id) =>
        canMove(id) && !spaceAncestorIds(id, summaries).includes(canvasId),
    )
    .map((id) => ({
      value: id,
      label: titles[id] || t('canvasList.untitled'),
      parentValue: summaries[id]?.parentSpaceId,
      description: spaceAncestorIds(id, summaries)
        .slice(0, -1)
        .map((ancestor) => titles[ancestor] || t('canvasList.untitled'))
        .join(' / '),
      disabled: id === expectedParent,
      disabledReason:
        id === expectedParent ? t('spaceHierarchy.currentLocation') : undefined,
    }));
  const ready = canMove(canvasId);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (liveWorkspaceId !== workspaceId) onClose();
  }, [liveWorkspaceId, workspaceId, onClose]);

  const submit = async (parent: string) => {
    if (
      !ready ||
      busy ||
      !options.some((option) => option.value === parent && !option.disabled)
    )
      return;
    if (await move(canvasId, parent, expectedParent)) onClose();
  };

  return (
    <SpacePicker
      reference={reference}
      title={t('spaceHierarchy.moveTitle', { name })}
      onClose={() => {
        if (!busy) onClose();
      }}
      searchLabel={t('moveSelection.search')}
      loadingLabel={
        busy ? t('spaceHierarchy.moving') : t('spacePreview.loadingTargets')
      }
      errorLabel={feedback || t('spacePreview.targetsUnavailable')}
      emptyLabel={t('spacePreview.noTargets')}
      currentSpaceId={expectedParent ?? undefined}
      selectedValue={expectedParent ?? undefined}
      options={options}
      loading={!ready && !metadataError && !missingMetadata}
      loadError={!!metadataError || missingMetadata}
      submitting={busy}
      onSubmit={(parent) => void submit(parent)}
      footer={
        error || metadataError || missingMetadata ? (
          <>
            {error && (
              <p role="alert" className="text-danger-fg">
                {error}
              </p>
            )}
            {(metadataError || missingMetadata) && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {t('spacePreview.retry')}
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
