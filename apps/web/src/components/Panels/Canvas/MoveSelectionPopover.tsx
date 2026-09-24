// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/_client';
import { listCanvases, moveCanvasSelection } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { MoveSelectionPanel } from './MoveSelectionPanel';

import type { SelectOption } from '@/components/Common/Select';
import type { MoveSelectionBody, MoveSelectionErrorCode } from '@huabu/shared';

const MOVE_ERROR_MESSAGES = {
  MOVE_SOURCE_STALE: 'moveSelection.errors.sourceStale',
  MOVE_SOURCE_NODE_MISSING: 'moveSelection.errors.sourceNodeMissing',
  MOVE_NODE_NOT_MOVABLE: 'moveSelection.errors.nodeNotMovable',
  MOVE_DESTINATION_MISSING: 'moveSelection.errors.destinationMissing',
  MOVE_DESTINATION_SAME_AS_SOURCE: 'moveSelection.errors.sameDestination',
  MOVE_DESTINATION_CREATE_FAILED:
    'moveSelection.errors.destinationCreateFailed',
  MOVE_DESTINATION_CLEANUP_FAILED: 'moveSelection.errors.reconcile',
  MOVE_WORLD_NOT_ALLOWED: 'moveSelection.errors.worldNotAllowed',
  MOVE_AGENT_RUNNING: 'moveSelection.errors.agentRunning',
  MOVE_AGENT_TASK_OWNED: 'moveSelection.errors.agentTaskOwned',
  MOVE_AGENT_PENDING_CHANGES: 'moveSelection.errors.agentPendingChanges',
  MOVE_AGENT_HISTORY_INVALID: 'moveSelection.errors.agentHistoryInvalid',
  MOVE_AGENT_CLOSE_FAILED: 'moveSelection.errors.agentCloseFailed',
  MOVE_AGENT_REHOME_FAILED: 'moveSelection.errors.agentRehomeFailed',
  MOVE_ARTIFACT_MISSING: 'moveSelection.errors.artifactMissing',
  MOVE_DESTINATION_CONFLICT: 'moveSelection.errors.destinationConflict',
  MOVE_COMPENSATION_FAILED: 'moveSelection.errors.reconcile',
  MOVE_OUTCOME_UNKNOWN: 'moveSelection.errors.reconcile',
  MOVE_FAILED: 'moveSelection.failed',
} as const satisfies Record<MoveSelectionErrorCode, string>;

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
  const [options, setOptions] = useState<SelectOption<string>[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(true);

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
        const next = canvases
          .filter((canvas) => canvas.canvasId !== canvasId)
          .map((canvas) => ({
            value: canvas.canvasId,
            label: canvas.title || t('moveSelection.untitledSpace'),
          }));
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
  }, [canvasId, t]);

  const close = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [setOpen, submitting]);

  const submit = async (
    destination: MoveSelectionBody['destination'],
    createSourcePreview: boolean,
  ) => {
    setSubmitting(true);
    let moveRequested = false;
    try {
      await drainPendingSaves();
      if (
        useCanvasStore.getState().canvasId !== canvasId ||
        useWorkspaceStore.getState().workspaceId !== workspaceId
      ) {
        toast(t('moveSelection.errors.sourceStale'), {
          tone: 'danger',
          duration: 0,
        });
        return;
      }
      const expectedSourceVersion = useCanvasStore.getState().version;
      moveRequested = true;
      const result = await moveCanvasSelection(canvasId, {
        selectedNodeIds,
        destination,
        createSourcePreview,
        expectedSourceVersion,
      });
      if (useWorkspaceStore.getState().workspaceId === workspaceId) {
        useWorkspaceStore
          .getState()
          .setSpaceTitle(result.destination.canvasId, result.destination.title);
        void useWorkspaceStore
          .getState()
          .refreshSpaceTitles([canvasId, result.destination.canvasId]);
      }
      if (mounted.current) setOpen(false);
      toast(
        t('moveSelection.success', {
          count: result.movedNodeCount,
          conversations: result.movedConversationCount,
        }),
        {
          tone: 'success',
          action: {
            label: t('moveSelection.openDestination'),
            onClick: () => navigate(`/canvas/${result.destination.canvasId}`),
          },
        },
      );
    } catch (error) {
      const code =
        moveRequested && error instanceof ApiError ? error.code : undefined;
      const messageKey =
        typeof code === 'string' &&
        Object.prototype.hasOwnProperty.call(MOVE_ERROR_MESSAGES, code)
          ? MOVE_ERROR_MESSAGES[code as MoveSelectionErrorCode]
          : 'moveSelection.failed';
      toast(t(messageKey), { tone: 'danger', duration: 0 });
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <MoveSelectionPanel
      reference={reference}
      boundary={boundary}
      count={selectedNodeIds.length}
      includesFrames={selection.some((node) => node.type === 'frame')}
      options={options}
      loading={loading}
      loadError={loadError}
      submitting={submitting}
      onClose={close}
      onSubmit={(destination, preview) => void submit(destination, preview)}
    />
  );
}
