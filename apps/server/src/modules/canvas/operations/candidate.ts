// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canvasOperationRequestSchema,
  canvasNodePatchEventSchema,
} from '@huabu/shared';
import {
  collectSiblingOrders,
  admitSiblingReorder,
  diffSiblingOrderEvents,
  executeCanvasCommands,
} from '@huabu/shared/canvas-engine';

import { prepareAgentCanvasCommands } from '../agent-command-preparation.js';
import { prepareLifecycleOperation } from './lifecycle.js';
import { rootOperationAdmission } from '../../storage/ports/operation-fields.js';
import { operationDigest } from '../../storage/ports/operation-rules.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from '../../storage/ports/operations.js';
import type {
  CanvasOperationCommit,
  CanvasOperationEvent,
  CanvasOperationRequest,
} from '@huabu/shared';
import type { CanvasNode, CanvasEdge } from '@huabu/shared/canvas-engine';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function operationNodes(snapshot: SpaceOperationSnapshot): CanvasNode[] {
  return snapshot.record.state.nodes.map((value) => {
    if (
      !object(value) ||
      typeof value['id'] !== 'string' ||
      !object(value['data']) ||
      !object(value['position']) ||
      !Number.isFinite(value['position']['x']) ||
      !Number.isFinite(value['position']['y']) ||
      (value['parentId'] !== null &&
        value['parentId'] !== undefined &&
        typeof value['parentId'] !== 'string')
    ) {
      throw new SpaceOperationError(
        'invalid-commit',
        'Invalid structural node in operation baseline',
      );
    }
    return value as CanvasNode;
  });
}

function accent(node: CanvasNode) {
  const style: unknown = node.data['style'];
  return object(style) && Object.hasOwn(style, 'accent')
    ? { present: true as const, value: style['accent'] }
    : { present: false as const };
}

