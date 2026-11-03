// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { deleteSpaceTree, getSpaceDeletionPreview } from '@/api/spaceHierarchy';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { Spinner } from '@/components/Common/Spinner';
import {
  getElectronBridge,
  requireDesktopTabSuccess,
} from '@/hooks/useElectron';
import { deleteWorkspace } from '@/store/previewWorkspace/persistence';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { prepareSpaceDeletion } from '@/utils/prepareSpaceDeletion';
import { holdSaveErrorRecovery } from '@/utils/saveErrorFeedback';

import type {
  DeleteSpaceTreeFailure,
  DeleteSpaceTreePreview,
} from '@huabu/shared';
import type { ParseKeys, TFunction } from 'i18next';

const deletionErrorKeys: Partial<Record<string, ParseKeys>> = {
  SPACE_AGENT_RUNNING: 'spaceHierarchy.deletionErrors.agentRunning',
  SPACE_TREE_CHANGED: 'spaceHierarchy.deletionErrors.treeChanged',
  SPACE_TREE_DELETE_FAILED: 'spaceHierarchy.deletionErrors.interrupted',
  SPACE_NOT_FOUND: 'spaceHierarchy.deletionErrors.notFound',
};

function describeDeletionError(cause: unknown, fallback: string, t: TFunction) {
  console.error('[space-deletion]', cause);
  const key =
    cause instanceof ApiError && cause.code
      ? deletionErrorKeys[cause.code]
      : undefined;
  return {
    message: key ? t(key) : fallback,
    details: !key && cause instanceof Error ? cause.message : undefined,
  };
}

function isDeletionFailure(value: unknown): value is DeleteSpaceTreeFailure {
  if (!value || typeof value !== 'object') return false;
  return (
    'deletedCanvasIds' in value &&
    Array.isArray(value.deletedCanvasIds) &&
    value.deletedCanvasIds.every((id: unknown) => typeof id === 'string') &&
    'remainingCanvasIds' in value &&
    Array.isArray(value.remainingCanvasIds) &&
    value.remainingCanvasIds.every((id: unknown) => typeof id === 'string') &&
    'cause' in value &&
    typeof value.cause === 'string'
  );
}

