// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/_client';
import { setSpaceParent } from '@/api/spaceHierarchy';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { Select } from '@/components/Common/Select';
import { toast } from '@/components/Common/Toast';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  REQUEST_DELETE_SPACE,
  REQUEST_REPARENT_SPACE,
  spaceAncestorIds,
} from '@/utils/spaceHierarchy';

import {
  REQUEST_CREATE_CHILD_SPACE,
  type CreateChildSpaceIntent,
} from './createChildSpaceAction';
import { moveNodesToSpace } from './moveNodesToSpace';
import { placeChildSpace } from './placeChildSpace';
import { SpaceDeletionDialog } from './SpaceDeletionDialog';

export function SpaceActions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const creating = useRef(false);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [action, setAction] = useState<'move' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    const create = async (event: Event) => {
      if (creating.current) return;
      const intent = (event as CustomEvent<CreateChildSpaceIntent>).detail;
      if (
        intent.canvasId !== useCanvasStore.getState().canvasId ||
        intent.workspaceId !== useWorkspaceStore.getState().workspaceId
      )
        return;
      creating.current = true;
      try {
        if (intent.nodeIds.length > 0) {
          await moveNodesToSpace(
            intent.canvasId,
            intent.nodeIds,
            {
              kind: 'new',
              title: t('canvasList.untitled'),
              asChild: true,
            },
            navigate,
          );
        } else if (intent.position) {
          await placeChildSpace(intent.canvasId, intent.position);
        }
      } finally {
        creating.current = false;
      }
    };
    window.addEventListener(REQUEST_CREATE_CHILD_SPACE, create);
    return () => window.removeEventListener(REQUEST_CREATE_CHILD_SPACE, create);
  }, [navigate, t]);
  useEffect(() => {
    const move = () => setAction('move');
    const remove = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail === 'string') setDeleting(detail);
    };
    window.addEventListener(REQUEST_REPARENT_SPACE, move);
    window.addEventListener(REQUEST_DELETE_SPACE, remove);
    return () => {
      window.removeEventListener(REQUEST_REPARENT_SPACE, move);
      window.removeEventListener(REQUEST_DELETE_SPACE, remove);
    };
  }, []);
  useEffect(() => {
    setAction(null);
    setDeleting(null);
  }, [canvasId, workspaceId]);
  return (
    <>
      {action && (
        <SpaceOrganizationDialog
          key={`${workspaceId}:${canvasId}:${action}`}
          canvasId={canvasId}
          onClose={() => setAction(null)}
        />
      )}
      {deleting && (
        <SpaceDeletionDialog
          key={deleting}
          canvasId={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(ids, failure) => {
            if (!failure) setDeleting(null);
            if (ids.includes(useCanvasStore.getState().canvasId))
              navigate('/spaces');
          }}
        />
      )}
    </>
  );
}

function SpaceOrganizationDialog({
  canvasId,
  onClose,
}: {
  canvasId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titles = useWorkspaceStore((state) => state.spaceTitles);
  const summaries = useWorkspaceStore((state) => state.spaceSummaries);
  const metadataStatus = useWorkspaceStore((state) => state.spaceTitlesStatus);
  const metadataError = useWorkspaceStore((state) => state.spaceTitlesError);
  const refresh = useWorkspaceStore((state) => state.refreshSpaceTitles);
  const summary = summaries[canvasId];
  const expectedParent = summary?.parentSpaceId ?? null;
  const [chosenParent, setParent] = useState<string>();
  const parent = chosenParent ?? expectedParent ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missingSummary = metadataStatus === 'ready' && !summary;
  const feedback =
    error ||
    metadataError ||
    (missingSummary ? t('spacePreview.missingTarget') : null);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const submit = async () => {
    const workspaceId = useWorkspaceStore.getState().workspaceId;
    setBusy(true);
    setError(null);
    try {
      await drainPendingSaves();
      if (
        useWorkspaceStore.getState().workspaceId !== workspaceId ||
        useCanvasStore.getState().canvasId !== canvasId
      )
        throw new Error(t('spaceHierarchy.workspaceChanged'));
      const result = await setSpaceParent(canvasId, {
        parentSpaceId: parent || null,
        expectedParentSpaceId: expectedParent,
      });
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return;
      await refresh([canvasId, result.canvasId]);
      if (useCanvasStore.getState().canvasId !== canvasId) return;
      onClose();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : t('spaceHierarchy.failed');
      setError(message);
      toast(message, { tone: 'danger' });
      if (
        cause instanceof ApiError &&
        cause.code === 'SPACE_PARENT_CHANGED' &&
        useWorkspaceStore.getState().workspaceId === workspaceId
      ) {
        setParent(undefined);
        await refresh([canvasId]);
      }
    } finally {
      setBusy(false);
    }
  };
  const actionLabel = t('spaceHierarchy.move');
  const disabled =
    busy ||
    metadataStatus !== 'ready' ||
    !summary ||
    parent === (expectedParent ?? '');
  return (
    <Modal
      isOpen
      title={actionLabel}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnEscape={!busy}
      closeOnBackdropClick={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button disabled={disabled} onClick={() => void submit()}>
            {actionLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) void submit();
        }}
      >
        <Select
          ariaLabel={t('spaceHierarchy.parent')}
          value={parent}
          onChange={setParent}
          disabled={busy || metadataStatus !== 'ready' || !summary}
          options={[
            { value: '', label: t('spaceHierarchy.topLevel') },
            ...Object.keys(titles)
              .filter(
                (id) => !spaceAncestorIds(id, summaries).includes(canvasId),
              )
              .map((id) => ({
                value: id,
                label: spaceAncestorIds(id, summaries)
                  .map(
                    (ancestor) => titles[ancestor] || t('canvasList.untitled'),
                  )
                  .join(' / '),
              })),
          ]}
        />
        {feedback && (
          <p role="alert" className="text-danger mt-3">
            {feedback}
          </p>
        )}
        {(metadataError || missingSummary) && (
          <Button variant="ghost" onClick={() => void refresh()}>
            {t('spacePreview.retry')}
          </Button>
        )}
      </form>
    </Modal>
  );
}
