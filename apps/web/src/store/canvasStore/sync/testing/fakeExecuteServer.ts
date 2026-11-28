// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Test double for `POST /api/canvas/:id/execute`.
 *
 * Runs the request's edits through the real shared engine
 * (`executeCanvasEdits`, so an edit is taken whole or not at all exactly as
 * on the server) against a server-side copy of the Space and answers with
 * the real diff in the real response shape: results per edit, rows that name
 * only what changed, mutated nodes by id, no echo of the commands. Store
 * tests therefore exercise the same reconcile path as the product. Only
 * persistence, authentication and the sync stream are absent. The double
 * computes nothing the server does not.
 *
 * A request id seen before is answered from the stored outcome
 * (`replayed: true`, no `deltas`) without executing again.
 *
 * Read versions are checked the way the server checks them: the double keeps
 * per-node stamps with the shared rules, judges every edit of a request with
 * the shared admission, and names a page by its `originator.tabId` (there is
 * no principal here).
 */

import { encodeBasis, parseBasis } from '@huabu/shared';
import {
  advanceNodeStamps,
  applySharedPostEffectsFromWriteResult,
  createReadVersionAdmission,
  diffCanvasState,
  executeCanvasEdits,
  seedNodeOrder,
  stripTransientNodeFields,
  toWireDeltas,
  type CanvasNode,
  type NestableNode,
  type NodeStamp,
} from '@huabu/shared/canvas-engine';

import { ApiError } from '@/api/_client';

import { contentRevisionsOf } from './contentRevisions';

import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

export interface FakeServerState {
  nodes: Node[];
  edges: Edge[];
  version: number;
}

/** The lineage of every read version the double issues. */
export const FAKE_LINEAGE = '00000000-0000-4000-8000-000000000001';

export interface FakeExecuteServer {
  /** Answer one request, mutating the server copy through `write`. */
  execute(
    canvasId: string,
    request: PostCanvasExecuteRequest,
  ): PostCanvasExecuteResponse;
  /** Every request received, in order (replays included). */
  readonly requests: PostCanvasExecuteRequest[];
  /** The read version of the server copy as it is now. */
  basis(): string;
  /** Forget the stamps, as a Space given a new history would. */
  resetStamps(): void;
}

/**
 * @param read  Current server copy of the Space.
 * @param write Store the result of a committed batch.
 */
