// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isDeepStrictEqual } from 'node:util';

import { CANVAS_NODE_TYPES } from '@huabu/shared';
import { isContainerNode } from '@huabu/shared/canvas-engine';

import { SpaceOperationError } from './operations.js';

import type { CanvasOperationEvent } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

type Patch = Extract<CanvasOperationEvent, { type: 'PATCH_NODE' }>;
type Change = Patch['changes'][number];

export function rootOperationAdmission(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
  movesCoordinates: boolean,
): 'locked' | 'unsupported-command' | undefined {
  if (node.data['locked'] === true) return 'locked';
  if (
    node.parentId ||
    !CANVAS_NODE_TYPES.some((type) => type === node.type) ||
    (isContainerNode(node) &&
      ((node.data['layoutMode'] !== undefined &&
        node.data['layoutMode'] !== 'free') ||
        (movesCoordinates &&
          nodes.some((child) => child.parentId === node.id))))
  )
    return 'unsupported-command';
  return undefined;
}

function nodeStyle(node: CanvasNode): Record<string, unknown> {
  const style = node.data['style'];
  return style !== null && typeof style === 'object' && !Array.isArray(style)
    ? (style as Record<string, unknown>)
    : {};
}

function operationFieldValue(node: CanvasNode, field: Change['field']) {
  if (field === 'position') return { present: true, value: node.position };
  const target = nodeStyle(node);
  const property = 'accent';
  return Object.hasOwn(target, property)
    ? { present: true, value: target[property] }
    : { present: false };
}

/** Apply only declared field units; used identically by preparation and storage replay. */
export function applyOperationFieldChange(
  node: CanvasNode,
  change: Change,
): void {
  if (
    !isDeepStrictEqual(operationFieldValue(node, change.field), change.before)
  )
    throw new SpaceOperationError(
      'invalid-commit',
      'Event before-value does not match committed state',
    );
  if (change.field === 'position') {
    if (!change.after.present)
      throw new SpaceOperationError(
        'invalid-commit',
        'Node position cannot be removed',
      );
    node.position = { ...change.after.value };
  } else {
    const target = nodeStyle(node);
    if (change.after.present) target['accent'] = change.after.value;
    else delete target['accent'];
    node.data['style'] = target;
  }
}
