// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listCanvases } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

import { SpacePicker, type SpacePickerOption } from './SpacePicker';

export function SpaceShortcutPicker({
  reference,
  onClose,
}: {
  reference: HTMLElement | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const worldId = useWorkspaceStore((state) => state.worldCanvasId);
  const addNodes = useCanvasStore((state) => state.addNodes);
  const [source] = useState({ canvasId, workspaceId });
  const [options, setOptions] = useState<SpacePickerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (canvasId !== source.canvasId || workspaceId !== source.workspaceId)
      onClose();
  }, [canvasId, workspaceId, source, onClose]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void listCanvases()
      .then(({ canvases }) => {
        if (!active) return;
        const summaries = Object.fromEntries(
          canvases.map((canvas) => [canvas.canvasId, canvas]),
        );
        setOptions(
          canvases
            .filter((canvas) => canvas.canvasId !== worldId)
            .map((canvas) => ({
              value: canvas.canvasId,
              label: canvas.title || t('spacePreview.untitledSpace'),
              parentValue: canvas.parentSpaceId,
              disabled: canvas.canvasId === source.canvasId,
              disabledReason:
                canvas.canvasId === source.canvasId
                  ? t('moveSelection.currentSpace')
                  : undefined,
              description: spaceAncestorIds(canvas.canvasId, summaries)
                .slice(0, -1)
                .map(
                  (id) =>
                    summaries[id]?.title || t('spacePreview.untitledSpace'),
                )
                .join(' / '),
            })),
        );
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [source, t, worldId]);

  return (
    <SpacePicker
      reference={reference}
      placement="top-start"
      title={t('spacePreview.chooseTarget')}
      searchLabel={t('spaceHierarchy.searchPlaceholder')}
      loadingLabel={t('spacePreview.loadingTargets')}
      errorLabel={t('spacePreview.targetsUnavailable')}
      emptyLabel={t('spacePreview.noTargets')}
      currentSpaceId={source.canvasId}
      options={options}
      loading={loading}
      loadError={loadError}
      onClose={onClose}
      onSubmit={(targetCanvasId) => {
        addNodes([
          {
            nodeType: 'spacePreview',
            data: { targetCanvasId, origin: { type: 'user-created' } },
          },
        ]);
        onClose();
        reference?.focus({ preventScroll: true });
      }}
    />
  );
}
