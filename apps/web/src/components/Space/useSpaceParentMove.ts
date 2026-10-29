// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { setSpaceParent } from '@/api/spaceHierarchy';
import { toast } from '@/components/Common/Toast';
import { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pageLifecycle } from '@/utils/pageLifecycle';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

function hasMoveMetadata(
  state: Pick<
    ReturnType<typeof useWorkspaceStore.getState>,
    'spaceTitles' | 'spaceSummaries' | 'worldCanvasId'
  >,
  canvasId: string,
) {
  return (
    !!canvasId &&
    canvasId !== state.worldCanvasId &&
    spaceAncestorIds(canvasId, state.spaceSummaries).every(
      (id) =>
        Object.hasOwn(state.spaceTitles, id) && !!state.spaceSummaries[id],
    )
  );
}

function isMetadataReady(state: ReturnType<typeof useWorkspaceStore.getState>) {
  return (
    state.isReady && !state.isSyncing && state.spaceTitlesStatus === 'ready'
  );
}

export function useSpaceParentMove() {
  const { t } = useTranslation();
  const ready = useWorkspaceStore(isMetadataReady);
  const spaceTitles = useWorkspaceStore((state) => state.spaceTitles);
  const spaceSummaries = useWorkspaceStore((state) => state.spaceSummaries);
  const worldCanvasId = useWorkspaceStore((state) => state.worldCanvasId);
  const canMove = (canvasId: string) =>
    ready &&
    hasMoveMetadata({ spaceTitles, spaceSummaries, worldCanvasId }, canvasId);
  const active = useRef(false);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const move = async (
    canvasId: string,
    parentSpaceId: string | null,
    expectedParentSpaceId: string | null,
  ): Promise<boolean> => {
    if (submitting.current) return false;
    const state = useWorkspaceStore.getState();
    const {
      workspaceId,
      spaceTitles: titles,
      spaceSummaries: summaries,
    } = state;
    const isSameWorkspace = () =>
      useWorkspaceStore.getState().workspaceId === workspaceId &&
      !useWorkspaceStore.getState().isSyncing;
    const isCurrent = () => active.current && isSameWorkspace();
    const name = titles[canvasId] || t('canvasList.untitled');
    const destination = parentSpaceId
      ? spaceAncestorIds(parentSpaceId, summaries)
          .map((id) => titles[id] || t('canvasList.untitled'))
          .join(' / ')
      : t('spaceHierarchy.topLevel');
    const refreshIds = [
      ...new Set([
        canvasId,
        ...[parentSpaceId, expectedParentSpaceId].filter(
          (id): id is string => !!id,
        ),
      ]),
    ];
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const moved = await pageLifecycle.run('updating', async () => {
        const requireMetadata = () => {
          const current = useWorkspaceStore.getState();
          if (
            !isMetadataReady(current) ||
            !hasMoveMetadata(current, canvasId) ||
            (parentSpaceId !== null && !hasMoveMetadata(current, parentSpaceId))
          )
            throw new Error(t('spacePreview.targetsUnavailable'));
        };
        requireMetadata();
        await drainPendingSaves();
        if (!isCurrent()) return false;
        requireMetadata();
        try {
          await setSpaceParent(canvasId, {
            parentSpaceId,
            expectedParentSpaceId,
          });
        } finally {
          // A failed attachment may still change ownership or leave an entry.
          if (isSameWorkspace()) {
            window.dispatchEvent(new Event('canvas-list-changed'));
            await state.refreshSpaceTitles(refreshIds);
          }
        }
        return true;
      });
      if (!moved || !isCurrent()) return false;
      toast(t('spaceHierarchy.moved', { name, destination }), {
        tone: 'success',
      });
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : t('spaceHierarchy.failed');
      if (isSameWorkspace()) {
        toast(message, { tone: 'danger' });
        if (active.current) setError(message);
      }
      return false;
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { move, busy, error, canMove };
}
