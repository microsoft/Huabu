// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  canvasCommitPageSchema,
  canvasOperationCommitSchema,
  canvasOperationMetadataSchema,
  canvasOperationReceiptSchema,
  canvasOperationSessionSchema,
} from '@huabu/shared';
import {
  applySiblingOrderEvents,
  collectSiblingOrders,
  nodeRevisionOf,
  diffSiblingOrderEvents,
} from '@huabu/shared/canvas-engine';

import { applyOperationFieldChange } from './operation-fields.js';
import { projectFieldReview } from './operation-review.js';
import { SpaceOperationError } from './operations.js';
import { digestJson as operationDigest } from '../../../utils/json.js';
export { digestJson as operationDigest } from '../../../utils/json.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from './operations.js';
import type {
  CanvasCommitPage,
  CanvasCommitQuery,
  CanvasOperationCommit,
  CanvasOperationSession,
} from '@huabu/shared';
import type {
  CanvasNode,
  SetSiblingOrderEvent,
} from '@huabu/shared/canvas-engine';

const WEEK = 7 * 86400000;
export const MAX_COMMIT_BYTES = 1048576;

export function newOperationSession(
  spaceEpoch: string,
  now: number,
): CanvasOperationSession {
  return canvasOperationSessionSchema.parse({
    protocolVersion: 1,
    sessionId: randomUUID(),
    spaceEpoch,
    modelVersion: 1,
    features: [
      'root-node-position',
      'root-node-accent',
      'root-node-order',
      'root-authored-content',
      'plain-root-lifecycle',
    ],
    expiresAt: now + WEEK,
    receiptsRetainedUntil: now + 2 * WEEK,
    limits: {
      maxCommands: 50,
      maxCommitBytes: MAX_COMMIT_BYTES,
      maxReplayCount: 200,
      maxReplayBytes: 4194304,
    },
  });
}

