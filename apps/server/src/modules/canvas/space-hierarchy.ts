// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';

import { createId } from '@huabu/shared';
import {
  getSelectionBounds,
  type CanvasNode,
} from '@huabu/shared/canvas-engine';

import {
  executeOnServerAlreadyLocked,
  publishCanvasExecution,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import {
  withCanvasMutexes,
  withSpaceHierarchyLock,
} from './write-coordinator.js';
import { agentThreadService } from '../agent/agent-thread.service.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import {
  createSpace,
  deleteSpaceFromValidatedTreeAlreadyLocked,
  getStructuredStore,
  space,
} from '../storage/index.js';
import { getWorkspaceKey } from '../workspace.js';

import type {
  CanvasNodeId,
  CanvasSummary,
  CreateChildSpaceBody,
  DeleteSpaceTreePreview,
  DeleteSpaceTreeFailure,
  SpaceParentBody,
  SpaceHierarchyResponse,
} from '@huabu/shared';

function isEntryId(value: string): value is CanvasNodeId {
  return /^node-[a-zA-Z0-9_-]+$/.test(value);
}

export class SpaceHierarchyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function hierarchyAncestors(
  members: readonly CanvasSummary[],
  canvasId: string,
): CanvasSummary[] {
  const byId = new Map(members.map((item) => [item.canvasId, item]));
  const result: CanvasSummary[] = [];
  const seen = new Set<string>();
  let id: string | null = canvasId;
  while (id) {
    if (seen.has(id))
      throw new SpaceHierarchyError(
        'SPACE_HIERARCHY_CYCLE',
        'Space hierarchy contains a cycle',
      );
    seen.add(id);
    const item = byId.get(id);
    if (!item)
      throw new SpaceHierarchyError(
        'SPACE_PARENT_MISSING',
        'Space or ancestor does not exist',
        404,
      );
    result.push(item);
    id = item.parentSpaceId ?? null;
  }
  return result;
}

export function spaceSubtree(
  members: readonly CanvasSummary[],
  canvasId: string,
): CanvasSummary[] {
  const root = members.find((item) => item.canvasId === canvasId);
  if (!root)
    throw new SpaceHierarchyError('SPACE_NOT_FOUND', 'Space not found', 404);
  const children = new Map<string, CanvasSummary[]>();
  for (const member of members) {
    if (!member.parentSpaceId) continue;
    const siblings = children.get(member.parentSpaceId) ?? [];
    siblings.push(member);
    children.set(member.parentSpaceId, siblings);
  }
  const result: CanvasSummary[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (seen.has(item.canvasId))
      throw new SpaceHierarchyError(
        'SPACE_HIERARCHY_CYCLE',
        'Space hierarchy contains a cycle',
      );
    seen.add(item.canvasId);
    result.push(item);
    stack.push(...(children.get(item.canvasId) ?? []));
  }
  return result.reverse();
}

export function deletionPreview(
  members: readonly CanvasSummary[],
  canvasId: string,
): DeleteSpaceTreePreview {
  const subtree = spaceSubtree(members, canvasId);
  const identity = subtree
    .map((item) => [item.canvasId, item.parentSpaceId ?? null])
    .sort();
  return {
    token: createHash('sha256')
      .update(JSON.stringify([getWorkspaceKey(), identity]))
      .digest('hex'),
    spaces: subtree.map(({ canvasId, title }) => ({ canvasId, title })),
  };
}

