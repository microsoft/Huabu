// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import { nodeIdAtScreenPoint } from './canvasNodeAtPoint';

function nodeElement(id: string, zIndex: number): HTMLElement {
  const element = document.createElement('div');
  element.className = 'react-flow__node';
  element.dataset.id = id;
  element.style.zIndex = String(zIndex);
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('nodeIdAtScreenPoint', () => {
  it('continues to the node below an excluded topmost node', () => {
    nodeElement('note-1', 1);
    nodeElement('sketch-1', 2);

    expect(nodeIdAtScreenPoint(50, 50)).toBe('sketch-1');
    expect(
      nodeIdAtScreenPoint(50, 50, {
        excludeNodeIds: new Set(['sketch-1']),
      }),
    ).toBe('note-1');
  });
});