export function validateOperationWrite(
  snapshot: SpaceOperationSnapshot,
  input: SpaceOperationWrite,
): void {
  const invalid: (message: string) => never = (message) => {
    throw new SpaceOperationError('invalid-commit', message);
  };
  const receipt = canvasOperationReceiptSchema.parse(input.receipt);
  const metadata = canvasOperationMetadataSchema.parse(input.metadata);
  if (!/^[a-f0-9]{64}$/.test(input.digest)) invalid('Invalid operation digest');
  if (snapshot.metadata.spaceEpoch !== input.key.spaceEpoch)
    throw new SpaceOperationError('stale-epoch', 'The Space epoch changed');
  if (snapshot.record.version !== input.expectedVersion)
    throw new SpaceOperationError('head-conflict', 'The Space head changed');
  if (
    metadata.spaceEpoch !== snapshot.metadata.spaceEpoch ||
    metadata.earliestReplayVersion !== snapshot.metadata.earliestReplayVersion
  )
    invalid('A normal operation cannot change the epoch or replay floor');
  if (
    receipt.spaceEpoch !== input.key.spaceEpoch ||
    receipt.sessionId !== input.key.sessionId ||
    receipt.operationId !== input.key.operationId
  )
    invalid('Receipt identity does not match the operation');
  if (receipt.results.some((result, index) => result.commandIndex !== index))
    invalid('Results must preserve command order');
  for (const result of receipt.results) {
    if (result.contentRevision === undefined) continue;
    const body = result.nodeId ? snapshot.sidecars[result.nodeId] : undefined;
    const event =
      receipt.status === 'committed'
        ? receipt.commit.events.find(
            (event) =>
              event.type === 'NODE_CONTENT_REVISION' &&
              event.nodeId === result.nodeId,
          )
        : undefined;
    const expectedRevision =
      event?.type === 'NODE_CONTENT_REVISION'
        ? event.afterRevision
        : body
          ? nodeRevisionOf(body)
          : undefined;
    if (result.contentRevision !== expectedRevision)
      invalid('Content result revision does not match its sidecar or event');
  }
  if (receipt.status !== 'committed') {
    if (
      input.structure ||
      input.review.length ||
      receipt.atVersion !== input.expectedVersion ||
      operationDigest(metadata) !== operationDigest(snapshot.metadata)
    )
      invalid('A terminal non-commit cannot mutate state or Review');
    return;
  }
  const commit = receipt.commit;
  const structure = input.structure;
  if (
    !structure ||
    structure.allowCreate ||
    structure.expectedVersion !== input.expectedVersion ||
    structure.nextRecord.version !== commit.toVersion ||
    receipt.commitVersion !== commit.toVersion ||
    commit.fromVersion !== input.expectedVersion ||
    commit.spaceEpoch !== receipt.spaceEpoch ||
    commit.sessionId !== receipt.sessionId ||
    commit.operationId !== receipt.operationId ||
    operationDigest(commit.results) !== operationDigest(receipt.results)
  )
    invalid('State, event and receipt disagree');
  if (commit.reviewRecord) {
    const projectedReview = projectFieldReview(
      snapshot,
      structure.nextRecord.state,
      commit,
      commit.reviewRecord.threadId,
    );
    if (
      operationDigest(projectedReview.descriptor) !==
        operationDigest(commit.reviewRecord) ||
      operationDigest(projectedReview.review) !== operationDigest(input.review)
    )
      invalid('Review records must match their immutable field commit');
  }
  const {
    state: _oldState,
    version: _oldVersion,
    updatedAt: _oldTime,
    ...oldIdentity
  } = snapshot.record;
  const {
    state: _newState,
    version: _newVersion,
    updatedAt: _newTime,
    ...newIdentity
  } = structure.nextRecord;
  if (operationDigest(oldIdentity) !== operationDigest(newIdentity))
    invalid(
      'A structural operation cannot change Space identity, title or ownership',
    );
  if (
    metadata.reviewRevision !==
    snapshot.metadata.reviewRevision + (input.review.length ? 1 : 0)
  )
    invalid('Review revision must advance with its transaction');
  if (
    commit.reviewRevision !==
    (input.review.length ? metadata.reviewRevision : undefined)
  )
    invalid('Review notification must match an actual list mutation');
  if (
    new Set(input.review.map(({ threadId }) => threadId)).size !==
    input.review.length
  )
    invalid('Duplicate Review thread in commit');
  if (Buffer.byteLength(JSON.stringify(commit)) > MAX_COMMIT_BYTES)
    throw new SpaceOperationError(
      'commit-too-large',
      'Commit exceeds the 1 MiB limit',
    );

  const projected = structuredClone(snapshot.record.state);
  const expectedMetadata = structuredClone(snapshot.metadata);
  expectedMetadata.reviewRevision = metadata.reviewRevision;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const seen = new Set<string>();
  const sidecarEvents = new Set<string>();
  const orderEvents: SetSiblingOrderEvent[] = [];
  const lifecycleIds = new Set<string>();
  for (const event of commit.events) {
    if (event.type === 'INSERT_NODE' || event.type === 'REMOVE_NODE') {
      const nodeId =
        event.type === 'INSERT_NODE' ? event.node.id : event.nodeId;
      if (lifecycleIds.has(nodeId) || sidecarEvents.has(nodeId))
        invalid('Duplicate lifecycle target');
      lifecycleIds.add(nodeId);
      sidecarEvents.add(nodeId);
      const matches = structure.nodeMutations.filter(
        (mutation) => mutation.nodeId === nodeId,
      );
      const mutation = matches[0];
      if (matches.length !== 1 || !mutation)
        invalid('Lifecycle event requires exactly one sidecar mutation');
      if (event.type === 'INSERT_NODE') {
        const retired = snapshot.metadata.retiredNodes?.[nodeId];
        if (
          snapshot.metadata.nodes[nodeId] ||
          snapshot.sidecars[nodeId] ||
          projected.nodes.some(
            (node) => isObject(node) && node['id'] === nodeId,
          ) ||
          mutation.kind !== 'put' ||
          mutation.record.type !== event.node.type ||
          mutation.record.nodeId !== nodeId ||
          nodeRevisionOf(mutation.record) !== event.contentRevision ||
          retired !== undefined
        )
          invalid(
            'Insertion must create an absent sidecar without reusing a retired identity',
          );
        projected.nodes.push(event.node);
        expectedMetadata.nodes[nodeId] = {
          incarnation: event.incarnation,
          membershipVersion: commit.toVersion,
          coordinateContext: `root:${metadata.spaceEpoch}`,
          fieldVersions: {
            position: commit.toVersion,
            'style.accent': commit.toVersion,
          },
        };
        if (event.node.type === 'frame')
          expectedMetadata.siblingOrderVersions.push({
            parentId: nodeId,
            version: commit.toVersion,
          });
      } else {
        const old = projected.nodes.find(
          (node) => isObject(node) && node['id'] === nodeId,
        );
        if (
          !isObject(old) ||
          old['parentId'] ||
          !['note', 'text', 'frame'].includes(String(old['type'])) ||
          projected.nodes.some(
            (node) => isObject(node) && node['parentId'] === nodeId,
          ) ||
          projected.edges.some(
            (edge) =>
              isObject(edge) &&
              (edge['source'] === nodeId || edge['target'] === nodeId),
          ) ||
          mutation.kind !== 'delete' ||
          !snapshot.sidecars[nodeId] ||
          snapshot.metadata.nodes[nodeId]?.incarnation !== event.incarnation ||
          nodeRevisionOf(snapshot.sidecars[nodeId]) !== event.contentRevision
        )
          invalid('Removal must consume a live root leaf and its sidecar');
        projected.nodes = projected.nodes.filter(
          (node) => !isObject(node) || node['id'] !== nodeId,
        );
        delete expectedMetadata.nodes[nodeId];
        expectedMetadata.retiredNodes ??= {};
        expectedMetadata.retiredNodes[nodeId] = {
          incarnation: event.incarnation,
          deletedVersion: commit.toVersion,
        };
        expectedMetadata.siblingOrderVersions =
          expectedMetadata.siblingOrderVersions.filter(
            ({ parentId }) => parentId !== nodeId,
          );
      }
      continue;
    }
    if (event.type === 'SET_SIBLING_ORDER') {
      if (event.orderVersion !== commit.toVersion)
        invalid('Sibling order must carry the commit writer version');
      const version = expectedMetadata.siblingOrderVersions.find(
        ({ parentId }) => parentId === event.parentId,
      );
      if (!version) {
        if (!lifecycleIds.has(event.parentId ?? '') || event.after.length)
          invalid('Missing sibling order metadata');
      } else version.version = commit.toVersion;
      orderEvents.push(event);
      continue;
    }
    if (event.type === 'NODE_CONTENT_REVISION') {
      if (sidecarEvents.has(event.nodeId))
        invalid('Duplicate content notification');
      sidecarEvents.add(event.nodeId);
      const before = snapshot.sidecars[event.nodeId];
      const mutations = structure.nodeMutations.filter(
        ({ nodeId }) => nodeId === event.nodeId,
      );
      const mutation = mutations[0];
      if (
        !before ||
        mutations.length !== 1 ||
        !mutation ||
        mutation.kind !== 'put'
      )
        invalid(
          'Content notification requires one existing sidecar replacement',
        );
      if (
        snapshot.metadata.nodes[event.nodeId]?.incarnation !==
          event.incarnation ||
        metadata.nodes[event.nodeId]?.incarnation !== event.incarnation ||
        nodeRevisionOf(before) !== event.beforeRevision ||
        nodeRevisionOf(mutation.record) !== event.afterRevision
      )
        invalid(
          'Content notification disagrees with the sidecar revision or lifetime',
        );
      const {
        content: _beforeContent,
        src: _beforeSrc,
        ...beforeMetadata
      } = before;
      const {
        content: _afterContent,
        src: _afterSrc,
        ...afterMetadata
      } = mutation.record;
      if (operationDigest(beforeMetadata) !== operationDigest(afterMetadata))
        invalid(
          'Sidecar metadata changes require their declared metadata events',
        );
      continue;
    }
    const node = projected.nodes.find(
      (node) => isObject(node) && node['id'] === event.nodeId,
    );
    if (!isObject(node) || !isObject(node['data']))
      invalid('Event target is absent');
    const currentMeta = snapshot.metadata.nodes[event.nodeId];
    const nextMeta = metadata.nodes[event.nodeId];
    const expectedMeta = expectedMetadata.nodes[event.nodeId];
    if (
      currentMeta?.incarnation !== event.incarnation ||
      nextMeta?.incarnation !== event.incarnation ||
      !expectedMeta
    )
      invalid('Event target lifetime does not match state');
    if (
      event.context &&
      (event.context.parentId !== (node['parentId'] ?? null) ||
        event.context.membershipVersion !== currentMeta.membershipVersion ||
        event.context.coordinateContext !== currentMeta.coordinateContext)
    )
      invalid('Patch context does not match committed state');
    for (const change of event.changes) {
      const key = JSON.stringify([event.nodeId, change.field]);
      if (seen.has(key)) invalid('Duplicate field in a commit');
      seen.add(key);
      applyOperationFieldChange(node as CanvasNode, change);
      if (nextMeta.fieldVersions[change.field] !== commit.toVersion)
        invalid('Changed field must carry the new writer version');
      expectedMeta.fieldVersions[change.field] = commit.toVersion;
    }
  }
  const previousNodes = snapshot.record.state.nodes as CanvasNode[];
  const projectedNodes = projected.nodes as CanvasNode[];
  if (lifecycleIds.size) {
    const expectedOrders = diffSiblingOrderEvents(
      previousNodes,
      projectedNodes,
      commit.toVersion,
    );
    if (operationDigest(expectedOrders) !== operationDigest(orderEvents))
      invalid(
        'Lifecycle changes require complete matching sibling order events',
      );
    const reported = receipt.results.flatMap((result) => result.nodeIds ?? []);
    if (
      reported.length !== lifecycleIds.size ||
      new Set(reported).size !== reported.length ||
      reported.some((id) => !lifecycleIds.has(id))
    )
      invalid(
        'Lifecycle receipt must identify every affected node exactly once',
      );
  }
  const lists = collectSiblingOrders(previousNodes);
  if (
    snapshot.metadata.siblingOrderVersions.length !== lists.size ||
    new Set(
      snapshot.metadata.siblingOrderVersions.map(({ parentId }) => parentId),
    ).size !== lists.size ||
    snapshot.metadata.siblingOrderVersions.some(
      ({ parentId, version }) =>
        !lists.has(parentId) || version > input.expectedVersion,
    )
  )
    invalid('Sibling order metadata does not match the baseline forest');
  if (orderEvents.length)
    projected.nodes = applySiblingOrderEvents(
      previousNodes,
      projectedNodes,
      orderEvents,
    );
  if (
    operationDigest(projected) !== operationDigest(structure.nextRecord.state)
  )
    invalid('Event replay does not equal the proposed structural state');
  if (structure.nodeMutations.some(({ nodeId }) => !sidecarEvents.has(nodeId)))
    invalid('Sidecar mutations require a matching owned notification');
  if (operationDigest(expectedMetadata) !== operationDigest(metadata))
    invalid('Metadata changes require corresponding declared events');
}