export async function setSpaceParent(
  canvasId: string,
  input: SpaceParentBody,
  entryPosition?: CreateChildSpaceBody['position'],
  /**
   * Runs under the hierarchy lock once a detachment to the root is valid and
   * real, before it is committed; a failure leaves the Space where it was.
   */
  beforeDetach?: () => Promise<void>,
): Promise<SpaceHierarchyResponse> {
  return withSpaceHierarchyLock(async () => {
    const repository = getStructuredStore().spaces();
    const members = await repository.list();
    const current = members.find((item) => item.canvasId === canvasId);
    if (!current)
      throw new SpaceHierarchyError('SPACE_NOT_FOUND', 'Space not found', 404);
    if ((current.parentSpaceId ?? null) !== input.expectedParentSpaceId)
      throw new SpaceHierarchyError(
        'SPACE_PARENT_CHANGED',
        'Space parent changed; refresh before retrying',
      );
    if (input.parentSpaceId) {
      if (
        hierarchyAncestors(members, input.parentSpaceId).some(
          (item) => item.canvasId === canvasId,
        )
      )
        throw new SpaceHierarchyError(
          'SPACE_HIERARCHY_CYCLE',
          'A Space cannot be moved into itself or its descendants',
        );
    }
    if ((current.parentSpaceId ?? null) === input.parentSpaceId)
      return {
        canvasId,
        parentSpaceId: input.parentSpaceId,
        parentEntryNodeId: current.parentEntryNodeId ?? null,
      };
    if (input.parentSpaceId === null) await beforeDetach?.();

    return withCanvasMutexes(
      [
        canvasId,
        ...(input.parentSpaceId ? [input.parentSpaceId] : []),
        ...(current.parentSpaceId ? [current.parentSpaceId] : []),
      ],
      async () => {
        const oldParent = current.parentSpaceId
          ? await space(current.parentSpaceId).read()
          : null;
        const oldEntry = (
          oldParent?.state.nodes as CanvasNode[] | undefined
        )?.find((node) => node.id === current.parentEntryNodeId);
        if (
          oldEntry &&
          (!isEntryId(oldEntry.id) ||
            oldEntry.type !== 'spacePreview' ||
            oldEntry.data.targetCanvasId !== canvasId)
        )
          throw new SpaceHierarchyError(
            'SPACE_ENTRY_INVALID',
            'The previous parent entry is invalid; refresh before retrying',
          );
        let entryId: CanvasNodeId | null = null;
        let entryWrite: ExecuteOnServerOutput | undefined;
        if (input.parentSpaceId) {
          entryId = createId('node');
          const parent = await space(input.parentSpaceId).read();
          if (!parent)
            throw new SpaceHierarchyError(
              'SPACE_PARENT_MISSING',
              'Parent Space not found',
              404,
            );
          const nodes = parent.state.nodes as CanvasNode[];
          const bounds = getSelectionBounds(nodes, nodes);
          const result = await executeOnServerAlreadyLocked({
            canvasId: input.parentSpaceId,
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: entryId,
                    nodeType: 'spacePreview',
                    data: { targetCanvasId: canvasId },
                    position: entryPosition ?? {
                      x: bounds ? bounds.maxX + 80 : 80,
                      y: bounds?.minY ?? 80,
                    },
                  },
                ],
              },
            ],
            originator: { source: 'system' },
            publish: false,
          });
          if (!result.results.every((item) => item.applied))
            throw new SpaceHierarchyError(
              'SPACE_ENTRY_FAILED',
              'Could not create the child Space entry',
            );
          entryWrite = result;
        }
        try {
          if (
            !(await repository.setParent({
              canvasId,
              parentSpaceId: input.parentSpaceId,
              parentEntryNodeId: entryId,
            }))
          )
            throw new SpaceHierarchyError(
              'SPACE_PARENT_FAILED',
              'Could not save Space parent',
            );
          if (current.parentSpaceId && oldEntry && isEntryId(oldEntry.id)) {
            try {
              const removed = await executeOnServerAlreadyLocked({
                canvasId: current.parentSpaceId,
                commands: [{ type: 'DELETE_NODES', nodeIds: [oldEntry.id] }],
                originator: { source: 'system' },
              });
              if (removed.results.some((result) => !result.applied))
                throw new Error(
                  'The previous parent entry could not be removed',
                );
            } catch (cause) {
              throw new SpaceHierarchyError(
                'SPACE_ENTRY_REMOVE_FAILED',
                'Space ownership changed, but removing the previous entry failed. Refresh and remove the remaining shortcut.',
                500,
                {
                  cause: cause instanceof Error ? cause.message : String(cause),
                },
              );
            }
          }
        } finally {
          // A failed attachment retains the card; publish only after ownership settles.
          if (entryWrite) publishCanvasExecution(entryWrite);
        }
        return {
          canvasId,
          parentSpaceId: input.parentSpaceId,
          parentEntryNodeId: entryId,
        };
      },
    );
  });
}

