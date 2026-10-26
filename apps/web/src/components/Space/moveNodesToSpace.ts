// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ApiError } from '@/api/_client';
import { moveCanvasSelection } from '@/api/canvas';
import { dismissToast, toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pageLifecycle } from '@/utils/pageLifecycle';

import type { MoveSelectionBody, MoveSelectionErrorCode } from '@huabu/shared';
import type { NavigateFunction } from 'react-router-dom';

const MOVE_ERROR_MESSAGES = {
  MOVE_SOURCE_STALE: 'moveSelection.errors.sourceStale',
  MOVE_SOURCE_NODE_MISSING: 'moveSelection.errors.sourceNodeMissing',
  MOVE_NODE_NOT_MOVABLE: 'moveSelection.errors.nodeNotMovable',
  MOVE_DESTINATION_MISSING: 'moveSelection.errors.destinationMissing',
  MOVE_DESTINATION_SAME_AS_SOURCE: 'moveSelection.errors.sameDestination',
  MOVE_HIERARCHY_CYCLE: 'moveSelection.errors.hierarchyCycle',
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

const pendingSources = new Set<string>();
const successToastIds = new Set<string>();
let feedbackGeneration = 0;

/** Leaving the source page also invalidates feedback from in-flight moves. */
export function dismissMoveSuccessToasts() {
  feedbackGeneration++;
  for (const id of successToastIds) dismissToast(id);
  successToastIds.clear();
}

export async function moveNodesToSpace(
  canvasId: string,
  selectedNodeIds: string[],
  destination: MoveSelectionBody['destination'],
  navigate: NavigateFunction,
): Promise<boolean> {
  if (pendingSources.has(canvasId)) return false;
  pendingSources.add(canvasId);
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  const generation = feedbackGeneration;
  let moveRequested = false;
  try {
    return await pageLifecycle.run('updating', async () => {
      await drainPendingSaves();
      if (
        generation !== feedbackGeneration ||
        useCanvasStore.getState().canvasId !== canvasId ||
        useWorkspaceStore.getState().workspaceId !== workspaceId
      ) {
        toast(i18n.t('moveSelection.errors.sourceStale'), {
          tone: 'danger',
          duration: 0,
        });
        return false;
      }
      moveRequested = true;
      const result = await moveCanvasSelection(canvasId, {
        selectedNodeIds,
        destination,
        createSourcePreview:
          destination.kind === 'new' && destination.asChild === true,
        expectedSourceVersion: useCanvasStore.getState().version,
      });
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return true;
      useWorkspaceStore
        .getState()
        .setSpaceTitle(result.destination.canvasId, result.destination.title);
      void useWorkspaceStore
        .getState()
        .refreshSpaceTitles([canvasId, result.destination.canvasId]);
      if (
        generation !== feedbackGeneration ||
        useCanvasStore.getState().canvasId !== canvasId
      )
        return true;
      const toastId = toast(
        i18n.t('moveSelection.success', {
          count: result.movedNodeCount,
          conversations: result.movedConversationCount,
        }),
        {
          tone: 'success',
          duration: 8000,
          action: {
            label: i18n.t('moveSelection.openDestination'),
            onClick: () => {
              if (generation !== feedbackGeneration) return;
              if (useWorkspaceStore.getState().workspaceId !== workspaceId) {
                toast(i18n.t('spaceHierarchy.workspaceChanged'), {
                  tone: 'warning',
                });
                return;
              }
              navigate(
                `/canvas/${encodeURIComponent(result.destination.canvasId)}`,
                {
                  state: {
                    returnToSpace: canvasId,
                    workspaceId,
                    focusNodeIds: result.roots.map(
                      (root) => root.destinationNodeId,
                    ),
                  },
                },
              );
            },
          },
        },
      );
      successToastIds.add(toastId);
      return true;
    });
  } catch (error) {
    const code =
      moveRequested && error instanceof ApiError ? error.code : undefined;
    const key =
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(MOVE_ERROR_MESSAGES, code)
        ? MOVE_ERROR_MESSAGES[code as MoveSelectionErrorCode]
        : 'moveSelection.failed';
    toast(i18n.t(key), { tone: 'danger', duration: 0 });
    return false;
  } finally {
    pendingSources.delete(canvasId);
  }
}