/** Pure admission/candidate execution: no uploads, sidecars, effects or publication. */
export function prepareOperationCandidate(
  snapshot: SpaceOperationSnapshot,
  raw: CanvasOperationRequest,
  principalId: string,
  origin: CanvasOperationCommit['origin'],
  now: number,
): SpaceOperationWrite {
  const parsed = canvasOperationRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new SpaceOperationError(
      'invalid-commit',
      'Invalid operation request',
    );
  const request = parsed.data;
  if (request.spaceEpoch !== snapshot.metadata.spaceEpoch)
    throw new SpaceOperationError('stale-epoch', 'The Space epoch changed');
  if (request.observedVersion > snapshot.record.version)
    throw new SpaceOperationError(
      'head-conflict',
      'Observed version is ahead of the authoritative Space',
    );
  const before = operationNodes(snapshot);
  collectSiblingOrders(before);
  const nodeIds = new Set(before.map(({ id }) => id));
  const edgeIds = new Set<string>();
  for (const edge of snapshot.record.state.edges) {
    if (
      !object(edge) ||
      typeof edge['id'] !== 'string' ||
      typeof edge['source'] !== 'string' ||
      typeof edge['target'] !== 'string' ||
      !nodeIds.has(edge['source']) ||
      !nodeIds.has(edge['target']) ||
      edgeIds.has(edge['id'])
    )
      throw new SpaceOperationError(
        'invalid-commit',
        'Invalid edge topology in operation baseline',
      );
    edgeIds.add(edge['id']);
  }
  let nodes = structuredClone(before);
  if (
    request.commands.some(
      ({ type }) => type === 'CREATE_NODES' || type === 'DELETE_NODES',
    )
  )
    return prepareLifecycleOperation(
      snapshot,
      request,
      before,
      principalId,
      origin,
      now,
    );
  const results: CanvasOperationCommit['results'] = [];
  const reject = (
    commandIndex: number,
    reason: NonNullable<CanvasOperationCommit['results'][number]['reason']>,
    nodeId?: string,
  ) => {
    results.push({
      commandIndex,
      applied: false,
      reason,
      ...(nodeId ? { nodeId } : {}),
    });
  };
  for (const [commandIndex, command] of request.commands.entries()) {
    if (command.type === 'CREATE_NODES' || command.type === 'DELETE_NODES')
      throw new SpaceOperationError(
        'invalid-commit',
        'Lifecycle admission was bypassed',
      );
    const entries =
      command.type === 'SET_NODE_GEOMETRY'
        ? command.items
        : command.type === 'MERGE_NODE_DATA'
          ? command.patches
          : [
              ...command.nodeIds,
              ...(typeof command.to === 'object'
                ? [
                    'before' in command.to
                      ? command.to.before
                      : command.to.after,
                  ]
                : []),
            ].map((nodeId) => ({ nodeId }));
    if (
      entries.length > 1000 ||
      new Set(entries.map(({ nodeId }) => nodeId)).size !== entries.length ||
      (command.type === 'SET_NODE_GEOMETRY'
        ? command.items.some(
            (item) => item.size !== undefined || item.position === undefined,
          )
        : command.type === 'MERGE_NODE_DATA' &&
          command.patches.some(
            ({ patch, expectRev }) =>
              expectRev !== undefined ||
              Object.keys(patch).some((key) => key !== 'style') ||
              !patch.style ||
              Object.keys(patch.style).length !== 1 ||
              !Object.hasOwn(patch.style, 'accent'),
          ))
    ) {
      reject(commandIndex, 'unsupported-command');
      continue;
    }
    const guards = request.preconditions.filter(
      (guard) => guard.commandIndex === commandIndex,
    );
    if (
      guards.length !== entries.length ||
      new Set(guards.map(({ nodeId }) => nodeId)).size !== guards.length
    ) {
      reject(commandIndex, 'invalid-guard');
      continue;
    }
    let failure: CanvasOperationCommit['results'][number] | undefined;
    for (const { nodeId } of entries) {
      const node = nodes.find((node) => node.id === nodeId);
      const meta = snapshot.metadata.nodes[nodeId];
      const guard = guards.find((guard) => guard.nodeId === nodeId);
      let reason:
        | NonNullable<CanvasOperationCommit['results'][number]['reason']>
        | undefined;
      if (
        !guard ||
        (command.type === 'SET_NODE_GEOMETRY'
          ? guard.kind !== 'coordinates'
          : command.type === 'REORDER_NODES'
            ? guard.kind !== 'membership'
            : guard.kind !== 'node')
      )
        reason = 'invalid-guard';
      else if (!node || !meta || meta.incarnation !== guard.incarnation)
        reason = 'stale-target';
      else if (
        (guard.kind === 'coordinates' || guard.kind === 'membership') &&
        (guard.parentId !== (node.parentId ?? null) ||
          guard.membershipVersion !== meta.membershipVersion)
      )
        reason = 'stale-parent';
      else if (
        guard.kind === 'coordinates' &&
        guard.coordinateContext !== meta.coordinateContext
      )
        reason = 'stale-context';
      else
        reason = rootOperationAdmission(
          nodes,
          node,
          command.type === 'SET_NODE_GEOMETRY',
        );
      if (reason) {
        failure = { commandIndex, applied: false, reason, nodeId };
        break;
      }
    }
    if (failure) {
      results.push(failure);
      continue;
    }
    if (
      command.type === 'REORDER_NODES' &&
      !admitSiblingReorder(nodes, command.nodeIds, command.to).valid
    ) {
      reject(commandIndex, 'stale-target');
      continue;
    }
    const execution = executeCanvasCommands(
      { source: origin.kind, commands: prepareAgentCanvasCommands([command]) },
      {
        canvasId: snapshot.record.canvasId,
        nodes,
        edges: structuredClone(snapshot.record.state.edges) as CanvasEdge[],
      },
    );
    if (
      execution.pendingEffects.deletedNodeIds.length ||
      execution.pendingEffects.contentEditedNodeIds.length ||
      execution.pendingEffects.deferredFitFrameIds.length
    ) {
      throw new SpaceOperationError(
        'invalid-commit',
        'The admitted command produced unsupported effects',
      );
    }
    const nextNodes = execution.writeResult.nodes;
    const changed = operationDigest(nextNodes) !== operationDigest(nodes);
    results.push({
      commandIndex,
      applied: changed,
      ...(!changed ? { reason: 'no-change' as const } : {}),
    });
    nodes = nextNodes;
  }
  if (
    request.preconditions.some(
      ({ commandIndex }) => commandIndex >= request.commands.length,
    )
  )
    throw new SpaceOperationError(
      'invalid-commit',
      'A guard references an absent command',
    );

  const rejected = results.some(
    ({ applied, reason }) => !applied && reason !== 'no-change',
  );
  if (request.mode === 'atomic' && rejected) {
    nodes = before;
    for (const result of results) {
      if (result.applied) {
        result.applied = false;
        result.reason = 'atomic-rejected';
      }
    }
  }
  const metadata = structuredClone(snapshot.metadata);
  const events: CanvasOperationEvent[] = [];
  const toVersion = snapshot.record.version + 1;
  for (const previous of before) {
    const next = nodes.find(({ id }) => id === previous.id);
    if (!next)
      throw new SpaceOperationError(
        'invalid-commit',
        'Unexpected node deletion',
      );
    const changes = [];
    if (operationDigest(previous.position) !== operationDigest(next.position)) {
      changes.push({
        field: 'position',
        before: { present: true, value: previous.position },
        after: { present: true, value: next.position },
      });
    }
    if (operationDigest(accent(previous)) !== operationDigest(accent(next)))
      changes.push({
        field: 'style.accent',
        before: accent(previous),
        after: accent(next),
      });
    if (!changes.length) continue;
    const meta = metadata.nodes[previous.id];
    if (!meta)
      throw new SpaceOperationError(
        'invalid-commit',
        'Missing target lifetime',
      );
    const event = canvasNodePatchEventSchema.parse({
      type: 'PATCH_NODE',
      nodeId: previous.id,
      incarnation: meta.incarnation,
      context: {
        parentId: previous.parentId ?? null,
        membershipVersion: meta.membershipVersion,
        coordinateContext: meta.coordinateContext,
      },
      changes,
    });
    for (const change of event.changes)
      meta.fieldVersions[change.field] = toVersion;
    events.push(event);
  }
  const orders = diffSiblingOrderEvents(before, nodes, toVersion);
  for (const order of orders) {
    const version = metadata.siblingOrderVersions.find(
      ({ parentId }) => parentId === order.parentId,
    );
    if (!version)
      throw new SpaceOperationError(
        'invalid-commit',
        'Missing sibling order metadata',
      );
    version.version = toVersion;
    events.push(order);
  }
  const identity = {
    spaceEpoch: request.spaceEpoch,
    sessionId: request.sessionId,
    operationId: request.operationId,
  };
  const common = {
    key: { ...identity, principalId },
    digest: operationDigest(request),
    expectedVersion: snapshot.record.version,
    metadata,
    review: [],
  };
  if (!events.length) {
    return {
      ...common,
      receipt: {
        ...identity,
        status: rejected ? 'rejected' : 'noop',
        atVersion: snapshot.record.version,
        commit: null,
        results,
      },
    };
  }
  const commit: CanvasOperationCommit = {
    ...identity,
    fromVersion: snapshot.record.version,
    toVersion,
    origin,
    events,
    results,
  };
  return {
    ...common,
    receipt: {
      ...identity,
      status: 'committed',
      commitVersion: toVersion,
      commit,
      results,
    },
    structure: {
      expectedVersion: snapshot.record.version,
      nextRecord: {
        ...snapshot.record,
        version: toVersion,
        updatedAt: now,
        state: { ...snapshot.record.state, nodes },
      },
      nodeMutations: [],
    },
  };
}
