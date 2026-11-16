// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Test double for `POST /api/canvas/:id/execute`.
 *
 * Runs the request's commands through the real shared engine against a
 * server-side copy of the Space and answers with the real diff, the way the
 * server does, so store tests exercise the same reconcile path as the
 * product. Only persistence, authentication and the sync stream are absent.
 *
 * A request id seen before is answered from the stored response
 * (`replayed: true`) without executing again.
 *
 * Read versions are checked the way the server checks them: the double keeps
 * per-node stamps with the shared rules, judges every run of a request with
 * the shared admission, and names a page by its `originator.tabId` (there is
 * no principal here).
 */

import { encodeBasis, parseBasis } from '@huabu/shared';
import {
  advanceNodeStamps,
  applySharedPostEffectsFromWriteResult,
  createReadVersionAdmission,
  diffCanvasState,
  diffSiblingOrderEvents,
  executeCanvasCommands,
  isRefusedResult,
  stripTransientNodeFields,
  type CanvasNode,
  type NodeStamp,
  type ReadVersionRun,
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
        if (earlier) return { ...earlier, replayed: true };
      }
      const before = read();
      const prevNodes = before.nodes.map((node) =>
        stripTransientNodeFields(node),
      );
      const commands = request.commands as CanvasCommand[];
      const page = request.originator.tabId;
      const readStamps = { floor: 0, nodes: currentStamps() };
      const runs: ReadVersionRun[] = (request.runs ?? []).map((run) => {
        const read = parseBasis(run.basis);
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
        const earlier = (run.after ?? []).filter(
          (ref) => ref.operationId !== undefined,
        );
        return {
          start: run.start,
          count: run.count,
          version: read.version,
          after: (run.after ?? []).filter(
            (ref) => ref.operationId === undefined,
          ),
          ...(earlier.some((ref) => {
            const results = stored
              .get(ref.operationId as string)
              ?.results.slice(ref.start, ref.start + ref.count);
            return (
              !results ||
              results.length !== ref.count ||
              results.some(isRefusedResult)
            );
          })
            ? { blocked: true }
            : {}),
        };
      });
      const admission =
        runs.length > 0
          ? createReadVersionAdmission({
              commands,
              runs,
              stamps: readStamps,
              prestateNodes: prevNodes,
              ...(page ? { page } : {}),
            })
          : null;
      const out = executeCanvasCommands(
        { source: 'ui', commands },
        { nodes: prevNodes, edges: before.edges, canvasId },
        admission ? { admit: admission.admit } : {},
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
      const orderEvents = changed
        ? diffSiblingOrderEvents(
            prevNodes as unknown as CanvasNode[],
            nextNodes as unknown as CanvasNode[],
            toVersion,
          )
        : [];
      if (changed) {
        const checked =
          runs.reduce((covered, run) => covered + run.count, 0) ===
          commands.length;
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
        ? contentRevisionsOf(deltas)
        : undefined;
      const response: PostCanvasExecuteResponse = {
        canvasId,
        fromVersion: before.version,
        toVersion,
        deltas,
        results: out.commandResults.map((result) => ({
          command: result.command,
          applied: result.applied,
          ...(result.reason ? { reason: result.reason } : {}),
        })),
        commands: request.commands,
        pendingEffects: {
          mutatedNodes: out.pendingEffects.mutatedNodes,
          deletedNodeIds: out.pendingEffects.deletedNodeIds,
          contentEditedNodeIds: out.pendingEffects.contentEditedNodeIds,
          deferredFitFrameIds: out.pendingEffects.deferredFitFrameIds,
        },
        ...(orderEvents.length > 0 ? { orderEvents } : {}),
        ...(nodeContentRevisions ? { nodeContentRevisions } : {}),
        ...(operationId ? { operationId } : {}),
      };
      if (operationId) stored.set(operationId, response);
      return response;
    },
  };
}

export interface FakeSpaceServer extends FakeExecuteServer {
  /** The server's copy of the Space. */
  readonly state: FakeServerState;
  /** Replace the server copy, as a fresh Space load would find it. */
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
      state = { nodes, edges, version };
      server.requests.length = 0;
    },
  };
}