export function createFakeExecuteServer(
  read: () => FakeServerState,
  write: (next: FakeServerState) => void,
): FakeExecuteServer {
  const stored = new Map<string, PostCanvasExecuteResponse>();
  const requests: PostCanvasExecuteRequest[] = [];
  let stamps: Readonly<Record<string, NodeStamp>> = {};
  /** Version the stamps describe; a copy replaced behind them starts over. */
  let stampedVersion: number | null = null;
  const currentStamps = (): Readonly<Record<string, NodeStamp>> => {
    if (stampedVersion !== read().version) stamps = {};
    stampedVersion = read().version;
    return stamps;
  };

  return {
    requests,
    basis: () => encodeBasis(FAKE_LINEAGE, read().version),
    resetStamps() {
      stamps = {};
      stampedVersion = null;
    },
    execute(canvasId, request) {
      requests.push(request);
      const { operationId } = request;
      if (operationId) {
        const earlier = stored.get(operationId);
        if (earlier) {
          // The stored outcome: what the request changed is not kept.
          const { deltas: _deltas, ...outcome } = earlier;
          return { ...outcome, replayed: true };
        }
      }
      const before = read();
      // The server's read of a stored Space keys every node that has no
      // paint key, before any batch runs. Keyed nodes come back unchanged.
      const prevNodes = seedStoredNodes(
        before.nodes.map((node) => stripTransientNodeFields(node)),
      );
      const page = request.originator?.tabId;
      const readStamps = { floor: 0, nodes: currentStamps() };
      const edits = request.edits.map((edit, index) => {
        let version: number | undefined;
        if (edit.basis !== undefined) {
          const read = parseBasis(edit.basis);
          if (
            !read ||
            read.lineage !== FAKE_LINEAGE ||
            read.version > before.version
          ) {
            throw new ApiError(
              409,
              { code: 'basis-unknown', message: 'basis-unknown' },
              'basis-unknown',
            );
          }
          version = read.version;
        }
        const after: number[] = [];
        let blocked = false;
        for (const ref of edit.after ?? []) {
          if (ref.operationId === undefined) {
            if (ref.edit < index) after.push(ref.edit);
            else blocked = true;
          } else if (
            stored.get(ref.operationId)?.edits[ref.edit]?.applied !== true
          ) {
            blocked = true;
          }
        }
        return {
          commands: edit.commands as CanvasCommand[],
          ...(version !== undefined ? { version } : {}),
          ...(after.length > 0 ? { after } : {}),
          ...(blocked ? { blocked } : {}),
        };
      });
      const admission = edits.some((edit) => edit.version !== undefined)
        ? createReadVersionAdmission({
            edits,
            stamps: readStamps,
            prestateNodes: prevNodes,
            ...(page ? { page } : {}),
          })
        : null;
      const out = executeCanvasEdits(
        { source: 'ui', edits },
        { nodes: prevNodes, edges: before.edges, canvasId },
        admission ? { admitEdit: admission.admitEdit } : {},
      );
      const shared = applySharedPostEffectsFromWriteResult(out.writeResult);
      const nextNodes = out.writeResult.nodes.map((node) =>
        stripTransientNodeFields(node),
      );
      const deltas = diffCanvasState(
        {
          nodes: prevNodes as unknown as CanvasNode[],
          edges: before.edges,
        },
        { nodes: nextNodes as unknown as CanvasNode[], edges: shared.edges },
      );
      const changed =
        deltas.length > 0 ||
        prevNodes.length !== nextNodes.length ||
        prevNodes.some((node, index) => node.id !== nextNodes[index]?.id);
      const toVersion = changed ? before.version + 1 : before.version;
      if (changed) {
        const checked = edits.every((edit) => edit.version !== undefined);
        stamps = advanceNodeStamps(
          readStamps,
          prevNodes,
          nextNodes,
          toVersion,
          page && admission && checked
            ? { by: page, except: admission.unseenMoves(nextNodes) }
            : undefined,
        );
        write({ nodes: nextNodes, edges: shared.edges, version: toVersion });
        stampedVersion = toVersion;
      }
      const nodeContentRevisions = changed
        ? contentRevisionsOf(deltas, nextNodes)
        : undefined;
      const response: PostCanvasExecuteResponse = {
        canvasId,
        fromVersion: before.version,
        toVersion,
        deltas: toWireDeltas(deltas),
        edits: out.editResults.map((edit) => ({
          applied: edit.applied,
          ...(edit.reason ? { reason: edit.reason } : {}),
          ...(edit.failedAt !== undefined ? { failedAt: edit.failedAt } : {}),
          results: edit.results.map((result) => ({
            applied: result.applied,
            ...(result.reason ? { reason: result.reason } : {}),
          })),
        })),
        pendingEffects: {
          mutatedNodeIds: [
            ...new Set(out.pendingEffects.mutatedNodes.map((node) => node.id)),
          ],
          deletedNodeIds: out.pendingEffects.deletedNodeIds,
          contentEditedNodeIds: out.pendingEffects.contentEditedNodeIds,
          deferredFitFrameIds: out.pendingEffects.deferredFitFrameIds,
        },
        ...(nodeContentRevisions ? { nodeContentRevisions } : {}),
        ...(operationId ? { operationId } : {}),
      };
      if (operationId) stored.set(operationId, response);
      return response;
    },
  };
}

/**
 * Key a stored Space's nodes the way the server's read does. A test that
 * puts nodes into the store as a loaded Space passes them through this, so
 * the page starts with the keys a real load gives it.
 */
export function seedStoredNodes<T extends Node>(nodes: readonly T[]): T[] {
  return seedNodeOrder(nodes as unknown as NestableNode[]) as unknown as T[];
}

export interface FakeSpaceServer extends FakeExecuteServer {
  /** The server's copy of the Space. */
  readonly state: FakeServerState;
  /**
   * Replace the server copy, as a fresh Space load would find it: nodes
   * stored without paint keys are given them, as the server's read does.
   */
  reset(nodes: Node[], edges: Edge[], version?: number): void;
}

/** A {@link FakeExecuteServer} that keeps the Space copy itself. */
export function createFakeSpaceServer(): FakeSpaceServer {
  let state: FakeServerState = { nodes: [], edges: [], version: 1 };
  const server = createFakeExecuteServer(
    () => state,
    (next) => {
      state = next;
    },
  );
  return {
    execute: server.execute,
    requests: server.requests,
    basis: server.basis,
    resetStamps: server.resetStamps,
    get state() {
      return state;
    },
    reset(nodes, edges, version = 1) {
      state = { nodes: seedStoredNodes(nodes), edges, version };
      server.requests.length = 0;
    },
  };
}
