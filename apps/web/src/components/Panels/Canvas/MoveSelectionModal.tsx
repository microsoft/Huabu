// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/_client';
import { listCanvases, moveCanvasSelection } from '@/api/canvas';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { Select, type SelectOption } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import type { MoveSelectionErrorCode } from '@huabu/shared';

const NEW_SPACE_DESTINATION = '__new_space__';
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

export function MoveSelectionModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isOpen = useCanvasStore((state) => state.moveSelectionDialogOpen);
  const setOpen = useCanvasStore((state) => state.setMoveSelectionDialogOpen);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const nodes = useCanvasStore((state) => state.nodes);
  const [options, setOptions] = useState<SelectOption<string>[]>([]);
  const [destinationCanvasId, setDestinationCanvasId] = useState('');
  const [creatingNewSpace, setCreatingNewSpace] = useState(false);
  const [newSpaceTitle, setNewSpaceTitle] = useState('');
  const [createSourcePreview, setCreateSourcePreview] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  );
  const destinationOptions = useMemo<SelectOption<string>[]>(
    () => [
      ...(loading
        ? [
            {
              value: '__loading__',
              label: t('moveSelection.loadingTargets'),
              disabled: true,
            },
          ]
        : loadError
          ? [
              {
                value: '__load_error__',
                label: t('moveSelection.targetsUnavailable'),
                disabled: true,
              },
            ]
          : options.length === 0
            ? [
                {
                  value: '__empty__',
                  label: t('moveSelection.noTargets'),
                  disabled: true,
                },
              ]
            : options),
      {
        value: NEW_SPACE_DESTINATION,
        label: t('moveSelection.createNewDestination'),
        sectionLabel: t('moveSelection.newDestinationSection'),
      },
    ],
    [loadError, loading, options, t],
  );

  useEffect(() => {
    if (isOpen) setCreateSourcePreview(true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
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
        setDestinationCanvasId((current) =>
          next.some((option) => option.value === current)
            ? current
            : (next[0]?.value ?? ''),
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
  }, [canvasId, isOpen, t]);

  const close = () => {
    if (!submitting) setOpen(false);
  };

  const selectDestination = (value: string) => {
    if (value === NEW_SPACE_DESTINATION) {
      setCreatingNewSpace(true);
      return;
    }
    setCreatingNewSpace(false);
    setDestinationCanvasId(value);
  };

  const submit = async () => {
    const title = newSpaceTitle.trim();
    if (
      !canvasId ||
      selectedNodeIds.length === 0 ||
      (!creatingNewSpace && !destinationCanvasId) ||
      (creatingNewSpace && !title)
    ) {
      return;
    }
    setSubmitting(true);
    const workspaceId = useWorkspaceStore.getState().workspaceId;
    let moveRequested = false;
    try {
      await drainPendingSaves();
      const expectedSourceVersion = useCanvasStore.getState().version;
      moveRequested = true;
      const result = await moveCanvasSelection(canvasId, {
        selectedNodeIds,
        destination: creatingNewSpace
          ? { kind: 'new', title }
          : { kind: 'existing', canvasId: destinationCanvasId },
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
      setOpen(false);
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
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={t('moveSelection.title')}
      description={t('moveSelection.description', {
        count: selectedNodeIds.length,
      })}
      onClose={close}
      closeOnBackdropClick={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={close}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="solid"
            disabled={
              submitting ||
              (!creatingNewSpace &&
                (loading || loadError || !destinationCanvasId)) ||
              (creatingNewSpace && !newSpaceTitle.trim()) ||
              selectedNodeIds.length === 0
            }
            onClick={() => void submit()}
          >
            {submitting
              ? t('moveSelection.moving')
              : t('moveSelection.confirm')}
          </Button>
        </>
      }
    >
      <div className="mt-4">
        <Select
          className="w-full"
          options={destinationOptions}
          value={creatingNewSpace ? NEW_SPACE_DESTINATION : destinationCanvasId}
          onChange={selectDestination}
          disabled={submitting}
          placeholder={t('moveSelection.selectDestination')}
          ariaLabel={t('moveSelection.selectDestination')}
        />
        {creatingNewSpace ? (
          <TextInput
            className="mt-3 w-full"
            size="md"
            value={newSpaceTitle}
            onChange={(event) => setNewSpaceTitle(event.target.value)}
            disabled={submitting}
            placeholder={t('moveSelection.newSpaceName')}
            aria-label={t('moveSelection.newSpaceName')}
            autoFocus
          />
        ) : null}
        <p className="text-fg-subtle mt-3 text-xs">
          {t('moveSelection.boundaryNotice')}
        </p>
        <label className="text-fg-default mt-3 flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-info mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
            checked={createSourcePreview}
            onChange={(event) => setCreateSourcePreview(event.target.checked)}
            disabled={submitting}
          />
          <span>{t('moveSelection.createSourcePreview')}</span>
        </label>
      </div>
    </Modal>
  );
}