export async function createChildSpace(
  parentSpaceId: string,
  title: string,
  position?: CreateChildSpaceBody['position'],
): Promise<SpaceHierarchyResponse> {
  return withSpaceHierarchyLock(async () => {
    hierarchyAncestors(
      await getStructuredStore().spaces().list(),
      parentSpaceId,
    );
    const canvasId = createId('canvas');
    const result = await createSpace(canvasId, title);
    if (!result.ok)
      throw new SpaceHierarchyError(
        'SPACE_CREATE_FAILED',
        'Could not create child Space',
      );
    // Retain the created Space if attachment fails; refresh resolves uncertain writes.
    try {
      return await setSpaceParent(
        canvasId,
        {
          parentSpaceId,
          expectedParentSpaceId: null,
        },
        position,
      );
    } catch (error) {
      throw new SpaceHierarchyError(
        'SPACE_CHILD_INCOMPLETE',
        'Space created but attaching it failed; it remains available in Home',
        500,
        {
          canvasId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
}

export async function deleteSpaceTree(
  canvasId: string,
  token: string,
): Promise<string[]> {
  return withSpaceHierarchyLock(async () => {
    const members = await getStructuredStore().spaces().list();
    const root = members.find((item) => item.canvasId === canvasId);
    const preview = deletionPreview(members, canvasId);
    if (preview.token !== token)
      throw new SpaceHierarchyError(
        'SPACE_TREE_CHANGED',
        'The subtree changed; review the deletion again',
      );
    const ids = preview.spaces.map((item) => item.canvasId);
    return withCanvasMutexes(
      [...ids, ...(root?.parentSpaceId ? [root.parentSpaceId] : [])],
      async () => {
        const releaseThreads: Array<() => void> = [];
        const deleted: string[] = [];
        try {
          for (const id of ids) {
            const record = await space(id).read();
            for (const raw of record?.state.nodes ?? []) {
              const node = raw as {
                type?: string;
                data?: { threadId?: string };
              };
              const threadId =
                node.type === 'question' ? node.data?.threadId : undefined;
              if (!threadId) continue;
              if (agentThreadService.isActive(threadId, id))
                throw new SpaceHierarchyError(
                  'SPACE_AGENT_RUNNING',
                  'Stop running Agents before deleting this subtree',
                );
              const release = acquireAgentTurn(threadId);
              if (!release)
                throw new SpaceHierarchyError(
                  'SPACE_AGENT_RUNNING',
                  'An Agent is busy',
                );
              releaseThreads.push(release);
            }
          }
          for (const id of ids) {
            const outcome = await deleteSpaceFromValidatedTreeAlreadyLocked(id);
            if (!outcome.ok)
              throw new Error(
                `Could not delete Space ${id}: ${outcome.reason}`,
              );
            deleted.push(id);
          }
          if (
            root?.parentSpaceId &&
            root.parentEntryNodeId &&
            isEntryId(root.parentEntryNodeId)
          ) {
            const removed = await executeOnServerAlreadyLocked({
              canvasId: root.parentSpaceId,
              commands: [
                { type: 'DELETE_NODES', nodeIds: [root.parentEntryNodeId] },
              ],
              originator: { source: 'system' },
            });
            if (removed.results.some((result) => !result.applied))
              throw new Error(
                'The deleted Space entry could not be removed from its parent',
              );
          }
          return deleted;
        } catch (error) {
          if (deleted.length === 0 && error instanceof SpaceHierarchyError)
            throw error;
          throw new SpaceHierarchyError(
            'SPACE_TREE_DELETE_FAILED',
            `Subtree deletion did not complete: ${deleted.length} of ${ids.length} Spaces deleted. Refresh and review the remaining subtree before retrying.`,
            500,
            {
              deletedCanvasIds: deleted,
              remainingCanvasIds: ids.filter((id) => !deleted.includes(id)),
              cause: error instanceof Error ? error.message : String(error),
            } satisfies DeleteSpaceTreeFailure,
          );
        } finally {
          for (const release of releaseThreads.reverse()) release();
        }
      },
    );
  });
}
