// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { getDescendantIds } from '@huabu/shared/canvas-engine';

import { listCanvases } from '@/api/canvas';
import { moveNodesToSpace } from '@/components/Space/moveNodesToSpace';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

import {
  MoveSelectionPanel,
  type MoveDestinationOption,
} from './MoveSelectionPanel';

export function MoveSelectionPopover() {
  const isOpen = useCanvasStore((state) => state.moveSelectionDialogOpen);
  return isOpen ? <MoveSelectionContent /> : null;
}

function MoveSelectionContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setOpen = useCanvasStore((state) => state.setMoveSelectionDialogOpen);
  const reference = useCanvasStore((state) => state.moveSelectionAnchor);
  const boundary = useCanvasStore((state) => state.canvasWrapper);
  const currentCanvasId = useCanvasStore((state) => state.canvasId);
  const [canvasId] = useState(currentCanvasId);
  const currentWorkspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [workspaceId] = useState(currentWorkspaceId);
  const [selection] = useState(() =>
    useCanvasStore.getState().nodes.filter((node) => node.selected),
  );
  const selectedNodeIds = selection.map((node) => node.id);
  const [movedIds] = useState(() => {
    const ids = new Set(selection.map((node) => node.id));
    for (const node of selection) {
      if (node.type === 'frame') {
        for (const id of getDescendantIds(
          useCanvasStore.getState().nodes,
          node.id,
        ))
          ids.add(id);
      }
    }
    return ids;
  });
  const [boundaryEdgeCount] = useState(
    () =>
      useCanvasStore
        .getState()
        .edges.filter(
          (edge) => movedIds.has(edge.source) !== movedIds.has(edge.target),
        ).length,
  );
  const selectionIds = useMemo(
    () => new Set(selection.map((node) => node.id)),
    [selection],
  );
  const selectionMatches = useCanvasStore((state) => {
    const selected = state.nodes.filter((node) => node.selected);
    return (
      selected.length === selectionIds.size &&
      selected.every((node) => selectionIds.has(node.id))
    );
  });
  const [options, setOptions] = useState<MoveDestinationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (currentCanvasId !== canvasId || currentWorkspaceId !== workspaceId)
      setOpen(false);
  }, [canvasId, currentCanvasId, currentWorkspaceId, setOpen, workspaceId]);

  useEffect(() => {
    if (!submitting && !selectionMatches) setOpen(false);
  }, [selectionMatches, setOpen, submitting]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void listCanvases()
      .then(({ canvases }) => {
        if (!active) return;
        const titles = Object.fromEntries(
          canvases.map((canvas) => [canvas.canvasId, canvas]),
        );
        const movedChildren = new Set(
          canvases
            .filter(
              (canvas) =>
                canvas.parentSpaceId === canvasId &&
                canvas.parentEntryNodeId &&
                movedIds.has(canvas.parentEntryNodeId),
            )
            .map((canvas) => canvas.canvasId),
        );
        const next = canvases
          .filter(
            (canvas) =>
              canvas.canvasId !== useWorkspaceStore.getState().worldCanvasId,
          )
          .map((canvas) => {
            const ancestors = spaceAncestorIds(canvas.canvasId, titles);
            const disabledReason =
              canvas.canvasId === canvasId
                ? t('moveSelection.currentSpace')
                : ancestors.some((id) => movedChildren.has(id))
                  ? t('moveSelection.errors.hierarchyCycle')
                  : undefined;
            return {
              value: canvas.canvasId,
              parentValue: canvas.parentSpaceId,
              label: canvas.title || t('moveSelection.untitledSpace'),
              disabled: !!disabledReason,
              disabledReason,
              description: ancestors
                .slice(0, -1)
                .map(
                  (id) => titles[id]?.title || t('moveSelection.untitledSpace'),
                )
                .join(' / '),
            };
          });
        setOptions(next);
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
  }, [canvasId, movedIds, t]);

  const close = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [setOpen, submitting]);

  const submit = async (destinationId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const moved = await moveNodesToSpace(
        canvasId,
        selectedNodeIds,
        {
          kind: 'existing',
          canvasId: destinationId,
        },
        navigate,
      );
      if (moved && mounted.current) setOpen(false);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <MoveSelectionPanel
      reference={reference}
      boundary={boundary}
      count={selectedNodeIds.length}
      currentSpaceId={canvasId}
      boundaryEdgeCount={boundaryEdgeCount}
      includesFrames={selection.some((node) => node.type === 'frame')}
      options={options}
      loading={loading}
      loadError={loadError}
      submitting={submitting}
      onClose={close}
      onSubmit={(destinationId) => void submit(destinationId)}
    />
  );
}
