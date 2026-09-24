// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  executeCanvasCommands,
  normalizeSpaceShortcut,
  SPACE_SHORTCUT_SIZE,
} from '../index.js';

import type { CanvasNodeId } from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

const id = 'shortcut' as CanvasNodeId;
const legacy: CanvasNode = {
  id,
  type: 'spacePreview',
  position: { x: 100, y: 200 },
  data: { type: 'spacePreview', targetCanvasId: 'target' },
  style: { width: 1200, height: 800 },
};

describe('Space Shortcut geometry', () => {
  it.each([undefined, 1200])(
    'creates a shortcut with width %s without pinning a nominal height',
    (width) => {
      const result = executeCanvasCommands(
        {
          source: 'ui',
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id,
                  nodeType: 'spacePreview',
                  position: { x: 0, y: 0 },
                  data: {
                    targetCanvasId: 'target',
                    widthMode: width === undefined ? undefined : 'fixed',
                  },
                  size:
                    width === undefined ? undefined : { width, height: 800 },
                },
              ],
            },
          ],
        },
        { canvasId: 'host', nodes: [], edges: [] },
      );
      expect(result.writeResult.nodes[0]).toMatchObject({
        style: { width: width ?? SPACE_SHORTCUT_SIZE.defaultWidth },
        data: {
          targetCanvasId: 'target',
          widthMode: width === undefined ? 'auto' : 'fixed',
        },
      });
      expect(result.writeResult.nodes[0].style?.height).toBeUndefined();
    },
  );

  it('normalizes legacy previews idempotently without changing references or placement', () => {
    const normalized = normalizeSpaceShortcut(legacy);
    expect(normalized.style).toEqual({ width: 1200 });
    expect(normalized.data).toEqual({ ...legacy.data, widthMode: 'fixed' });
    expect(normalized.position).toBe(legacy.position);
    expect(normalizeSpaceShortcut(normalized)).toBe(normalized);
    expect(legacy.style?.height).toBe(800);
  });

  it.each([100, 320, 1000])(
    'pins bounded width %s and ignores authored height',
    (width) => {
      const automatic = {
        ...normalizeSpaceShortcut(legacy),
        data: { ...legacy.data, widthMode: 'auto' },
      };
      const result = executeCanvasCommands(
        {
          source: 'ui',
          commands: [
            {
              type: 'SET_NODE_GEOMETRY',
              items: [
                {
                  nodeId: id,
                  size: { width, height: 600 },
                },
              ],
            },
          ],
        },
        { canvasId: 'host', nodes: [automatic], edges: [] },
      );
      const node = result.writeResult.nodes[0];
      expect(node.style?.width).toBe(Math.max(240, width));
      expect(node.style?.height).toBeUndefined();
      expect(node.data.widthMode).toBe('fixed');
      expect(node.data.targetCanvasId).toBe('target');
    },
  );
});
