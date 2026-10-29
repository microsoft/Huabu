// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { deleteSpaceTree, getSpaceDeletionPreview } from '@/api/spaceHierarchy';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { toast } from '@/components/Common/Toast';
import { NODE_ICON } from '@/config/nodeIcons';
import {
  getElectronBridge,
  requireDesktopTabSuccess,
} from '@/hooks/useElectron';
import { drainPendingSaves } from '@/store/canvasStore';
import { deleteWorkspace } from '@/store/previewWorkspace/persistence';
import { useWorkspaceStore } from '@/store/workspaceStore';

import type {
  DeleteSpaceTreeFailure,
  DeleteSpaceTreePreview,
} from '@huabu/shared';

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
  onClose,
  onDeleted,
}: {
  canvasId: string;
  onClose: () => void;
  onDeleted: (ids: string[], failure?: string) => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const liveWorkspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [workspaceId] = useState(liveWorkspaceId);
  useEffect(() => {
    if (liveWorkspaceId !== workspaceId) onClose();
  }, [liveWorkspaceId, workspaceId, onClose]);
  const [preview, setPreview] = useState<DeleteSpaceTreePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [rootDeleted, setRootDeleted] = useState(false);
  const root = preview?.spaces.find((item) => item.canvasId === canvasId);
  const descendants =
    preview?.spaces.filter((item) => item.canvasId !== canvasId) ?? [];
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    void getSpaceDeletionPreview(canvasId)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : t('spaceHierarchy.failed'),
          );
      });
    return () => {
      active = false;
    };
  }, [canvasId, attempt, t]);

  const remove = async () => {
    if (!preview) return;
    setBusy(true);
    const tabs = getElectronBridge()?.tabs;
    let deletionPrepared = false;
    try {
      await drainPendingSaves();
      if (useWorkspaceStore.getState().workspaceId !== workspaceId)
        throw new Error(t('spaceHierarchy.workspaceChanged'));
      if (tabs) {
        const canvasIds = preview.spaces.map((space) => space.canvasId);
        const state = await tabs.getState();
        if (
          state.tabs.some(
            (tab) => tab.canvasId && canvasIds.includes(tab.canvasId),
          )
        ) {
          const message = t('desktopTabs.closeBeforeDeleting');
          setError(message);
          toast(message, { tone: 'warning' });
          return;
        }
        requireDesktopTabSuccess(
          await tabs.command({
            type: 'begin-space-deletion',
            canvasId,
            canvasIds,
          }),
        );
        deletionPrepared = true;
      }
      const result = await deleteSpaceTree(canvasId, preview.token);
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return;
      for (const id of result.deletedCanvasIds) deleteWorkspace(id);
      await useWorkspaceStore
        .getState()
        .refreshSpaceTitles(result.deletedCanvasIds);
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return;
      onDeleted(result.deletedCanvasIds);
    } catch (cause) {
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return;
      const message =
        cause instanceof Error ? cause.message : t('spaceHierarchy.failed');
      setError(message);
      if (tabs) toast(message, { tone: 'danger' });
      setPreview(null);
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
        const deleted = cause.details.deletedCanvasIds;
        for (const id of deleted) deleteWorkspace(id);
        setRootDeleted(deleted.includes(canvasId));
        toast(message, { tone: 'danger' });
        onDeleted(deleted, message);
      }
      await useWorkspaceStore.getState().refreshSpaceTitles();
    } finally {
      if (tabs && deletionPrepared) {
        try {
          requireDesktopTabSuccess(await tabs.command('end-space-deletion'));
        } catch (cause) {
          console.error(
            '[desktop-tabs] Could not release Space deletion:',
            cause,
          );
          toast(cause instanceof Error ? cause.message : String(cause), {
            tone: 'danger',
          });
        }
      }
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      title={t('canvasList.deleteTitle')}
      description={t('spaceHierarchy.deleteWarning')}
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
            {t('actions.cancel')}
          </Button>
          <Button
            tone="danger"
            onClick={() => void remove()}
            disabled={busy || !preview}
          >
            {busy && <Loading layout="inline" size="sm" />}
            {preview
              ? t('spaceHierarchy.deleteCount', {
                  count: preview.spaces.length,
                })
              : t('actions.delete')}
          </Button>
        </>
      }
    >
      {preview ? (
        <>
          <div className="border-edge-default mt-4 overflow-hidden rounded-lg border">
            <div className="bg-bg-default flex items-center gap-2.5 px-3 py-3">
              <NODE_ICON.spacePreview
                aria-hidden
                className="text-fg-muted h-5 w-5 shrink-0"
              />
              <span
                className="text-fg-default truncate text-sm font-medium"
                title={root?.title || t('canvasList.untitled')}
              >
                {root?.title || t('canvasList.untitled')}
              </span>
            </div>
            {descendants.length > 0 && (
              <div className="border-edge-default border-t px-3 py-2">
                <p className="text-fg-subtle mb-1 text-xs">
                  {t('spaceHierarchy.deleteDescendants', {
                    count: descendants.length,
                  })}
                </p>
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {descendants.map((item) => (
                    <li
                      key={item.canvasId}
                      className="text-fg-muted flex items-center gap-2 py-1 text-sm"
                    >
                      <NODE_ICON.spacePreview
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span
                        className="truncate"
                        title={item.title || t('canvasList.untitled')}
                      >
                        {item.title || t('canvasList.untitled')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="text-fg-subtle mt-3 text-xs">
            {t('spaceHierarchy.linkedSpacesKept')}
          </p>
        </>
      ) : !error ? (
        <Loading
          layout="block"
          size="sm"
          message={t('canvasList.loading')}
          className="py-6"
        />
      ) : null}
      {error && (
        <div role="alert" className="text-danger-fg mt-3 space-y-2 text-sm">
          <p>{error}</p>
          {!rootDeleted && (
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
              disabled={busy}
            >
              {t('spacePreview.retry')}
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
