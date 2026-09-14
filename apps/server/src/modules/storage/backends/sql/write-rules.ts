// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  stringifyJson,
  validateCanvasFile,
  validateNodeContent,
} from './codecs.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type {
  NodePutResult,
  SpaceNodeMutation,
  SpaceWriteInput,
} from '../../ports/structured.js';

export function mutationError(
  mutation: SpaceNodeMutation,
  result: NodePutResult,
): Error {
  const prefix = `Space write failed for node ${JSON.stringify(mutation.nodeId)}`;
  if (result.ok) return new Error(`${prefix}: unexpected success result`);
  switch (result.reason) {
    case 'not-found':
      return new Error(`${prefix}: Space does not exist`);
    case 'revision-conflict':
      return new Error(`${prefix}: unexpected revision conflict`);
    case 'label-conflict':
      return new Error(
        `${prefix}: label conflicts with node ${JSON.stringify(result.conflictingNodeId)}`,
      );
    case 'duplicate-node':
      return new Error(`${prefix}: duplicate persisted node`);
    case 'write-suppressed':
      return new Error(`${prefix}: write is suppressed after deletion`);
  }
}

export function validateInput(canvasId: string, input: SpaceWriteInput): void {
  if (!Number.isFinite(input.expectedVersion)) {
    throw new TypeError('expectedVersion must be a finite number');
  }
  validateCanvasFile(input.nextRecord, canvasId);
  if (input.nextRecord.version !== input.expectedVersion + 1) {
    throw new Error(
      `SpaceWrite(${canvasId}) expected nextRecord.version ` +
        `${input.expectedVersion + 1}, received ${input.nextRecord.version}`,
    );
  }
  if (
    input.allowCreate === true &&
    (input.nodeMutations.length > 0 || input.delta !== undefined)
  ) {
    throw new Error(
      'allowCreate is valid only for a record-only structural write',
    );
  }
  if (
    input.delta !== undefined &&
    input.delta.version !== input.nextRecord.version
  ) {
    throw new Error(
      'delta.version must equal the committed Space record version',
    );
  }
  if (input.delta !== undefined) {
    stringifyJson(input.delta, `Space ${JSON.stringify(canvasId)} delta`);
  }
  for (const mutation of input.nodeMutations) {
    sanitizeId(mutation.nodeId, 'nodeId');
    if (mutation.kind === 'put') {
      validateNodeContent(mutation.record, mutation.nodeId);
    }
  }
}
