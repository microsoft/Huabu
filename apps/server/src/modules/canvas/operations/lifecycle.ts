// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { canvasLifecycleNodeSchema } from '@huabu/shared';
import {
  diffSiblingOrderEvents,
  executeCanvasCommands,
  nodeRevisionOf,
} from '@huabu/shared/canvas-engine';

import { normalizeForCompare, toSafeFilename } from '../../../utils/naming.js';
import { allocateNodeIdentity } from '../../storage/ports/node-identity.js';
import { operationDigest } from '../../storage/ports/operation-rules.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';
import { prepareAgentCanvasCommands } from '../agent-command-preparation.js';
import { buildNodeContent, stripNodesForCanvas } from '../canvas-executor.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from '../../storage/ports/operations.js';
import type { SpaceNodeMutation } from '../../storage/ports/structured.js';
import type {
  CanvasOperationCommit,
  CanvasOperationEvent,
  CanvasOperationRequest,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

/** Lifecycle groups are isolated from ordinary patches until dependent-command admission is wired. */
export function prepareLifecycleOperation(
  snapshot: SpaceOperationSnapshot,
  request: CanvasOperationRequest,
  before: CanvasNode[],
  principalId: string,
  origin: CanvasOperationCommit['origin'],
  now: number,
): SpaceOperationWrite {
  const identity = {
    spaceEpoch: request.spaceEpoch,
    sessionId: request.sessionId,
    operationId: request.operationId,
  };
  const common = {
    key: { ...identity, principalId },
    digest: operationDigest(request),
    expectedVersion: snapshot.record.version,
    review: [],
  };
  const reject = (
    reason: NonNullable<CanvasOperationCommit['results'][number]['reason']>,
  ): SpaceOperationWrite => ({
    ...common,
    metadata: structuredClone(snapshot.metadata),
    receipt: {
      ...identity,
      status: 'rejected',
      atVersion: snapshot.record.version,
      commit: null,
      results: request.commands.map((_, commandIndex) => ({
        commandIndex,
        applied: false,
        reason,
      })),
    },
  });
  const command = request.commands[0];
  if (
    request.commands.length !== 1 ||
    !command ||
    (command.type !== 'CREATE_NODES' && command.type !== 'DELETE_NODES')
  )
    return reject('unsupported-command');
  const version = snapshot.record.version + 1;
  const metadata = structuredClone(snapshot.metadata);
  const events: CanvasOperationEvent[] = [];
  const nodeMutations: SpaceNodeMutation[] = [];
  let nodes: CanvasNode[];
  let affected: string[];
  if (command.type === 'CREATE_NODES') {
    if (request.preconditions.length) return reject('invalid-guard');
    if (
      command.nodes.some(
        (input) =>
          !['note', 'text', 'frame'].includes(input.nodeType) ||
          input.parentId ||
          Object.keys(input.data ?? {}).some(
            (key) => !['label', 'content', 'style'].includes(key),
          ) ||
          (input.nodeType === 'frame' && input.data?.content !== undefined),
      )
    )
      return reject('unsupported-command');
    // Allocation occurs only after receipt lookup; the selected IDs persist with the result.
    const inputs = command.nodes.map((input) => ({
      ...input,
      id: input.id ?? `node-${randomUUID()}`,
    }));
    affected = inputs.map(({ id }) => id);
    if (new Set(affected).size !== affected.length)
      return reject('id-conflict');
    for (const input of inputs) {
      if (
        before.some(({ id }) => id === input.id) ||
        snapshot.sidecars[input.id] ||
        metadata.nodes[input.id] ||
        metadata.retiredNodes?.[input.id]
      )
        return reject('id-conflict');
    }
    // The existing engine owns defaults, geometry and label allocation; only local selection is suppressed.
    const hydrated = before.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(snapshot.sidecars[node.id]
          ? { label: snapshot.sidecars[node.id]?.label }
          : {}),
      },
    }));
    const commands = prepareAgentCanvasCommands([
      { type: 'CREATE_NODES', nodes: inputs },
    ]);
    const execution = executeCanvasCommands(
      { source: 'system', commands },
      {
        canvasId: snapshot.record.canvasId,
        nodes: hydrated,
        edges: [],
      },
    );
    const created = execution.writeResult.nodes.filter(({ id }) =>
      affected.includes(id),
    );
    if (created.length !== inputs.length)
      throw new SpaceOperationError(
        'invalid-commit',
        'Creation engine did not produce the admitted nodes',
      );
    nodes = [...before];
    const occupiedLabels = Object.values(snapshot.sidecars).map((record) =>
      normalizeForCompare(toSafeFilename(record.label, record.nodeId)),
    );
    for (const input of inputs) {
      const createdNode = created.find(({ id }) => id === input.id);
      if (!createdNode)
        throw new SpaceOperationError('invalid-commit', 'Missing created node');
      const initialSidecar = buildNodeContent(createdNode);
      if (!initialSidecar)
        throw new SpaceOperationError(
          'invalid-commit',
          'Missing initial sidecar',
        );
      const allocation = allocateNodeIdentity(
        initialSidecar,
        input.id,
        null,
        occupiedLabels,
      );
      const sidecar = allocation.record;
      occupiedLabels.push(allocation.collisionKey);
      if (input.data?.label !== undefined)
        sidecar['labelSource'] = origin.kind === 'agent' ? 'agent' : 'user';
      const stripped = stripNodesForCanvas([createdNode])[0];
      if (!stripped)
        throw new SpaceOperationError(
          'invalid-commit',
          'Missing created structure',
        );
      // Do not admit engine-local selection, measured geometry or private owner fields into replay.
      const node = canvasLifecycleNodeSchema.parse({
        id: stripped.id,
        type: stripped.type,
        position: stripped.position,
        ...(stripped.style ? { style: stripped.style } : {}),
        ...(stripped.width === undefined ? {} : { width: stripped.width }),
        ...(stripped.height === undefined ? {} : { height: stripped.height }),
        data: {
          type: stripped.type,
          ...(stripped.data.style ? { style: stripped.data.style } : {}),
          ...(stripped.data.heightMode
            ? { heightMode: stripped.data.heightMode }
            : {}),
        },
      });
      const incarnation = randomUUID();
      metadata.nodes[node.id] = {
        incarnation,
        membershipVersion: version,
        coordinateContext: `root:${request.spaceEpoch}`,
        fieldVersions: { position: version, 'style.accent': version },
      };
      if (node.type === 'frame')
        metadata.siblingOrderVersions.push({ parentId: node.id, version });
      events.push({
        type: 'INSERT_NODE',
        node,
        incarnation,
        contentRevision: nodeRevisionOf(sidecar),
      });
      nodeMutations.push({
        kind: 'put',
        nodeId: node.id,
        record: sidecar,
        strictLabel: true,
        authoritativeInsert: true,
      });
      nodes.push(node);
    }
  } else {
    affected = command.nodeIds;
    if (affected.length > 50 || new Set(affected).size !== affected.length)
      return reject('unsupported-command');
    if (
      request.preconditions.length !== affected.length ||
      new Set(request.preconditions.map(({ nodeId }) => nodeId)).size !==
        affected.length
    )
      return reject('invalid-guard');
    for (const nodeId of affected) {
      const node = before.find(({ id }) => id === nodeId);
      const meta = metadata.nodes[nodeId];
      const body = snapshot.sidecars[nodeId];
      const guard = request.preconditions.find(
        (entry) => entry.nodeId === nodeId,
      );
      if (!guard || guard.kind !== 'delete' || guard.commandIndex !== 0)
        return reject('invalid-guard');
      if (!node || !meta || !body || meta.incarnation !== guard.incarnation)
        return reject('stale-target');
      if (node.data.locked) return reject('locked');
      if (
        node.parentId ||
        !['note', 'text', 'frame'].includes(node.type ?? '') ||
        before.some((child) => child.parentId === nodeId) ||
        snapshot.record.state.edges.some((edge) => {
          const value = edge as { source?: string; target?: string };
          return value.source === nodeId || value.target === nodeId;
        }) ||
        (node.type === 'frame' &&
          node.data.layoutMode &&
          node.data.layoutMode !== 'free')
      )
        return reject('unsupported-command');
      if (
        meta.membershipVersion !== guard.membershipVersion ||
        meta.coordinateContext !== guard.coordinateContext ||
        operationDigest(meta.fieldVersions) !==
          operationDigest(guard.fieldVersions) ||
        nodeRevisionOf(body) !== guard.expectRev
      )
        return reject('stale-delete');
      events.push({
        type: 'REMOVE_NODE',
        nodeId,
        incarnation: meta.incarnation,
        contentRevision: nodeRevisionOf(body),
      });
      metadata.retiredNodes ??= {};
      metadata.retiredNodes[nodeId] = {
        incarnation: meta.incarnation,
        deletedVersion: version,
      };
      delete metadata.nodes[nodeId];
      metadata.siblingOrderVersions = metadata.siblingOrderVersions.filter(
        ({ parentId }) => parentId !== nodeId,
      );
      nodeMutations.push({ kind: 'delete', nodeId });
    }
    const execution = executeCanvasCommands(
      {
        source: 'system',
        commands: prepareAgentCanvasCommands([command]),
      },
      { canvasId: snapshot.record.canvasId, nodes: before, edges: [] },
    );
    nodes = execution.writeResult.nodes;
  }
  for (const event of diffSiblingOrderEvents(before, nodes, version)) {
    events.push(event);
    const order = metadata.siblingOrderVersions.find(
      ({ parentId }) => parentId === event.parentId,
    );
    if (order) order.version = version;
  }
  const results = [{ commandIndex: 0, applied: true, nodeIds: affected }];
  const commit: CanvasOperationCommit = {
    ...identity,
    fromVersion: snapshot.record.version,
    toVersion: version,
    origin,
    events,
    results,
  };
  return {
    ...common,
    metadata,
    receipt: {
      ...identity,
      status: 'committed',
      commitVersion: version,
      commit,
      results,
    },
    structure: {
      expectedVersion: snapshot.record.version,
      nextRecord: {
        ...snapshot.record,
        version,
        updatedAt: now,
        state: { ...snapshot.record.state, nodes },
      },
      nodeMutations,
    },
  };
}