/** All rows are read at one transaction watermark. Never split a commit. */
export function operationReplayPage(
  snapshot: SpaceOperationSnapshot,
  query: CanvasCommitQuery,
  rows: readonly unknown[],
): CanvasCommitPage {
  const { metadata, record } = snapshot;
  if (
    query.spaceEpoch !== metadata.spaceEpoch ||
    query.afterVersion < metadata.earliestReplayVersion
  ) {
    return {
      status: 'snapshot-required',
      spaceEpoch: metadata.spaceEpoch,
      earliestReplayVersion: metadata.earliestReplayVersion,
      latestVersion: record.version,
    };
  }
  const throughVersion = query.throughVersion ?? record.version;
  if (throughVersion > record.version || query.afterVersion > throughVersion)
    throw new SpaceOperationError('head-conflict', 'Invalid replay watermark');
  const commits: CanvasOperationCommit[] = [];
  let cursor = query.afterVersion;
  const page = (): CanvasCommitPage => ({
    status: 'commits',
    spaceEpoch: metadata.spaceEpoch,
    fromVersion: query.afterVersion,
    throughVersion,
    commits,
    nextAfterVersion: cursor,
    hasMore: cursor < throughVersion,
  });
  for (const row of rows) {
    const parsed = canvasOperationCommitSchema.safeParse(row);
    if (
      !parsed.success ||
      parsed.data.spaceEpoch !== metadata.spaceEpoch ||
      parsed.data.fromVersion !== cursor ||
      parsed.data.toVersion > throughVersion
    )
      throw new SpaceOperationError(
        'replay-corrupt',
        'Commit history is not contiguous',
      );
    if (commits.length === query.limit) break;
    const commit = parsed.data;
    commits.push(commit);
    cursor = commit.toVersion;
    if (Buffer.byteLength(JSON.stringify(page())) > query.maxBytes) {
      commits.pop();
      cursor = commit.fromVersion;
      if (!commits.length)
        throw new SpaceOperationError(
          'replay-page-too-small',
          'A complete commit does not fit this page',
        );
      return canvasCommitPageSchema.parse(page());
    }
  }
  if (cursor < throughVersion && commits.length < query.limit)
    throw new SpaceOperationError('replay-corrupt', 'Commit history has a gap');
  const result = canvasCommitPageSchema.parse(page());
  if (Buffer.byteLength(JSON.stringify(result)) > query.maxBytes)
    throw new SpaceOperationError(
      'replay-page-too-small',
      'Replay envelope does not fit this page',
    );
  return result;
}
