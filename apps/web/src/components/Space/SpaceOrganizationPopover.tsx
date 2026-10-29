// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { revealNodesOnCanvas } from '@/utils/canvasViewport';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

import { getSpaceEntryPosition } from './spaceEntryPlacement';
import { SpacePicker } from './SpacePicker';
import { useSpaceParentMove } from './useSpaceParentMove';

export function SpaceOrganizationPopover({
  canvasId,
  reference,
  onClose,
  mode = 'destination',
}: {
  canvasId: string;
  reference: HTMLElement | null;
  onClose: () => void;
  mode?: 'destination' | 'source';
}) {
  const { t } = useTranslation();
  const { move, busy, error, canMove, hasMetadata } =
    useSpaceParentMove('inline');
  const liveWorkspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [workspaceId] = useState(liveWorkspaceId);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
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
        hasMetadata(id) &&
        (mode === 'source'
          ? !spaceAncestorIds(canvasId, summaries).includes(id)
          : !spaceAncestorIds(id, summaries).includes(canvasId)),
    )
    .map((id) => ({
      value: id,
      label: titles[id] || t('canvasList.untitled'),
      parentValue: summaries[id]?.parentSpaceId,
      description: spaceAncestorIds(id, summaries)
        .slice(0, -1)
        .map((ancestor) => titles[ancestor] || t('canvasList.untitled'))
        .join(' / '),
      disabled:
        mode === 'source'
          ? summaries[id]?.parentSpaceId === canvasId
          : id === expectedParent,
      disabledReason:
        mode === 'source'
          ? summaries[id]?.parentSpaceId === canvasId
            ? t('spaceHierarchy.alreadyChild')
            : undefined
          : id === expectedParent
            ? t('spaceHierarchy.currentLocation')
            : undefined,
    }));
  const ready = canMove(canvasId);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (liveWorkspaceId !== workspaceId) onClose();
  }, [liveWorkspaceId, workspaceId, onClose]);
  useEffect(() => {
    if (mode !== 'source') return;
    let finished = false;
    const update = () => {
      if (finished) return;
      const state = useCanvasStore.getState();
      if (
        state.canvasId !== canvasId ||
        useWorkspaceStore.getState().workspaceId !== workspaceId
      ) {
        finished = true;
        onClose();
        return;
      }
      if (
        !pendingEntryId ||
        !state.nodes.some((node) => node.id === pendingEntryId)
      )
        return;
      finished = true;
      setPendingEntryId(null);
      state.selectNodes([pendingEntryId]);
      if (state.rfInstance && state.canvasWrapper)
        revealNodesOnCanvas(state.rfInstance, state.canvasWrapper, [
          pendingEntryId,
        ]);
      onClose();
      reference?.focus({ preventScroll: true });
    };
    update();
    return useCanvasStore.subscribe((state, previous) => {
      if (
        state.canvasId !== previous.canvasId ||
        state.nodes !== previous.nodes
      )
        update();
    });
  }, [canvasId, mode, onClose, pendingEntryId, reference, workspaceId]);

  const submit = async (parent: string) => {
    if (
      !ready ||
      busy ||
      pendingEntryId ||
      !options.some((option) => option.value === parent && !option.disabled)
    )
      return;
    if (mode === 'source') {
      const result = await move(
        parent,
        canvasId,
        summaries[parent]?.parentSpaceId ?? null,
        getSpaceEntryPosition,
      );
      if (result) setPendingEntryId(result.parentEntryNodeId);
    } else if (await move(canvasId, parent, expectedParent)) onClose();
  };

  return (
    <SpacePicker
      reference={reference}
      title={
        mode === 'source'
          ? t('spaceHierarchy.bring')
          : t('spaceHierarchy.moveTitle', { name })
      }
      placement={mode === 'source' ? 'top-start' : 'bottom-start'}
      onClose={() => {
        if (!busy) onClose();
      }}
      searchLabel={t(
        mode === 'source'
          ? 'spaceHierarchy.searchPlaceholder'
          : 'moveSelection.search',
      )}
      loadingLabel={
        busy || pendingEntryId
          ? t('spaceHierarchy.moving')
          : t('spacePreview.loadingTargets')
      }
      errorLabel={feedback || t('spacePreview.targetsUnavailable')}
      emptyLabel={t('spacePreview.noTargets')}
      currentSpaceId={
        mode === 'source' ? canvasId : (expectedParent ?? undefined)
      }
      selectedValue={
        mode === 'source' ? undefined : (expectedParent ?? undefined)
      }
      options={options}
      loading={
        !!pendingEntryId || (!ready && !metadataError && !missingMetadata)
      }
      loadError={!!metadataError || missingMetadata}
      submitting={busy}
      onSubmit={(parent) => void submit(parent)}
      footer={
        error || metadataError || missingMetadata ? (
          <>
            {error && !metadataError && !missingMetadata && (
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
