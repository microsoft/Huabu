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
 */

import {
  applySharedPostEffectsFromWriteResult,
  diffCanvasState,
  diffSiblingOrderEvents,
  executeCanvasCommands,
  stripTransientNodeFields,
  type CanvasNode,
} from '@huabu/shared/canvas-engine';

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

export interface FakeExecuteServer {
  /** Answer one request, mutating the server copy through `write`. */
  execute(
    canvasId: string,
    request: PostCanvasExecuteRequest,
  ): PostCanvasExecuteResponse;
  /** Every request received, in order (replays included). */
  readonly requests: PostCanvasExecuteRequest[];
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

  return {
    requests,
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
      const out = executeCanvasCommands(
        { source: 'ui', commands: request.commands as CanvasCommand[] },
        { nodes: prevNodes, edges: before.edges, canvasId },
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
        write({ nodes: nextNodes, edges: shared.edges, version: toVersion });
      }
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
    get state() {
      return state;
    },
    reset(nodes, edges, version = 1) {
      state = { nodes, edges, version };
      server.requests.length = 0;
    },
  };
}
