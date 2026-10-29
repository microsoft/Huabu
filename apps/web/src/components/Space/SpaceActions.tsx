// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  REQUEST_DELETE_SPACE,
  REQUEST_REPARENT_SPACE,
} from '@/utils/spaceHierarchy';

import {
  REQUEST_CREATE_CHILD_SPACE,
  type CreateChildSpaceIntent,
} from './createChildSpaceAction';
import { moveNodesToSpace } from './moveNodesToSpace';
import { placeChildSpace } from './placeChildSpace';
import { SpaceDeletionDialog } from './SpaceDeletionDialog';
import { SpaceOrganizationPopover } from './SpaceOrganizationPopover';

export function SpaceActions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const creating = useRef(false);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [action, setAction] = useState<{
    reference: HTMLElement | null;
  } | null>(null);
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
    const move = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      setAction({ reference: detail instanceof HTMLElement ? detail : null });
    };
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
        <SpaceOrganizationPopover
          key={`${workspaceId}:${canvasId}`}
          canvasId={canvasId}
          reference={action.reference}
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