export function SpaceDeletionDialog({
  canvasId,
  containerSpaceId,
  onClose,
  onDeleted,
}: {
  canvasId: string;
  containerSpaceId?: string;
  onClose: () => void;
  onDeleted: (ids: string[], failure?: string, completed?: boolean) => void;
}) {
  const { t } = useTranslation();
  useEffect(holdSaveErrorRecovery, []);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const preparationRef = useRef<AbortController | null>(null);
  useEffect(() => () => preparationRef.current?.abort(), []);
  const liveWorkspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [workspaceId] = useState(liveWorkspaceId);
  useEffect(() => {
    if (liveWorkspaceId !== workspaceId) onClose();
  }, [liveWorkspaceId, workspaceId, onClose]);
  const [preview, setPreview] = useState<DeleteSpaceTreePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [rootDeleted, setRootDeleted] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const root = preview?.spaces.find((item) => item.canvasId === canvasId);
  const descendantCount =
    preview?.spaces.filter((item) => item.canvasId !== canvasId).length ?? 0;
  useEffect(() => {
    let active = true;
    setChecking(true);
    setError(null);
    setErrorDetails(null);
    void getSpaceDeletionPreview(canvasId)
      .then((value) => {
        if (active) {
          setPreview(value);
          cancelRef.current?.focus();
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          const failure = describeDeletionError(
            cause,
            t('spaceHierarchy.deletionErrors.preview'),
            t,
          );
          setError(failure.message);
          setErrorDetails(failure.details ?? null);
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [canvasId, attempt, t]);

  const remove = async () => {
    if (!preview || !root || checking || busy || error) return;
    setBusy(true);
    const tabs = getElectronBridge()?.tabs;
    let deletionPrepared = false;
    let deletedCanvasIds: string[] = [];
    let failure: string | undefined;
    let refreshFailure: string | undefined;
    let details: string | undefined;
    let deletionRequested = false;
    const reportFailure = (cause: unknown, fallback: string) => {
      const { message, details: nextDetails } = describeDeletionError(
        cause,
        fallback,
        t,
      );
      failure =
        failure && failure !== message ? `${failure}\n${message}` : message;
      if (nextDetails)
        details =
          details && details !== nextDetails
            ? `${details}\n${nextDetails}`
            : nextDetails;
    };
    const reportRefreshFailure = (cause: unknown) => {
      console.error(
        '[space-deletion] Could not refresh Space metadata:',
        cause,
      );
      if (!failure && deletedCanvasIds.includes(canvasId))
        refreshFailure = t('spaceHierarchy.deletionErrors.deletedRefresh');
      else if (!failure)
        reportFailure(cause, t('spaceHierarchy.deletionErrors.refresh'));
    };
    try {
      if (
        containerSpaceId &&
        (root.parentSpaceId !== containerSpaceId ||
          preview.spaces.some((space) => space.canvasId === containerSpaceId))
      )
        throw new Error(t('spaceHierarchy.deleteFromContainer'));
      const controller = new AbortController();
      preparationRef.current = controller;
      const timer = setTimeout(
        () =>
          controller.abort(
            new Error(t('spaceHierarchy.deletionErrors.prepareTimeout')),
          ),
        15_000,
      );
      try {
        await prepareSpaceDeletion(controller.signal);
        controller.signal.throwIfAborted();
      } finally {
        clearTimeout(timer);
        if (preparationRef.current === controller)
          preparationRef.current = null;
      }
      if (useWorkspaceStore.getState().workspaceId !== workspaceId)
        throw new Error(t('spaceHierarchy.workspaceChanged'));
      if (tabs) {
        const canvasIds = preview.spaces.map((space) => space.canvasId);
        requireDesktopTabSuccess(
          await tabs.command({
            type: 'begin-space-deletion',
            canvasId,
            canvasIds,
          }),
        );
        deletionPrepared = true;
      }
      deletionRequested = true;
      const result = await deleteSpaceTree(canvasId, preview.token);
      deletedCanvasIds = result.deletedCanvasIds;
    } catch (cause) {
      reportFailure(
        cause,
        deletionRequested
          ? t('spaceHierarchy.deletionErrors.request')
          : t('spaceHierarchy.deletionErrors.prepare'),
      );
      const confirmed = new Set(preview.spaces.map((item) => item.canvasId));
      if (
        cause instanceof ApiError &&
        cause.code === 'SPACE_TREE_DELETE_FAILED' &&
        isDeletionFailure(cause.details) &&
        [
          ...cause.details.deletedCanvasIds,
          ...cause.details.remainingCanvasIds,
        ].every((id) => confirmed.has(id))
      ) {
        deletedCanvasIds = cause.details.deletedCanvasIds;
      }
    } finally {
      if (
        deletionRequested &&
        useWorkspaceStore.getState().workspaceId === workspaceId
      ) {
        try {
          for (const id of deletedCanvasIds) deleteWorkspace(id);
          await useWorkspaceStore
            .getState()
            .refreshSpaceTitles(deletedCanvasIds);
          const current = useWorkspaceStore.getState();
          if (
            current.workspaceId === workspaceId &&
            current.spaceTitlesStatus === 'error'
          )
            reportRefreshFailure(
              new Error(current.spaceTitlesError || t('spaceHierarchy.failed')),
            );
        } catch (cause) {
          reportRefreshFailure(cause);
        }
      }
      if (tabs && deletionPrepared) {
        try {
          requireDesktopTabSuccess(
            await tabs.command({
              type: 'end-space-deletion',
              deletedCanvasIds,
            }),
          );
        } catch (cause) {
          reportFailure(cause, t('spaceHierarchy.deletionErrors.release'));
        }
      }
      if (useWorkspaceStore.getState().workspaceId === workspaceId) {
        setBusy(false);
        setRootDeleted(deletedCanvasIds.includes(canvasId));
        setDeletedCount(deletedCanvasIds.length);
        if (failure) {
          setError(failure);
          setErrorDetails(details ?? null);
        }
        if (deletedCanvasIds.length > 0) {
          if (refreshFailure && !failure)
            onDeleted(deletedCanvasIds, refreshFailure, true);
          else onDeleted(deletedCanvasIds, failure);
        }
      }
    }
  };
  return (
    <Modal
      isOpen
      title={
        root
          ? t(
              rootDeleted
                ? 'spaceHierarchy.deletedNamedTitle'
                : error
                  ? 'spaceHierarchy.deleteFailedNamedTitle'
                  : busy
                    ? 'spaceHierarchy.deletingNamedTitle'
                    : 'spaceHierarchy.deleteNamedTitle',
              {
                name: root.title || t('canvasList.untitled'),
              },
            )
          : error
            ? t('spaceHierarchy.deleteFailedTitle')
            : t('canvasList.deleteTitle')
      }
      className="[overflow-wrap:anywhere]"
      description={
        error || busy ? undefined : t('spaceHierarchy.deleteWarning')
      }
      initialFocusRef={cancelRef}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnEscape={!busy}
      closeOnBackdropClick={!busy}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {rootDeleted ? t('actions.close') : t('actions.cancel')}
          </Button>
          {error ? (
            !rootDeleted && (
              <Button
                onClick={() => {
                  setChecking(true);
                  setAttempt((value) => value + 1);
                }}
                disabled={checking}
              >
                {t('spaceHierarchy.recheckDeletion')}
              </Button>
            )
          ) : (
            <Button
              tone="danger"
              onClick={() => void remove()}
              disabled={busy || checking || !root}
            >
              {busy && <Spinner size="sm" />}
              {busy
                ? t('spaceHierarchy.deleting')
                : preview && !checking
                  ? t('spaceHierarchy.deleteCount', {
                      count: preview.spaces.length,
                    })
                  : t('actions.delete')}
            </Button>
          )}
        </>
      }
    >
      {busy ? (
        <p role="status" className="text-fg-muted mt-3 text-sm">
          {t('spaceHierarchy.deletionInProgress')}
        </p>
      ) : !error && !checking && preview ? (
        descendantCount > 0 ? (
          <p className="text-fg-muted mt-3 text-sm">
            {t('spaceHierarchy.deleteDescendants', {
              count: descendantCount,
            })}
          </p>
        ) : null
      ) : !error ? (
        <Loading
          layout="block"
          size="sm"
          message={t('canvasList.loading')}
          className="py-6"
        />
      ) : null}
      {error && (
        <div role="alert" className="mt-3 space-y-2 text-sm">
          <p className="text-danger-fg whitespace-pre-wrap">{error}</p>
          {deletedCount > 0 && (
            <p className="text-fg-muted">
              {t('spaceHierarchy.deletionProgress', { count: deletedCount })}
            </p>
          )}
        </div>
      )}
      {errorDetails && (
        <details className="text-fg-muted mt-3 text-xs">
          <summary className="cursor-pointer">
            {t('spaceHierarchy.deletionDetails')}
          </summary>
          <p className="mt-2 whitespace-pre-wrap">{errorDetails}</p>
        </details>
      )}
    </Modal>
  );
}
